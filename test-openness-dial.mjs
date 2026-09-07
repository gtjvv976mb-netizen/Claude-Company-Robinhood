/**
 * HOW OPEN THE DESK IS — one dial, and the line it must not cross.
 *
 * The band floors are QUALITY bars: "too quiet to bother with". They are not safety
 * facts. A honeypot, a sell that reverts, a position that cannot be exited and one wallet
 * holding the float are measured elsewhere and are untouched by this setting — that
 * separation is the whole reason it is safe to have a dial at all.
 *
 * The old numbers were pump.fun's and rejected 88% of this market. Measured 2026-09-07 on
 * the desk's own DexScreener universe: liquidity p50 $13.4k, volume p50 $322,
 * transactions p50 23 — against a medium band asking $8,000 and 40. On pump.fun a live
 * coin does $8k in an hour; here the median on-board coin does $322 in a DAY.
 *
 *   node test-openness-dial.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

/** Read the floors a given DESK_OPENNESS produces, in a clean process. */
const floorsAt = (level) => JSON.parse(execFileSync(process.execPath,
  ["--input-type=module", "-e",
   'const c = await import("./src/config.js");' +
   'console.log(JSON.stringify({ level: c.OPENNESS, bands: c.BAND_FLOORS, flat: c.floorsFor(null) }));'],
  { cwd: new URL(".", import.meta.url).pathname,
    env: { ...process.env, DESK_OPENNESS: level ?? "", CLAUDE_CO_DB: "/tmp/openness-test.db" },
    encoding: "utf8" }).trim());

console.log("\nTHE DIAL ACTUALLY MOVES THE FLOORS");
const strict = floorsAt("strict"), open = floorsAt("open"), wide = floorsAt("wide");
ok("strict is the old pump.fun bar", () => {
  assert.equal(strict.bands.medium.vol, 8_000);
  assert.equal(strict.bands.medium.txns, 40);
});
ok("open is materially looser than strict", () => {
  assert.ok(open.bands.medium.vol < strict.bands.medium.vol / 10,
    `open $${open.bands.medium.vol} vs strict $${strict.bands.medium.vol}`);
  assert.ok(open.bands.medium.txns < strict.bands.medium.txns / 4);
});
ok("wide is looser again", () =>
  assert.ok(wide.bands.medium.vol < open.bands.medium.vol));
ok("every level is monotonic across the four bars", () => {
  for (const k of ["liq", "vol", "txns"])
    assert.ok(strict.bands.medium[k] > open.bands.medium[k] && open.bands.medium[k] > wide.bands.medium[k],
      `${k} is not monotonic across strict > open > wide`);
});

console.log("\nTHE DEFAULT IS 'open' (owner, 2026-09-07)");
ok("an unset DESK_OPENNESS means open", () => assert.equal(floorsAt("").level, "open"));
ok("an unknown value falls back to open rather than crashing or going strict", () =>
  assert.equal(floorsAt("banana").level, "open"));

console.log("\nTHE SHAPE SURVIVES THE DIAL");
for (const [name, f] of [["strict", strict], ["open", open], ["wide", wide]]) {
  ok(`${name}: a bigger coin still clears a higher bar`, () => {
    assert.ok(f.bands.nano.liq < f.bands.medium.liq);
    assert.ok(f.bands.medium.liq < f.bands.very_high.liq);
  });
  ok(`${name}: an unknown cap gets the STRICTEST band, never the loosest`, () => {
    assert.equal(f.flat.liq, f.bands.very_high.liq);
    assert.ok(f.flat.liq > f.bands.nano.liq);
  });
}

console.log("\nNO LEVEL ADMITS A COIN BY ARITHMETIC");
for (const [name, f] of [["strict", strict], ["open", open], ["wide", wide]]) {
  ok(`${name}: no floor is zero`, () => {
    for (const [band, v] of Object.entries(f.bands))
      assert.ok(v.liq > 0 && v.vol > 0 && v.txns >= 1,
        `${band} has a zero floor: ${JSON.stringify(v)}`);
  });
}

console.log("\nTHE DIAL CANNOT REACH A SAFETY FACT");
ok("no openness level touches the honeypot, exit or concentration gates", () => {
  const fs = require("node:fs");
  const cfgSrc = fs.readFileSync(new URL("./src/config.js", import.meta.url), "utf8");
  const block = cfgSrc.slice(cfgSrc.indexOf("const OPENNESS_LEVELS"), cfgSrc.indexOf("export const BAND_FLOORS"));
  for (const gate of ["cannot_exit", "honeypot", "sellSim", "holder_concentration",
                      "mint_role_live", "blacklist", "lp_pullable", "maxRoundTripSlippagePct"])
    assert.ok(!block.includes(gate), `the dial must not reach ${gate}`);
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
