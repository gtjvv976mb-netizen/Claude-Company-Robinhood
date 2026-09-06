import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ── A MONITOR MUST NOT REPORT A CONTROL IT NEVER READ ────────────────────────
 * readExecutorEnv returns {} for a missing file, and every control path then falls
 * back to a default relative to executorDir — which defaults to process.cwd(). Run
 * from anywhere but the install directory, the monitor reported "not paused, not
 * hard-stopped" while looking at paths that do not exist. A monitor that says the
 * safety controls are clear because it could not find them is worse than no monitor.
 *
 * And it is the DEFAULT way it would be run: install.sh never scheduled this program
 * and mentioned it only inside a download list, so nobody was ever told which
 * directory it needs. */
const { inspectExecutor } = await import("./monitor.mjs");

let n = 0;
/* AWAITED. The first version of this helper was synchronous while every body was
   async, so the promises were never awaited and every assertion inside them was
   unobserved — the PASS lines printed no matter what the code did. A test that
   cannot fail is worse than no test, and this file exists to catch exactly that
   shape of lie elsewhere. */
const ok = async (name, fn) => { await fn(); n++; console.log(`PASS  ${name}`); };
const critical = (r) => (r.issues || []).filter((i) => i.severity === "critical").map((i) => i.code);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-monitor-"));

const run = (over = {}) => inspectExecutor({
  executorDir: dir, environment: {}, fetchFn: async () => { throw new Error("no network in this test"); },
  processProbe: () => ({ alive: false }), runtimeFingerprintFn: () => null,
  oracleProbe: async () => ({ ok: false, reason: "skipped" }),
  sleepAssertionProbe: () => ({ ok: true }), requireSleepAssertion: false,
  assertLiveReadyFn: () => true, now: () => 1_800_000_000_000, ...over,
});

await ok("with no environment file it says the control state is guessed, loudly", async () => {
  const r = await run();
  assert.ok(critical(r).includes("executor_env_unreadable"),
    `expected a critical executor_env_unreadable, got ${JSON.stringify(critical(r))}`);
  assert.equal(r.controls.controlsRead, false,
    "and the report says outright that the controls were not read");
});

await ok("the guess warning names the directory it guessed from", async () => {
  const r = await run();
  const m = (r.issues || []).find((i) => i.code === "executor_env_unreadable");
  assert.match(m.message, /GUESSED/, "the word matters — a reader skims");
  assert.match(m.message, /--executor-dir/, "and it must say how to fix it");
});

await ok("given the control paths explicitly, it stops warning and reports for real", async () => {
  const pause = path.join(dir, "PAUSE_ENTRIES");
  const hard = path.join(dir, "HARD_STOP");
  const r = await run({ environment: { PAUSE_ENTRIES_FILE: pause, HARD_STOP_FILE: hard } });
  assert.ok(!critical(r).includes("executor_env_unreadable"));
  assert.equal(r.controls.controlsRead, true);
  assert.equal(r.controls.hardStop, false, "absent really is absent when we know where to look");
});

await ok("and it sees a hard stop that is actually there", async () => {
  const pause = path.join(dir, "PAUSE_ENTRIES");
  const hard = path.join(dir, "HARD_STOP");
  fs.writeFileSync(hard, "", { mode: 0o600 });
  const r = await run({ environment: { PAUSE_ENTRIES_FILE: pause, HARD_STOP_FILE: hard } });
  assert.equal(r.controls.hardStop, true);
  assert.equal(r.controls.controlsRead, true);
  fs.rmSync(hard);
});

/* The installer must actually tell someone this program exists, with a flag the
   parser accepts — an unknown argument throws. */
await ok("the installer prints a monitor command whose flags the parser accepts", () => {
  const install = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  const monitorSrc = fs.readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
  assert.match(install, /node \$CURRENT_LINK\/monitor\.mjs --executor-dir \$INSTALL_DIR/,
    "the summary must name the monitor and pass the install directory");
  const accepted = new Set([...monitorSrc.matchAll(/argv\[i\] === "(--[a-z-]+)"/g)].map((m) => m[1])
    .concat([...monitorSrc.matchAll(/\["(--[a-z-]+)", "(--[a-z-]+)"\]/g)].flatMap((m) => [m[1], m[2]])));
  for (const line of install.match(/monitor\.mjs [^\n]*/g) || [])
    for (const flag of line.match(/--[a-z-]+/g) || [])
      assert.ok(accepted.has(flag), `install.sh offers ${flag}; monitor.mjs throws on unknown arguments`);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} monitor honesty checks passed`);
