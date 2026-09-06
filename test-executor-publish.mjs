import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE INSTALLER AND THE PUBLISHER MUST AGREE ───────────────────────────────
 * install.sh downloads a fixed list of runtime files from the published site and
 * runs `curl -f ... || exit 1`, so ONE missing file aborts every remote install.
 * The publish list in scripts/build-viewer.mjs drifted from it: token2022.mjs is
 * a runtime import of jupiter.mjs, the installer fetched it, the build never
 * published it, and https://claudedotcompany.com/executor/token2022.mjs was a
 * 404 — so the documented one-command install was broken outright.
 *
 * A comment already warned about this exact class of bug ("an install that
 * fetches this list without them dies at boot"). A comment is not a test. This
 * derives BOTH lists from the source and refuses any file the installer wants
 * and the build does not ship. */
const install = fs.readFileSync(new URL("./executor/install.sh", import.meta.url), "utf8");
const build = fs.readFileSync(new URL("./scripts/build-viewer.mjs", import.meta.url), "utf8");

const runtime = install.match(/RUNTIME_FILES=\(([^)]*)\)/)?.[1]?.trim().split(/\s+/) ?? [];
assert.ok(runtime.length >= 10, `could not read RUNTIME_FILES from install.sh (got ${runtime.length})`);

/* the live-mode source-integrity loop fetches the same set plus the manifests */
const sourceLoop = install.match(/for source_file in ([^;]+); do/)?.[1]?.trim().split(/\s+/) ?? [];
assert.ok(sourceLoop.length >= 10, "could not read the live source-file loop from install.sh");

const publishBlock = build.match(/const EXECUTOR_FILES = \[([\s\S]*?)\n\];/)?.[1] ?? "";
assert.ok(publishBlock, "could not read EXECUTOR_FILES from build-viewer.mjs");
const published = new Set([...publishBlock.matchAll(/"([\w.-]+\.[a-z]+)"/g)].map((m) => m[1]));

for (const f of new Set([...runtime, ...sourceLoop])) {
  assert.ok(published.has(f),
    `install.sh fetches executor/${f} but the build never publishes it — every remote install would abort on it`);
}

/* Every published .mjs must also exist, or the build throws at a worse moment. */
for (const f of published) {
  assert.ok(fs.existsSync(new URL(`./executor/${f}`, import.meta.url)),
    `EXECUTOR_FILES lists ${f}, which is not in executor/`);
}

/* ── DERIVE THE RUNTIME, DO NOT ENUMERATE IT ──────────────────────────────────
 * Walk poller.mjs's transitive relative imports. That set IS the trading runtime;
 * every hand-maintained list about it must equal or contain it. Note the regex has
 * to tolerate a multi-line import — poller.mjs's jupiter.mjs import spans several
 * lines, and a lazier pattern silently drops that whole subtree. */
/* Three forms, and all three are load-bearing:
 *   import { x } from "./a.mjs"      — the ordinary one
 *   import "./b.mjs"                 — SIDE-EFFECT ONLY, no `from` clause. The Robinhood
 *                                      poller registers its measured live thresholds this
 *                                      way; a walker without this arm calls that module
 *                                      dead and would let it drop out of the fingerprint.
 *   await import("./c.mjs")          — dynamic
 * A multi-line import must match too: poller.mjs's jupiter.mjs import spans several lines. */
const IMPORT = /from\s+"\.\/([^"]+)"|(?:^|[;{}\s])import\s+"\.\/([^"]+)"|import\(\s*"\.\/([^"]+)"/gm;
const runtimeClosure = (() => {
  const seen = new Set(); const queue = ["poller.mjs"];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    let src;
    try { src = fs.readFileSync(new URL(`./executor/${f}`, import.meta.url), "utf8"); }
    catch { continue; }
    seen.add(f);
    for (const m of src.matchAll(IMPORT)) queue.push(m[1] ?? m[2] ?? m[3]);
  }
  return seen;
})();
assert.ok(runtimeClosure.size >= 12, `import walk found only ${runtimeClosure.size} modules — the walker is broken`);

/* A module the bot loads but the build never publishes dies at boot. */
for (const f of runtimeClosure)
  assert.ok(published.has(f),
    `the trading runtime loads ./${f}, which the build does not publish — the installed bot would die at boot`);

/* ── THE FINGERPRINT MUST COVER EXACTLY WHAT RUNS ─────────────────────────────
 * executorRuntimeFingerprint calls itself "a byte identity for exactly the modules
 * loaded by the trading process". It listed 14 while poller.mjs loads 15, and the
 * one it missed was token2022.mjs — the Token-2022 mint auditor, which decides
 * whether a mint can tax, block or freeze the holder. Its bytes could have changed
 * without changing the identity the heartbeat reports. Both directions are checked:
 * a module that runs unfingerprinted is a hole, and a fingerprinted module that
 * does not run makes the identity depend on bytes that cannot affect behaviour. */
{
  const hh = fs.readFileSync(new URL("./executor/heartbeat-health.mjs", import.meta.url), "utf8");
  const block = hh.match(/TRADING_RUNTIME_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(block, "could not read TRADING_RUNTIME_FILES");
  /* only real artifact names — a quoted phrase inside a comment is not a module */
  const fingerprinted = new Set([...block.matchAll(/"([\w.-]+\.mjs)"/g)].map((m) => m[1]));
  const unfingerprinted = [...runtimeClosure].filter((f) => !fingerprinted.has(f));
  assert.deepEqual(unfingerprinted, [],
    `the trading process loads these modules but the runtime fingerprint does not cover them: ${unfingerprinted.join(", ")}`);
  const notLoaded = [...fingerprinted].filter((f) => !runtimeClosure.has(f));
  assert.deepEqual(notLoaded, [],
    `the fingerprint covers modules the trading process does not load: ${notLoaded.join(", ")}`);
}

console.log(`executor publish list covers all ${runtime.length} installer runtime files and their imports`);
