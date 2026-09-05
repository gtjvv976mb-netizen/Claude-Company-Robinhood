import db, { ensureColumn } from "./lib/store.js";
import { cfg } from "./config.js";
import { leaveOneOut } from "./agents/composite.js";
import { runContext } from "./lib/bus.js";
/* The cycle budget is ONE number, owned by llm.js. This file used to read the env with
 * its own default (8) while llm.js paced against a different one (4) — so the recorded
 * behaviour profile could disagree with the brake that actually ran. One export. */
import { CYCLE_BUDGET_USD } from "./lib/llm.js";
import { canonicalJson, decisionManifest, deployedCommit, sha256 } from "./provenance.js";
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "../executor/trade-policy.mjs";
export { POLICY_VERSION } from "../executor/trade-policy.mjs";

export const EVALUATION_VERSION = "2026-09-01.2";
export const PROMPT_VERSION = "desk-2026-08-31";
export const HORIZONS_MIN = [15, 60, 360, 1440, 2880];

db.exec(`
CREATE TABLE IF NOT EXISTS decision_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key            TEXT NOT NULL UNIQUE,
  cycle              TEXT NOT NULL,
  mint               TEXT NOT NULL,
  symbol             TEXT,
  floor_no           INTEGER,
  evidence_scope     TEXT NOT NULL DEFAULT 'unattributed',
  run_kind           TEXT NOT NULL DEFAULT 'workup',
  decided_at         INTEGER NOT NULL,
  entry_price        REAL,
  round_trip_cost_pct REAL,
  size_usd           REAL,
  outcome            TEXT,
  final_decision     TEXT,
  binding_gate       TEXT,
  raw_redteam        TEXT,
  effective_redteam  TEXT,
  redteam_binding    INTEGER NOT NULL DEFAULT 0,
  evaluation_version TEXT NOT NULL,
  policy_version     TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  prompt_manifest_hash TEXT,
  behavior_fingerprint TEXT,
  behavior_profile_json TEXT,
  source_commit      TEXT,
  models_json        TEXT NOT NULL,
  config_json        TEXT NOT NULL,
  weights_json       TEXT NOT NULL,
  attribution_json   TEXT,
  published_call_id  INTEGER,
  record_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_runs_mint ON decision_runs(mint, decided_at);

CREATE TABLE IF NOT EXISTS forward_marks (
  run_id          INTEGER NOT NULL REFERENCES decision_runs(id),
  horizon_min     INTEGER NOT NULL,
  due_at          INTEGER NOT NULL,
  observed_at     INTEGER,
  price_mid       REAL,
  liquidity_usd   REAL,
  mark_method     TEXT,
  mark_delay_ms   INTEGER,
  gross_return_pct REAL,
  net_return_pct  REAL,
  mae_pct         REAL,
  mfe_pct         REAL,
  data_status     TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (run_id, horizon_min)
);
CREATE INDEX IF NOT EXISTS idx_forward_marks_due ON forward_marks(data_status, due_at);

CREATE TABLE IF NOT EXISTS simulated_outcomes (
  run_id          INTEGER PRIMARY KEY REFERENCES decision_runs(id),
  policy_version  TEXT NOT NULL,
  observed_at     INTEGER,
  exit_price      REAL,
  exit_reason     TEXT,
  gross_return_pct REAL,
  net_return_pct  REAL,
  pnl_usd         REAL,
  mae_pct         REAL,
  mfe_pct         REAL,
  data_status     TEXT NOT NULL
);
`);

// These are cheap forward-only migrations if an evaluation database was created by
// an earlier pre-release build.
ensureColumn("decision_runs", "run_kind", "TEXT NOT NULL DEFAULT 'workup'");
ensureColumn("decision_runs", "floor_no", "INTEGER");
// A NULL floor on a historical row does not prove that it came from the house. Keep
// pre-migration rows explicitly unattributed and out of scoped evidence.
ensureColumn("decision_runs", "evidence_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
ensureColumn("decision_runs", "prompt_version", `TEXT NOT NULL DEFAULT '${PROMPT_VERSION}'`);
ensureColumn("decision_runs", "prompt_manifest_hash", "TEXT");
ensureColumn("decision_runs", "behavior_fingerprint", "TEXT");
ensureColumn("decision_runs", "behavior_profile_json", "TEXT");
ensureColumn("decision_runs", "source_commit", "TEXT");
ensureColumn("decision_runs", "models_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("decision_runs", "config_json", "TEXT NOT NULL DEFAULT '{}'");
// Publication happens after a decision is recorded. This forward-only link makes the
// measured strategy the exact cohort that reached the call sheet, including mandate
// selections below CEO APPROVED, without rewriting the immutable decision payload.
ensureColumn("decision_runs", "published_call_id", "INTEGER");
ensureColumn("forward_marks", "liquidity_usd", "REAL");
ensureColumn("forward_marks", "mark_method", "TEXT");
ensureColumn("forward_marks", "mark_delay_ms", "INTEGER");
db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_runs_provenance
         ON decision_runs(evidence_scope,floor_no,prompt_manifest_hash,evaluation_version,policy_version,decided_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_runs_behavior
         ON decision_runs(evidence_scope,behavior_fingerprint,evaluation_version,policy_version,
                          prompt_manifest_hash,final_decision,run_kind,floor_no,decided_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_runs_publication
         ON decision_runs(evidence_scope,behavior_fingerprint,published_call_id,
                          evaluation_version,policy_version,run_kind,decided_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_forward_marks_evaluation
         ON forward_marks(horizon_min,due_at,data_status,run_id)`);

export const evidenceScopeFor = (floorNo) =>
  floorNo == null || Number(floorNo) === 50 ? "house" : "tenant";

const recordedConfig = () => ({
  equityUsd: cfg.equityUsd,
  maxRiskPct: cfg.maxRiskPct,
  maxBookRiskPct: cfg.maxBookRiskPct,
  maxCandidates: cfg.maxCandidates,
  targetSizeUsd: cfg.targetSizeUsd,
  maxRoundTripSlippagePct: cfg.maxRoundTripSlippagePct,
  screen: cfg.screen,
  dailyBudgetUsd: cfg.dailyBudgetUsd,
});

const endpointOrigin = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "invalid-custom-endpoint";
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "invalid-custom-endpoint";
  }
};

/** Secret-free runtime identity for a comparable decision cohort. Source files alone
 * are insufficient because production environment overrides, model selection, lane,
 * and runtime versions can change behavior without changing a prompt file. */
export function runtimeBehaviorProfile({ runKind = "cycle", pmProvider = "claude" } = {}) {
  const manifest = decisionManifest();
  return {
    decisionManifestHash: manifest.hash,
    evaluationVersion: EVALUATION_VERSION,
    policyVersion: POLICY_VERSION,
    promptVersion: PROMPT_VERSION,
    nodeVersion: process.versions.node,
    runKind,
    pmProvider,
    config: recordedConfig(),
    weights: cfg.weights,
    models: {
      ...cfg.models,
      ceo: process.env.DESK_MODEL_CEO || "claude-opus-5",
      review: process.env.DESK_MODEL_REVIEW || "claude-sonnet-5",
      grok: process.env.DESK_MODEL_GROK || "grok-4.6",
    },
    effort: cfg.effort,
    runtimeKnobs: {
      opportunisticShare: Number(process.env.DESK_OPPORTUNISTIC_SHARE || 0.55),
      hourlyBurst: Number(process.env.DESK_HOURLY_BURST || 3),
      takeProfitX: Number(process.env.DESK_TAKE_PROFIT_X || POLICY_DEFAULTS.takeProfitX),
      maxAgeHours: Number(process.env.DESK_MAX_AGE_HOURS || POLICY_DEFAULTS.maxAgeHours),
      trailPct: Number(process.env.DESK_TRAIL_PCT || POLICY_DEFAULTS.trailPct),
      workupsPerCycle: Number(process.env.PENTHOUSE_WORKUPS || 8),
      cycleBudgetUsd: CYCLE_BUDGET_USD,
      topN: Number(process.env.PENTHOUSE_TOP_N || 5),
      perCell: Number(process.env.PENTHOUSE_PER_CELL || 5),
      padQuota: Math.min(1, Math.max(0, Number(process.env.PENTHOUSE_PAD_QUOTA || 0.6))),
      whaleBudgetMs: Number(process.env.PENTHOUSE_WHALE_BUDGET_MS || 45_000),
      mustCall: process.env.PENTHOUSE_MUST_CALL !== "0",
      huntBudgetMs: Number(process.env.PENTHOUSE_HUNT_BUDGET_MS || 240_000),
      huntMax: Number(process.env.PENTHOUSE_HUNT_MAX || 12),
      maxLiveCalls: Math.max(1, Number(process.env.PENTHOUSE_MAX_LIVE_CALLS || 6)),
      sequential: process.env.PENTHOUSE_SEQUENTIAL !== "0",
      thesisHalfLifeHours: Number(process.env.THESIS_HALFLIFE_HOURS || 12),
      funnelScreenTtlMin: Number(process.env.FUNNEL_SCREEN_TTL_MIN || 12),
      funnelStudyTtlMin: Number(process.env.FUNNEL_STUDY_TTL_MIN || 40),
      funnelUnseenDropMin: Number(process.env.FUNNEL_UNSEEN_DROP_MIN || 25),
      funnelRestaleMovePct: Number(process.env.FUNNEL_RESTALE_MOVE_PCT || 20),
      trendHuntTtlMin: Number(process.env.TREND_HUNT_TTL_MINS || 90),
      watchHoldsToPromote: Math.max(1, Number(process.env.WATCH_HOLDS_TO_PROMOTE || 1)),
      whaleMinUsd: Number(process.env.WHALE_MIN_USD || 500),
      prepareTransaction: process.env.DESK_PREPARE_TX === "1",
      walletConfigured: Boolean(process.env.DESK_WALLET_PUBKEY),
      /* The RPC named in the contract: RH_RPC (default rpc.mainnet.chain.robinhood.com),
       * with RH_RPC_SECONDARY as an optional second provider. A SOLANA_RPC in the
       * environment is not a fingerprint of this desk's behaviour and is not read. */
      customRpc: Boolean(process.env.RH_RPC),
      rpcOrigin: endpointOrigin(process.env.RH_RPC),
      secondaryRpc: Boolean(process.env.RH_RPC_SECONDARY),
      secondaryRpcOrigin: endpointOrigin(process.env.RH_RPC_SECONDARY),
      birdeyeEnabled: Boolean(process.env.BIRDEYE_API_KEY),
      xaiEnabled: Boolean(process.env.XAI_API_KEY),
      customXaiBase: Boolean(process.env.XAI_BASE_URL),
      xaiOrigin: endpointOrigin(process.env.XAI_BASE_URL),
    },
  };
}

export const runtimeBehaviorFingerprint = (options = {}) =>
  sha256(canonicalJson(runtimeBehaviorProfile(options)));

function gateFor(rec) {
  if (!rec) return "missing_record";
  if (rec.outcome === "no_data" || rec.outcome === "screened_out" || rec.outcome === "insufficient_coverage") return rec.outcome;
  if (rec.outcome === "killed") return `analyst:${rec.killedBy || "unknown"}`;
  if (rec.compliance?.pass === false) return "compliance";
  if (rec.redteam?.verdict === "refuted" && rec.pm?.decision !== "PROPOSE") return "redteam";
  if (rec.pm?.decision === "PASS") return "pm";
  if (rec.finalDecision === "DECLINED") return "ceo";
  return rec.finalDecision || rec.pm?.decision || rec.outcome || "unknown";
}

/** Immutable signal-level journal. One research run remains one observation no matter
 * how many tenants later copy it. */
export function recordDecision(cycle, rec, now = Date.now()) {
  if (!rec?.mint) return null;
  const runKey = `${cycle}:${rec.mint}`;
  const context = runContext.getStore();
  const floorNo = context?.floor ?? null;
  const evidenceScope = context?.evidenceScope ?? evidenceScopeFor(floorNo);
  const promptManifestHash = decisionManifest().hash;
  const behaviorProfile = runtimeBehaviorProfile({
    runKind: rec.runKind ?? rec.hook ?? "workup",
    pmProvider: rec.pmProvider ?? "claude",
  });
  const behaviorFingerprint = sha256(canonicalJson(behaviorProfile));
  const sourceCommit = deployedCommit();
  const rawRt = rec.redteamRaw?.verdict ?? rec.redteam?.downgraded_from ?? rec.redteam?.verdict ?? null;
  const effectiveRt = rec.redteam?.verdict ?? null;
  const gate = gateFor(rec);
  const attr = leaveOneOut(rec.analysts || {});
  const info = db.prepare(`INSERT OR IGNORE INTO decision_runs
    (run_key,cycle,mint,symbol,floor_no,evidence_scope,run_kind,decided_at,entry_price,round_trip_cost_pct,size_usd,outcome,
     final_decision,binding_gate,raw_redteam,effective_redteam,redteam_binding,
     evaluation_version,policy_version,prompt_version,prompt_manifest_hash,behavior_fingerprint,
     behavior_profile_json,source_commit,models_json,config_json,
     weights_json,attribution_json,record_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runKey, cycle, rec.mint, rec.symbol ?? rec.ev?.symbol ?? null,
      floorNo, evidenceScope, rec.runKind ?? rec.hook ?? "workup", now,
      rec.ev?.pair?.priceUsd ?? null, rec.ev?.exitProbe?.roundTripLossPct ?? null,
      rec.order?.size ?? rec.ceo?.order_size_usd ?? rec.risk?.position_size_usd ?? null,
      rec.outcome ?? null, rec.finalDecision ?? null, gate, rawRt, effectiveRt,
      gate === "redteam" ? 1 : 0, EVALUATION_VERSION, POLICY_VERSION, PROMPT_VERSION,
      promptManifestHash, behaviorFingerprint, JSON.stringify(behaviorProfile), sourceCommit,
      JSON.stringify(cfg.models), JSON.stringify(recordedConfig()),
      JSON.stringify(cfg.weights), JSON.stringify(attr), JSON.stringify(rec));
  const row = db.prepare("SELECT id, entry_price FROM decision_runs WHERE run_key=?").get(runKey);
  if (!row) return null;
  for (const h of HORIZONS_MIN) {
    db.prepare(`INSERT OR IGNORE INTO forward_marks (run_id,horizon_min,due_at)
                VALUES (?,?,?)`).run(row.id, h, now + h * 60000);
  }
  return row.id;
}

/** Bind a successfully opened call to the immutable decision that produced it.
 *
 * The call is created first because a duplicate/full book must not label a decision as
 * published. The update is idempotent for the same call and refuses cross-floor links.
 * A false return is retained as an explicit provenance warning by the publisher; it
 * never silently admits an unlinked row into the strategy scorecard. */
export function linkPublishedCall(runId, callId, { floorNo = null } = {}) {
  const decisionId = Number(runId);
  const publishedCallId = Number(callId);
  if (!Number.isInteger(decisionId) || decisionId <= 0 ||
      !Number.isInteger(publishedCallId) || publishedCallId <= 0) return false;
  const row = db.prepare(`SELECT floor_no,evidence_scope,published_call_id
                          FROM decision_runs WHERE id=?`).get(decisionId);
  if (!row) return false;
  const expectedScope = evidenceScopeFor(floorNo);
  if (row.evidence_scope !== expectedScope) return false;
  if (expectedScope === "tenant" && Number(row.floor_no) !== Number(floorNo)) return false;
  if (expectedScope === "house" && floorNo != null && Number(floorNo) === 50 &&
      Number(row.floor_no) !== 50) return false;
  if (row.published_call_id != null) return Number(row.published_call_id) === publishedCallId;
  const result = db.prepare(`UPDATE decision_runs SET published_call_id=?
                             WHERE id=? AND (published_call_id IS NULL OR published_call_id=?)`)
    .run(publishedCallId, decisionId, publishedCallId);
  return result.changes === 1;
}

export const FORWARD_MARK_TOLERANCE_MS = 15 * 60_000;

/** Called by each free market sweep. A horizon is graded from the nearest persisted
 * observation around its due time—not from whichever much-later price happens to be
 * live after a restart. We wait through the full tolerance window before choosing. */
export function refreshForwardMarks(_universe, now = Date.now()) {
  const due = db.prepare(`SELECT m.*, r.mint, r.entry_price, r.round_trip_cost_pct, r.decided_at
                          FROM forward_marks m JOIN decision_runs r ON r.id=m.run_id
                          WHERE m.data_status='pending' AND m.due_at<=?
                          ORDER BY m.due_at LIMIT 500`).all(now);
  let marked = 0, unavailable = 0, waiting = 0;
  for (const m of due) {
    if (now < m.due_at + FORWARD_MARK_TOLERANCE_MS) { waiting++; continue; }
    let point = null;
    try {
      point = db.prepare(`SELECT ts,price,liq FROM snapshots
        WHERE mint=? AND ts>=? AND ts<=? AND price>0
        ORDER BY ts ASC LIMIT 1`).get(
          m.mint, m.due_at, m.due_at + FORWARD_MARK_TOLERANCE_MS) ?? null;
    } catch { /* snapshot storage may not be initialized in an isolated unit test */ }
    const px = point?.price ?? null;
    if (!(px > 0) || !(m.entry_price > 0)) {
      db.prepare(`UPDATE forward_marks SET observed_at=?,data_status='unavailable'
                  WHERE run_id=? AND horizon_min=? AND data_status='pending'`)
        .run(now, m.run_id, m.horizon_min);
      unavailable++;
      continue;
    }
    const gross = ((px - m.entry_price) / m.entry_price) * 100;
    const net = gross - Math.max(0, Number(m.round_trip_cost_pct) || 0);
    let lo = null, hi = null;
    try {
      const range = db.prepare(`SELECT MIN(price) lo, MAX(price) hi FROM snapshots
                                WHERE mint=? AND ts>=? AND ts<=? AND price>0`)
        .get(m.mint, m.decided_at, point.ts);
      lo = range?.lo; hi = range?.hi;
    } catch {}
    const mae = lo > 0 ? ((lo - m.entry_price) / m.entry_price) * 100 : null;
    const mfe = hi > 0 ? ((hi - m.entry_price) / m.entry_price) * 100 : null;
    db.prepare(`UPDATE forward_marks SET observed_at=?,price_mid=?,liquidity_usd=?,mark_method=?,mark_delay_ms=?,
                gross_return_pct=?,net_return_pct=?,mae_pct=?,mfe_pct=?,data_status='observed'
                WHERE run_id=? AND horizon_min=? AND data_status='pending'`)
      .run(point.ts, px, point.liq ?? null, "nearest_persisted_snapshot",
        Math.abs(point.ts - m.due_at), gross, net, mae, mfe,
        m.run_id, m.horizon_min);
    marked++;
  }
  return { due: due.length, marked, unavailable, waiting, replay: refreshSimulatedOutcomes(now) };
}

/** Replay the exact versioned server/executor policy over observations that arrived
 * after the decision. This grades refusals as counterfactuals in the same units as
 * approvals and never manufactures an exit when the token disappeared. */
export function refreshSimulatedOutcomes(now = Date.now()) {
  const pending = db.prepare(`SELECT r.* FROM decision_runs r
    LEFT JOIN simulated_outcomes o ON o.run_id=r.id
    WHERE o.run_id IS NULL AND r.policy_version=? ORDER BY r.id LIMIT 500`).all(POLICY_VERSION);
  const insert = db.prepare(`INSERT OR IGNORE INTO simulated_outcomes
    (run_id,policy_version,observed_at,exit_price,exit_reason,gross_return_pct,
     net_return_pct,pnl_usd,mae_pct,mfe_pct,data_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let observed = 0, unavailable = 0, waiting = 0;

  for (const run of pending) {
    if (!(run.entry_price > 0)) {
      insert.run(run.id, POLICY_VERSION, now, null, "no entry mark", null, null, null, null, null, "unavailable");
      unavailable++;
      continue;
    }
    let rec = null;
    try { rec = JSON.parse(run.record_json); } catch {}
    const stop = Number(rec?.ticket?.stop_price ?? rec?.risk?.stop_price);
    const target = Number(rec?.ticket?.take_profit?.[0]?.price);
    if (!(stop > 0) || stop >= run.entry_price) {
      insert.run(run.id, POLICY_VERSION, now, null, "no replayable stop", null, null, null, null, null, "unmanageable");
      unavailable++;
      continue;
    }
    let points = [];
    try {
      points = db.prepare(`SELECT ts,price FROM snapshots
        WHERE mint=? AND ts>=? AND price>0 ORDER BY ts`).all(run.mint, run.decided_at);
    } catch { /* the snapshot module may not have initialized yet */ }
    if (!points.length) {
      if (now >= run.decided_at + (POLICY_DEFAULTS.maxAgeHours + 6) * 3600e3) {
        insert.run(run.id, POLICY_VERSION, now, null, "no post-decision observations",
          null, null, null, null, null, "unavailable");
        unavailable++;
      } else waiting++;
      continue;
    }

    let position = { entry: run.entry_price, stop, target: target > 0 ? target : null,
      high: run.entry_price, openedAtMs: run.decided_at };
    let lo = run.entry_price, hi = run.entry_price, outcome = null;
    for (const point of points) {
      lo = Math.min(lo, point.price); hi = Math.max(hi, point.price);
      const d = pricePolicy({ position, mark: point.price, nowMs: point.ts });
      position = d.position;
      if (d.action === "sell") { outcome = { ...d, point }; break; }
    }
    if (!outcome) {
      const last = points[points.length - 1];
      if (now >= run.decided_at + (POLICY_DEFAULTS.maxAgeHours + 6) * 3600e3 &&
          last.ts < run.decided_at + POLICY_DEFAULTS.maxAgeHours * 3600e3) {
        insert.run(run.id, POLICY_VERSION, now, null, "observations ended before policy expiry",
          null, null, null,
          ((lo - run.entry_price) / run.entry_price) * 100,
          ((hi - run.entry_price) / run.entry_price) * 100, "unavailable");
        unavailable++;
      } else waiting++;
      continue;
    }

    const gross = ((outcome.point.price - run.entry_price) / run.entry_price) * 100;
    const net = gross - Math.max(0, Number(run.round_trip_cost_pct) || 0);
    const pnl = Number(run.size_usd) > 0 ? Number(run.size_usd) * net / 100 : null;
    insert.run(run.id, POLICY_VERSION, outcome.point.ts, outcome.point.price, outcome.reason,
      gross, net, pnl,
      ((lo - run.entry_price) / run.entry_price) * 100,
      ((hi - run.entry_price) / run.entry_price) * 100, "observed");
    observed++;
  }
  return { pending: pending.length, observed, unavailable, waiting };
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export function evaluationSummary({ horizonMin = 1440, minSignals = 100,
  minResolvedCoveragePct = 80, nowMs = Date.now(), floorNo = undefined,
  evidenceScope = undefined, promptManifestHash = undefined,
  evaluationVersion = undefined, policyVersion = undefined,
  behaviorFingerprint = undefined, decisionCohort = "all" } = {}) {
  const addRunScope = (filters, args) => {
    if (evidenceScope != null) {
      if (!["house", "tenant", "unattributed"].includes(evidenceScope)) {
        throw new Error(`invalid evidence scope: ${evidenceScope}`);
      }
      filters.push("r.evidence_scope=?");
      args.push(evidenceScope);
    }
    if (floorNo === null) filters.push("r.floor_no IS NULL");
    else if (Number.isInteger(floorNo)) { filters.push("r.floor_no=?"); args.push(floorNo); }
    if (promptManifestHash != null) {
      filters.push("r.prompt_manifest_hash=?");
      args.push(promptManifestHash);
    }
    if (evaluationVersion != null) {
      filters.push("r.evaluation_version=?");
      args.push(evaluationVersion);
    }
    if (policyVersion != null) {
      filters.push("r.policy_version=?");
      args.push(policyVersion);
    }
    if (behaviorFingerprint != null) {
      filters.push("r.behavior_fingerprint=?");
      args.push(behaviorFingerprint);
    }
    if (decisionCohort === "approved") filters.push("r.final_decision='APPROVED'");
    else if (decisionCohort === "not-approved") filters.push("COALESCE(r.final_decision,'')<>'APPROVED'");
    else if (decisionCohort === "published") filters.push("r.published_call_id IS NOT NULL");
    else if (decisionCohort === "not-published") filters.push("r.published_call_id IS NULL");
    else if (decisionCohort !== "all") throw new Error(`invalid decision cohort: ${decisionCohort}`);
  };

  const eligibleThrough = nowMs - FORWARD_MARK_TOLERANCE_MS;
  const filters = ["m.horizon_min=?", "m.due_at<=?", "m.data_status='observed'"];
  const args = [horizonMin, eligibleThrough];
  addRunScope(filters, args);
  const rows = db.prepare(`SELECT r.mint,r.redteam_binding,m.net_return_pct,m.mae_pct,m.mfe_pct
                           FROM decision_runs r JOIN forward_marks m ON m.run_id=r.id
                           WHERE ${filters.join(" AND ")}`)
    .all(...args);
  const coverageFilters = ["m.horizon_min=?", "m.due_at<=?"];
  const coverageArgs = [horizonMin, eligibleThrough];
  addRunScope(coverageFilters, coverageArgs);
  const coverageRows = db.prepare(`SELECT m.data_status status,COUNT(*) count
    FROM forward_marks m JOIN decision_runs r ON r.id=m.run_id
    WHERE ${coverageFilters.join(" AND ")}
    GROUP BY m.data_status ORDER BY m.data_status`).all(...coverageArgs);
  const coverageByStatus = Object.fromEntries(coverageRows.map((row) =>
    [row.status, Number(row.count || 0)]));
  const dueMarks = coverageRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const observedMarks = coverageByStatus.observed || 0;
  const resolvedCoveragePct = dueMarks
    ? Number((observedMarks / dueMarks * 100).toFixed(1)) : null;
  const returns = rows.map((r) => r.net_return_pct).filter(Number.isFinite);
  const distinctMints = new Set(rows.map((row) => row.mint)).size;
  // Multiple runs on one asset share market path and are not independent samples. Use
  // one mean per mint for expectancy and its confidence interval; keep raw signal count
  // only as descriptive throughput.
  const byMint = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.net_return_pct)) continue;
    const values = byMint.get(row.mint) || [];
    values.push(row.net_return_pct);
    byMint.set(row.mint, values);
  }
  const independentReturns = [...byMint.values()].map(mean);
  const avg = mean(independentReturns);
  const variance = independentReturns.length > 1
    ? independentReturns.reduce((s, x) => s + (x - avg) ** 2, 0) /
      (independentReturns.length - 1) : null;
  const se = variance != null ? Math.sqrt(variance / independentReturns.length) : null;
  const expectancyLow95 = se != null ? avg - 1.96 * se : null;
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x <= 0);
  const grossWins = wins.reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
  const rtRows = rows.filter((r) => r.redteam_binding);
  const prevented = rtRows.reduce((s, r) => s + Math.max(0, -r.net_return_pct), 0);
  const killed = rtRows.reduce((s, r) => s + Math.max(0, r.net_return_pct), 0);
  const replayFilters = ["o.data_status='observed'", "o.policy_version=?"];
  const replayArgs = [policyVersion || POLICY_VERSION];
  addRunScope(replayFilters, replayArgs);
  const replayRows = db.prepare(`SELECT r.redteam_binding,o.net_return_pct,o.mae_pct,o.mfe_pct
    FROM simulated_outcomes o JOIN decision_runs r ON r.id=o.run_id
    WHERE ${replayFilters.join(" AND ")}`).all(...replayArgs);
  const replayReturns = replayRows.map((r) => r.net_return_pct).filter(Number.isFinite);
  const replayRt = replayRows.filter((r) => r.redteam_binding);
  const replayPrevented = replayRt.reduce((s, r) => s + Math.max(0, -r.net_return_pct), 0);
  const replayKilled = replayRt.reduce((s, r) => s + Math.max(0, r.net_return_pct), 0);

  const sampleGateMet = returns.length >= minSignals && distinctMints >= minSignals &&
    resolvedCoveragePct != null && resolvedCoveragePct >= minResolvedCoveragePct;

  return {
    horizonMin, cohort: decisionCohort, signals: returns.length, distinctMints,
    wins: wins.length, losses: losses.length,
    dueMarks, observedMarks, resolvedCoveragePct,
    marksByStatus: coverageRows.map((row) => ({ status: row.status, count: Number(row.count) })),
    hitRatePct: returns.length ? Number((wins.length / returns.length * 100).toFixed(1)) : null,
    expectancyPct: avg == null ? null : Number(avg.toFixed(2)),
    expectancyLow95Pct: expectancyLow95 == null ? null : Number(expectancyLow95.toFixed(2)),
    profitFactor: grossLosses ? Number((grossWins / grossLosses).toFixed(2)) : null,
    avgWinPct: mean(wins) == null ? null : Number(mean(wins).toFixed(2)),
    avgLossPct: mean(losses) == null ? null : Number(mean(losses).toFixed(2)),
    avgMaePct: mean(rows.map((r) => r.mae_pct).filter(Number.isFinite)),
    avgMfePct: mean(rows.map((r) => r.mfe_pct).filter(Number.isFinite)),
    redTeam: { bindingSignals: rtRows.length, lossesPreventedPct: Number(prevented.toFixed(2)),
      winnersKilledPct: Number(killed.toFixed(2)), valuePct: Number((prevented - killed).toFixed(2)) },
    policyReplay: {
      version: policyVersion || POLICY_VERSION,
      signals: replayReturns.length,
      expectancyPct: mean(replayReturns) == null ? null : Number(mean(replayReturns).toFixed(2)),
      avgMaePct: mean(replayRows.map((r) => r.mae_pct).filter(Number.isFinite)),
      avgMfePct: mean(replayRows.map((r) => r.mfe_pct).filter(Number.isFinite)),
      redTeam: { bindingSignals: replayRt.length,
        lossesPreventedPct: Number(replayPrevented.toFixed(2)),
        winnersKilledPct: Number(replayKilled.toFixed(2)),
        valuePct: Number((replayPrevented - replayKilled).toFixed(2)) },
    },
    sampleGateMet,
    edgeClaimable: sampleGateMet && expectancyLow95 != null && expectancyLow95 > 0,
    edgeNote: !sampleGateMet
      ? `${returns.length} observations / ${distinctMints} distinct assets / ${resolvedCoveragePct ?? 0}% due-mark coverage; requires ${minSignals} / ${minSignals} / ${minResolvedCoveragePct}% — no edge may be claimed`
      : expectancyLow95 > 0 ? "95% lower confidence bound on net expectancy is above zero"
      : "net expectancy has not cleared zero at 95% confidence",
  };
}
