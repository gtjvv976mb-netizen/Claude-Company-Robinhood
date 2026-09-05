import db, { ensureColumn } from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { DECIMALS, TOKEN } from "./leasing.js";
import { evmRpc, TRANSFER_TOPIC, wordToAddress, hexToBigInt } from "./treasury-evm.js";
import { canonicalAddress, isEvmAddress, isEvmTxHash } from "./canonical.js";
// fills references calls(id), so that table must exist before this module's DDL runs.
// Importing for the side effect is the dependency, and stating it here keeps it honest.
import "./calls.js";

/**
 * PERFORMANCE — did the tenant actually take the call, and what did it make them?
 *
 * Read-only, always. Chain 4663 is public, so the desk can follow a floor owner's own
 * wallet and see the fills without ever holding a key, a coin, or a permission. Nothing
 * here can move anything: it reads ERC-20 Transfer logs out of mined receipts and
 * writes rows to a local database.
 *
 * This exists because a track record the desk computes from chain data is worth
 * something, and one the desk asks its customers to self-report is worth nothing.
 */

export const FEE_PCT = Number(process.env.PERF_FEE_PCT || 10);
/** The access token is leasing.js's TOKEN (CLAUDECO_RH_TOKEN, a placeholder zero
 *  address until launch); MINT is kept as the name perf's callers have always read. */
export const MINT = TOKEN;

/* THE QUOTE LEGS a fill can be priced from. PONS V2 pairs against WETH or USDG
 * (approvedPairTokens), V1 against WETH; Kyber may also take native ETH, which leaves
 * no Transfer log at all — see readFill. USDG is a dollar with 6 decimals. */
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

db.exec(`
CREATE TABLE IF NOT EXISTS fills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no    INTEGER NOT NULL,
  call_id     INTEGER REFERENCES calls(id),
  wallet      TEXT NOT NULL,
  mint        TEXT NOT NULL,             -- the token's 0x address (column name kept for schema stability)
  side        TEXT NOT NULL,             -- buy | sell | transfer_in | transfer_out
  token_units TEXT NOT NULL,             -- base units of the token that moved
  quote_usd   REAL,                      -- what it cost or returned, best effort
  signature   TEXT NOT NULL,             -- the transaction hash (column name kept)
  slot        INTEGER,                   -- the block number (column name kept)
  block_time  INTEGER,
  seen_at     INTEGER NOT NULL,
  UNIQUE (signature, mint, side)
);
CREATE INDEX IF NOT EXISTS idx_fills_floor ON fills(floor_no, id DESC);
CREATE INDEX IF NOT EXISTS idx_fills_call ON fills(call_id);

-- One settled result per (floor, call). Written only when a position is fully closed,
-- because an unrealised gain is not a result and must never be billed as one.
CREATE TABLE IF NOT EXISTS results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no     INTEGER NOT NULL,
  call_id      INTEGER NOT NULL REFERENCES calls(id),
  wallet       TEXT NOT NULL,
  bought_usd   REAL NOT NULL,
  sold_usd     REAL NOT NULL,
  pnl_usd      REAL NOT NULL,
  fee_pct      REAL NOT NULL,
  fee_usd      REAL NOT NULL DEFAULT 0,
  fee_claudeco TEXT,                  -- base units owed, only ever on a gain
  fee_paid     INTEGER NOT NULL DEFAULT 0,
  token_usd    REAL,                  -- the CLAUDECO price the fee was converted at
  settled_at   INTEGER NOT NULL,
  UNIQUE (floor_no, call_id)
);
`);

ensureColumn("results", "fee_usd", "REAL NOT NULL DEFAULT 0");
ensureColumn("results", "fee_paid", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("results", "token_usd", "REAL");

/** The chain's ETH/USD, from the data lane's reconciled source (CoinGecko cross-checked
 *  against Kyber's amountInUsd). Null when it cannot be read — a fill priced in ETH is
 *  then left unpriced rather than priced at a guess. */
export async function ethPrice() {
  try {
    const { ethUsd } = await import("./data/eth-usd.js");
    const r = await ethUsd();
    return r?.ok && Number(r.value) > 0 ? Number(r.value) : null;
  } catch { return null; }
}

/** What one CLAUDECO is worth right now — the rate a fee is converted at. Kyber's
 *  price() is the data lane's; a token not yet launched (zero address) has no price. */
export async function tokenPriceUsd() {
  if (!isEvmAddress(MINT) || /^0x0{40}$/.test(MINT)) return null;
  try {
    const { price } = await import("./data/kyber.js");
    const p = await price([MINT]);
    const v = p?.[MINT]?.usdPrice ?? p?.[MINT.toLowerCase()]?.usdPrice ?? null;
    return Number(v) > 0 ? Number(v) : null;
  } catch { return null; }
}

/** Every ERC-20 Transfer in a receipt, decoded. Pure. */
export function transfersIn(receipt) {
  const out = [];
  for (const log of receipt?.logs ?? []) {
    const t = log?.topics ?? [];
    if (log?.removed || t.length !== 3 || t[0] !== TRANSFER_TOPIC) continue;
    out.push({ token: canonicalAddress(String(log.address)), from: wordToAddress(t[1]), to: wordToAddress(t[2]),
      value: hexToBigInt(log.data) });
  }
  return out;
}

/**
 * Read one mined transaction as a fill. Pure, from the receipt's logs.
 *
 * The token side is unambiguous — Transfer logs to or from the wallet in that token.
 * The dollar side is best-effort: a USDG leg is a dollar; a WETH leg is priced through
 * ETH/USD; a NATIVE ETH leg leaves no Transfer log, so `nativeWei` (the tx value on a
 * buy) may be supplied by the caller, and where nothing prices the leg the value is
 * left null rather than invented.
 */
export function readFill(receipt, wallet, token, ethPriceUsd, { nativeWei = 0n } = {}) {
  if (!receipt || receipt.status !== "0x1") return null;      // reverted or voided (ArbOS 61: status 0x0, no logs)
  const w = canonicalAddress(wallet), tk = canonicalAddress(token);
  let tokenDelta = 0n, wethDelta = 0n, usdgDelta = 0n;
  for (const x of transfersIn(receipt)) {
    const signed = x.to === w ? x.value : x.from === w ? -x.value : 0n;
    if (signed === 0n) continue;
    if (x.token === tk) tokenDelta += signed;
    else if (x.token === WETH) wethDelta += signed;
    else if (x.token === USDG) usdgDelta += signed;
  }
  if (tokenDelta === 0n) return null;

  // What the wallet paid or received, in dollars. Native ETH spent on a buy is the
  // transaction's value; on a sell the proceeds arrive as a WETH withdraw the logs do
  // not attribute to the wallet, so a native-leg sell stays unpriced (null).
  const usdgMoved = Number(usdgDelta) / 1e6;
  const ethMoved = Number(wethDelta) / 1e18 - (tokenDelta > 0n ? Number(BigInt(nativeWei || 0n)) / 1e18 : 0);
  let quoteUsd = null;
  if (Math.abs(usdgMoved) > 0.000001) quoteUsd = Math.abs(usdgMoved);
  else if (Math.abs(ethMoved) > 1e-9 && ethPriceUsd > 0) quoteUsd = Math.abs(ethMoved) * ethPriceUsd;

  // A genuine trade moves tokens AND meaningful value the other way. A plain transfer
  // moves only tokens — the counter-movement is dust or nothing. Reading a transfer
  // as a sale is not a rounding error: it would bill a performance fee on money that
  // was never made. The tenant's own payment to the treasury is exactly this shape.
  const TRADE_FLOOR_USD = 0.5;
  const isTrade = quoteUsd != null && quoteUsd >= TRADE_FLOOR_USD;
  const side = tokenDelta > 0n
    ? (isTrade ? "buy" : "transfer_in")
    : (isTrade ? "sell" : "transfer_out");

  return {
    side,
    tokenUnits: (tokenDelta > 0n ? tokenDelta : -tokenDelta).toString(),
    quoteUsd: isTrade ? Number(quoteUsd.toFixed(4)) : null,
  };
}

/* BLOCKS FROM A TIMESTAMP, without an index: the chain seals a block every ~100 ms
 * (100.6 ms measured over 10,000 blocks, live-thresholds.mjs BLOCK_MS), so a wall-clock
 * window is a block window to within the cadence's drift. Over-reach by a margin;
 * an extra chunk of empty logs costs a request, a missed fill costs a result. */
const BLOCK_MS = Number(process.env.RH_BLOCK_MS || 100);
const LOG_CHUNK = Number(process.env.PERF_LOG_CHUNK_BLOCKS || 50_000);
const MAX_SCAN_BLOCKS = Number(process.env.PERF_MAX_SCAN_BLOCKS || 1_500_000);   // ~42h at 100 ms

const blockTimeCache = new Map();
async function blockTimestamp(blockHex) {
  const hit = blockTimeCache.get(blockHex);
  if (hit) return hit;
  const r = await evmRpc("eth_getBlockByNumber", [blockHex, false]);
  const ts = r.ok && r.data?.timestamp ? Number(hexToBigInt(r.data.timestamp)) : null;
  if (ts) blockTimeCache.set(blockHex, ts);
  return ts;
}

/**
 * Follow one wallet's activity in one token and record any fills found.
 * Purely observational: it asks the chain what already happened, via eth_getLogs on
 * the token's Transfer topic filtered to the wallet on either side.
 */
export async function scanFills({ floorNo, callId, wallet, mint, limit = 40 }) {
  const w = canonicalAddress(wallet), token = canonicalAddress(mint);
  if (!isEvmAddress(w) || !isEvmAddress(token)) return { ok: false, error: "bad address" };

  // Only activity DURING the call belongs to the call. A tenant who traded this
  // token last week did not trade the desk's idea — attributing those fills would
  // bill a performance fee on money the call never made.
  const call = callId ? db.prepare("SELECT opened_at, closed_at FROM calls WHERE id=?").get(callId) : null;
  const windowStart = call ? Math.floor(call.opened_at / 1000) - 300 : null;   // 5 min of clock skew grace
  const windowEnd = call?.closed_at ? Math.floor(call.closed_at / 1000) + 48 * 3600 : null; // exits take time

  const head = await evmRpc("eth_blockNumber", []);
  if (!head.ok) return { ok: false, error: head.error, fills: 0 };
  const headNo = Number(hexToBigInt(head.data));
  const now = Date.now();
  const sinceMs = windowStart != null ? now - windowStart * 1000 : 24 * 3600e3;
  const span = Math.min(MAX_SCAN_BLOCKS, Math.ceil(sinceMs / BLOCK_MS) + 3_000);
  const fromNo = Math.max(0, headNo - span);

  const ethUsd = await ethPrice();
  const wallWord = "0x" + w.slice(2).padStart(64, "0");
  const hashes = new Set();
  for (let lo = fromNo; lo <= headNo; lo += LOG_CHUNK) {
    const hi = Math.min(headNo, lo + LOG_CHUNK - 1);
    const range = { address: token, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) };
    // Two filters, because a topic position is one side of the transfer: to the wallet, from the wallet.
    for (const topics of [[TRANSFER_TOPIC, null, wallWord], [TRANSFER_TOPIC, wallWord]]) {
      const r = await evmRpc("eth_getLogs", [{ ...range, topics }]);
      if (!r.ok) return { ok: false, error: r.error, fills: 0 };
      for (const log of r.data ?? []) if (log?.transactionHash) hashes.add(String(log.transactionHash).toLowerCase());
    }
  }

  let found = 0;
  for (const hash of [...hashes].slice(-Math.max(1, limit))) {
    if (!isEvmTxHash(hash)) continue;
    const already = db.prepare("SELECT 1 FROM fills WHERE signature=? AND mint=? LIMIT 1").get(hash, token);
    if (already) continue;
    const rc = await evmRpc("eth_getTransactionReceipt", [hash]);
    if (!rc.ok || !rc.data) continue;
    const receipt = rc.data;
    const blockNo = Number(hexToBigInt(receipt.blockNumber ?? "0x0"));
    const blockTime = await blockTimestamp(receipt.blockNumber);
    if (windowStart != null && blockTime != null && blockTime < windowStart) continue;
    if (windowEnd != null && blockTime != null && blockTime > windowEnd) continue;

    /* The buy's ETH leaves as the transaction's value, which no log records; read it from
       the transaction so a native buy is a fill and not a "transfer_in" that can never
       settle (review, 2026-09-05). A sell's proceeds arrive as a WETH withdraw the logs do carry. */
    let nativeWei = 0n;
    try {
      const txr = await evmRpc("eth_getTransactionByHash", [hash]);
      if (txr.ok && txr.data && canonicalAddress(txr.data.from) === w) nativeWei = hexToBigInt(txr.data.value ?? "0x0");
    } catch { nativeWei = 0n; }
    const fill = readFill(receipt, w, token, ethUsd, { nativeWei });
    if (!fill) continue;
    try {
      db.prepare(`INSERT INTO fills (floor_no,call_id,wallet,mint,side,token_units,quote_usd,signature,slot,block_time,seen_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(floorNo, callId ?? null, w, token, fill.side, fill.tokenUnits, fill.quoteUsd,
             hash, blockNo, blockTime, Date.now());
      found++;
      emit("fill", { floorNo, callId, side: fill.side, quoteUsd: fill.quoteUsd, mint: token });
    } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; }
  }
  return { ok: true, fills: found, scannedBlocks: headNo - fromNo, unpricedEthLeg: ethUsd == null };
}

/**
 * Settle a call for a floor. A result is only written once the position is fully closed:
 * an unrealised gain is not a result, and must never be billed as one.
 */
export async function settle({ floorNo, callId, wallet }) {
  const fills = db.prepare("SELECT * FROM fills WHERE floor_no=? AND call_id=? ORDER BY id").all(floorNo, callId);
  if (!fills.length) return { ok: false, error: "no fills" };

  // Transfers are recorded for the audit trail but are not trades and cannot be billed.
  const bought = fills.filter((f) => f.side === "buy");
  const sold = fills.filter((f) => f.side === "sell");
  const transfers = fills.filter((f) => f.side.startsWith("transfer"));
  const boughtUnits = bought.reduce((a, f) => a + BigInt(f.token_units), 0n);
  const soldUnits = sold.reduce((a, f) => a + BigInt(f.token_units), 0n);
  if (!bought.length || soldUnits < boughtUnits) return { ok: false, error: "position still open" };

  const boughtUsd = bought.reduce((a, f) => a + (f.quote_usd ?? 0), 0);
  const soldUsd = sold.reduce((a, f) => a + (f.quote_usd ?? 0), 0);
  if (!boughtUsd || !soldUsd) return { ok: false, error: "no priced fills — cannot compute a result honestly" };

  const pnl = Number((soldUsd - boughtUsd).toFixed(4));
  // A fee is charged on gains only. A losing call costs the tenant nothing.
  const feeUsd = pnl > 0 ? (pnl * FEE_PCT) / 100 : 0;

  // Convert the fee to CLAUDECO at the live rate and settle it against the same credit
  // balance the tenant already tops up. Priced at settlement, and the rate is recorded,
  // so a later price move cannot retroactively change what was charged.
  let feeUnits = 0n, tokenUsd = null, paid = 0;
  if (feeUsd > 0) {
    tokenUsd = await tokenPriceUsd();
    if (tokenUsd && tokenUsd > 0) {
      feeUnits = BigInt(Math.round((feeUsd / tokenUsd) * 10 ** DECIMALS));
    }
  }

  try {
    db.exec("BEGIN IMMEDIATE");
    const existing = db.prepare("SELECT 1 FROM results WHERE floor_no=? AND call_id=?").get(floorNo, callId);
    if (existing) { db.exec("ROLLBACK"); return { ok: false, error: "already settled" }; }

    if (feeUnits > 0n) {
      const { balanceOf } = await import("./leasing.js");
      if (balanceOf(wallet) >= feeUnits) {
        db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)")
          .run(wallet, feeUnits.toString(), Date.now());
        paid = 1;
      }
      // If the balance will not cover it the fee stands as owed. It is never written as
      // a negative balance, and it never blocks an exit call — see feesOwed().
    }

    db.prepare(`INSERT INTO results (floor_no,call_id,wallet,bought_usd,sold_usd,pnl_usd,fee_pct,fee_usd,fee_claudeco,fee_paid,token_usd,settled_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(floorNo, callId, wallet, boughtUsd, soldUsd, pnl, FEE_PCT,
           Number(feeUsd.toFixed(4)), feeUnits.toString(), paid, tokenUsd, Date.now());
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    if (!/UNIQUE/i.test(String(e.message))) throw e;
    return { ok: false, error: "already settled" };
  }

  emit("result", { floorNo, callId, pnlUsd: pnl, feeUsd: Number(feeUsd.toFixed(4)),
    feeClaudeco: feeUnits.toString(), paid: Boolean(paid) });
  return { ok: true, boughtUsd, soldUsd, pnlUsd: pnl, feeUsd: Number(feeUsd.toFixed(4)),
           feeClaudeco: feeUnits.toString(), paid: Boolean(paid), tokenUsd,
           transfersIgnored: transfers.length };
}

/**
 * Fees settled but not covered by the balance at the time.
 *
 * An unpaid fee may gate NEW research. It must never gate an exit call: holding
 * someone in a position over a billing dispute would be indefensible, and the desk
 * publishes exits to everyone regardless of what they owe.
 */
export function feesOwed(wallet) {
  const rows = db.prepare("SELECT fee_claudeco, fee_usd FROM results WHERE wallet=? AND fee_paid=0 AND fee_usd>0").all(wallet);
  return {
    count: rows.length,
    baseUnits: rows.reduce((a, r) => a + BigInt(r.fee_claudeco || "0"), 0n).toString(),
    usd: Number(rows.reduce((a, r) => a + r.fee_usd, 0).toFixed(2)),
  };
}

/** Try again on fees that could not be covered when they settled. */
export async function collectOwed(wallet) {
  const { balanceOf } = await import("./leasing.js");
  const rows = db.prepare("SELECT id, fee_claudeco FROM results WHERE wallet=? AND fee_paid=0 AND fee_usd>0 ORDER BY id").all(wallet);
  let collected = 0;
  for (const r of rows) {
    const units = BigInt(r.fee_claudeco || "0");
    if (units <= 0n || balanceOf(wallet) < units) continue;
    db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)").run(wallet, units.toString(), Date.now());
    db.prepare("UPDATE results SET fee_paid=1 WHERE id=?").run(r.id);
    collected++;
  }
  return { collected, stillOwed: feesOwed(wallet) };
}

export function recordFor(floorNo) {
  const rows = db.prepare("SELECT * FROM results WHERE floor_no=? ORDER BY id DESC").all(floorNo);
  const wins = rows.filter((r) => r.pnl_usd > 0).length;
  const net = rows.reduce((a, r) => a + r.pnl_usd, 0);
  const fees = rows.reduce((a, r) => a + (r.fee_usd ?? 0), 0);
  const unpaid = rows.filter((r) => r.fee_usd > 0 && !r.fee_paid);
  return {
    settled: rows.length,
    wins, losses: rows.length - wins,
    winRate: rows.length ? Math.round((wins / rows.length) * 100) : null,
    netPnlUsd: Number(net.toFixed(2)),
    feesChargedUsd: Number(fees.toFixed(2)),
    feesUnpaidUsd: Number(unpaid.reduce((a, r) => a + r.fee_usd, 0).toFixed(2)),
    feePct: FEE_PCT,
    results: rows.slice(0, 20),
  };
}

/** The house record across every floor — computed from chain data, not self-reported. */
/**
 * Wilson score interval for a binomial proportion — the honest bounds on a hit
 * rate from a small sample. A raw 7/10 reads as 70%, but its Wilson lower bound
 * is about 40%: on ten trades you cannot distinguish a good desk from a lucky
 * one. Reporting the point estimate alone is how a run of luck gets sold as an
 * edge, so the record carries the interval and a claim gate beside it.
 */
export function wilson(wins, n, z = 1.96) {
  if (!n) return { low: null, high: null };
  const p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom),
  };
}

export function houseRecord() {
  // One house call is one forecast. Ten tenants copying it are execution samples,
  // not ten independent proofs that the signal worked.
  const rows = db.prepare(`SELECT call_id,
                                  AVG(pnl_usd) pnl_usd,
                                  AVG(100.0 * pnl_usd / NULLIF(bought_usd, 0)) return_pct,
                                  SUM(pnl_usd) total_pnl_usd
                           FROM results GROUP BY call_id`).all();
  const wins = rows.filter((r) => r.return_pct > 0).length;
  const n = rows.length;
  const w = wilson(wins, n);
  const pct = (x) => (x == null ? null : Math.round(x * 100));
  const returns = rows.map((r) => Number(r.return_pct)).filter(Number.isFinite);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const variance = returns.length > 1
    ? returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1) : null;
  const expectancyLow95 = variance != null ? mean - 1.96 * Math.sqrt(variance / returns.length) : null;
  const enough = n >= 100;
  const edgeClaimable = enough && w.low > 0.5 && expectancyLow95 > 0;
  return {
    settled: n, wins, losses: n - wins,
    winRate: n ? Math.round((wins / n) * 100) : null,
    // The research scorecard uses one representative result per call. Actual copied
    // dollars are retained separately so commercial activity is visible without
    // masquerading as extra statistical evidence.
    netPnlUsd: Number(rows.reduce((a, r) => a + Number(r.pnl_usd || 0), 0).toFixed(2)),
    tenantNetPnlUsd: Number(rows.reduce((a, r) => a + Number(r.total_pnl_usd || 0), 0).toFixed(2)),
    // Claim only when both hit rate and net expectancy clear their conservative
    // lower bounds on a frozen signal-level sample.
    hitRateLow: pct(w.low), hitRateHigh: pct(w.high),
    expectancyPct: mean == null ? null : Number(mean.toFixed(4)),
    expectancyLow95Pct: expectancyLow95 == null ? null : Number(expectancyLow95.toFixed(4)),
    edgeClaimable,
    edgeNote: !n ? "no settled trades — no edge may be claimed"
      : !enough ? `only ${n}/100 independent calls settled — too few to claim an edge`
      : w.low <= 0.5 ? `95% lower hit-rate bound is ${pct(w.low)}% — no edge demonstrated`
      : !(expectancyLow95 > 0) ? "95% lower net-expectancy bound has not cleared zero"
      : `hit rate ${pct(w.low)}–${pct(w.high)}% and net expectancy both clear zero at 95% confidence`,
  };
}


/* ── the server keeps its own books ─────────────────────────────────────────
 * Fills used to enter the ledger only when a floor's owner pressed Sync, so the
 * leaderboard was as fresh as each tenant's last visit. The server now walks
 * taken calls itself, round-robin so a big building spreads its RPC spend across
 * ticks instead of bursting. Wallets are read, never touched — same scan the
 * button runs, nobody's finger required. */
let syncCursor = 0;
export async function autoSyncAll({ maxFloors = 6, maxCallsPerFloor = 8 } = {}) {
  const floors = db.prepare(`
    SELECT DISTINCT d.floor_no, f.owner FROM deliveries d
    JOIN floors f ON f.n = d.floor_no AND f.state = 'owned' AND f.owner IS NOT NULL
    WHERE d.taken = 1
    ORDER BY d.floor_no`).all();
  if (!floors.length) return { floors: 0, fills: 0, settled: 0 };

  const picked = [];
  for (let i = 0; i < Math.min(maxFloors, floors.length); i++)
    picked.push(floors[(syncCursor + i) % floors.length]);
  syncCursor = (syncCursor + picked.length) % Math.max(1, floors.length);

  let fills = 0, settled = 0;
  for (const fl of picked) {
    const rows = db.prepare(`
      SELECT d.call_id, c.mint FROM deliveries d JOIN calls c ON c.id = d.call_id
      WHERE d.floor_no = ? AND d.taken = 1
      ORDER BY d.taken_at DESC LIMIT ?`).all(fl.floor_no, maxCallsPerFloor);
    for (const r of rows) {
      try {
        const sc = await scanFills({ floorNo: fl.floor_no, callId: r.call_id, wallet: fl.owner, mint: r.mint });
        if (sc.ok) fills += sc.fills ?? 0;
        const st = await settle({ floorNo: fl.floor_no, callId: r.call_id, wallet: fl.owner });
        if (st.ok) settled++;            // settle refuses open positions on its own
      } catch {}                          // one floor's RPC trouble must not stall the rest
    }
  }
  return { floors: picked.length, fills, settled };
}
