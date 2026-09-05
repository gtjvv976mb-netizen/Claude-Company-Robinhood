import { backlog, emit, runFor } from "./src/lib/bus.js";
import db from "./src/lib/store.js";
import {
  decisionManifest,
  deployedCommit,
  testManifest,
} from "./src/provenance.js";
import {
  EVALUATION_VERSION,
  FORWARD_MARK_TOLERANCE_MS,
  POLICY_VERSION,
  evaluationSummary,
  recordDecision,
  runtimeBehaviorFingerprint,
  runtimeBehaviorProfile,
} from "./src/evaluation.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nEXACT DECISION AND TEST PROVENANCE");
const first = decisionManifest();
const second = decisionManifest();
const tests = testManifest();
ok("decision manifest is deterministic", first.hash === second.hash);
ok("decision manifest includes the charter and deterministic policy",
  first.files.some((f) => f.path === "DESK.md") &&
  first.files.some((f) => f.path === "executor/trade-policy.mjs") &&
  first.files.some((f) => f.path === "src/evaluation.js") &&
  first.files.some((f) => f.path === "src/identity.js"));
ok("manifest paths are an explicit safe set",
  first.files.every((f) => !/\.env|\.db|reports|node_modules|secret|keypair/i.test(f.path)));
ok("test manifest matches the discovered suites",
  tests.files.some((f) => f.path === "scripts/test-all.mjs") &&
  tests.files.some((f) => f.path === "test-improvement-provenance.mjs") &&
  tests.files.some((f) => f.path === "executor/test-strategy.mjs"));
ok("local source commit is exact when git metadata is present",
  deployedCommit() === "unknown" || /^[0-9a-f]{40}$/.test(deployedCommit()), deployedCommit());

console.log("\nHOUSE AND TENANT EVIDENCE STAY SEPARATE");
const now = 1_800_000_000_000;
const rec = (mint) => ({ mint, symbol: mint, outcome: "decided", finalDecision: "PASS",
  runKind: "cycle", ev: { pair: { priceUsd: 1 }, exitProbe: { roundTripLossPct: 1 } } });
const houseId = recordDecision("house-cycle", rec("HOUSE"), now);
const tenantId = await runFor(7, () => recordDecision("tenant-cycle", rec("TENANT"), now));
const hqId = await runFor(50, () => recordDecision("hq-cycle", rec("HQ"), now));
const staleEvaluationId = recordDecision("stale-evaluation", rec("STALE-EVAL"), now);
const staleFingerprintId = recordDecision("stale-fingerprint", rec("STALE-FP"), now);
const house = db.prepare(`SELECT floor_no,evidence_scope,prompt_manifest_hash,run_kind
                          FROM decision_runs WHERE id=?`).get(houseId);
const tenant = db.prepare(`SELECT floor_no,evidence_scope,prompt_manifest_hash,run_kind
                           FROM decision_runs WHERE id=?`).get(tenantId);
const hq = db.prepare("SELECT floor_no,evidence_scope FROM decision_runs WHERE id=?").get(hqId);
ok("house decision retains null floor and exact prompt hash",
  house.floor_no == null && house.evidence_scope === "house" &&
  house.prompt_manifest_hash === first.hash && house.run_kind === "cycle");
ok("tenant decision retains its floor and exact prompt hash",
  tenant.floor_no === 7 && tenant.evidence_scope === "tenant" &&
  tenant.prompt_manifest_hash === first.hash);
ok("HQ floor 50 is explicitly house evidence",
  hq.floor_no === 50 && hq.evidence_scope === "house");

for (const [id, result] of [
  [houseId, 5], [tenantId, 99], [hqId, 7],
  [staleEvaluationId, 777], [staleFingerprintId, 888],
]) {
  db.prepare(`UPDATE forward_marks SET observed_at=?,net_return_pct=?,mae_pct=-1,mfe_pct=2,data_status='observed'
              WHERE run_id=? AND horizon_min=15`).run(now + 900_000, result, id);
}
db.prepare("UPDATE decision_runs SET evaluation_version='stale-evaluation' WHERE id=?")
  .run(staleEvaluationId);
db.prepare("UPDATE decision_runs SET behavior_fingerprint=? WHERE id=?")
  .run("0".repeat(64), staleFingerprintId);

const fingerprint = runtimeBehaviorFingerprint({ runKind: "cycle", pmProvider: "claude" });
const summaryNow = now + 15 * 60_000 + FORWARD_MARK_TOLERANCE_MS + 1;
const common = {
  horizonMin: 15,
  minSignals: 100,
  nowMs: summaryNow,
  promptManifestHash: first.hash,
  evaluationVersion: EVALUATION_VERSION,
  policyVersion: POLICY_VERSION,
  behaviorFingerprint: fingerprint,
};
const houseOnly = evaluationSummary({ ...common, evidenceScope: "house" });
const tenantOnly = evaluationSummary({ ...common, evidenceScope: "tenant", floorNo: 7 });
ok("house scorecard excludes tenant, stale-version, and stale-runtime outcomes",
  houseOnly.signals === 2 && houseOnly.expectancyPct === 6,
  JSON.stringify(houseOnly));
ok("tenant scorecard can be isolated independently", tenantOnly.signals === 1 && tenantOnly.expectancyPct === 99,
  JSON.stringify(tenantOnly));

runFor(null, () => emit("tenant:private-fixture",
  { floorNo: 7, mint: "PRIVATE", quoteUsd: 123 }));
const tenantEvent = db.prepare(`SELECT floor,evidence_scope,data FROM chronicle
  WHERE type='tenant:private-fixture' ORDER BY id DESC LIMIT 1`).get();
ok("floorNo events retain tenant provenance and never enter another floor's backlog",
  tenantEvent.floor === 7 && tenantEvent.evidence_scope === "tenant" &&
  backlog(7).some((event) => event.type === "tenant:private-fixture") &&
  !backlog(8).some((event) => event.type === "tenant:private-fixture"));

// The desk's read endpoint is RH_RPC on this chain (src/config.js reads it for the
// runtime profile's rpcOrigin); SOLANA_RPC no longer exists here.
const priorRpc = process.env.RH_RPC;
const priorXaiBase = process.env.XAI_BASE_URL;
process.env.RH_RPC = "https://account:password@rpc.example.test/private-key?api_key=secret";
process.env.XAI_BASE_URL = "https://xai-alt.example.test/v1/private-token";
const endpointProfile = JSON.stringify(runtimeBehaviorProfile());
if (priorRpc == null) delete process.env.RH_RPC; else process.env.RH_RPC = priorRpc;
if (priorXaiBase == null) delete process.env.XAI_BASE_URL; else process.env.XAI_BASE_URL = priorXaiBase;
ok("runtime identity distinguishes endpoint origins without retaining URL credentials",
  endpointProfile.includes("https://rpc.example.test") &&
  endpointProfile.includes("https://xai-alt.example.test") &&
  !/password|private-key|api_key|secret|private-token/.test(endpointProfile));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
