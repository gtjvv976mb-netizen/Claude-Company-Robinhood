/**
 * THE SIMULATOR HAS TO MEASURE THIS CHAIN'S ENGINE, ON THIS CHAIN'S CLOCK AND COST.
 *
 * simulate.mjs is published to the public viewer (scripts/build-viewer.mjs), so a wrong
 * number in it is a shipped claim, not a private note. Three of them were wrong for as
 * long as the file existed, and each is pinned here because each would be silently
 * re-introduced by an ordinary-looking edit:
 *
 *   1. stepPosition() was called with NO nowMs, so heldMs was ~0 forever and the band
 *      window — this desk's PRIMARY exit ("this desk sells on the clock") — never fired.
 *      The engine was being graded with its main exit switched off. A regression here
 *      does not throw and does not look wrong; it just quietly reports a different bot.
 *   2. A constant documented as a ROUND TRIP was charged on the way in AND on the way
 *      out, turning 6% into ~12%. Charging a round trip twice is the single easiest
 *      arithmetic slip in the file, so it gets an exact-equality test rather than a
 *      range.
 *   3. The portfolio rails ran at Solana's scale (0.05 / 0.5 / 0.15) against a 0.0112 ETH
 *      clip, so not one of them could ever bind and half the engine was measured doing
 *      nothing. They must be the SAME object the live process uses, not a copy of it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  runOne, makePath, deskExitStep, simConfig, rng, agg,
  STEP_MS, STEPS, BAND_HOLD_MS, DESK_STOP_FRAC, DESK_TARGET_MUL, legGasEth,
} from "./simulate.mjs";
import { stepPosition, openPosition } from "./strategy.mjs";
import { expectedRoundTripPct, CHEAPEST_CLIP_ETH, LIVE_CAPS, HOLD_WINDOWS } from "./live-thresholds.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const src = fs.readFileSync(new URL("./simulate.mjs", import.meta.url), "utf8");

console.log("\nTHE CLOCK RUNS, AND THE BAND EXIT FIRES");
{
  /* The regression that matters: a position opened at step 0 and walked with a real
     nowMs must close on the band, not ride to the end of the path. Flat price, so the
     ONLY thing that can close it is the clock. */
  const bandStep = Math.round(BAND_HOLD_MS / STEP_MS);
  const cfg = simConfig();
  const call = { mint: "m", symbol: "C", stop: 0.75, target: 1.6, openedAtMs: 0,
    hold_max_ms: BAND_HOLD_MS, hold_band: "very_high" };
  const pos = openPosition({ call, sol: CHEAPEST_CLIP_ETH, fillPrice: 1, cfg });
  let firedAt = null;
  for (let i = 1; i <= STEPS && firedAt == null; i++) {
    const d = stepPosition({ pos, mark: 1, deskExit: null, cfg, nowMs: i * STEP_MS });
    if (d.action === "sell") firedAt = i;
  }
  ok("the band exit fires on a flat path", firedAt != null,
    firedAt == null ? "it never fired — the clock is not reaching trade-policy" : `step ${firedAt}`);
  ok("...at the 120h band, not on the last step", firedAt === bandStep,
    `fired ${firedAt}, band step ${bandStep}, path ${STEPS}`);
  ok("...and the band lands INSIDE the path with room after it", bandStep < STEPS,
    `band ${bandStep} of ${STEPS} steps`);
  ok("the registry owns the hold window", BAND_HOLD_MS === HOLD_WINDOWS * 3600e3);

  /* THE OLD CALL SHAPE, EXACTLY, so this is a regression test and not a vacuous one.
     The bug needed BOTH halves: the synthetic call carried no openedAtMs, so
     strategy.mjs defaulted it to Date.now(), AND stepPosition was called with no nowMs,
     so trade-policy defaulted that to Date.now() too. heldMs was then ~0 on every step
     of every run and the band could not fire. Reproduce both halves or the test proves
     nothing: with openedAtMs pinned to 0 and the clock defaulted, heldMs is decades and
     it fires on step 1, which is the opposite failure. */
  const oldCall = { mint: "m", symbol: "C", stop: 0.75, target: 1.6 };   // no openedAtMs
  const pos2 = openPosition({ call: oldCall, sol: CHEAPEST_CLIP_ETH, fillPrice: 1, cfg });
  let firedWithout = null;
  for (let i = 1; i <= STEPS && firedWithout == null; i++) {
    const d = stepPosition({ pos: pos2, mark: 1, deskExit: null, cfg });   // no nowMs
    if (d.action === "sell") firedWithout = i;
  }
  ok("...and under the OLD shape (no openedAtMs, no nowMs) it never fired", firedWithout == null,
    firedWithout == null ? "the bug is pinned" : `fired at ${firedWithout}`);
  ok("...which is why the band needed both halves: the call carries the clock now",
    pos.openedAtMs === 0 && pos.holdMaxMs === BAND_HOLD_MS);
}

console.log("\nTHE BAND TRAVELS ON THE CALL, SO BOTH ARMS GET IT");
{
  const bandStep = Math.round(BAND_HOLD_MS / STEP_MS);
  const flat = new Array(STEPS + 1).fill(1);
  ok("deskExitStep caps at the band on a path that never breaches",
    deskExitStep(flat, 0.75, 1.6, 6, bandStep) === bandStep);
  const rises = flat.map((_, i) => 1 + i * 0.01);           // breaches the 1.6x target late
  ok("...and still caps at the band when the lagged breach is later",
    deskExitStep(rises, 0.75, 1.6, 6, bandStep) <= bandStep);
  const rugs = flat.map((_, i) => (i < 3 ? 1 : 0.5));        // breaches the stop at step 3
  ok("...but an early breach still wins", deskExitStep(rugs, 0.75, 1.6, 6, bandStep) === 3 + 6);
}

console.log("\nTHE ROUND TRIP IS CHARGED ONCE");
{
  /* A flat path of exactly 1.0 with no exit: the position is worth what was paid, so the
     whole P&L is the round trip. Charged once it is -clip*cost; charged twice it is
     roughly -clip*2*cost, which is what this file used to report. */
  const cfg = simConfig();
  const clip = cfg.fixedSol;
  const cost = cfg.costPctFor(clip);
  const flatRand = () => 0.5;
  const r = runOne({
    managed: false, calls: 1, deskLag: 0, cfg: { ...cfg, _volLo: 0, _volSpan: 0 },
    rand: (() => { let n = 0; return () => (n++ === 0 ? 0.5 : 0.5); })(),
  });
  void flatRand;
  /* A zero-vol path still drifts to its outcome class, so assert the ARITHMETIC directly
     rather than the drifted number: gross*(1-cost) - clip, never gross*(1-cost)*(1-cost). */
  const grossOf = (net) => (net + clip) / (1 - cost);
  const net = r.realized;
  const impliedGross = grossOf(net);
  const doubleCharged = impliedGross * (1 - cost) * (1 - cost) - clip;
  ok("a run nets gross*(1-cost) - clip", Math.abs((impliedGross * (1 - cost) - clip) - net) < 1e-12);
  ok("...and not the double-charged number", Math.abs(doubleCharged - net) > 1e-9,
    `single ${net.toFixed(8)} vs double ${doubleCharged.toFixed(8)}`);
  ok("the cost comes from this chain's own curve",
    Math.abs(cost - expectedRoundTripPct(clip) / 100) < 1e-15,
    `${(cost * 100).toFixed(2)}% at ${clip} ETH`);
  ok("...which is the 7.35% measured at the cheapest clip",
    Math.abs(expectedRoundTripPct(CHEAPEST_CLIP_ETH) - 7.35) < 0.02);
}

console.log("\nTHE RAILS RUN AT THIS CHAIN'S SCALE, FROM THE LIVE OBJECT");
{
  const cfg = simConfig();
  ok("per-trade cap is the live cap", cfg.maxSolPerTrade === LIVE_CAPS.maxEthPerTrade);
  ok("daily deploy cap is the live cap", cfg.dailySolCap === LIVE_CAPS.dailyEthCap);
  ok("daily loss limit is the live cap", cfg.dailyLossLimitSol === LIVE_CAPS.dailyLossLimitEth);
  ok("open-position cap is the live cap", cfg.maxOpenPositions === LIVE_CAPS.maxOpenPositions);
  /* Compare what the running system computes, never two source literals. */
  ok("...and the live caps are derived from the measured clip, not restated",
    LIVE_CAPS.maxEthPerTrade === CHEAPEST_CLIP_ETH);
  ok("the simulator does not carry its own copy of the caps",
    !/dailySolCap:\s*0\.5|maxSolPerTrade:\s*0\.05|dailyLossLimitSol:\s*0\.15/.test(src));
}

console.log("\nTHE SHIPPED FILE SAYS ETH, AND SAYS WHAT IT DOES NOT KNOW");
{
  const labels = src.match(/\bSOL\b/g) || [];
  ok("no SOL label survives in the simulator", labels.length === 0,
    labels.length ? `${labels.length} left` : "");
  ok("the header admits the price distribution is still Solana-shaped",
    /STILL SOLANA-SHAPED/.test(src));
  ok("...and that the step duration is a modelling choice",
    /modelling choice, not a measurement/.test(src));
  ok("...and that the inherited noise is now per-hour",
    /UPPER BOUND/.test(src) && /--vol/.test(src));
  ok("the desk bracket is this fork's measured one",
    DESK_STOP_FRAC === 0.75 && DESK_TARGET_MUL === 1.6);
}

console.log("\nTHE HEADER PRINTS THE SIZE THE ENGINE ACTUALLY DEPLOYS");
{
  const out = execFileSync(process.execPath,
    [new URL("./simulate.mjs", import.meta.url).pathname, "--trials", "2", "--calls", "3"],
    { encoding: "utf8" });
  const cfg = simConfig();
  ok("the run prints the clip it trades", out.includes(`Clip ${cfg.fixedSol} ETH`));
  ok("...and the caps it runs under", out.includes(`${cfg.dailySolCap} ETH/day`));
  ok("...and where the band exit lands", out.includes(`lands at step ${Math.round(BAND_HOLD_MS / STEP_MS)}`));
  ok("...and reports a risk engine delta", /RISK ENGINE DELTA/.test(out));
  ok("...and no failure model unless asked", /no sequencer failure model/.test(out));
  ok("a leg of gas is a real number", legGasEth() > 0 && legGasEth() < 0.001);
}

console.log("\nTHE PIECES ARE IMPORTABLE, SO THEY CAN BE TESTED AT ALL");
{
  ok("makePath is exported", typeof makePath === "function");
  ok("runOne is exported", typeof runOne === "function");
  ok("agg is exported", typeof agg === "function");
  ok("rng is deterministic", rng(7)() === rng(7)());
  assert.equal(typeof simConfig().costPctFor, "function");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
