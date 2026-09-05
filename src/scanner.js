import { readRpc } from "./lib/http.js";
import db from "./lib/store.js";
import { cfg } from "./config.js";
import { emit } from "./lib/bus.js";
import { MINT, TREASURY } from "./leasing.js";

/**
 * The treasury scanner: the ONLY writer of credit rows.
 *
 * Nothing a user can call performs an RPC request. That is deliberate — an earlier
 * design let anyone submit a signature for verification, which meant a free keypair and
 * a random string could force archival lookups, exhaust the RPC plan, and close the sale
 * for everybody. Here RPC volume is a function of treasury traffic, not HTTP traffic.
 *
 * Credit goes to the owner of the DEBITED token account, never the signer or fee payer:
 * a relayer or an SPL delegate paying on someone's behalf must credit that someone.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS scanner_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

const getState = (k) => db.prepare("SELECT value FROM scanner_state WHERE key=?").get(k)?.value ?? null;
const setState = (k, v) => db.prepare("INSERT INTO scanner_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/** The treasury's token account for the mint, found by RPC so no PDA math is needed. */
export async function treasuryTokenAccount() {
  const cached = getState("treasury_token_account");
  if (cached) return cached;
  const r = await readRpc(cfg.rpc, "getTokenAccountsByOwner",
    [TREASURY, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);
  if (!r.ok) throw new Error(`getTokenAccountsByOwner: ${r.error}`);
  const acct = r.data?.value?.[0]?.pubkey;
  if (!acct) throw new Error("treasury holds no token account for this mint yet — receive 1 token to create it");
  setState("treasury_token_account", acct);
  return acct;
}

/** Pull the credit-relevant facts out of one confirmed transaction. */
function readTransfer(tx, tokenAccount) {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;                       // failed transactions credit nobody

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const idxOf = (i) => keys[i];

  const pre = new Map((meta.preTokenBalances || []).map((b) => [b.accountIndex, b]));
  const post = new Map((meta.postTokenBalances || []).map((b) => [b.accountIndex, b]));

  let received = 0n;
  for (const [idx, p] of post) {
    if (p.mint !== MINT) continue;
    const before = BigInt(pre.get(idx)?.uiTokenAmount?.amount ?? "0");
    const after = BigInt(p.uiTokenAmount.amount);
    const delta = after - before;
    if (idxOf(idx) === tokenAccount && delta > 0n) received += delta;
  }
  if (received <= 0n) return null;

  // Who paid? The debit that EQUALS what the treasury received — a swap routed
  // through an AMM debits the pool's vault hardest, and "biggest debit" would
  // credit the pool authority with the buyer's payment. Only when no debit
  // matches exactly do we fall back to the largest, and then only if it covers
  // the amount; otherwise the fee payer signed for it and gets the credit.
  const debits = [];
  for (const [idx, p] of pre) {
    if (p.mint !== MINT) continue;
    const before = BigInt(p.uiTokenAmount.amount);
    const after = BigInt(post.get(idx)?.uiTokenAmount?.amount ?? "0");
    const debit = before - after;
    if (debit > 0n && p.owner) debits.push({ owner: p.owner, debit });
  }
  const exact = debits.find((d) => d.debit === received);
  if (exact) return { received, payer: exact.owner };
  debits.sort((a, b) => (b.debit > a.debit ? 1 : -1));
  if (debits[0] && debits[0].debit >= received) return { received, payer: debits[0].owner };
  const feePayer = keys[0] ?? null;                         // first account key signs and pays fees
  return feePayer ? { received, payer: feePayer } : null;
}

/* PARKED ON CHAIN 4663. Every read below is Solana JSON-RPC (getSignaturesForAddress,
 * getTransaction, SPL pre/post token balances) against a treasury that was an SPL
 * token account. On an EVM endpoint each tick would answer method-not-found every 20
 * seconds and credit nobody. The ERC-20 replacement — replay Transfer logs to
 * TREASURY_OWNER_RH for CLAUDECO_RH_TOKEN in ≤10k-block spans, crediting `from` — is
 * the auth-leasing lane's; the exact shape is in docs/HANDOFF-data-sources.md. Until
 * it lands the scanner is a no-op that says so once, and leasing stays closed. Set
 * DESK_CHAIN=solana to run the old path against a Solana RPC (tests, archaeology). */
export const SCANNER_ENABLED = (process.env.DESK_CHAIN || "robinhood") === "solana";

export async function scanOnce({ limit = 40 } = {}) {
  if (!SCANNER_ENABLED) return { ok: false, error: "treasury scanner parked on chain 4663 — ERC-20 Transfer-log scanner pending (HANDOFF-data-sources)", parked: true };
  if (!TREASURY) return { ok: false, error: "TREASURY_OWNER not set" };

  const tokenAccount = await treasuryTokenAccount();
  const until = getState("last_signature") || undefined;

  // getSignaturesForAddress takes TWO params — address and one config object. Passing
  // commitment as a third argument returns "Invalid params: Expected end of params",
  // which failed silently on every poll: the scanner never saw a payment, so a tenant
  // could send 1,000,000 CLAUDECO and never be credited.
  //
  // Page backwards (newest→older via `before`) until the batch reaches the stored
  // cursor: one fetch of the newest N would silently orphan payment N+1 in a rush,
  // because the cursor then advances past it forever.
  const batches = [];
  let before;
  for (let page = 0; page < 25; page++) {
    const sigs = await readRpc(cfg.rpc, "getSignaturesForAddress",
      [tokenAccount, { limit, commitment: "finalized",
        ...(until ? { until } : {}), ...(before ? { before } : {}) }]);
    if (!sigs.ok) {
      // A failed page with pages already in hand: process nothing — the cursor
      // must not advance over the gap the missing page would leave.
      if (batches.length) return { ok: false, error: `pagination broke: ${sigs.error}` };
      return { ok: false, error: sigs.error };
    }
    const page_ = sigs.data || [];
    batches.push(...page_);
    if (page_.length < limit) break;                        // reached until / genesis
    before = page_[page_.length - 1].signature;
  }

  const list = batches.filter((s) => !s.err).reverse();     // oldest first
  let credited = 0;

  // The cursor may only advance over transactions we actually processed. A transient
  // getTransaction failure mid-batch aborts the pass with the cursor at the last
  // SUCCESS, so the failed payment is re-fetched next poll instead of orphaned.
  let lastProcessed = null;
  for (const s of list) {
    const already = db.prepare("SELECT 1 FROM credits WHERE signature=? LIMIT 1").get(s.signature);
    if (already) { lastProcessed = s.signature; continue; }

    const tx = await readRpc(cfg.rpc, "getTransaction",
      [s.signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (!tx.ok) break;                                      // retry from here next poll
    if (!tx.data) { lastProcessed = s.signature; continue; } // pruned/absent: nothing to credit, ever

    const found = readTransfer(tx.data, tokenAccount);
    if (found) {
      try {
        db.prepare(`INSERT INTO credits (signature,dest_account,wallet,base_units,slot,block_time,seen_at)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(s.signature, tokenAccount, found.payer, found.received.toString(),
               tx.data.slot ?? null, tx.data.blockTime ?? null, Date.now());
        credited++;
        emit("credit", { wallet: found.payer, baseUnits: found.received.toString(), signature: s.signature });
      } catch (e) {
        if (!/UNIQUE/i.test(String(e.message))) throw e;    // duplicate = already credited
      }
    }
    lastProcessed = s.signature;
  }

  if (lastProcessed) setState("last_signature", lastProcessed);
  return { ok: true, scanned: list.length, credited,
           partial: lastProcessed !== (list[list.length - 1]?.signature ?? lastProcessed) };
}

let timer = null;
export function startScanner({ intervalMs = 20000 } = {}) {
  if (!SCANNER_ENABLED) { console.log("[scanner] parked on chain 4663 — the SPL treasury scanner does not run here; leasing credits are closed until the ERC-20 scanner lands"); return; }
  if (!TREASURY) { console.log("[scanner] TREASURY_OWNER not set — leasing is closed"); return; }
  if (timer) return;
  const tick = async () => {
    try {
      const r = await scanOnce();
      if (r.ok && r.credited) console.log(`[scanner] credited ${r.credited} payment(s)`);
      if (!r.ok) console.log(`[scanner] ${r.error}`);
    } catch (e) { console.log(`[scanner] ${e.message}`); }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  console.log(`[scanner] watching treasury ${TREASURY.slice(0, 6)}… every ${intervalMs / 1000}s`);
}
export function stopScanner() { if (timer) clearInterval(timer); timer = null; }
