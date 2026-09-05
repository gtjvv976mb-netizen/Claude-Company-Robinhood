import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyProcessTopology, inspectExecutor, readExecutorEnv } from "./monitor.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const RUNTIME_FINGERPRINT = "b".repeat(32);
const WALLET = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wallste-monitor-"));
const makeDb = (file, { cursor = 12, positions = [], intents = [] } = {}) => {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    CREATE TABLE positions(mint TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE intents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,mint TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT;
  `);
  const meta = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
  meta.run("cursor", JSON.stringify(cursor)); meta.run("primed", "true");
  meta.run("wallet", JSON.stringify(WALLET));
  meta.run("risk_state", JSON.stringify({ deployedTodaySol: 0, realizedTodaySol: 0, wins: 0, losses: 0 }));
  for (const row of positions) db.prepare("INSERT INTO positions VALUES(?,?,?)")
    .run(row.mint, JSON.stringify(row.data), row.updatedAt);
  for (const row of intents) db.prepare("INSERT INTO intents VALUES(?,?,?,?,?)")
    .run(row.id, row.kind, row.mint, row.state, row.updatedAt);
  db.close(); fs.chmodSync(file, 0o600);
};
const writeConfig = (dir, extraLines = []) => {
  const file = path.join(dir, ".cc-executor.env");
  fs.writeFileSync(file, [
    "CC_API='https://example.invalid'", "CC_FLOOR=50", "CC_SECRET=TOP_SECRET_NEVER_PRINT",
    "EXECUTE=1", `STATE_DB=${path.join(dir, ".cc-executor.sqlite")}`,
    "RH_RPC=https://primary.invalid/key/PRIMARY_SECRET",
    "RH_RPC_SECONDARY=https://secondary.invalid/key/SECONDARY_SECRET",
    `EXECUTOR_SOURCE_COMMIT=${SOURCE_COMMIT}`,
    ...extraLines,
  ].join("\n"), { mode: 0o600 });
  return file;
};
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const processProbe = async () => ({ alive: true, commandMatches: true,
  cwdMatches: true, identityVerified: true, supervisor: "launchd" });
const runtimeFingerprintFn = () => RUNTIME_FINGERPRINT;
const oracleProbe = async () => ({ source: "chainlink-eth-usd-4663-v1", price: 2455.22,
  publishTime: 999, confidencePct: 0.5, divergencePct: 0 });
/* The registry is VOID on this chain by design (live-thresholds.mjs); the monitor
   mirrors the poller's refusal. Scenarios about OTHER checks inject a passing gate so
   they assert one thing each; the last scenario asserts the real gate refuses. */
const liveReady = () => true;
const inspect = (options = {}) => inspectExecutor({ requireSleepAssertion: false, assertLiveReadyFn: liveReady, ...options });
const heartbeat = (now, extra = {}) => ({
  mode: "live", wallet: WALLET, cursor: 12, open: 0, seenAt: now - 1_000,
  health: {
    state: "healthy", lastTickCompletedAt: now - 1_000, lastFeedSuccessAt: now - 1_000,
    consecutiveFeedFailures: 0, consecutiveTickFailures: 0,
    runtimeCommit: SOURCE_COMMIT, runtimeFingerprint: RUNTIME_FINGERPRINT,
    feedRollback: false,
    executionReadiness: {
      ready: true, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "weth-usdg", providers: 2, amountWei: "400000000000000",
    },
    caps: {
      maxEthPerTrade: 0.0004, dailyEthCap: 0.0008,
      dailyLossLimitEth: 0.0008, maxOpenPositions: 4,
    },
  },
  ...extra,
});

{
  const source = fs.readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
  const boundedOracleProviders = source.match(
    /createRpc\((?:primaryUrl|secondaryUrl), \{ label: "(?:primary|secondary) RPC" \}\)/g,
  ) || [];
  assert.equal(boundedOracleProviders.length, 2,
    "both recurring monitor oracle providers must use the shared aborting RPC transport, labelled and never logged by URL");
  assert.ok(/independentEthUsdPrice\(\[primary, secondary\]/.test(source), "the oracle is read through BOTH providers");
  assert.ok(!/@solana|Pyth|mainnet-beta|lamports/i.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")),
    "no Solana residue in the monitor's code");
}

{
  const dir = tmp();
  writeConfig(dir, ["MAX_ETH_PER_TRADE=0.004", "DAILY_ETH_CAP=0.04",
    "DAILY_LOSS_LIMIT_ETH=0.012", "MAX_OPEN_POSITIONS=4"]);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  const now = 1_000_000;
  const raisedHealth = {
    ...heartbeat(now).health,
    caps: { maxEthPerTrade: 0.004, dailyEthCap: 0.04,
      dailyLossLimitEth: 0.012, maxOpenPositions: 4 },
    executionReadiness: { ...heartbeat(now).health.executionReadiness,
      amountWei: "4000000000000000" },
  };
  const report = await inspect({
    executorDir: dir, environment: {}, now, processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(now, { health: raisedHealth }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "healthy");
  assert.ok(!report.issues.some((item) =>
    ["heartbeat_caps_mismatch", "execution_readiness_size_mismatch"].includes(item.code)));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = "/private/tmp/Claude Company/executor";
  const runnerCommand = `/usr/local/bin/node ${dir}/launchd-runner.mjs run ` +
    `--env ${dir}/.cc-executor.env --poller ${dir}/poller.mjs ` +
    "--label com.claudeco.wallste";
  const manualRunner = classifyProcessTopology({ pid: 41, command: runnerCommand,
    cwd: dir, executorDir: dir, registeredLaunchdPid: null });
  const supervisedRunner = classifyProcessTopology({ pid: 41, command: runnerCommand,
    cwd: dir, executorDir: dir, registeredLaunchdPid: 41 });
  assert.equal(manualRunner.supervisor, "manual",
    "matching runner arguments alone cannot claim LaunchAgent supervision");
  assert.equal(supervisedRunner.supervisor, "launchd",
    "the exact registered LaunchAgent pid can prove supervision");
}

{
  const dir = tmp();
  const envFile = writeConfig(dir);
  assert.equal(readExecutorEnv(envFile).CC_SECRET, "TOP_SECRET_NEVER_PRINT");
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  const seen = [];
  const report = await inspect({
    executorDir: dir, environment: { CC_SECRET: "AMBIENT_WRONG", EXECUTE: "0" }, now: 1_000_000,
    processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url, options) => {
      assert.equal(options.headers.authorization, "Bearer TOP_SECRET_NEVER_PRINT");
      seen.push(url);
      if (url.endsWith("/heartbeat")) return response({ heartbeat: heartbeat(1_000_000) });
      return response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] });
    },
  });
  assert.equal(report.status, "healthy");
  assert.equal(report.mode, "live", "the protected service file overrides ambient shell configuration");
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.unpauseReadiness, "not-paused");
  assert.equal(report.feed.cursorLag, 0);
  assert.equal(seen.length, 2);
  assert.ok(!JSON.stringify(report).includes("TOP_SECRET_NEVER_PRINT"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, runtimeFingerprintFn, oracleProbe,
    processProbe: async () => ({ alive: true, commandMatches: true,
      cwdMatches: false, identityVerified: false, supervisor: "launchd" }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { cursor: 11, open: 1, health: {
          ...heartbeat(1_000_000).health, runtimeFingerprint: "c".repeat(32),
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "critical");
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.unpauseReadiness, "blocked");
  for (const code of ["process_identity_unverified", "heartbeat_runtime_mismatch",
    "heartbeat_cursor_mismatch", "heartbeat_open_mismatch"])
    assert.ok(report.issues.some((item) => item.code === code), `missing ${code}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000,
    processProbe, runtimeFingerprintFn, oracleProbe, requireSleepAssertion: true,
    sleepAssertionProbe: async () => ({ ok: true, assertionPid: 12345, acPower: true,
      idleSystemSleep: true, systemSleep: true }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "entries-paused");
  assert.equal(report.safeToUnpause, true,
    "a deliberate pause can be certified without reporting the trader as actively healthy");
  assert.equal(report.unpauseReadiness, "ready");
  assert.equal(report.process.supervisor, "launchd");
  assert.equal(report.sleepAssertion.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, runtimeFingerprintFn, oracleProbe,
    processProbe: async () => ({ alive: true, commandMatches: true, cwdMatches: true,
      identityVerified: true, supervisor: "manual" }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.process.supervisor, "manual");
  assert.ok(report.issues.some((item) => item.code === "supervisor_unverified"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, runtimeFingerprintFn, oracleProbe,
    processProbe, requireSleepAssertion: true,
    sleepAssertionProbe: async () => ({ ok: false, reason: "caffeinate exited" }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.sleepAssertion.ok, false);
  assert.ok(report.issues.some((item) => item.code === "sleep_assertion_missing"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000,
    processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 11, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  assert.equal(report.feed.ok, false);
  assert.equal(report.feed.cursorLag, -1);
  assert.ok(report.issues.some((item) => item.code === "feed_cursor_regression"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const now = 1_000_000;
  const cases = [
    [null, "execution_readiness_missing"],
    [{ ready: false, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "weth-usdg", providers: 2, amountWei: "400000000000000" }, "execution_readiness_failed"],
    [{ ready: true, lastSuccessAt: now - 300_001, observedAt: now - 300_001,
      route: "weth-usdg", providers: 2, amountWei: "400000000000000" }, "execution_readiness_stale"],
    [{ ready: true, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "wsol-usdc", providers: 2, amountWei: "400000000000000" }, "execution_readiness_invalid"],
    [{ ready: true, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "weth-usdg", providers: 1, amountWei: "400000000000000" }, "execution_readiness_invalid"],
    [{ ready: true, lastSuccessAt: now - 1_000, observedAt: now - 1_000,
      route: "weth-usdg", providers: 2, amountWei: "399999999999999" },
    "execution_readiness_size_mismatch"],
  ];
  for (const [executionReadiness, expectedCode] of cases) {
    const report = await inspect({
      executorDir: dir, environment: {}, now, processProbe, runtimeFingerprintFn, oracleProbe,
      fetchFn: async (url) => url.endsWith("/heartbeat")
        ? response({ heartbeat: heartbeat(now, { health: {
            ...heartbeat(now).health, state: "entries-paused", entriesPaused: true,
            executionReadiness,
          } }) })
        : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
    });
    assert.equal(report.safeToUnpause, false);
    assert.ok(report.issues.some((item) => item.code === expectedCode), `missing ${expectedCode}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const now = 1_000_000;
  const report = await inspect({
    executorDir: dir, environment: {}, now, processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(now, { health: {
          ...heartbeat(now).health, state: "entries-paused", entriesPaused: true,
          feedRollback: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.feed.cursorLag, 0);
  assert.equal(report.safeToUnpause, false);
  assert.ok(report.issues.some((item) => item.code === "executor_feed_rollback"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  const now = 2_000_000;
  makeDb(path.join(dir, ".cc-executor.sqlite"), {
    positions: [{ mint: "MintThatMustExit111111111111", updatedAt: now - 1_000,
      data: { manualExitRequired: true, manualExitReason: "synthetic impact breach" } }],
    intents: [{ id: "entry:50:danger", kind: "entry", mint: "DangerMint111111111111",
      state: "ambiguous", updatedAt: now - 600_000 }],
  });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), "99999999\n", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now,
    processProbe: async () => ({ alive: false, commandMatches: false, supervisor: null }),
    runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: { mode: "live", cursor: 12, open: 1, seenAt: now - 600_000 } })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 14,
          events: [{ id: 13, ts: now - 120_000 }, { id: 14, ts: now - 110_000 }] }),
  });
  assert.equal(report.status, "critical");
  assert.equal(report.safeToUnpause, false);
  for (const code of ["process_dead", "position_exit_blocked", "intent_ambiguous", "feed_cursor_lag", "heartbeat_stale"])
    assert.ok(report.issues.some((item) => item.code === code), `missing ${code}`);
  assert.ok(!JSON.stringify(report).includes("TOP_SECRET_NEVER_PRINT"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe, runtimeFingerprintFn,
    oracleProbe: async () => { throw new Error("https://primary.invalid/key/MUST_NOT_PRINT"); },
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.status, "critical");
  assert.equal(report.safeToUnpause, false);
  assert.ok(report.issues.some((item) => item.code === "eth_usd_oracle_unavailable"));
  assert.ok(!JSON.stringify(report).includes("MUST_NOT_PRINT"));
  assert.ok(!JSON.stringify(report).includes("PRIMARY_SECRET"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp();
  const file = path.join(dir, ".cc-executor.env");
  fs.writeFileSync(file,
    'CC_SECRET="back\\\\slash\\"quote\\$dollar\\`tick"\nCC_FLOOR="50"\n', { mode: 0o600 });
  const parsed = readExecutorEnv(file);
  assert.equal(parsed.CC_SECRET, 'back\\slash"quote$dollar`tick');
  assert.equal(parsed.CC_FLOOR, "50");
  fs.writeFileSync(file, 'CC_SECRET="unterminated\n', { mode: 0o600 });
  assert.throws(() => readExecutorEnv(file), /unterminated quoted value/);
  fs.writeFileSync(file, 'CC_SECRET="readable-by-group"\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readExecutorEnv(file), /accessible by group or other/);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "power pause\n", { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe,
    runtimeFingerprintFn, oracleProbe, requireSleepAssertion: true,
    sleepAssertionProbe: async () => ({ ok: false, commandBound: true,
      powerSource: "battery", assertionPid: 12345, acPower: false,
      idleSystemSleep: true, systemSleep: false }),
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.process.alive, true, "the lock owner remains available for exits on battery");
  assert.equal(report.controls.entriesPaused, true);
  assert.equal(report.controls.entryPauseValid, true);
  assert.equal(report.sleepAssertion.powerSource, "battery");
  assert.equal(report.safeToUnpause, false,
    "battery power cannot be certified for unpause even when the idle assertion survives");
  assert.ok(report.issues.some((item) => item.code === "sleep_assertion_missing"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.symlinkSync(path.join(dir, "dangling-pause-target"),
    path.join(dir, ".cc-executor.sqlite.pause-entries"));
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe,
    runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.controls.entriesPaused, true,
    "a dangling pause symlink is active rather than misreported as absent");
  assert.equal(report.controls.entryPauseValid, false);
  assert.equal(report.safeToUnpause, false);
  assert.ok(report.issues.some((item) => item.code === "entry_pause_invalid"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  const lockFile = path.join(dir, ".cc-executor.sqlite.lock");
  fs.writeFileSync(lockFile, `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(`${lockFile}.sleep-assertion-fault`, "synthetic publication failure\n",
    { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe,
    runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.controls.entriesPaused, true,
    "the canonical sleep fault latch is an entry pause even without the configured pause file");
  assert.equal(report.controls.sleepAssertionFault, true);
  assert.equal(report.controls.sleepAssertionFaultValid, true);
  assert.equal(report.safeToUnpause, false,
    "monitoring can never certify unpause while the durable fault is latched");
  assert.ok(report.issues.some((item) => item.code === "sleep_assertion_fault_latched"));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // A poller wired to the Solana desk's API (or the reverse) is caught by the feed contract.
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  const report = await inspect({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe, runtimeFingerprintFn, oracleProbe,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000) })
      : response({ cluster: "mainnet-beta", latest_id: 12, events: [] }),
  });
  assert.equal(report.feed.ok, false);
  assert.ok(report.issues.some((item) => item.code === "feed_unavailable" && /non-4663/.test(item.message)),
    "a feed that does not say chain 4663 is refused");
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // The real registry: VOID live thresholds make "safe to unpause" impossible, exactly
  // as they make the poller refuse to arm — the monitor may not certify a boot the
  // executor will refuse.
  const dir = tmp(); writeConfig(dir);
  makeDb(path.join(dir, ".cc-executor.sqlite"));
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.lock"), `${process.pid}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ".cc-executor.sqlite.pause-entries"), "", { mode: 0o600 });
  const report = await inspectExecutor({
    executorDir: dir, environment: {}, now: 1_000_000, processProbe, runtimeFingerprintFn, oracleProbe,
    requireSleepAssertion: false,
    fetchFn: async (url) => url.endsWith("/heartbeat")
      ? response({ heartbeat: heartbeat(1_000_000, { health: {
          ...heartbeat(1_000_000).health, state: "entries-paused", entriesPaused: true,
        } }) })
      : response({ chain: 4663, cluster: "robinhood-4663", latest_id: 12, events: [] }),
  });
  assert.equal(report.safeToUnpause, false);
  const gate = report.issues.find((item) => item.code === "thresholds_unmeasured");
  assert.ok(gate, "the registry gate is mirrored");
  assert.match(gate.message, /not measured on this chain/);
  assert.equal(report.chain, 4663);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n16 monitor scenarios passed\n");
