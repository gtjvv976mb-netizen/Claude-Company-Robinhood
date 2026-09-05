import assert from "node:assert/strict";
import fs from "node:fs";

if (!process.env.CLAUDE_CO_DB)
  throw new Error("test runner must provide CLAUDE_CO_DB");

const db = (await import("./src/lib/store.js")).default;
const { buildExecutorDashboard, EXECUTOR_CANARY_DEFAULTS, EXECUTOR_OPERATOR_MAXIMA } =
  await import("./src/executor-dashboard.js");
const { executorStatusPayload, floorFeedSettingsForViewer } = await import("./src/office.js");
const { settingsFor } = await import("./src/copy.js");
const { HQ_FLOOR } = await import("./src/tower.js");

const now = 1_800_000_000_000;
/* Robinhood edition: the executor's burner is an EVM address; the balance is native ETH
   on chain 4663 and travels as wei (a decimal string) + eth (a number). */
const wallet = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const mint = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const dashboard = buildExecutorDashboard({
  floorNo: 50,
  nowMs: now,
  heartbeat: {
    mode: "live", wallet, cursor: 12, open: 1,
    held: [{ mint, eth: 0.0004 }, { mint: "not-an-address", eth: 999 }],
    health: { state: "entries-paused", entriesPaused: true, secret: "nested-must-not-cross",
      executionReadiness: { ready: true, providers: 2,
        lastSuccessAt: now - 20_000, observedAt: now - 20_000,
        route: "eth-usdg", amountWei: "400000000000000" },
      caps: { maxEthPerTrade: 0.0004, dailyEthCap: 0.0008,
        dailyLossLimitEth: 0.0008, maxOpenPositions: 4 } },
    ts: now - 40_000, seenAt: now - 30_000,
    secret: "must-not-cross",
  },
  balanceResult: { ok: true, wei: "20000000000000000", eth: 0.02, observedAt: now },
  settings: {
    feedCredentialReady: true, appetite: "aggressive", bankrollSol: 2,
    instantDelivery: true, categories: ["memecoin"], launchpads: ["pump.fun"],
    minLiquidityUsd: 25_000, takeProfitX: 2, fixedSol: 0.003,
    marketCapTier: "micro", updatedAt: now - 1_000,
    executorSecret: "must-not-cross",
  },
});

assert.equal(dashboard.telemetry.connected, true);
assert.equal(dashboard.telemetry.source, "self-reported-by-tenant-machine");
assert.equal(dashboard.telemetry.heartbeat.held.length, 1);
assert.equal(dashboard.wallet.state, "ready-balance");
assert.equal(dashboard.wallet.source, "robinhood-4663-latest-read");
assert.equal(dashboard.wallet.balanceWei, "20000000000000000");
assert.equal(dashboard.wallet.balanceEth, 0.02);
assert.equal(dashboard.activation.executionReadinessReady, true);
assert.equal(dashboard.activation.walletFunded, true);
assert.equal(dashboard.boundary.remoteControl, false);
assert.deepEqual(dashboard.capPolicy.canaryDefaults, EXECUTOR_CANARY_DEFAULTS);
assert.deepEqual(dashboard.capPolicy.operatorMaxima, EXECUTOR_OPERATOR_MAXIMA);
assert.equal(dashboard.capPolicy.active.maxEthPerTrade, 0.0004);
assert.ok(!JSON.stringify(dashboard).includes("must-not-cross"));

const raisedPulse = {
  mode: "live", wallet, seenAt: now - 1_000,
  health: {
    state: "entries-paused", entriesPaused: true,
    caps: { maxEthPerTrade: 0.004, dailyEthCap: 0.04,
      dailyLossLimitEth: 0.012, maxOpenPositions: 4 },
    executionReadiness: { ready: true, providers: 2, route: "eth-usdg",
      lastSuccessAt: now - 1_000, observedAt: now - 1_000, amountWei: "400000000000000" },
  },
};
const raisedMismatch = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: raisedPulse,
  balanceResult: { ok: true, wei: "100000000000000000", eth: 0.1, observedAt: now } });
assert.equal(raisedMismatch.activation.executionReadinessReady, false,
  "a raised executor cannot inherit readiness from the smaller default rehearsal");
assert.equal(raisedMismatch.telemetry.heartbeat.health.state, "degraded",
  "a wrong-size live rehearsal cannot display entries-paused/healthy status");
const raisedReady = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { ...raisedPulse, health: { ...raisedPulse.health,
    executionReadiness: { ...raisedPulse.health.executionReadiness, amountWei: "4000000000000000" } } },
  balanceResult: { ok: true, wei: "100000000000000000", eth: 0.1, observedAt: now } });
assert.equal(raisedReady.activation.executionReadinessReady, true);
assert.equal(raisedReady.activation.walletFunded, true);
// active cap 0.004 + the 0.001 ETH gas-headroom PLACEHOLDER (no rent on an EVM chain)
assert.ok(Math.abs(raisedReady.wallet.requiredForReadinessEth - 0.005) < 1e-12,
  `requiredForReadinessEth=${raisedReady.wallet.requiredForReadinessEth}`);

/* THE IDENTITY USES THE POLLER'S ROUNDING. A cap of 0.0004567 ETH is rehearsed by the
   poller at FLOOR(0.0004567e6) micro-ETH = 456000000000000 wei — floor, never round, so a
   rehearsal can never exceed a cap by rounding up (review, 2026-09-05); cap * 1e18 would be
   456700000000000 and an honest bot would never read as rehearsed. */
{
  const { ethToWei } = await import("./src/executor-dashboard.js");
  const oddCap = 0.0004567;
  const pollerWei = ethToWei(oddCap);
  const naiveWei = BigInt(Math.round(oddCap * 1e18));
  console.log(`  ethToWei(${oddCap}) = ${pollerWei} · naive cap*1e18 = ${naiveWei}`);
  assert.equal(pollerWei, 456000000000000n);
  assert.notEqual(pollerWei, naiveWei, "the two roundings differ for a seven-decimal cap");
  const odd = buildExecutorDashboard({ floorNo: 50, nowMs: now,
    heartbeat: { ...raisedPulse, health: { ...raisedPulse.health,
      caps: { ...raisedPulse.health.caps, maxEthPerTrade: oddCap },
      executionReadiness: { ...raisedPulse.health.executionReadiness, amountWei: pollerWei.toString() } } },
    balanceResult: { ok: true, wei: "100000000000000000", eth: 0.1, observedAt: now } });
  assert.equal(odd.activation.executionReadinessReady, true,
    "a rehearsal sized by the poller's own rounding covers the cap");
  // The Solana wire names are not aliases: they read as no caps and no rehearsal.
  const solanaNamed = buildExecutorDashboard({ floorNo: 50, nowMs: now,
    heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
      health: { state: "healthy",
        caps: { maxSolPerTrade: 0.005, dailySolCap: 0.01, dailyLossLimitSol: 0.01, maxOpenPositions: 4 },
        executionReadiness: { ready: true, providers: 2, route: "wsol-usdc",
          lastSuccessAt: now - 1_000, observedAt: now - 1_000, amountLamports: 5_000_000 } } } });
  assert.equal(solanaNamed.capPolicy.active, null, "Solana cap names are not read as ETH caps");
  assert.equal(solanaNamed.telemetry.heartbeat.health.executionReadiness.route, null);
  assert.equal(solanaNamed.telemetry.heartbeat.health.executionReadiness.amountWei, "0");
  assert.equal(solanaNamed.activation.executionReadinessReady, false);
  assert.equal(solanaNamed.telemetry.heartbeat.health.state, "degraded");
}

const capsMissing = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy" } },
  balanceResult: { ok: true, wei: "1000000000000000000", eth: 1, observedAt: now } });
assert.equal(capsMissing.wallet.state, "active-caps-unavailable");
assert.equal(capsMissing.activation.walletFunded, false,
  "a positive balance cannot claim readiness until active caps are known");
assert.equal(capsMissing.telemetry.heartbeat.health.state, "degraded",
  "a live heartbeat without active-cap evidence cannot display healthy status");
const capsBelowMinimum = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { maxEthPerTrade: 0.0000009,
      dailyEthCap: 0.0008, dailyLossLimitEth: 0.0008, maxOpenPositions: 4 } } } });
assert.equal(capsBelowMinimum.capPolicy.active, null);
assert.equal(capsBelowMinimum.telemetry.heartbeat.health.state, "degraded");
const readinessMissing = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { maxEthPerTrade: 0.0004,
      dailyEthCap: 0.0008, dailyLossLimitEth: 0.0008, maxOpenPositions: 4 } } } });
assert.equal(readinessMissing.telemetry.heartbeat.health.state, "degraded",
  "a live heartbeat without readiness evidence cannot display healthy status");
const readinessStale = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "healthy", caps: { maxEthPerTrade: 0.0004,
      dailyEthCap: 0.0008, dailyLossLimitEth: 0.0008, maxOpenPositions: 4 },
    executionReadiness: { ready: true, providers: 2, route: "eth-usdg",
      lastSuccessAt: now - 300_001, observedAt: now - 300_001,
      amountWei: "400000000000000" } } } });
assert.equal(readinessStale.telemetry.heartbeat.health.state, "degraded",
  "stale live readiness cannot display healthy status");
const manualWithoutReadiness = buildExecutorDashboard({ floorNo: 50, nowMs: now,
  heartbeat: { mode: "live", wallet, seenAt: now - 1_000,
    health: { state: "manual-action", caps: { maxEthPerTrade: 0.0004,
      dailyEthCap: 0.0008, dailyLossLimitEth: 0.0008, maxOpenPositions: 4 } } } });
assert.equal(manualWithoutReadiness.telemetry.heartbeat.health.state, "manual-action",
  "missing readiness must not hide a higher-severity operator action state");

const stale = buildExecutorDashboard({
  floorNo: 50, nowMs: now,
  heartbeat: { mode: "paper", wallet, seenAt: now - 151_000,
    health: { executionReadiness: { ready: true, providers: 2,
      lastSuccessAt: now - 20_000, observedAt: now - 20_000,
      route: "eth-usdg", amountWei: "4000000000000000" },
      caps: { maxEthPerTrade: 0.004, dailyEthCap: 0.04,
        dailyLossLimitEth: 0.012, maxOpenPositions: 4 } } },
  balanceResult: { ok: true, wei: "1000000000000000", eth: 0.001 },
});
assert.equal(stale.telemetry.connected, false);
assert.equal(stale.wallet.state, "below-readiness-reserve",
  "the historical wallet balance may remain visible for diagnosis");
assert.equal(stale.capPolicy.activeFresh, false);
for (const gate of ["currentPaperMode", "currentLiveMode", "executionReadinessReady",
  "walletReported", "walletFunded"]) {
  assert.equal(stale.activation[gate], false,
    `stale telemetry cannot complete the ${gate} activation gate`);
}

const privateSettings = {
  webhook_url: "https://hooks.example/private",
  executor_url: "https://executor.example/private",
  executor_secret: "feed-secret",
  executor_heartbeat: JSON.stringify({ wallet, held: [{ mint }] }),
  appetite: "aggressive",
};
const guestSettings = floorFeedSettingsForViewer(privateSettings);
assert.equal(guestSettings.webhook_url, "(set)");
assert.equal(guestSettings.executor_url, "(set)");
assert.equal(guestSettings.executor_secret, null);
assert.equal(guestSettings.executor_heartbeat, null,
  "a guest call-sheet response cannot bypass the owner-only executor status route");
assert.equal(guestSettings.appetite, "aggressive");
assert.deepEqual(floorFeedSettingsForViewer(privateSettings, { isOwner: true }), privateSettings,
  "the authenticated owner retains their private setup fields");

const secret = settingsFor(HQ_FLOOR).executor_secret;
db.prepare("UPDATE copy_settings SET appetite='aggressive', bankroll_sol=2, executor_heartbeat=? WHERE floor_no=?")
  .run(JSON.stringify({
    mode: "live", wallet, cursor: 42, open: 1, held: [{ mint, eth: 0.0004 }],
    health: { state: "healthy", executionReadiness: {
      ready: true, lastSuccessAt: now - 1_000, observedAt: now - 2_000,
      route: "eth-usdg", providers: 2, amountWei: "400000000000000",
    }, caps: { maxEthPerTrade: 0.0004, dailyEthCap: 0.0008,
      dailyLossLimitEth: 0.0008, maxOpenPositions: 4 } },
    ts: now - 3_000, seenAt: now - 2_000,
  }), HQ_FLOOR);
let balanceReads = 0;
const payload = await executorStatusPayload(HQ_FLOOR, {
  nowMs: now,
  balanceReader: async (address) => {
    balanceReads++;
    assert.equal(address, wallet);
    return { ok: true, wei: "20000000000000000", eth: 0.02 };
  },
});
assert.equal(balanceReads, 1);
assert.equal(payload.wallet.balanceEth, 0.02);
assert.equal(payload.wallet.balanceWei, "20000000000000000");
assert.equal(payload.activation.currentLiveMode, true);
assert.ok(!JSON.stringify(payload).includes(secret));

const source = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
const routeStart = source.indexOf("const executorStatusMatch");
const routeEnd = source.indexOf("RETIRED BROWSER RPC LANE");
const route = source.slice(routeStart, routeEnd);
assert.ok(routeStart > 0 && routeEnd > routeStart);
assert.match(route, /req\.method !== "GET"/);
assert.match(route, /!holdsFloor\(floorNo\)/);
assert.match(route, /executorStatusPayload\(floorNo\)/);
assert.doesNotMatch(route, /readBody|signTransaction|sendTransaction|executor_secret/);

const pollerSource = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
/* The executor's ETH names (poller.mjs LIVE_LIMITS / OPERATOR_MAX, read 2026-09-05). */
for (const [key, value] of Object.entries({
  maxEthPerTrade: 0.0004,
  dailyEthCap: 0.0008,
  dailyLossLimitEth: 0.0008,
  maxOpenPositions: 4,
})) {
  assert.match(pollerSource, new RegExp(`${key}:\\s*${String(value).replace(".", "\\.")}`),
    `dashboard canary default ${key} must stay pinned to the executor's default`);
}
for (const [key, value] of Object.entries({
  maxEthPerTrade: 0.004,
  dailyEthCap: 0.04,
  dailyLossLimitEth: 0.012,
})) {
  assert.match(pollerSource, new RegExp(`OPERATOR_MAX[\\s\\S]*${key}:\\s*${String(value).replace(".", "\\.")}`),
    `dashboard operator maximum ${key} must stay pinned to the executor policy`);
}
assert.match(pollerSource, /I acknowledge WALL-ST-E caps v3/);
assert.doesNotMatch(pollerSource, /I raise the live caps for/);

console.log("\nWALL-ST-E dashboard is owner-only, read-only, and secret-safe\n");
