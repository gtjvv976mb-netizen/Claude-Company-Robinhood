/**
 * THE SIZE AND THE COST — the two numbers that decide whether a Robinhood trade can pay
 * for itself, and the two the fork inherited from a chain where neither meant the same.
 *
 * SIZE. poller.mjs set `fixedSol: PAPER_DEFAULTS.fixedEth` (0.0016 ETH) unconditionally,
 * and planEntry treats fixedSol as an OVERRIDE — `if (c.fixedSol > 0) want = c.fixedSol`
 * lands before every rail and discards the Kelly size. Under the canary it was clamped
 * back down and did no harm; ABOVE 0.0016 it silently defeated the caps ceremony, so an
 * operator who typed the acknowledgement to raise the cap to 0.004 still traded 0.0016.
 * On a flat-gas chain that is a 16.8% round trip instead of a 9.2% one.
 *
 * COST. strategy.mjs ships costPct 0.06 — a Jupiter round trip, proportional, on a chain
 * where gas rounded to nothing. Here gas is FLAT, so all-in cost is a U in the clip:
 * 55% at the canary, 9.2% at the operator max, a minimum near 0.0112 ETH, rising again
 * on impact. R_net = (target - cost) / (stop + cost) is the entire +EV test, so an
 * understated cost makes a losing bracket look profitable — the dangerous direction.
 *
 *   node executor/test-rh-sizing.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { expectedRoundTripPct, ROUND_TRIP_GAS, PONS_ROUND_TRIP_PCT } from "./live-thresholds.mjs";
import { DEFAULTS, planEntry, freshState } from "./strategy.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

console.log("\nTHE COST CURVE IS A U, NOT A CONSTANT");
ok("the canary clip is catastrophically expensive", () =>
  assert.ok(expectedRoundTripPct(0.0004) > 50,
    `0.0004 ETH should cost >50% of the position; got ${expectedRoundTripPct(0.0004).toFixed(2)}%`));
ok("the operator cap is an order of magnitude cheaper than the canary", () =>
  assert.ok(expectedRoundTripPct(0.004) < expectedRoundTripPct(0.0004) / 5,
    "flat gas means a 10x bigger clip is ~10x cheaper in gas terms"));
ok("cost RISES again on impact at large clips — it is not monotonically decreasing", () =>
  assert.ok(expectedRoundTripPct(0.5) > expectedRoundTripPct(0.05),
    "a model without an impact term would keep falling forever and justify unlimited size"));
ok("there is an interior minimum, and it is around 0.01 ETH", () => {
  let best = { c: null, p: Infinity };
  for (let c = 0.001; c <= 0.3; c *= 1.02) {
    const p = expectedRoundTripPct(c);
    if (p < best.p) best = { c, p };
  }
  assert.ok(best.c > 0.005 && best.c < 0.03, `minimum at ${best.c.toFixed(4)} ETH`);
  assert.ok(best.p < 8, `cheapest round trip ${best.p.toFixed(2)}% should be under 8%`);
});
ok("gas is FLAT — halving the clip roughly doubles gas as a share", () => {
  const gasEth = ROUND_TRIP_GAS * 0.309 * 1e-9;
  const at = (c) => expectedRoundTripPct(c, { impactPct: 0 });
  assert.ok(Math.abs(at(0.004) - (gasEth / 0.004) * 100) < 1e-6, "the gas term is exactly flat/clip");
  assert.ok(at(0.002) > at(0.004) * 1.9, "halving the clip must roughly double the gas share");
});
ok("the measured PONS medians are the source, not an invented curve", () => {
  assert.equal(PONS_ROUND_TRIP_PCT[0.005], 4.055);
  assert.equal(PONS_ROUND_TRIP_PCT[0.05], 8.250);
  assert.equal(PONS_ROUND_TRIP_PCT[0.5], 25.045);
});
ok("a clip is required — a missing one must not silently read as free", () => {
  assert.throws(() => expectedRoundTripPct(0), /positive/);
  assert.throws(() => expectedRoundTripPct(null), /positive/);
});

console.log("\nTHE INHERITED CONSTANT UNDERSTATES COST AT EVERY PERMITTED SIZE");
for (const clip of [0.0004, 0.0016, 0.004, 0.01]) {
  ok(`costPct 0.06 is too low at ${clip} ETH`, () =>
    assert.ok(expectedRoundTripPct(clip) > 6,
      `measured ${expectedRoundTripPct(clip).toFixed(2)}% vs the inherited 6%`));
}
ok("and the error runs in the direction that flatters a losing bracket", () => {
  const call = { mint: "0x1", symbol: "T", ts: 0, entry_ref: 1, stop: 0.85, target: 1.35 };
  const st = () => { const s = freshState(0); s.equitySol = 0.1; s.spendableSol = 0.1; s.openCount = 0; s.wins = 28; s.losses = 28; return s; };
  const inherited = planEntry({ call, cfg: { ...DEFAULTS, costPct: 0.06 }, state: st() });
  const measured = planEntry({ call, cfg: { ...DEFAULTS, costPct: expectedRoundTripPct(0.004) / 100 }, state: st() });
  assert.ok(measured.wMin > inherited.wMin,
    `the real cost must demand a HIGHER win rate: inherited ${(inherited.wMin * 100).toFixed(0)}% vs measured ${(measured.wMin * 100).toFixed(0)}%`);
});
ok("at the canary the bracket is unwinnable at ANY hit rate", () => {
  const cost = expectedRoundTripPct(0.0004) / 100;
  assert.ok(0.35 - cost < 0, "a 35% target cannot cover a 55% round trip, so R_net is negative");
  const call = { mint: "0x1", symbol: "T", ts: 0, entry_ref: 1, stop: 0.85, target: 1.35 };
  const s = freshState(0); s.equitySol = 0.1; s.spendableSol = 0.1; s.openCount = 0;
  const plan = planEntry({ call, cfg: { ...DEFAULTS, costPct: cost }, state: s });
  assert.equal(plan.action, "skip", "the +EV gate must refuse it outright");
  assert.match(plan.reason, /costs eat the target/);
});

console.log("\nCOST FOLLOWS THE CLIP, BECAUSE CONVICTION SHRINKS IT");
/* costPct was a single number priced at the per-trade CAP. Conviction scales a position
   to as little as convictionFloor (0.35) of that, and gas is FLAT — so a low-conviction
   trade takes a 0.0014 ETH position whose real round trip is 18.64% while the +EV gate
   was told 9.16%. Nine points understated, in the direction that makes a losing bracket
   look profitable. */
{
  const cfg = { ...DEFAULTS, maxSolPerTrade: 0.004, fixedSol: 0.004, minSolPerTrade: 0.0001,
    costPct: expectedRoundTripPct(0.004) / 100, costPctFor: (c) => expectedRoundTripPct(c) / 100 };
  const st = () => { const s = freshState(0); s.equitySol = 0.1; s.spendableSol = 0.1; s.openCount = 0; return s; };
  const call = (conviction) => ({ mint: "0x1", symbol: "T", ts: 0, entry_ref: 1, stop: 0.85, target: 1.35, conviction });
  const wMinAt = (conviction) => planEntry({ call: call(conviction), cfg, state: st() }).wMin;
  ok("a low-conviction trade demands a HIGHER hit rate than a full-conviction one", () =>
    assert.ok(wMinAt(35) > wMinAt(100),
      `floor ${(wMinAt(35) * 100).toFixed(0)}% vs full ${(wMinAt(100) * 100).toFixed(0)}%`));
  ok("...and the gap is the flat-gas one, not a rounding difference", () =>
    assert.ok(wMinAt(35) - wMinAt(100) > 0.1,
      "0.0014 ETH costs 18.64% where 0.004 costs 9.16% — that must show in the gate"));
  ok("a call with no conviction is priced at the full clip, not penalised", () =>
    assert.equal(wMinAt(null), wMinAt(100), "the desk's silence is not evidence"));
  ok("without costPctFor the flat costPct is used exactly as before", () => {
    const flat = { ...cfg, costPctFor: undefined };
    assert.equal(planEntry({ call: call(35), cfg: flat, state: st() }).wMin,
      planEntry({ call: call(100), cfg: flat, state: st() }).wMin,
      "callers that do not opt in must be unchanged");
  });
  ok("the poller supplies it", () => {
    const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
    assert.match(poller, /costPctFor: \(clipEth\) => expectedRoundTripPct\(clipEth\) \/ 100,/);
  });
}

console.log("\nTHE POLLER SIZES FROM THE CEREMONY, NOT FROM A CONSTANT");
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
ok("fixedSol tracks the configured cap", () =>
  assert.match(poller, /fixedSol: configuredTradeCap\.value,/));
ok("fixedSol is no longer pinned to the paper constant", () =>
  assert.ok(!/fixedSol: PAPER_DEFAULTS\.fixedEth/.test(poller),
    "a hardcoded size silently caps the operator's own ceremony"));
ok("costPct is derived from the measured curve at the configured clip", () =>
  assert.match(poller, /costPct: expectedRoundTripPct\(configuredTradeCap\.value\) \/ 100,/));
ok("the derivation reads the registry rather than a literal", () =>
  assert.match(poller, /import \{ expectedRoundTripPct \} from "\.\/live-thresholds\.mjs"/));
ok("raising the cap therefore raises BOTH the size and the cost estimate", () => {
  // the two CFG lines must both read configuredTradeCap, or the ceremony half-applies
  const cfg = poller.slice(poller.indexOf("const CFG = {"), poller.indexOf("scaleOutPct: 0,"));
  assert.ok(/maxSolPerTrade: configuredTradeCap\.value/.test(cfg), "the cap itself");
  assert.ok(/fixedSol: configuredTradeCap\.value/.test(cfg), "and the size taken");
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
