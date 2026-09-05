import { z } from "zod";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  IMPROVEMENT_BUNDLE_VERSION,
  IMPROVEMENT_REPORT_VERSION,
} from "./improvement-constants.js";
import { DECISION_MANIFEST_FILES } from "./manifest.js";

export { IMPROVEMENT_REPORT_VERSION } from "./improvement-constants.js";

const bounded = (max) => z.string().trim().min(1).max(max);
const finiteOrNull = z.number().finite().nullable();
const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const isoTime = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)),
  "invalid ISO timestamp");

const ManifestEntrySchema = z.object({
  path: z.string().min(1).max(220).regex(/^[\w./-]+$/),
  sha256: hash,
}).strict();

const manifestSchema = (schemaVersion) => z.object({
  schemaVersion: z.literal(schemaVersion),
  files: z.array(ManifestEntrySchema).min(1).max(300),
  hash,
}).strict().superRefine((manifest, ctx) => {
  const paths = manifest.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    ctx.addIssue({ code: "custom", message: "manifest paths must be unique" });
  }
  if (paths.some((value, index) => index > 0 && paths[index - 1].localeCompare(value) > 0)) {
    ctx.addIssue({ code: "custom", message: "manifest paths must be sorted" });
  }
  if (manifest.files.some((entry) => entry.path.includes("..") || entry.path.startsWith("/"))) {
    ctx.addIssue({ code: "custom", message: "manifest contains an unsafe path" });
  }
  if (sha256(canonicalJson(manifest.files)) !== manifest.hash) {
    ctx.addIssue({ code: "custom", message: "manifest digest mismatch" });
  }
});

const MarkStatusSchema = z.object({
  status: z.enum(["pending", "observed", "unavailable"]),
  count,
}).strict();

const RedTeamSchema = z.object({
  bindingSignals: count,
  lossesPreventedPct: z.number().finite(),
  winnersKilledPct: z.number().finite(),
  valuePct: z.number().finite(),
}).strict();

const ScorecardSchema = z.object({
  horizonMin: z.union([z.literal(15), z.literal(60), z.literal(360),
    z.literal(1440), z.literal(2880)]),
  cohort: z.enum(["published", "not-published"]),
  signals: count,
  distinctMints: count,
  wins: count,
  losses: count,
  dueMarks: count,
  observedMarks: count,
  resolvedCoveragePct: finiteOrNull,
  marksByStatus: z.array(MarkStatusSchema).max(3),
  hitRatePct: finiteOrNull,
  expectancyPct: finiteOrNull,
  expectancyLow95Pct: finiteOrNull,
  profitFactor: finiteOrNull,
  avgWinPct: finiteOrNull,
  avgLossPct: finiteOrNull,
  avgMaePct: finiteOrNull,
  avgMfePct: finiteOrNull,
  redTeam: RedTeamSchema,
  policyReplay: z.object({
    version: bounded(80), signals: count, expectancyPct: finiteOrNull,
    avgMaePct: finiteOrNull, avgMfePct: finiteOrNull, redTeam: RedTeamSchema,
  }).strict(),
  sampleGateMet: z.boolean(),
  edgeClaimable: z.boolean(),
  edgeNote: bounded(500),
}).strict().superRefine((card, ctx) => {
  if (card.wins + card.losses !== card.signals || card.observedMarks < card.signals ||
      card.distinctMints > card.signals || card.observedMarks > card.dueMarks) {
    ctx.addIssue({ code: "custom", message: "scorecard counts are inconsistent" });
  }
  const expectedCoverage = card.dueMarks
    ? Number((card.observedMarks / card.dueMarks * 100).toFixed(1)) : null;
  if (card.resolvedCoveragePct !== expectedCoverage) {
    ctx.addIssue({ code: "custom", message: "scorecard coverage is inconsistent" });
  }
  if (card.edgeClaimable && !card.sampleGateMet) {
    ctx.addIssue({ code: "custom", message: "edge claim bypasses the sample gate" });
  }
});

const NamedCountSchema = (key) => z.object({ [key]: bounded(120), count }).strict();

// One registry row from executor/thresholds.mjs, reduced to the four fields the bundle
// carries (see thresholdSummary in improvement-bundle.js). `value` is scalar or the
// canonical JSON / digest of a table; `at` is the measurement date or null.
const ThresholdSchema = z.object({
  name: z.string().min(1).max(120).regex(/^[\w.-]+$/),
  value: z.union([z.number().finite(), z.boolean(), z.null(), z.string().max(400)]),
  provenance: z.enum(["measured", "inherited", "assumed"]),
  at: z.string().max(40).nullable(),
}).strict();

export const ImprovementBundleSchema = z.object({
  reviewId: z.string().regex(/^review_[0-9a-f]{24}$/),
  contentSha256: hash,
  schemaVersion: z.literal(IMPROVEMENT_BUNDLE_VERSION),
  generatedAt: isoTime,
  source: z.object({
    commit,
    evaluationVersion: bounded(80),
    policyVersion: bounded(80),
    promptVersion: bounded(80),
    behaviorFingerprint: hash,
    primaryCohort: z.object({
      evidenceScope: z.literal("house"), runKind: z.literal("cycle"),
      pmProvider: z.literal("claude"), decisionCohort: z.literal("published"),
    }).strict(),
    decisionManifest: manifestSchema("decision-manifest.v1"),
    testManifest: manifestSchema("test-manifest.v1"),
  }).strict(),
  thresholds: z.array(ThresholdSchema).max(100).superRefine((rows, ctx) => {
    const names = rows.map((row) => row.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", message: "threshold names must be unique" });
    }
    if (names.some((value, index) => index > 0 && names[index - 1].localeCompare(value) > 0)) {
      ctx.addIssue({ code: "custom", message: "thresholds must be sorted by name" });
    }
  }),
  privacy: z.object({
    scope: z.literal("house-aggregate-only"),
    tenantDataIncluded: z.literal(false), rawWorkupsIncluded: z.literal(false),
    marketTextIncluded: z.literal(false), credentialsIncluded: z.literal(false),
  }).strict(),
  governance: z.object({
    role: z.literal("Codex Improvement Engineer"), mode: z.literal("advisory"),
    mayTrade: z.literal(false), maySignOrSend: z.literal(false),
    mayChangeRiskOrPrompts: z.literal(false), mayWriteProduction: z.literal(false),
    mayDeploy: z.literal(false), output: z.literal("reviewable proposal artifact only"),
    promotionGate: z.literal("human review, ordinary pull request, full CI, then explicit merge"),
  }).strict(),
  workerPolicy: z.object({
    runsInsideTradingApi: z.literal(false), sandboxMode: z.literal("read-only"),
    approvalPolicy: z.literal("never"), agentNetworkAccess: z.literal(false),
    webSearch: z.literal(false), maxConcurrentRuns: z.literal(1),
    maxWallClockMinutes: z.literal(15),
  }).strict(),
  evidence: z.object({
    behaviorChangeGate: z.object({
      horizonMin: z.literal(1440), cohort: z.literal("published"),
      minimumSignals: z.literal(100), minimumDistinctMints: z.literal(100),
      minimumResolvedCoveragePct: z.literal(80), signals: count, distinctMints: count,
      resolvedCoveragePct: finiteOrNull, met: z.boolean(),
    }).strict(),
    scorecards: z.array(ScorecardSchema).length(5),
    unpublishedCounterfactual24h: ScorecardSchema,
    coverage: z.object({
      currentHouseRuns: count, primaryPublishedRuns: count,
      unattributedOrDifferentRunsExcluded: count,
      tenantRunsExcluded: z.literal(true), unattributedRowsExcluded: z.literal(true),
      published24hMarksByStatus: z.array(MarkStatusSchema).max(3),
    }).strict(),
    decisions: z.array(NamedCountSchema("decision")).max(50),
    bindingGates: z.array(NamedCountSchema("gate")).max(50),
    sevenDayOperations: z.object({
      seatFailures: z.array(NamedCountSchema("seat")).max(50),
      modelSpendBySeat: z.array(z.object({
        seat: bounded(120), calls: count, usd: z.number().finite().nonnegative(),
      }).strict()).max(50),
      calls: z.object({ opened: count, closed: count, closedUp: count,
        closedDownOrFlat: count }).strict(),
      lessonsByGrade: z.array(NamedCountSchema("grade")).max(20),
    }).strict(),
  }).strict(),
  acceptance: z.object({
    requiredCommands: z.tuple([z.literal("npm test"), z.literal("npm run build")]),
    proposalLimit: z.literal(5),
    allowedAreas: z.tuple([z.literal("prompt"), z.literal("test"), z.literal("evaluation"),
      z.literal("observability"), z.literal("workflow"), z.literal("security"), z.literal("cost")]),
    prohibited: z.tuple([
      z.literal("trade, sign, send, size, rank, or publish a position"),
      z.literal("edit files, apply a patch, commit, push, merge, or deploy"),
      z.literal("read production SQLite, tenant records, credentials, sessions, or executor configuration"),
      z.literal("claim an edge or recommend behavior changes below the sample gate"),
    ]),
  }).strict(),
}).strict().superRefine((bundle, ctx) => {
  const daily = bundle.evidence.scorecards.find((card) => card.horizonMin === 1440);
  const gate = bundle.evidence.behaviorChangeGate;
  const computed = Boolean(daily && daily.cohort === "published" &&
    daily.signals >= gate.minimumSignals && daily.distinctMints >= gate.minimumDistinctMints &&
    daily.resolvedCoveragePct != null && daily.resolvedCoveragePct >= gate.minimumResolvedCoveragePct);
  if (!daily || gate.signals !== daily.signals || gate.distinctMints !== daily.distinctMints ||
      gate.resolvedCoveragePct !== daily.resolvedCoveragePct || gate.met !== computed ||
      daily.sampleGateMet !== computed) {
    ctx.addIssue({ code: "custom", message: "behavior-change gate is inconsistent" });
  }
  const horizons = bundle.evidence.scorecards.map((card) => card.horizonMin);
  if (new Set(horizons).size !== 5 || ![15, 60, 360, 1440, 2880].every((h) => horizons.includes(h))) {
    ctx.addIssue({ code: "custom", message: "scorecard horizons are incomplete" });
  }
});

const METRIC_POINTER = /^\/evidence\/(?:behaviorChangeGate\/(?:met|signals|distinctMints|resolvedCoveragePct)|coverage\/(?:currentHouseRuns|primaryPublishedRuns|unattributedOrDifferentRunsExcluded)|scorecards\/[0-4]\/(?:signals|distinctMints|dueMarks|observedMarks|resolvedCoveragePct|hitRatePct|expectancyPct|expectancyLow95Pct|profitFactor|sampleGateMet|edgeClaimable)|unpublishedCounterfactual24h\/(?:signals|distinctMints|dueMarks|observedMarks|resolvedCoveragePct|expectancyPct|expectancyLow95Pct)|sevenDayOperations\/calls\/(?:opened|closed|closedUp|closedDownOrFlat))$/;

const MetricEvidenceSchema = z.object({
  kind: z.literal("metric"),
  metricId: z.string().max(180).regex(METRIC_POINTER),
  interpretation: bounded(800),
}).strict();

const safeTarget = /^(?:[A-Za-z0-9][\w.-]*|(?:src|scripts|viewer|services|executor|docs|\.github)\/[\w./-]+)$/;
const forbiddenTarget = /(?:^|\/)(?:\.env|node_modules|reports|dist|\.git)(?:\/|$)|\.db(?:-|$)|secret|keypair|auth\.json/i;
const CodeEvidenceSchema = z.object({
  kind: z.literal("code"),
  path: z.string().min(1).max(180).regex(safeTarget),
  lineStart: z.number().int().min(1).max(100_000),
  lineEnd: z.number().int().min(1).max(100_000),
  observation: bounded(800),
}).strict().refine((value) => value.lineEnd >= value.lineStart && value.lineEnd - value.lineStart <= 8,
  "code evidence range must contain at most nine lines");
const EvidenceSchema = z.discriminatedUnion("kind", [MetricEvidenceSchema, CodeEvidenceSchema]);

const ProposalSchema = z.object({
  rank: z.number().int().min(1).max(5), priority: z.enum(["P1", "P2", "P3"]),
  area: z.enum(["prompt", "test", "evaluation", "observability", "workflow", "security", "cost"]),
  title: bounded(160), problem: bounded(1200),
  evidence: z.array(EvidenceSchema).min(1).max(6),
  targetFiles: z.array(bounded(180)).min(1).max(8), proposedChange: bounded(2400),
  changesDecisionPolicy: z.boolean(), expectedImpact: bounded(1000),
  risks: z.array(bounded(600)).min(1).max(6),
  acceptanceTests: z.array(bounded(600)).min(1).max(8),
  confidence: z.number().min(0).max(1), requiresHumanReview: z.literal(true),
}).strict();

export const ImprovementReportSchema = z.object({
  schemaVersion: z.literal(IMPROVEMENT_REPORT_VERSION),
  reviewId: z.string().regex(/^review_[0-9a-f]{24}$/), sourceCommit: commit,
  createdAt: isoTime, verdict: z.enum(["healthy", "needs_attention", "insufficient_evidence"]),
  executiveSummary: bounded(1600),
  evidenceAssessment: z.object({
    sampleGateMet: z.boolean(), limitations: z.array(bounded(600)).max(10),
  }).strict(),
  proposals: z.array(ProposalSchema).max(5),
  deferred: z.array(z.object({
    idea: bounded(600), reason: bounded(600), evidenceNeeded: bounded(600),
  }).strict()).max(8),
  safetyAttestation: z.object({
    analysisOnly: z.literal(true), noFilesChanged: z.literal(true),
    noTradeAuthority: z.literal(true), noProductionAccess: z.literal(true),
    humanReviewRequired: z.literal(true),
  }).strict(),
}).strict();

export const IMPROVEMENT_OUTPUT_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "reviewId", "sourceCommit", "createdAt", "verdict",
    "executiveSummary", "evidenceAssessment", "proposals", "deferred", "safetyAttestation"],
  properties: {
    schemaVersion: { type: "string", enum: [IMPROVEMENT_REPORT_VERSION] },
    reviewId: { type: "string", pattern: "^review_[0-9a-f]{24}$" },
    sourceCommit: { type: "string", pattern: "^[0-9a-f]{40}$" },
    createdAt: { type: "string", maxLength: 40 },
    verdict: { type: "string", enum: ["healthy", "needs_attention", "insufficient_evidence"] },
    executiveSummary: { type: "string", minLength: 1, maxLength: 1600 },
    evidenceAssessment: { type: "object", additionalProperties: false,
      required: ["sampleGateMet", "limitations"], properties: {
        sampleGateMet: { type: "boolean" },
        limitations: { type: "array", maxItems: 10, items: { type: "string", maxLength: 600 } },
      } },
    proposals: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false,
      required: ["rank", "priority", "area", "title", "problem", "evidence", "targetFiles",
        "proposedChange", "changesDecisionPolicy", "expectedImpact", "risks", "acceptanceTests",
        "confidence", "requiresHumanReview"], properties: {
        rank: { type: "integer", minimum: 1, maximum: 5 },
        priority: { type: "string", enum: ["P1", "P2", "P3"] },
        area: { type: "string", enum: ["prompt", "test", "evaluation", "observability", "workflow", "security", "cost"] },
        title: { type: "string", minLength: 1, maxLength: 160 },
        problem: { type: "string", minLength: 1, maxLength: 1200 },
        evidence: { type: "array", minItems: 1, maxItems: 6, items: { anyOf: [
          { type: "object", additionalProperties: false,
            required: ["kind", "metricId", "interpretation"], properties: {
              kind: { type: "string", enum: ["metric"] },
              metricId: { type: "string", pattern: METRIC_POINTER.source, maxLength: 180 },
              interpretation: { type: "string", minLength: 1, maxLength: 800 },
            } },
          { type: "object", additionalProperties: false,
            required: ["kind", "path", "lineStart", "lineEnd", "observation"], properties: {
              kind: { type: "string", enum: ["code"] },
              path: { type: "string", maxLength: 180 },
              lineStart: { type: "integer", minimum: 1, maximum: 100000 },
              lineEnd: { type: "integer", minimum: 1, maximum: 100000 },
              observation: { type: "string", minLength: 1, maxLength: 800 },
            } },
        ] } },
        targetFiles: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", maxLength: 180 } },
        proposedChange: { type: "string", minLength: 1, maxLength: 2400 },
        changesDecisionPolicy: { type: "boolean" },
        expectedImpact: { type: "string", minLength: 1, maxLength: 1000 },
        risks: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", maxLength: 600 } },
        acceptanceTests: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", maxLength: 600 } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        requiresHumanReview: { type: "boolean", enum: [true] },
      } } },
    deferred: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
      required: ["idea", "reason", "evidenceNeeded"], properties: {
        idea: { type: "string", minLength: 1, maxLength: 600 },
        reason: { type: "string", minLength: 1, maxLength: 600 },
        evidenceNeeded: { type: "string", minLength: 1, maxLength: 600 },
      } } },
    safetyAttestation: { type: "object", additionalProperties: false,
      required: ["analysisOnly", "noFilesChanged", "noTradeAuthority", "noProductionAccess", "humanReviewRequired"],
      properties: Object.fromEntries(["analysisOnly", "noFilesChanged", "noTradeAuthority",
        "noProductionAccess", "humanReviewRequired"].map((key) => [key, { type: "boolean", enum: [true] }])) },
  },
};

export function verifyImprovementBundle(input) {
  const bundle = ImprovementBundleSchema.parse(input);
  const expectedDecisionPaths = [...DECISION_MANIFEST_FILES].sort();
  const actualDecisionPaths = bundle.source.decisionManifest.files.map((entry) => entry.path);
  if (canonicalJson(actualDecisionPaths) !== canonicalJson(expectedDecisionPaths)) {
    throw new Error("decision manifest membership mismatch");
  }
  const { reviewId, contentSha256, ...payload } = bundle;
  const expected = sha256(canonicalJson(payload));
  if (contentSha256 !== expected || reviewId !== `review_${expected.slice(0, 24)}`) {
    throw new Error("improvement bundle digest mismatch");
  }
  return bundle;
}

export function resolveBundleMetric(bundle, pointer) {
  if (!METRIC_POINTER.test(pointer)) throw new Error(`unsupported evidence metric: ${pointer}`);
  let value = bundle;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`missing evidence metric: ${pointer}`);
    }
    value = value[key];
  }
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
    throw new Error(`evidence metric is not scalar: ${pointer}`);
  }
  const scorecardMatch = pointer.match(/^\/evidence\/scorecards\/(\d+)\//);
  const sampleSize = scorecardMatch
    ? bundle.evidence.scorecards[Number(scorecardMatch[1])]?.signals ?? null
    : pointer.startsWith("/evidence/behaviorChangeGate/")
      ? bundle.evidence.behaviorChangeGate.signals : null;
  return { metricId: pointer, value, sampleSize };
}

export function parseImprovementReport(raw, bundleInput) {
  const bundle = verifyImprovementBundle(bundleInput);
  let value = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("improvement report is too large");
    try { value = JSON.parse(raw); }
    catch { throw new Error("improvement report is not valid JSON"); }
  }
  const report = ImprovementReportSchema.parse(value);
  if (report.reviewId !== bundle.reviewId || report.sourceCommit !== bundle.source.commit) {
    throw new Error("improvement report does not match its source bundle");
  }
  const generatedAt = Date.parse(bundle.generatedAt);
  const createdAt = Date.parse(report.createdAt);
  if (createdAt < generatedAt - 5 * 60_000 || createdAt > generatedAt + 30 * 60_000) {
    throw new Error("improvement report timestamp is outside the review window");
  }
  const sampleGateMet = bundle.evidence.behaviorChangeGate.met;
  if (report.evidenceAssessment.sampleGateMet !== sampleGateMet) {
    throw new Error("improvement report misstated the evidence sample gate");
  }
  const ranks = new Set();
  const decisionTargets = new Set(bundle.source.decisionManifest.files.map((entry) => entry.path));
  // The manifest enumerates today's behavior files, but a proposal may add tomorrow's
  // file beneath a behavior directory. Protect concrete nested surfaces such as
  // src/agents and executor without collapsing every unrelated src/** service file
  // into decision policy merely because several manifest files live at src's root.
  const decisionSurfaceRoots = new Set([...decisionTargets].flatMap((target) => {
    const parts = target.split("/").slice(0, -1);
    if (!parts.length || (parts.length === 1 && parts[0] === "src")) return [];
    return [parts.join("/")];
  }));
  const isDecisionTarget = (target) => decisionTargets.has(target) ||
    [...decisionTargets].some((entry) => entry.startsWith(`${target}/`)) ||
    [...decisionSurfaceRoots].some((root) => target === root || target.startsWith(`${root}/`));
  for (const proposal of report.proposals) {
    if (ranks.has(proposal.rank)) throw new Error("improvement proposal ranks must be unique");
    ranks.add(proposal.rank);
    const inferredPolicyChange = proposal.area === "prompt" ||
      proposal.targetFiles.some(isDecisionTarget);
    if (proposal.changesDecisionPolicy !== inferredPolicyChange) {
      throw new Error("improvement proposal misstated whether it changes decision policy");
    }
    if (inferredPolicyChange && !sampleGateMet) {
      throw new Error("decision-policy proposal rejected below the evidence sample gate");
    }
    for (const target of proposal.targetFiles) {
      if (!safeTarget.test(target) || forbiddenTarget.test(target) || target.includes("..")) {
        throw new Error(`unsafe improvement target: ${target}`);
      }
    }
    for (const evidence of proposal.evidence) {
      if (evidence.kind === "metric") resolveBundleMetric(bundle, evidence.metricId);
      else if (forbiddenTarget.test(evidence.path) || evidence.path.includes("..")) {
        throw new Error(`unsafe code evidence target: ${evidence.path}`);
      }
    }
  }
  return report;
}
