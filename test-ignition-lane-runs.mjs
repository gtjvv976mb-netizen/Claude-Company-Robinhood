/**
 * THE IGNITION LANE MUST ACTUALLY RUN.
 *
 * ignitionUniverse() is the only path that can see a PONS launch and the only source of
 * a minute tape. Its single caller was warmFunnel(), and warmFunnel() is called ONLY
 * from the `if (book.full)` branch of the cycle — so on a desk whose book has never been
 * full it had NEVER EXECUTED. Meanwhile the paid path took its universe from the keyword
 * sweep alone, which returns dexId "uniswap" for 68 of 69 RH pairs and carries no launch
 * data at all. A lane built to see coins at birth, dark on every cycle the desk ever ran.
 *
 *   node test-ignition-lane-runs.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};
const src = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");

console.log("\nONE UNIVERSE, BUILT ONCE, USED BY BOTH PATHS");
ok("the merge is its own exported function", () =>
  assert.match(src, /export async function mergedUniverse\(\)/));
ok("it draws from BOTH the sweep and the ignition lane", () =>
  assert.match(src, /Promise\.all\(\[sweep\(\), ignitionUniverse\(\)\]\)/));
ok("warmFunnel uses it", () =>
  assert.match(src, /const \{ universe, igniting: ignitingCount \} = await mergedUniverse\(\);/));
ok("and so does the PAID path — the one that runs when the book is not full", () =>
  assert.match(src, /const universe = \(await mergedUniverse\(\)\)\.universe\.map\(canonicalCandidate\);/));
ok("the paid path no longer takes the keyword sweep alone", () => {
  /* The cycle's own universe line is the one under test. Other lanes (freshScan) may
     legitimately sweep only; this pins the CYCLE. */
  const cycle = src.slice(src.indexOf("emit(\"cycle:start\""), src.indexOf("emit(\"cohort:ranked\""));
  assert.ok(!/const universe = \(await sweep\(\)\)/.test(cycle),
    "the paid path must not rebuild a sweep-only universe");
});

console.log("\nIGNITION ROWS WIN THE DEDUPE, BECAUSE THEY CARRY THE TAPE");
ok("ignition is merged first", () =>
  assert.match(src, /for \(const raw of \[\.\.\.igniting, \.\.\.swept\]\)/));
ok("first writer wins, so the richer row survives", () =>
  assert.match(src, /if \(!merged\.has\(c\.mint\)\) merged\.set\(c\.mint, c\);/));
ok("every row is canonicalised on both keys", () => {
  assert.match(src, /mint: canonicalAddress\(raw\.mint\), launchpad: canonicalLaunchpad\(raw\.launchpad\)/);
});

console.log("\nTHE LANE IS STILL ALLOWED TO FAIL WITHOUT TAKING THE CYCLE DOWN");
ok("an unavailable ignition lane returns an empty list, not a throw", () =>
  assert.match(src, /emit\("ignition:unavailable"[\s\S]{0,120}?return \[\];/));

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
