import db from "./lib/store.js";
import { canonicalAddress, canonicalTxHash, isEvmAddress, isEvmTxHash } from "./canonical.js";

/* A ROLLING BOARD, NOT A SNAPSHOT.
 *
 * Each sweep sees only what the launchpad happens to be trading in that two-minute window,
 * and a verified caller is about one callout in eighteen — so the tab showed five cards,
 * then one, then none, and read as broken when it was working. What the reader wants is
 * "who has called something recently", which is a question about the last few hours, not
 * about this instant. Every caller that clears the bar is kept here and the tab is drawn
 * from the window; a caller seen again updates in place rather than appearing twice.
 *
 * Durable, because Render restarts on every deploy and an in-memory board would empty
 * itself several times a day for reasons that have nothing to do with the market. */
db.exec(`
CREATE TABLE IF NOT EXISTS verified_callouts (
  mint          TEXT NOT NULL,
  caller        TEXT NOT NULL,
  symbol        TEXT,
  username      TEXT,
  text          TEXT,
  multiple      REAL,
  wallet_sol_usd REAL,                 -- the caller's gas-token holding in USD; ETH on this chain (column name kept for schema stability)
  callout_id    TEXT,
  url           TEXT,
  called_at     INTEGER,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (mint, caller)
);
CREATE INDEX IF NOT EXISTS idx_verified_callouts_seen ON verified_callouts(last_seen DESC);
`);

/** The window the board covers. A call older than this is history, not news. */
export const CALLOUT_BOARD_HOURS = Math.max(1, Math.min(168,
  Number(process.env.CALLOUT_BOARD_HOURS || 12) || 12));

/** Record what cleared the bar. Re-seeing a caller refreshes their balance and time. */
export function rememberVerifiedCallouts(rows, { now = Date.now() } = {}) {
  const write = db.prepare(`
    INSERT INTO verified_callouts
      (mint, caller, symbol, username, text, multiple, wallet_sol_usd, callout_id, url, called_at, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mint, caller) DO UPDATE SET
      symbol=excluded.symbol, username=excluded.username, text=excluded.text,
      multiple=excluded.multiple, wallet_sol_usd=excluded.wallet_sol_usd,
      url=excluded.url, called_at=excluded.called_at, last_seen=excluded.last_seen`);
  let kept = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.mint || !r?.user) continue;
    // walletEthUsd is the name on this chain; walletSolUsd is read for one release.
    const holdingUsd = r.walletEthUsd ?? r.walletSolUsd;
    try {
      write.run(canonicalAddress(r.mint), canonicalAddress(r.user), r.symbol ?? null, r.username ?? null,
        typeof r.text === "string" ? r.text.slice(0, 240) : null,
        Number.isFinite(Number(r.multiple)) ? Number(r.multiple) : null,
        Number.isFinite(Number(holdingUsd)) ? Number(holdingUsd) : null,
        r.id ?? null, r.url ?? null,
        Number.isFinite(Number(r.ts)) ? Number(r.ts) : null, now, now);
      kept++;
    } catch { /* one bad row never costs the sweep */ }
  }
  // Bounded: the window prunes by age, and this caps a pathological burst.
  try {
    db.prepare(`DELETE FROM verified_callouts WHERE last_seen < ?`)
      .run(now - CALLOUT_BOARD_HOURS * 3600e3);
    db.prepare(`DELETE FROM verified_callouts WHERE rowid NOT IN
      (SELECT rowid FROM verified_callouts ORDER BY last_seen DESC LIMIT 400)`).run();
  } catch { /* pruning is housekeeping, never a reason to fail a request */ }
  return kept;
}

/** The board: everything that cleared the bar inside the window, freshest first. */
export function verifiedCalloutBoard({ now = Date.now(), hours = CALLOUT_BOARD_HOURS, limit = 60 } = {}) {
  try {
    return db.prepare(`SELECT *, wallet_sol_usd AS wallet_eth_usd FROM verified_callouts WHERE last_seen >= ?
      ORDER BY last_seen DESC, wallet_sol_usd DESC LIMIT ?`)
      .all(now - hours * 3600e3, Math.max(1, Math.min(200, limit)));
  } catch { return []; }
}

/** The tape values a confirmed token inflow at the current market mark. It does not
 * reconstruct the wallet's original quote-token consideration, so the public contract
 * names that basis explicitly instead of calling it purchase USD. */
export const DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD = 500;

/* OWNER RULE (2026-09-03): the Callouts tab posts a call when the caller carries
 * pump.fun's own gold verification AND their wallet holds at least $1,000 of SOL.
 *
 * It replaces an earlier rule that also demanded confirmed pool-touching INFLOW worth
 * $2,500 at the current mark, matched to the caller's exact wallet. That bar is a much
 * harder thing to prove — it needs a signature scan per coin that frequently cannot
 * match, so the desk only ever attempted three coins a run and the tab stayed empty for
 * days. Measured 2026-09-03 across 70 pump.fun coins: 22 carried callouts, 146 callouts
 * from 143 distinct callers, 8 of them verified, and 6 of those 7 verified wallets held
 * more than $1,000 of SOL. The new rule is answerable with one balance read.
 *
 * What it claims is exactly what it measures: this caller is verified by pump.fun, and
 * this is what their wallet holds. It is NOT a claim that they bought this coin. */
const configuredCalloutWalletUsd = Number(process.env.CALLOUT_MIN_WALLET_USD || 1000);
export const CALLOUT_MIN_WALLET_USD = Number.isFinite(configuredCalloutWalletUsd) && configuredCalloutWalletUsd > 0
  ? configuredCalloutWalletUsd : 1000;

/* Retained for the whale TAPE, which still values matched inflow and keeps its own bar. */
const configuredCalloutWhaleUsd = Number(process.env.CALLOUT_WHALE_MIN_USD || 2500);
export const CALLOUT_WHALE_MIN_USD = Number.isFinite(configuredCalloutWhaleUsd) && configuredCalloutWhaleUsd > 0
  ? configuredCalloutWhaleUsd : 2500;

/**
 * Keep only pump.fun-verified callers whose own wallet clears the SOL bar.
 *
 * Pure. `walletUsdOf` answers what a wallet holds in dollars, or null when it could not
 * be read — and an unreadable balance is dropped rather than assumed, the same rule the
 * rest of the desk follows for a number it did not measure. Returns what it dropped and
 * why, so the tab can say "nothing cleared the bar" instead of going silently blank.
 */
export function verifiedHolderCallouts(rows, { minUsd = CALLOUT_MIN_WALLET_USD, walletUsdOf } = {}) {
  const bar = Number.isFinite(Number(minUsd)) && Number(minUsd) > 0 ? Number(minUsd) : CALLOUT_MIN_WALLET_USD;
  const read = typeof walletUsdOf === "function" ? walletUsdOf : () => null;
  const kept = [];
  let unverifiedHidden = 0, belowBarHidden = 0, unreadableHidden = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.verified !== true) { unverifiedHidden++; continue; }
    const wallet = typeof row.user === "string" ? row.user : null;
    /* Number(null) is 0, which would file every unreadable balance as "holds nothing"
       and hide a measurement failure inside an ordinary rejection. Read first, then
       decide whether there is a number at all. */
    const raw = wallet && isEvmAddress(wallet) ? read(canonicalAddress(wallet)) : undefined;
    const usd = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(usd)) { unreadableHidden++; continue; }
    if (usd < bar) { belowBarHidden++; continue; }
    // ETH is the gas token here; walletSolUsd rides along for one release as an alias.
    kept.push({ ...row, walletEthUsd: Math.round(usd), walletSolUsd: Math.round(usd) });
  }
  // Biggest holder first: on a tab that shows five, the wallet with the most at stake
  // is the one worth reading.
  kept.sort((a, b) => (b.walletEthUsd ?? 0) - (a.walletEthUsd ?? 0));
  return { rows: kept, unverifiedHidden, belowBarHidden, unreadableHidden, walletUsd: bar };
}

/** Keep only Pump.fun-verified authors whose matched inflow clears the whale bar.
 *  Pure; returns what it dropped and why, so the tab can say so instead of going blank. */
export function verifiedWhaleCallouts(rows, { minUsd = CALLOUT_WHALE_MIN_USD } = {}) {
  const bar = Number.isFinite(Number(minUsd)) && Number(minUsd) > 0 ? Number(minUsd) : CALLOUT_WHALE_MIN_USD;
  const kept = [];
  let unverifiedHidden = 0, belowWhaleHidden = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = Number(row?.matchedCurrentValueUsd);
    if (row?.verified !== true) { unverifiedHidden++; continue; }
    if (!Number.isFinite(value) || value < bar) { belowWhaleHidden++; continue; }
    kept.push(row);
  }
  return { rows: kept, unverifiedHidden, belowWhaleHidden, whaleUsd: bar };
}

const record = (value) => value && typeof value === "object" && !Array.isArray(value);

const finite = (value) => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const count = (value) => {
  const number = finite(value);
  return number != null && number >= 0 ? Math.floor(number) : null;
};

const jsonCopy = (value, fallback = null) => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : JSON.parse(encoded);
  } catch {
    return fallback;
  }
};

const httpsUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

/* A receipt is a transaction hash: 0x and 64 hex digits, lowercased so two spellings of
 * one transaction are one receipt. (The Solana build accepted an 80-90 char base58
 * signature here.) */
const signature = (value) => {
  if (typeof value !== "string") return null;
  const candidate = canonicalTxHash(value.trim());
  return isEvmTxHash(candidate) ? candidate : null;
};

const authorWallet = (callout) => {
  if (!record(callout)) return null;
  const wallet = callout.user ?? callout.wallet ?? callout.authorWallet ?? callout.author?.wallet;
  return isEvmAddress(wallet) ? canonicalAddress(wallet) : null;
};

const tradeWallet = (trade) => record(trade) && isEvmAddress(trade.wallet) ? canonicalAddress(trade.wallet) : null;

const timestamp = (value) => {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  return typeof value === "string" && value.trim() ? value : null;
};

const receiptFor = (trade) => {
  const sig = signature(trade.signature);
  const suppliedLink = httpsUrl(trade.link ?? trade.url ?? trade.txUrl);
  return {
    currentValueUsd: finite(trade.currentValueUsd ?? trade.usd),
    timestamp: timestamp(trade.at ?? trade.timestamp),
    signature: sig,
    // Blockscout is the human-facing explorer on 4663 (answers 403 to curl, 200 to a browser).
    link: suppliedLink ?? (sig ? `https://robinhoodchain.blockscout.com/tx/${sig}` : null),
    basis: "token-inflow-at-current-market-mark",
  };
};

/**
 * Join Pump.fun callout authors to the recent on-chain tape.
 *
 * A profile, username, badge, or impressive multiple is never evidence that the
 * author moved size. A row qualifies only when the author's exact, valid 0x wallet
 * owns at least one confirmed pool-touching token inflow whose value at the current
 * market mark clears `minUsd`. That is evidence of matched wallet activity, not proof
 * of original purchase consideration. The caller owns recency by supplying its recent
 * tape; this pure function does no network or clock reads and makes no identity guesses.
 *
 * The returned coin-level object is ready to serialize into the API. `callouts` is
 * largest matched buyer first and contains no unmatched chatter. Each row retains the
 * Pump.fun fields (including verified/profile/source) and adds the transactions which
 * made it eligible. Scan completeness and valuation basis ride beside the threshold so
 * a partial/current-mark approximation cannot be mistaken for a complete cost record.
 */
/** The launchpad-neutral name; the Pumpfun-named export below is kept for one release
 *  because office.js imports it by that name. Same function. */
export const evidenceBackedCallouts = (args) => evidenceBackedPumpfunCallouts(args);
export function evidenceBackedPumpfunCallouts({
  mint = null,
  callouts = [],
  trades = [],
  minUsd = DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD,
  partial = false,
  scanned = null,
  unread = null,
  failed = null,
} = {}) {
  const requestedThreshold = finite(minUsd);
  const thresholdUsd = requestedThreshold != null && requestedThreshold > 0
    ? requestedThreshold : DEFAULT_CALLOUT_CURRENT_VALUE_THRESHOLD_USD;
  const sourceCallouts = Array.isArray(callouts) ? callouts : [];
  const sourceTrades = Array.isArray(trades) ? trades : [];
  const receiptsByWallet = new Map();
  let qualifyingInflowRecords = 0;

  for (const trade of sourceTrades) {
    const wallet = tradeWallet(trade);
    const currentValueUsd = record(trade) ? finite(trade.currentValueUsd ?? trade.usd) : null;
    if (!wallet || trade.side !== "buy" ||
        trade.evidenceKind !== "pool_token_inflow_current_value" ||
        currentValueUsd == null || currentValueUsd < thresholdUsd) continue;
    const receipt = receiptFor(trade);
    receiptsByWallet.set(wallet, [...(receiptsByWallet.get(wallet) ?? []), receipt]);
    qualifyingInflowRecords++;
  }

  for (const receipts of receiptsByWallet.values()) {
    receipts.sort((a, b) => b.currentValueUsd - a.currentValueUsd);
  }

  const matched = [];
  const matchedWallets = new Set();
  for (let index = 0; index < sourceCallouts.length; index++) {
    const callout = sourceCallouts[index];
    const wallet = authorWallet(callout);
    const receipts = wallet ? receiptsByWallet.get(wallet) : null;
    if (!wallet || !receipts?.length) continue;

    const preserved = jsonCopy(callout, {});
    const matchedCurrentValueUsd = Number(
      receipts.reduce((sum, inflow) => sum + inflow.currentValueUsd, 0).toFixed(2),
    );
    matchedWallets.add(wallet);
    matched.push({
      ...preserved,
      // These fields are explicit and conservative even if malformed upstream data
      // attempted to put a different value into the JSON copy.
      user: wallet,
      verified: callout.verified === true,
      profile: jsonCopy(callout.profile, null),
      source: jsonCopy(callout.source, null),
      matchedCurrentValueUsd,
      // Compatibility for the former renderer. The canonical UI uses the explicit
      // current-value field and never labels this as original buy consideration.
      whaleUsd: matchedCurrentValueUsd,
      evidence: {
        kind: "recent_pool_token_inflow_current_value",
        thresholdUsd,
        matchedCurrentValueUsd,
        qualifyingInflowCount: receipts.length,
        inflows: jsonCopy(receipts, []),
        valueBasis: "token-inflow-at-current-market-mark",
        purchaseConsiderationProven: false,
      },
      _inputIndex: index,
    });
  }

  matched.sort((a, b) => b.matchedCurrentValueUsd - a.matchedCurrentValueUsd ||
    a._inputIndex - b._inputIndex);
  for (const callout of matched) delete callout._inputIndex;

  const scannedCount = count(scanned);
  const unreadCount = count(unread);
  const failedCount = count(failed);
  return {
    mint: typeof mint === "string" && mint ? mint : null,
    callouts: matched,
    evidence: {
      kind: "launchpad_callout_author_token_inflow_match",
      thresholdUsd,
      valueBasis: "token-inflow-at-current-market-mark",
      purchaseConsiderationProven: false,
      partial: partial === true || (unreadCount != null && unreadCount > 0) ||
        (failedCount != null && failedCount > 0),
      scanned: scannedCount,
      unread: unreadCount,
      failed: failedCount,
      tradeRecords: sourceTrades.length,
      qualifyingInflowRecords,
      matchedAuthors: matchedWallets.size,
    },
  };
}
