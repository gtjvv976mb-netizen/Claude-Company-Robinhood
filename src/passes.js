/**
 * GUEST PASSES — paid admission to another tenant's floor.
 *
 * A tenant's floor is private, but privacy here is a market, not a wall: anyone
 * who already holds a lease may buy their way into another tenant's gallery by
 * paying that tenant directly — 250,000 $CLAUDECO, wallet to wallet, none of it
 * touching the treasury. The building takes no cut; the tenant's alpha earns
 * the tenant's rent.
 *
 * The payment is a plain ERC-20 transfer the buyer makes in their own wallet.
 * We only verify it: the named transaction must move enough $CLAUDECO from the
 * buyer to the floor owner's wallet, must have succeeded, and must not have
 * been used to buy a pass before. Verification is read-only, like everything
 * else this desk does on chain.
 */
import db from "./lib/store.js";
import { TOKEN, DECIMALS, leaseFor, launched, NOT_LAUNCHED } from "./leasing.js";
import { evmRpc, TRANSFER_TOPIC, wordToAddress, hexToBigInt } from "./treasury-evm.js";
import { canonicalAddress, canonicalTxHash, isEvmAddress, isEvmTxHash } from "./canonical.js";

export const PASS_TOKENS = Number(process.env.GUEST_PASS_CLAUDECO || 250_000);
export const PASS_DAYS = Number(process.env.GUEST_PASS_DAYS || 30);
const PASS_BASE_UNITS = BigInt(Math.round(PASS_TOKENS)) * 10n ** BigInt(DECIMALS);

db.exec(`
CREATE TABLE IF NOT EXISTS floor_passes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no   INTEGER NOT NULL,
  viewer     TEXT NOT NULL,
  owner      TEXT NOT NULL,
  signature  TEXT NOT NULL UNIQUE,     -- the transaction hash (column name kept for schema stability)
  base_units TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passes_floor ON floor_passes(floor_no, viewer, expires_at);
`);

/** The viewer's live pass for a floor, if one is current. */
export function passFor(floorNo, viewer) {
  if (!viewer) return null;
  return db.prepare(
    "SELECT * FROM floor_passes WHERE floor_no=? AND viewer=? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
    .get(floorNo, canonicalAddress(viewer), Date.now()) || null;
}

/**
 * The token balance deltas a receipt implies, per wallet, for ONE token. Pure, so the
 * judgement can be tested on a receipt whose answer is already known. A Transfer log
 * is the only part of a transaction that cannot be dressed up: the owner's $CLAUDECO
 * must rise by at least the price, the buyer's must fall.
 */
export function tokenDeltas(receipt, token) {
  const tk = canonicalAddress(token);
  const deltas = new Map();
  for (const log of receipt?.logs ?? []) {
    const t = log?.topics ?? [];
    if (log?.removed || t.length !== 3 || t[0] !== TRANSFER_TOPIC) continue;
    if (canonicalAddress(String(log.address)) !== tk) continue;
    const from = wordToAddress(t[1]), to = wordToAddress(t[2]);
    const value = hexToBigInt(log.data);
    deltas.set(from, (deltas.get(from) ?? 0n) - value);
    deltas.set(to, (deltas.get(to) ?? 0n) + value);
  }
  return deltas;
}

/**
 * Verify a payment and grant the pass.
 */
export async function grantPass({ floorNo, viewer, signature }) {
  const lease = leaseFor(floorNo);
  if (!lease) return { ok: false, error: "that floor has no tenant to pay" };
  const v = canonicalAddress(viewer);
  if (!isEvmAddress(v)) return { ok: false, error: "sign in with a 0x wallet first" };
  if (canonicalAddress(lease.wallet) === v) return { ok: false, error: "it is your own floor" };
  if (passFor(floorNo, v)) return { ok: false, error: "your pass is still live" };
  if (!launched()) return { ok: false, error: NOT_LAUNCHED };
  const hash = canonicalTxHash(String(signature || "").trim());
  if (!isEvmTxHash(hash))
    return { ok: false, error: "that does not look like a transaction hash (0x + 64 hex digits)" };
  const used = db.prepare("SELECT 1 FROM floor_passes WHERE signature=?").get(hash);
  if (used) return { ok: false, error: "that payment already bought a pass" };

  /* MINED AND SUCCEEDED, like every other money path. A sequencer can drop a
   * transaction silently (no receipt at all) and ArbOS 61 compliance can void one
   * (receipt status 0x0, no logs, gas burned) — neither is a payment. */
  const res = await evmRpc("eth_getTransactionReceipt", [hash]);
  if (!res?.ok || !res.data) return { ok: false, error: "transaction not found yet — give it a moment" };
  const receipt = res.data;
  if (receipt.status !== "0x1") return { ok: false, error: "that transaction failed or was voided on chain" };

  // Only a payment made FOR this purchase counts: a months-old transfer between
  // the same two wallets is not pass revenue, and each old transfer would
  // otherwise be one free pass.
  const blk = await evmRpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const blockTime = blk?.ok && blk.data?.timestamp ? Number(hexToBigInt(blk.data.timestamp)) : null;
  const age = blockTime ? Date.now() - blockTime * 1000 : null;
  if (age == null || age > 30 * 60e3)
    return { ok: false, error: "that payment is too old — send the pass payment now, then paste its hash" };
  if (blockTime * 1000 < lease.created_at)
    return { ok: false, error: "that payment predates the current lease" };

  const deltas = tokenDeltas(receipt, TOKEN);
  const ownerGain = deltas.get(canonicalAddress(lease.wallet)) ?? 0n;
  const viewerLoss = deltas.get(v) ?? 0n;
  if (ownerGain < PASS_BASE_UNITS)
    return { ok: false, error: `the floor's owner received ${Number(ownerGain) / 10 ** DECIMALS} — a pass costs ${PASS_TOKENS.toLocaleString()}` };
  if (viewerLoss > -PASS_BASE_UNITS)
    return { ok: false, error: "the payment must come from the wallet you signed in with" };

  const now = Date.now();
  const expires = now + PASS_DAYS * 86400e3;
  try {
    db.prepare(`INSERT INTO floor_passes (floor_no, viewer, owner, signature, base_units, granted_at, expires_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(floorNo, v, canonicalAddress(lease.wallet), hash, ownerGain.toString(), now, expires);
  } catch (e) {
    // Double-click race: both requests pass the used-check before either inserts.
    // The loser's UNIQUE violation is "already bought", not a 500.
    if (/UNIQUE/i.test(String(e.message))) return { ok: false, error: "that payment already bought a pass" };
    throw e;
  }
  return { ok: true, pass: passFor(floorNo, v), days: PASS_DAYS };
}
