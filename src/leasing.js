import db, { ensureColumn } from "./lib/store.js";
import { isEvmAddress, normalise, isZeroAddress, ZERO_ADDRESS, CHAIN_ID } from "./lib/address.js";
import { FLOORS, HQ_FLOOR } from "./tower.js";
import { erc20BalanceOf } from "./treasury-evm.js";

/**
 * Floor leasing, paid in the Robinhood-edition $CLAUDECO — an ERC-20 on Robinhood
 * Chain (4663). Prices stay in whole tokens (FLOOR_PRICE_CLAUDECO etc.); base units are
 * wei-style, price * 10^CLAUDECO_RH_DECIMALS.
 *
 * Two facts are kept strictly separate, because they cannot be made atomic:
 *
 *   1. MONEY ARRIVED — a verified inbound ERC-20 Transfer to the treasury becomes a
 *      wallet-scoped credit, in base units, written ONLY by the treasury scanner
 *      (src/treasury-evm.js, reading Transfer logs — never a user-submitted tx hash).
 *   2. A FLOOR WAS TAKEN — spending the lease price of credit on a vacant floor. Pure
 *      database transaction, no RPC, instant.
 *
 * That separation is what removes the attacks an earlier reservation-based design had:
 * there is no reservation to squat, so the cheapest way to deny a floor is to buy it;
 * and a dust payment produces a dust credit and touches no floor at all.
 *
 * THE TOKEN LAUNCHED 2026-09-04 22:56 UTC on PONS V2, paired to NVDA:
 * 0x7039986CaC6C7885b53f10c7492E653055470ab9 (pool 0x595aa54d2a32d9c6ced42e88355dae507aaf6fa5).
 * CLAUDECO_RH_TOKEN carries it; when the env is unset (a scratch boot) everything below
 * still says "not launched" cleanly rather than throw: the tower renders, sign-in works,
 * and the lease button explains itself.
 */

export const TOKEN = (process.env.CLAUDECO_RH_TOKEN || ZERO_ADDRESS).toLowerCase();
/** @deprecated Solana name, kept so a stale import cannot crash boot. Same value as TOKEN. */
export const MINT = TOKEN;
export const DECIMALS = Number(process.env.CLAUDECO_RH_DECIMALS || 18);
/** Price in whole tokens; base units = price * 10^decimals. */
export const PRICE_TOKENS = Number(process.env.FLOOR_PRICE_CLAUDECO || 1_000_000);
export const PRICE_BASE_UNITS = BigInt(Math.round(PRICE_TOKENS)) * 10n ** BigInt(DECIMALS);
export const TREASURY = (process.env.TREASURY_OWNER_RH || "").trim().toLowerCase();
/** True once CLAUDECO_RH_TOKEN names a real contract. */
export const launched = () => isEvmAddress(TOKEN) && !isZeroAddress(TOKEN);
export const NOT_LAUNCHED = "token not launched yet";
/** Rent, in whole tokens, charged per period. CLAUDECO buys access, not exposure. */
export const RENT_TOKENS = Number(process.env.FLOOR_RENT_CLAUDECO || 250_000);
export const RENT_BASE_UNITS = BigInt(Math.round(RENT_TOKENS)) * 10n ** BigInt(DECIMALS);
export const RENT_PERIOD_DAYS = Number(process.env.FLOOR_RENT_DAYS || 30);

db.exec(`
-- One credit row per Transfer LOG: (tx hash, log index). Keyed that way so a single
-- transaction carrying two transfers to the treasury is two credits, not one
-- silently-dropped one. Column names keep the Solana edition's shape (signature = tx
-- hash, slot = block number) so the ledger readers did not have to change.
CREATE TABLE IF NOT EXISTS credits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  signature     TEXT NOT NULL,        -- 0x tx hash
  dest_account  TEXT NOT NULL,        -- the treasury, lowercase
  log_index     INTEGER NOT NULL DEFAULT 0,
  wallet        TEXT NOT NULL,        -- the DEBITED address (Transfer.from): who actually paid
  base_units    TEXT NOT NULL,        -- decimal string; JS numbers cannot hold these safely
  slot          INTEGER,              -- block number
  block_time    INTEGER,
  seen_at       INTEGER NOT NULL,
  UNIQUE (signature, log_index)       -- replay of the same transfer is impossible
);
CREATE INDEX IF NOT EXISTS idx_credits_wallet ON credits(wallet);

CREATE TABLE IF NOT EXISTS leases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no    INTEGER NOT NULL UNIQUE REFERENCES floors(n),
  wallet      TEXT NOT NULL,
  base_units  TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL
);
-- ONE FLOOR PER WALLET, enforced by the database. Application-level checks lose races.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lease_one_per_wallet ON leases(wallet);

CREATE TABLE IF NOT EXISTS rent (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no   INTEGER NOT NULL,
  wallet     TEXT NOT NULL,
  base_units TEXT NOT NULL,
  period_end INTEGER NOT NULL,
  paid       INTEGER NOT NULL DEFAULT 0,
  charged_at INTEGER NOT NULL,
  UNIQUE (floor_no, period_end)
);
CREATE INDEX IF NOT EXISTS idx_rent_floor ON rent(floor_no, id DESC);

CREATE TABLE IF NOT EXISTS spends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet     TEXT NOT NULL,
  base_units TEXT NOT NULL,
  lease_id   INTEGER REFERENCES leases(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spends_wallet ON spends(wallet);
`);
/* A database carried over from the Solana edition has the old credits table, whose
   inline UNIQUE(signature, dest_account) cannot be dropped without a rebuild. This adds
   the column so the scanner's INSERT works there too; on such a database a second
   transfer inside one tx would be refused as a duplicate. The Robinhood service is a
   fresh disk, so this is belt and braces, said out loud. */
ensureColumn("credits", "log_index", "INTEGER NOT NULL DEFAULT 0");

const sum = (rows) => rows.reduce((t, r) => t + BigInt(r.base_units), 0n);

/** Credited minus spent, in base units. */
/* The credit ledger above is the BUILDING'S number — deposits to the treasury
 * minus spends. It is not, and was never, the wallet's own holdings; showing it
 * under the bare label "Balance" convinced the first real user their tokens had
 * vanished. This is the wallet's actual on-chain $CLAUDECO — one eth_call to
 * balanceOf(owner) on the token — read-only, cached for thirty seconds so a busy
 * page does not become an RPC bill. Returns null (not 0n) before the token is
 * launched: "no token yet" and "holds nothing" are different things to show. */
const onchainCache = new Map();
export async function walletBalanceOf(wallet) {
  const w = normalise(wallet);
  if (!w) throw new Error("bad wallet");
  if (!launched()) return null;
  const hit = onchainCache.get(w);
  if (hit && Date.now() - hit.ts < 30_000) return hit.v;
  const res = await erc20BalanceOf(TOKEN, w);
  if (!res?.ok) throw new Error(res?.error || "rpc failed");
  onchainCache.set(w, { ts: Date.now(), v: res.value });
  return res.value;
}

export function balanceOf(wallet) {
  const credited = sum(db.prepare("SELECT base_units FROM credits WHERE wallet = ?").all(wallet));
  const spent = sum(db.prepare("SELECT base_units FROM spends WHERE wallet = ?").all(wallet));
  return credited - spent;
}

export function creditsFor(wallet) {
  return db.prepare(
    "SELECT signature, base_units, slot, block_time FROM credits WHERE wallet = ? ORDER BY id DESC LIMIT 25"
  ).all(wallet);
}

export function leaseOf(wallet) {
  return db.prepare("SELECT * FROM leases WHERE wallet = ?").get(wallet) || null;
}

export function leaseFor(floorNo) {
  return db.prepare("SELECT * FROM leases WHERE floor_no = ?").get(floorNo) || null;
}

/**
 * Take a floor. Everything below happens inside one transaction so two concurrent
 * requests cannot both win — the unique indexes are the referee, not the if-statements.
 */
export function allocate({ wallet, floorNo, name = null }) {
  if (!isEvmAddress(wallet)) return { ok: false, error: "bad wallet" };
  wallet = normalise(wallet);
  floorNo = Number(floorNo);
  if (!Number.isInteger(floorNo) || floorNo < 1 || floorNo > FLOORS) {
    return { ok: false, error: "no such floor" };
  }
  if (floorNo === HQ_FLOOR) return { ok: false, error: "the penthouse is not for lease" };

  try {
    db.exec("BEGIN IMMEDIATE");

    if (leaseOf(wallet)) { db.exec("ROLLBACK"); return { ok: false, error: "this wallet already holds a floor" }; }

    const floor = db.prepare("SELECT * FROM floors WHERE n = ?").get(floorNo);
    if (!floor) { db.exec("ROLLBACK"); return { ok: false, error: "no such floor" }; }
    if (floor.state !== "vacant") { db.exec("ROLLBACK"); return { ok: false, error: "that floor is taken" }; }

    const bal = balanceOf(wallet);
    if (bal < PRICE_BASE_UNITS) {
      db.exec("ROLLBACK");
      return {
        ok: false, error: "not enough $CLAUDECO credited yet",
        needBaseUnits: PRICE_BASE_UNITS.toString(), haveBaseUnits: bal.toString(),
      };
    }

    const lease = db.prepare(
      "INSERT INTO leases (floor_no, wallet, base_units, name, created_at) VALUES (?,?,?,?,?)"
    ).run(floorNo, wallet, PRICE_BASE_UNITS.toString(), name, Date.now());

    db.prepare("INSERT INTO spends (wallet, base_units, lease_id, created_at) VALUES (?,?,?,?)")
      .run(wallet, PRICE_BASE_UNITS.toString(), lease.lastInsertRowid, Date.now());

    db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=? AND state='vacant'")
      .run(wallet, name, Date.now(), floorNo);

    db.exec("COMMIT");
    return { ok: true, floorNo, wallet, leaseId: lease.lastInsertRowid };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    // A unique-index violation here is the race losing, not a bug.
    if (/UNIQUE/i.test(String(e.message))) {
      return { ok: false, error: "already taken — that floor or that wallet was claimed a moment ago" };
    }
    return { ok: false, error: String(e.message) };
  }
}

/** When this floor's rent is next due. A fresh lease is paid up for one period. */
export function rentDueAt(floorNo) {
  const last = db.prepare("SELECT period_end FROM rent WHERE floor_no=? ORDER BY period_end DESC LIMIT 1").get(floorNo);
  if (last) return last.period_end;
  const lease = leaseFor(floorNo);
  return lease ? lease.created_at + RENT_PERIOD_DAYS * 86400000 : null;
}

export function rentStatus(floorNo) {
  const due = rentDueAt(floorNo);
  const unpaid = db.prepare("SELECT COUNT(*) n FROM rent WHERE floor_no=? AND paid=0").get(floorNo).n;
  return { dueAt: due, overdue: due != null && Date.now() > due, unpaidPeriods: unpaid,
    rentTokens: RENT_TOKENS, periodDays: RENT_PERIOD_DAYS };
}

/**
 * Charge rent on every floor whose period has elapsed. Charged from the same credit
 * balance the lease was paid from. A floor that cannot pay goes into arrears rather
 * than being evicted — and arrears never stops an exit call reaching the tenant.
 */
export function chargeDueRent() {
  const leases = db.prepare("SELECT * FROM leases").all();
  let charged = 0, unpaid = 0;
  for (const l of leases) {
    const due = rentDueAt(l.floor_no);
    if (due == null || Date.now() < due) continue;
    const periodEnd = due + RENT_PERIOD_DAYS * 86400000;
    const canPay = balanceOf(l.wallet) >= RENT_BASE_UNITS;
    try {
      db.exec("BEGIN IMMEDIATE");
      if (canPay) {
        db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)")
          .run(l.wallet, RENT_BASE_UNITS.toString(), Date.now());
      }
      db.prepare(`INSERT INTO rent (floor_no,wallet,base_units,period_end,paid,charged_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(l.floor_no, l.wallet, RENT_BASE_UNITS.toString(), periodEnd, canPay ? 1 : 0, Date.now());
      db.exec("COMMIT");
      canPay ? charged++ : unpaid++;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      if (!/UNIQUE/i.test(String(e.message))) throw e;
    }
  }
  return { charged, unpaid };
}

/** In arrears: gates NEW calls, never an exit. */
export const inArrears = (floorNo) =>
  db.prepare("SELECT COUNT(*) n FROM rent WHERE floor_no=? AND paid=0").get(floorNo).n > 0;

/**
 * Retry unpaid rent against today's balance. Without this, one missed charge
 * bricked the floor forever: the UI said "top up to resume new calls" while no
 * code path ever read the top-up — an instruction that corresponded to nothing.
 * Runs on the same hourly timer as chargeDueRent.
 */
export function settleArrears() {
  const rows = db.prepare("SELECT id, floor_no, wallet, base_units FROM rent WHERE paid=0 ORDER BY id").all();
  let settled = 0;
  for (const r of rows) {
    if (balanceOf(r.wallet) < BigInt(r.base_units)) continue;
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)")
        .run(r.wallet, r.base_units, Date.now());
      db.prepare("UPDATE rent SET paid=1 WHERE id=? AND paid=0").run(r.id);
      db.exec("COMMIT");
      settled++;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
  return { settled, remaining: rows.length - settled };
}

/** The EVM pay object the page needs to build its own transfer(treasury, amount): no
 *  token account, no program id, no blockhash — an ERC-20 transfer is one calldata. Null
 *  until the token exists, so the page says "not launched" instead of composing a call
 *  to the zero address. */
export function payConfig() {
  if (!launched() || !TREASURY) return null;
  return { chainId: CHAIN_ID, token: TOKEN, decimals: DECIMALS, treasury: TREASURY };
}

export function config() {
  const isLaunched = launched();
  return {
    chainId: CHAIN_ID,
    token: TOKEN, mint: TOKEN,          // `mint` is the Solana-era name the page still reads
    decimals: DECIMALS,
    priceTokens: PRICE_TOKENS, priceBaseUnits: PRICE_BASE_UNITS.toString(),
    rentTokens: RENT_TOKENS, rentPeriodDays: RENT_PERIOD_DAYS,
    treasury: TREASURY || null,
    oneFloorPerWallet: true,
    launched: isLaunched,
    ready: isLaunched && Boolean(TREASURY),
    reason: !isLaunched ? NOT_LAUNCHED : !TREASURY ? "treasury not configured" : null,
  };
}
