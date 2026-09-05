import assert from "node:assert/strict";
import fs from "node:fs";
import db from "./src/lib/store.js";
import { executorHeartbeatPayload, sanitizeExecutorHealth } from "./src/office.js";
import { settingsFor } from "./src/copy.js";
import { HQ_FLOOR } from "./src/tower.js";

const secret = settingsFor(HQ_FLOOR).executor_secret;
const pulse = { mode: "live", wallet: "PublicWalletOnly", cursor: 42, open: 1,
  held: [{ mint: "MintPublic", sol: 0.005 }], ts: Date.now(), seenAt: Date.now() };
db.prepare("UPDATE copy_settings SET executor_heartbeat=? WHERE floor_no=?")
  .run(JSON.stringify(pulse), HQ_FLOOR);

const payload = executorHeartbeatPayload(HQ_FLOOR);
assert.deepEqual(payload, { heartbeat: pulse });
assert.ok(!JSON.stringify(payload).includes(secret));
assert.deepEqual(executorHeartbeatPayload(49), { heartbeat: null });
const health = sanitizeExecutorHealth({ state: "manual-action", hardStop: true,
  blockedPositions: 4.9, consecutiveFeedFailures: 2, runtimeCommit: "A".repeat(40),
  runtimeFingerprint: "B".repeat(32),
  secret: "must-not-cross" });
assert.equal(health.state, "manual-action");
assert.equal(health.blockedPositions, 4);
assert.equal(health.runtimeCommit, "a".repeat(40));
assert.equal(health.runtimeFingerprint, "b".repeat(32));
assert.ok(!JSON.stringify(health).includes("must-not-cross"));

const now = Date.now();
const ready = sanitizeExecutorHealth({ state: "entries-paused", feedRollback: false,
  executionReadiness: { ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
    route: "eth-usdg", providers: 2, amountWei: "4000000000000000",
    secret: "readiness-secret-must-not-cross" },
  caps: { maxEthPerTrade: 0.004, dailyEthCap: 0.04,
    dailyLossLimitEth: 0.012, maxOpenPositions: 4, secret: "cap-secret-must-not-cross" } });
assert.equal(ready.state, "entries-paused");
assert.equal(ready.feedRollback, false);
assert.deepEqual(ready.executionReadiness, {
  ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
  route: "eth-usdg", providers: 2, amountWei: "4000000000000000", lastError: null,
});
assert.deepEqual(ready.caps, {
  maxEthPerTrade: 0.004, dailyEthCap: 0.04, dailyLossLimitEth: 0.012, maxOpenPositions: 4,
});
assert.ok(!JSON.stringify(ready).includes("readiness-secret-must-not-cross"));
assert.ok(!JSON.stringify(ready).includes("cap-secret-must-not-cross"));

const rollback = sanitizeExecutorHealth({ state: "healthy", feedRollback: true,
  executionReadiness: ready.executionReadiness });
assert.equal(rollback.feedRollback, true);
assert.equal(rollback.state, "degraded", "a feed rollback cannot persist as healthy");

const failedReadiness = sanitizeExecutorHealth({ state: "healthy", feedRollback: false,
  executionReadiness: { ...ready.executionReadiness, ready: false } });
assert.equal(failedReadiness.executionReadiness.ready, false);
assert.equal(failedReadiness.state, "degraded",
  "a failed execution probe cannot persist as healthy");

const malformed = sanitizeExecutorHealth({ state: "healthy", feedRollback: "false",
  executionReadiness: { ready: true, lastSuccessAt: String(now), observedAt: now,
    route: { secret: "nested-route-secret" }, providers: "2",
    amountWei: 400000000000000, endpoint: "https://rpc.invalid/private" },
  caps: { maxEthPerTrade: "0.0004", dailyEthCap: 0.0008,
    dailyLossLimitEth: 0.0008, maxOpenPositions: 4 } });
assert.equal(malformed.feedRollback, false, "only a literal boolean is retained");
assert.deepEqual(malformed.executionReadiness, {
  ready: false, lastSuccessAt: 0, observedAt: now, route: null, providers: 0,
  amountWei: "0", lastError: null,
});

/* THE REASON IS SANITISED LIKE EVERYTHING ELSE ON THIS SURFACE. It exists so an
   operator with both RPCs green can see why the rehearsal did not pass instead of a
   bare "0 / 2" — but it arrives from a tenant machine, so it is a bounded string or it
   is nothing, and control bytes never survive it. */
const reasoned = sanitizeExecutorHealth({ state: "degraded",
  executionReadiness: { ready: false, lastSuccessAt: 0, observedAt: now,
    route: "eth-usdg", providers: 0, amountWei: "400000000000000",
    lastError: "execution-readiness wallet reserve is insufficient\u0000 on one or both RPC providers" } });
assert.match(reasoned.executionReadiness.lastError, /wallet reserve is insufficient/);
assert.ok(!/\u0000/.test(reasoned.executionReadiness.lastError), "control bytes are stripped");
assert.equal(sanitizeExecutorHealth({ executionReadiness: { ready: false,
  lastError: { nested: "readiness-secret-must-not-cross" } } }).executionReadiness.lastError, null);
assert.equal(sanitizeExecutorHealth({ executionReadiness: { ready: false,
  lastError: "y".repeat(900) } }).executionReadiness.lastError.length, 300);
assert.equal(malformed.caps, null);
assert.equal(malformed.state, "degraded",
  "malformed rollback/readiness evidence fails status closed");
assert.ok(!JSON.stringify(malformed).includes("nested-route-secret"));
assert.ok(!JSON.stringify(malformed).includes("rpc.invalid"));

/* A heartbeat from a bot still on the Solana wire names — the executor lane's own
   heartbeat-health.mjs still emits them — carries no ETH caps and no 4663 rehearsal. */
const solanaNamed = sanitizeExecutorHealth({ state: "healthy",
  executionReadiness: { ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
    route: "wsol-usdc", providers: 2, amountLamports: 50_000_000 },
  caps: { maxSolPerTrade: 0.05, dailySolCap: 0.5, dailyLossLimitSol: 0.15, maxOpenPositions: 4 } });
assert.equal(solanaNamed.caps, null, "Solana cap names are not aliases for the ETH caps");
assert.equal(solanaNamed.executionReadiness.route, null);
assert.equal(solanaNamed.executionReadiness.amountWei, "0");
assert.equal(solanaNamed.executionReadiness.ready, false);
assert.equal(solanaNamed.state, "degraded");
console.log(`  solana-named heartbeat → caps=${solanaNamed.caps} route=${solanaNamed.executionReadiness.route} state=${solanaNamed.state}`);
// A rehearsal above the operator ceiling (0.004 ETH) is not a size this building admits.
const oversized = sanitizeExecutorHealth({ state: "healthy",
  executionReadiness: { ready: true, lastSuccessAt: now - 1000, observedAt: now - 1200,
    route: "eth-usdg", providers: 2, amountWei: "4000000000000001" } });
assert.equal(oversized.executionReadiness.amountWei, "0");
assert.equal(oversized.state, "degraded");

const subminimumCaps = sanitizeExecutorHealth({ state: "healthy", caps: {
  maxEthPerTrade: 0.0000009, dailyEthCap: 0.0008,
  dailyLossLimitEth: 0.0008, maxOpenPositions: 4,
} });
assert.equal(subminimumCaps.caps, null);
assert.equal(subminimumCaps.state, "degraded",
  "cap telemetry below the runtime minimum cannot persist as healthy");

const nonObjectReadiness = sanitizeExecutorHealth({ state: "healthy",
  executionReadiness: "secret-bearing-invalid-readiness" });
assert.equal(nonObjectReadiness.executionReadiness, null);
assert.equal(nonObjectReadiness.state, "degraded");
assert.ok(!JSON.stringify(nonObjectReadiness).includes("secret-bearing"));

const source = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const route = source.slice(source.indexOf("const hbMatch"), source.indexOf("RETIRED BROWSER RPC LANE"));
assert.match(route, /cryptoTimingEqual\(auth, secret\)/,
  "heartbeat GET and POST must remain behind the floor executor secret");
assert.match(route, /req\.method === "GET"/);
assert.match(route, /cache-control", "no-store"/);
assert.match(route, /req\.method !== "POST"/);
assert.match(route, /health: sanitizeExecutorHealth\(body\.health\)/,
  "the authenticated heartbeat route must persist only sanitized health evidence");

console.log("\nexecutor heartbeat readback is authenticated, read-only and secret-safe\n");
