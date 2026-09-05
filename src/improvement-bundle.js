import db from "./lib/store.js";
// These modules own the forward-only migrations for operational evidence tables.
// Import them before querying so a standalone bundle export cannot silently observe an
// old schema and report truthful-looking zeros.
import "./lib/llm.js";
import "./calls.js";
import "./agents/review.js";
import {
  EVALUATION_VERSION,
  HORIZONS_MIN,
  POLICY_VERSION,
  PROMPT_VERSION,
  evaluationSummary,
  runtimeBehaviorFingerprint,
} from "./evaluation.js";
import {
  canonicalJson,
  decisionManifest,
  deployedCommit,
  sha256,
  testManifest,
} from "./provenance.js";
import {
  IMPROVEMENT_BUNDLE_VERSION,
  IMPROVEMENT_MIN_COVERAGE_PCT,
  IMPROVEMENT_SAMPLE_GATE,
} from "./improvement-constants.js";
// The desk's numbers and where each came from. live-thresholds.mjs registers them on
// import; thresholds() reads the registry. Only the registry is imported — no swap,
// signing or RPC code enters the office process through this line.
import "../executor/live-thresholds.mjs";
import { thresholds as thresholdRegistry } from "../executor/thresholds.mjs";

export { IMPROVEMENT_BUNDLE_VERSION, IMPROVEMENT_MIN_COVERAGE_PCT,
  IMPROVEMENT_SAMPLE_GATE } from "./improvement-constants.js";

const all = (sql, ...args) => db.prepare(sql).all(...args);

const scalar = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);

const rounded = (value, digits = 4) => Number(Number(value || 0).toFixed(digits));

/**
 * name / value / provenance / at — and nothing else. The method and note strings are
 * free prose written by whoever measured the number, and prose does not cross this
 * boundary. A non-scalar value (a band table, a window list) is carried as its canonical
 * JSON so the reviewer can still see WHAT is set; past 400 characters only its digest
 * travels, which is enough to notice that it changed. Sorted by name so the bundle
 * digest does not depend on registration order.
 */
export function thresholdSummary(registry = thresholdRegistry()) {
  const scalar = (v) => v === null || ["number", "string", "boolean"].includes(typeof v);
  return [...registry]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      let value = t.value;
      if (!scalar(value)) {
        const json = canonicalJson(value);
        value = json.length <= 400 ? json : `sha256:${sha256(json)}`;
      } else if (typeof value === "number" && !Number.isFinite(value)) {
        value = String(value);
      }
      return { name: t.name, value, provenance: t.provenance, at: t.at ?? null };
    });
}

/**
 * A narrow, aggregate-only interface between the trading service and a separate Codex
 * worker. It contains no workup prose, symbols, mints, wallets, tenant records, URLs,
 * credentials, session state, or executor configuration. Market/social text never
 * crosses this boundary, which also keeps prompt injection out of the coding agent.
 */
export function buildImprovementBundle({ nowMs = Date.now(), sourceCommit = deployedCommit() } = {}) {
  const decision = decisionManifest();
  const tests = testManifest();
  const cutoff = nowMs - 7 * 24 * 60 * 60 * 1000;
  // The policy-change gate is deliberately one comparable cohort: calls actually
  // published by scheduled house cycles using the default Claude PM under this exact
  // runtime/config/commit. APPROVED alone is not the deployed strategy because the
  // mandate may safely publish a lower-tier cohort winner.
  const behaviorFingerprint = runtimeBehaviorFingerprint({
    runKind: "cycle", pmProvider: "claude",
  });
  const scorecards = HORIZONS_MIN.map((horizonMin) => evaluationSummary({
    horizonMin,
    minSignals: IMPROVEMENT_SAMPLE_GATE,
    minResolvedCoveragePct: IMPROVEMENT_MIN_COVERAGE_PCT,
    nowMs,
    evidenceScope: "house",
    promptManifestHash: decision.hash,
    evaluationVersion: EVALUATION_VERSION,
    policyVersion: POLICY_VERSION,
    behaviorFingerprint,
    decisionCohort: "published",
  }));
  const daily = scorecards.find((row) => row.horizonMin === 1440);
  const unpublishedCounterfactual24h = evaluationSummary({
    horizonMin: 1440,
    minSignals: IMPROVEMENT_SAMPLE_GATE,
    minResolvedCoveragePct: IMPROVEMENT_MIN_COVERAGE_PCT,
    nowMs,
    evidenceScope: "house",
    promptManifestHash: decision.hash,
    evaluationVersion: EVALUATION_VERSION,
    policyVersion: POLICY_VERSION,
    behaviorFingerprint,
    decisionCohort: "not-published",
  });

  const payload = {
    schemaVersion: IMPROVEMENT_BUNDLE_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      commit: sourceCommit,
      evaluationVersion: EVALUATION_VERSION,
      policyVersion: POLICY_VERSION,
      promptVersion: PROMPT_VERSION,
      behaviorFingerprint,
      primaryCohort: {
        evidenceScope: "house",
        runKind: "cycle",
        pmProvider: "claude",
        decisionCohort: "published",
      },
      decisionManifest: decision,
      testManifest: tests,
    },
    // Every number the executor trades on, with its provenance, so the reviewer can see
    // which are still `inherited` from Solana (void on this chain) and propose the
    // measurement — instead of tuning a threshold that assertLiveReady() would refuse.
    thresholds: thresholdSummary(),
    privacy: {
      scope: "house-aggregate-only",
      tenantDataIncluded: false,
      rawWorkupsIncluded: false,
      marketTextIncluded: false,
      credentialsIncluded: false,
    },
    governance: {
      role: "Codex Improvement Engineer",
      mode: "advisory",
      mayTrade: false,
      maySignOrSend: false,
      mayChangeRiskOrPrompts: false,
      mayWriteProduction: false,
      mayDeploy: false,
      output: "reviewable proposal artifact only",
      promotionGate: "human review, ordinary pull request, full CI, then explicit merge",
    },
    workerPolicy: {
      runsInsideTradingApi: false,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      agentNetworkAccess: false,
      webSearch: false,
      maxConcurrentRuns: 1,
      maxWallClockMinutes: 15,
    },
    evidence: {
      behaviorChangeGate: {
        horizonMin: 1440,
        cohort: "published",
        minimumSignals: IMPROVEMENT_SAMPLE_GATE,
        minimumDistinctMints: IMPROVEMENT_SAMPLE_GATE,
        minimumResolvedCoveragePct: IMPROVEMENT_MIN_COVERAGE_PCT,
        signals: daily?.signals ?? 0,
        distinctMints: daily?.distinctMints ?? 0,
        resolvedCoveragePct: daily?.resolvedCoveragePct ?? null,
        met: daily?.sampleGateMet === true,
      },
      scorecards,
      unpublishedCounterfactual24h,
      coverage: {
        currentHouseRuns: scalar(
          `SELECT COUNT(*) n FROM decision_runs
           WHERE evidence_scope='house' AND behavior_fingerprint=?`, behaviorFingerprint),
        primaryPublishedRuns: scalar(
          `SELECT COUNT(*) n FROM decision_runs
           WHERE evidence_scope='house' AND behavior_fingerprint=?
             AND published_call_id IS NOT NULL`, behaviorFingerprint),
        unattributedOrDifferentRunsExcluded: scalar(
          `SELECT COUNT(*) n FROM decision_runs
           WHERE evidence_scope='unattributed'
              OR (evidence_scope='house' AND
                  (behavior_fingerprint IS NULL OR behavior_fingerprint<>?))`, behaviorFingerprint),
        tenantRunsExcluded: true,
        unattributedRowsExcluded: true,
        published24hMarksByStatus: daily?.marksByStatus ?? [],
      },
      decisions: all(`SELECT COALESCE(final_decision,'unknown') decision,COUNT(*) count
        FROM decision_runs WHERE evidence_scope='house' AND behavior_fingerprint=?
        GROUP BY COALESCE(final_decision,'unknown') ORDER BY count DESC,decision`, behaviorFingerprint),
      bindingGates: all(`SELECT COALESCE(binding_gate,'unknown') gate,COUNT(*) count
        FROM decision_runs WHERE evidence_scope='house' AND behavior_fingerprint=?
        GROUP BY COALESCE(binding_gate,'unknown') ORDER BY count DESC,gate`, behaviorFingerprint),
      sevenDayOperations: {
        seatFailures: all(`SELECT COALESCE(json_extract(data,'$.seat'),'unknown') seat,COUNT(*) count
          FROM chronicle WHERE floor_attributed=1 AND evidence_scope='house'
            AND type='seat:failed' AND ts>=?
          GROUP BY COALESCE(json_extract(data,'$.seat'),'unknown') ORDER BY count DESC,seat`, cutoff),
        modelSpendBySeat: all(`SELECT COALESCE(seat,'unknown') seat,COUNT(*) calls,
          ROUND(COALESCE(SUM(usd),0),4) usd
          FROM llm_spend WHERE floor_attributed=1 AND evidence_scope='house' AND ts>=?
          GROUP BY COALESCE(seat,'unknown') ORDER BY usd DESC,seat`, cutoff)
          .map((row) => ({ ...row, usd: rounded(row.usd) })),
        calls: {
          opened: scalar("SELECT COUNT(*) n FROM calls WHERE source_attributed=1 AND source_scope='house' AND opened_at>=?", cutoff),
          closed: scalar("SELECT COUNT(*) n FROM calls WHERE source_attributed=1 AND source_scope='house' AND closed_at>=?", cutoff),
          closedUp: scalar("SELECT COUNT(*) n FROM calls WHERE source_attributed=1 AND source_scope='house' AND closed_at>=? AND close_mark>entry_ref", cutoff),
          closedDownOrFlat: scalar("SELECT COUNT(*) n FROM calls WHERE source_attributed=1 AND source_scope='house' AND closed_at>=? AND close_mark<=entry_ref", cutoff),
        },
        lessonsByGrade: all(`SELECT COALESCE(grade,'unknown') grade,COUNT(*) count
          FROM lessons l JOIN calls c ON c.id=l.call_id
          WHERE c.source_attributed=1 AND c.source_scope='house' AND l.ts>=?
          GROUP BY COALESCE(grade,'unknown') ORDER BY count DESC,grade`, cutoff),
      },
    },
    acceptance: {
      requiredCommands: ["npm test", "npm run build"],
      proposalLimit: 5,
      allowedAreas: ["prompt", "test", "evaluation", "observability", "workflow", "security", "cost"],
      prohibited: [
        "trade, sign, send, size, rank, or publish a position",
        "edit files, apply a patch, commit, push, merge, or deploy",
        "read production SQLite, tenant records, credentials, sessions, or executor configuration",
        "claim an edge or recommend behavior changes below the sample gate",
      ],
    },
  };

  const contentSha256 = sha256(canonicalJson(payload));
  return {
    reviewId: `review_${contentSha256.slice(0, 24)}`,
    contentSha256,
    ...payload,
  };
}

let cachedBundle = null;
export function currentImprovementBundle({ maxAgeMs = 60_000 } = {}) {
  const nowMs = Date.now();
  if (cachedBundle && nowMs - cachedBundle.createdAtMs < maxAgeMs) return cachedBundle.value;
  const value = buildImprovementBundle({ nowMs });
  cachedBundle = { createdAtMs: nowMs, value };
  return value;
}

export function improvementServiceStatus() {
  return {
    name: "Codex Improvement Engineer",
    mode: "advisory",
    bundleExporterLive: true,
    worker: "external-on-demand",
    sourceCommit: deployedCommit(),
    bundleAuthConfigured: Boolean(process.env.CODEX_REVIEW_TOKEN),
    proposalsOnly: true,
    runsInsideTradingApi: false,
    endpoint: "/api/improvements/review-bundle",
  };
}
