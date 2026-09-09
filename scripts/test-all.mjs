import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every test is discovered so newly-added regressions join CI without somebody
// remembering to update a second list. The installer test receives `.` and therefore
// validates the local release graph without touching the network.
const rootTests = fs.readdirSync(root)
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .sort();
const executorTests = fs.readdirSync(path.join(root, "executor"))
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .sort()
  .map((name) => path.join("executor", name));
const tests = [...rootTests, ...executorTests];

/* NO TEST MAY REACH THE NETWORK. Preloaded into every one of them; see the file for why.
   Live checks are the scripts/check-*-live.mjs family, run deliberately. */
const offlineGuard = pathToFileURL(path.join(root, "scripts", "offline-guard.mjs")).href;

let failed = 0;
const started = Date.now();

for (const test of tests) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-co-test-"));
  const dbFile = path.join(sandbox, "journal.sqlite");
  process.stdout.write(`\n\u2501\u2501 ${test} \u2501\u2501\n`);
  const args = ["--import", offlineGuard,
    ...(test === path.join("executor", "test-install.mjs") ? [test, "."] : [test])];
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    // Keep stderr available for a GitHub check annotation while preserving the
    // ordinary local/CI transcript. Public Actions logs may require authentication;
    // the annotation makes the exact failed test and assertion visible on the
    // commit's public check result without weakening the test gate.
    stdio: ["inherit", "inherit", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CLAUDE_CO_DB: dbFile,
      // A regression test must never spend model credit merely because the developer
      // running it happens to have a populated shell.
      ANTHROPIC_API_KEY: "",
      XAI_API_KEY: "",
      OPENAI_API_KEY: "",
      CODEX_IMPROVEMENT_MODEL: "",
      EXECUTE: "0",
    },
  });
  if (run.stderr) process.stderr.write(run.stderr);
  fs.rmSync(sandbox, { recursive: true, force: true });

  if (run.status !== 0) {
    failed++;
    const why = run.error?.message || run.signal || `exit ${run.status}`;
    console.error(`FAIL ${test} (${why})`);
    if (process.env.GITHUB_ACTIONS === "true") {
      const detail = String(run.stderr || why).slice(-4_000)
        .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
      console.error(`::error file=${test},title=Regression failed::${detail}`);
    }
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${tests.length - failed}/${tests.length} test files passed in ${elapsed}s.`);
if (failed) console.error(`${failed} test file${failed === 1 ? "" : "s"} failed.`);
process.exit(failed ? 1 : 0);
