/**
 * PRE-DECISION CANDIDATE BOARD
 *
 * The market board exists before Claude/Grok/CEO judgement. Persisting that exact
 * shortlist lets tenants inspect what the desk considered without relabelling an
 * unapproved coin as a call. No model output or execution instruction lives here.
 */
import db from "./lib/store.js";
import { CAP_BANDS, COIN_TYPES } from "./categories.js";
import { canonicalAddress } from "./canonical.js";

// This is a product contract, not just a UI page size. The persisted snapshot is
// the five coins the desk actually had in each drawer before paid judgement began.
export const CANDIDATES_PER_CELL = 5;
const MIN_RETENTION_MS = 60_000;

db.exec(`
CREATE TABLE IF NOT EXISTS candidate_board_runs (
  cycle        TEXT PRIMARY KEY,
  captured_at  INTEGER NOT NULL,
  considered   INTEGER,
  off_board    INTEGER,
  cells_filled INTEGER,
  cells_total  INTEGER
);
CREATE TABLE IF NOT EXISTS candidate_board_candidates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle              TEXT NOT NULL,
  cap_band           TEXT NOT NULL,
  coin_type          TEXT NOT NULL,
  rank_in_cell        INTEGER NOT NULL,
  mint               TEXT NOT NULL,
  symbol             TEXT,
  name               TEXT,
  score              REAL,
  market_cap_usd     REAL,
  liquidity_usd      REAL,
  volume_24h_usd     REAL,
  buys_24h           INTEGER,
  sells_24h          INTEGER,
  price_change_h1    REAL,
  age_hours          REAL,
  launchpad          TEXT,
  rank_why           TEXT,
  image_url          TEXT,
  pair_url           TEXT,
  FOREIGN KEY (cycle) REFERENCES candidate_board_runs(cycle) ON DELETE CASCADE,
  UNIQUE(cycle, cap_band, coin_type, rank_in_cell)
);
CREATE INDEX IF NOT EXISTS idx_candidate_board_cycle
  ON candidate_board_candidates(cycle, coin_type, cap_band, rank_in_cell);
CREATE INDEX IF NOT EXISTS idx_candidate_board_captured
  ON candidate_board_runs(captured_at DESC);
`);

const finiteOrNull = (value) => {
  // Number(null) and Number("") are both zero. Treating missing market data as a
  // real zero would make the dashboard assert facts the sweep never observed.
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const integerOrNull = (value) => {
  const n = finiteOrNull(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
};

const textOrNull = (value, max) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

const httpsUrlOrNull = (value) => {
  const text = textOrNull(value, 2_048);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
};

const rankWhyJson = (value) => JSON.stringify(
  Array.isArray(value)
    ? value.filter((reason) => typeof reason === "string")
      .map((reason) => textOrNull(reason, 240)).filter(Boolean).slice(0, 12)
    : [],
);

/** Record the board exactly where it exists: after the free screen and before
 * any paid analyst, choosing seat, CEO, or Grok decision. */
export function recordCandidateBoard(cycle, board, {
  considered = null,
  capturedAt = Date.now(),
  retentionMs = 7 * 24 * 60 * 60 * 1000,
} = {}) {
  const cycleId = String(cycle ?? "").trim().slice(0, 160);
  if (!cycleId) throw new Error("candidate board cycle is required");
  if (!board || !Array.isArray(board.cells)) throw new Error("candidate board cells are required");
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0)
    throw new Error("candidate board capturedAt is invalid");

  const insertRun = db.prepare(`INSERT INTO candidate_board_runs
    (cycle,captured_at,considered,off_board,cells_filled,cells_total) VALUES (?,?,?,?,?,?)
    ON CONFLICT(cycle) DO UPDATE SET
      captured_at=excluded.captured_at,
      considered=excluded.considered,
      off_board=excluded.off_board,
      cells_filled=excluded.cells_filled,
      cells_total=excluded.cells_total`);
  const insertCoin = db.prepare(`INSERT INTO candidate_board_candidates
    (cycle,cap_band,coin_type,rank_in_cell,mint,symbol,name,score,market_cap_usd,
     liquidity_usd,volume_24h_usd,buys_24h,sells_24h,price_change_h1,age_hours,
     launchpad,rank_why,image_url,pair_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM candidate_board_candidates WHERE cycle=?").run(cycleId);
    insertRun.run(cycleId, capturedAt, integerOrNull(considered), integerOrNull(board.offBoard),
      integerOrNull(board.filled), integerOrNull(board.possible));
    const seenCells = new Set();
    for (const cell of board.cells) {
      if (!CAP_BANDS[cell?.band] || !COIN_TYPES[cell?.type] || !Array.isArray(cell.coins)) continue;
      const cellKey = `${cell.band}/${cell.type}`;
      // buildBoard emits each cell once. Rejecting a duplicate protects the unique
      // rank contract and makes a malformed snapshot fail atomically, not halfway.
      if (seenCells.has(cellKey)) throw new Error(`duplicate candidate board cell: ${cellKey}`);
      seenCells.add(cellKey);
      let rank = 0;
      for (const coin of cell.coins.slice(0, CANDIDATES_PER_CELL)) {
        // The `mint` column stays (schema stability); it holds a lowercase 0x address now.
        const mint = canonicalAddress(textOrNull(coin?.mint, 64));
        if (!mint) continue;
        rank++;
        const pair = coin.pair ?? {};
        const tx = pair.txns?.h24 ?? {};
        insertCoin.run(
          cycleId, cell.band, cell.type, rank,
          mint, textOrNull(pair.baseSymbol ?? coin.symbol, 32),
          textOrNull(pair.baseName ?? coin.name, 160), finiteOrNull(coin.score),
          finiteOrNull(pair.marketCap ?? pair.fdv), finiteOrNull(pair.liquidityUsd),
          finiteOrNull(pair.volume?.h24), integerOrNull(tx.buys), integerOrNull(tx.sells),
          finiteOrNull(pair.priceChange?.h1), finiteOrNull(pair.ageHours),
          textOrNull(coin.launchpad, 64), rankWhyJson(coin.rankWhy),
          httpsUrlOrNull(pair.imageUrl), httpsUrlOrNull(pair.url),
        );
        inserted++;
      }
    }
    const retention = finiteOrNull(retentionMs);
    const cutoff = capturedAt - Math.max(MIN_RETENTION_MS, retention ?? 0);
    db.prepare("DELETE FROM candidate_board_runs WHERE captured_at < ?").run(cutoff);
    // Some SQLite builds do not cascade unless foreign_keys is enabled.
    db.prepare(`DELETE FROM candidate_board_candidates
      WHERE cycle NOT IN (SELECT cycle FROM candidate_board_runs)`).run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { cycle: cycleId, capturedAt, inserted };
}

/** Latest board, grouped into every market-cap drawer so an empty tier remains
 * visible as a market finding instead of disappearing from the UI. */
export function latestCandidateBoard({ coinType = "memecoin", perBand = 5 } = {}) {
  const requestedType = String(coinType ?? "");
  if (!COIN_TYPES[requestedType]) throw new Error(`unknown candidate coin type: ${requestedType}`);
  const run = db.prepare(`SELECT cycle,captured_at,considered,off_board,cells_filled,cells_total
    FROM candidate_board_runs ORDER BY captured_at DESC, cycle DESC LIMIT 1`).get();
  const bands = Object.fromEntries(Object.entries(CAP_BANDS).map(([key, value]) => [key, {
    key, label: value.label, lo: value.lo, hi: value.hi, note: value.note, candidates: [],
  }]));
  if (!run) return {
    capturedAt: null, cycle: null, source: "pre-decision", decisionStatus: "not-reviewed",
    coinType: requestedType, candidateCount: 0, bands,
  };

  const requestedCap = integerOrNull(perBand);
  const cap = Math.min(CANDIDATES_PER_CELL, Math.max(1, requestedCap || CANDIDATES_PER_CELL));
  const rows = db.prepare(`SELECT cap_band,rank_in_cell,mint,symbol,name,score,market_cap_usd,
      liquidity_usd,volume_24h_usd,buys_24h,sells_24h,price_change_h1,age_hours,
      launchpad,rank_why,image_url,pair_url
    FROM candidate_board_candidates
    WHERE cycle=? AND coin_type=? AND rank_in_cell<=?
    ORDER BY cap_band,rank_in_cell`).all(run.cycle, requestedType, cap);
  for (const row of rows) {
    if (!bands[row.cap_band]) continue;
    let rankWhy = [];
    try { rankWhy = JSON.parse(row.rank_why || "[]"); } catch {}
    bands[row.cap_band].candidates.push({
      rank: row.rank_in_cell, mint: row.mint, symbol: row.symbol, name: row.name,
      score: row.score, marketCapUsd: row.market_cap_usd, liquidityUsd: row.liquidity_usd,
      volume24hUsd: row.volume_24h_usd, buys24h: row.buys_24h, sells24h: row.sells_24h,
      priceChangeH1: row.price_change_h1, ageHours: row.age_hours,
      launchpad: row.launchpad, rankWhy, imageUrl: row.image_url, pairUrl: row.pair_url,
    });
  }
  return {
    cycle: run.cycle, capturedAt: run.captured_at, source: "pre-decision",
    decisionStatus: "not-reviewed", coinType: requestedType, candidateCount: rows.length,
    considered: run.considered, offBoard: run.off_board,
    cellsFilled: run.cells_filled, cellsTotal: run.cells_total,
    bands,
  };
}
