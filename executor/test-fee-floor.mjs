/**
 * THE FEE FLOOR IS DERIVED, AND IT MAY ONLY EVER REFUSE.
 *
 * Gas is flat on chain 4663, so two legs of it cost the same whatever the position is
 * worth. That makes the fee share of the RISKED DISTANCE — not of the notional — the
 * thing that decides whether a bracket can pay for itself, and it is solved rather than
 * picked: the smallest clip at which two legs stay under `maxFeeShareOfStop` of what the
 * stop puts at risk. The floor then moves on its own when gas moves or the stop tightens,
 * and nobody has to remember to edit it.
 *
 * ── THE MUTATION THIS FILE EXISTS TO CATCH ──────────────────────────────────────────
 *
 * The obvious implementation routes the derived number into `minSolPerTrade`, which is
 * what the Solana desk does — correctly, because that fork DELETED conviction sizing and
 * the key has exactly one consumer there. This fork KEPT conviction sizing, and
 * `minSolPerTrade` has a second job: it is the conviction FLOOR,
 * `want = Math.max(scaled, Math.min(want, minSolPerTrade))`. So the same edit that looks
 * like a safety improvement turns a live gas reading into a SIZE-UP path — a median
 * conviction call against a tight stop would be sized 2.9x larger BECAUSE THE NETWORK GOT
 * EXPENSIVE, with the reason string reporting both facts cheerfully.
 *
 * No rail may ever make a position larger. That is the assertion at the bottom of this
 * file, swept across every conviction from 0 to 100, and it is the one that must never be
 * deleted to make a refactor pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { feeFloorFor, planEntry, freshState, DEFAULTS } from "./strategy.mjs";
import {
  MAX_FEE_SHARE_OF_STOP, clampFeeShareOfStop, ROUND_TRIP_GAS, GAS_PRICE_GWEI,
  MIN_CLIP_ETH, CHEAPEST_CLIP_ETH,
} from "./live-thresholds.mjs";
import { threshold } from "./thresholds.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/** One leg of gas, in ETH — what poller.mjs's expectedNetworkFeeWei() reserves. */
const legEth = (gwei) => (ROUND_TRIP_GAS / 2) * gwei * 1e-9;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\nTHE FLOOR IS SOLVED FROM THE RAILS, NOT TYPED");
{
  /* Derived from the registry rather than pasted, so a re-measurement of the gas units
     or the share moves the expectation with the code. */
  const cases = [
    { gwei: 0.0844, stop: 0.25, note: "median gas, the desk's own band stop" },
    { gwei: GAS_PRICE_GWEI, stop: 0.14, note: "2026-09-04 gas, the minimum stop distance" },
    { gwei: 0.7, stop: 0.14, note: "a gas spike" },
  ];
  for (const c of cases) {
    const fee = legEth(c.gwei);
    const got = feeFloorFor({ feeReserveSol: fee, effectiveStopFrac: c.stop, maxFeeShareOfStop: MAX_FEE_SHARE_OF_STOP });
    const want = (2 * fee) / (MAX_FEE_SHARE_OF_STOP * c.stop);
    ok(`${c.gwei} gwei / stop ${c.stop} solves to ${got.toFixed(6)} ETH`, near(got, want),
      c.note);
  }
  const cheap = feeFloorFor({ feeReserveSol: legEth(0.0844), effectiveStopFrac: 0.25, maxFeeShareOfStop: MAX_FEE_SHARE_OF_STOP });
  ok("at median gas and a wide stop the floor is UNDER the static minimum, so nothing changes",
    cheap < MIN_CLIP_ETH, `${cheap.toFixed(6)} < ${MIN_CLIP_ETH}`);
  const tight = feeFloorFor({ feeReserveSol: legEth(GAS_PRICE_GWEI), effectiveStopFrac: 0.14, maxFeeShareOfStop: MAX_FEE_SHARE_OF_STOP });
  ok("at a tight stop it rises ABOVE the static minimum and starts refusing",
    tight > MIN_CLIP_ETH, `${tight.toFixed(6)} > ${MIN_CLIP_ETH}`);
  ok("...but still under the measured cheapest clip, so the default clip still trades",
    tight < CHEAPEST_CLIP_ETH, `${tight.toFixed(6)} < ${CHEAPEST_CLIP_ETH}`);
  ok("the floor rises with gas",
    feeFloorFor({ feeReserveSol: legEth(0.7), effectiveStopFrac: 0.14, maxFeeShareOfStop: MAX_FEE_SHARE_OF_STOP }) > tight);
  ok("...and with a tighter stop",
    feeFloorFor({ feeReserveSol: legEth(GAS_PRICE_GWEI), effectiveStopFrac: 0.10, maxFeeShareOfStop: MAX_FEE_SHARE_OF_STOP }) > tight);
}

console.log("\nTWO CLAMPS THAT ARE LOAD-BEARING");
{
  ok("a ZERO fee reserve gives a ZERO floor, never 1",
    feeFloorFor({ feeReserveSol: 0, effectiveStopFrac: 0.25, maxFeeShareOfStop: 0.25 }) === 0,
    "poller.mjs reserves 0 when EXECUTE is off — a 1 would floor every paper position at entry");
  ok("...and so does a missing one",
    feeFloorFor({ effectiveStopFrac: 0.25, maxFeeShareOfStop: 0.25 }) === 0);
  ok("a zero share gives a zero floor rather than dividing by it",
    feeFloorFor({ feeReserveSol: 0.0001, effectiveStopFrac: 0.25, maxFeeShareOfStop: 0 }) === 0);
  for (const bad of [0.95, 0.99, 1, 0, -0.1, NaN]) {
    let threw = false;
    try { feeFloorFor({ feeReserveSol: 0.0001, effectiveStopFrac: bad, maxFeeShareOfStop: 0.25 }); }
    catch { threw = true; }
    ok(`a stop of ${bad} throws rather than refusing everything silently`, threw);
  }
}

console.log("\nTHE SHARE HAS ONE HOME, AND CONFIGURATION MAY ONLY TIGHTEN IT");
{
  ok("an absent override is the registry's value", clampFeeShareOfStop(undefined) === MAX_FEE_SHARE_OF_STOP);
  ok("...and so is an empty string", clampFeeShareOfStop("") === MAX_FEE_SHARE_OF_STOP);
  ok("a tighter share is accepted", clampFeeShareOfStop(0.1) === 0.1);
  for (const bad of [0.5, 1, 2]) {
    let threw = false;
    try { clampFeeShareOfStop(bad); } catch { threw = true; }
    ok(`${bad} is refused — loosening a safety number is not configuration`, threw);
  }
  for (const bad of [0, -1, "x", "1e"]) {
    let threw = false;
    try { clampFeeShareOfStop(bad); } catch { threw = true; }
    ok(`${JSON.stringify(bad)} is refused`, threw);
  }
  const t = threshold("exec.maxFeeShareOfStop");
  /* ASSUMED, not INHERITED: in this registry INHERITED means VOID UNTIL RE-MEASURED and
     BLOCKING (test-thresholds.mjs holds every inherited row to value === null and
     live === true), and a null would delete the floor this constant derives. ASSUMED —
     "a starting guess nobody has checked" — is what 0.25 actually is here. */
  ok("registered ASSUMED, because nobody measured 0.25 on this chain",
    String(t.provenance).toLowerCase() === "assumed", String(t.provenance));
  ok("...and it carries a value, unlike an INHERITED row which must be void",
    t.value === MAX_FEE_SHARE_OF_STOP && t.value !== null);
  ok("...and live:false, because it is not a gate but the constant a gate is solved from",
    t.live === false);

  /* Value parity, never text parity: what the desk computes must equal what the executor
     registered — the shape test-executor-dashboard.mjs already uses. */
  const { cfg } = await import("../src/config.js");
  ok("src/config.js reads the registry rather than restating it",
    cfg.executorMaxFeeShareOfStop === MAX_FEE_SHARE_OF_STOP,
    `${cfg.executorMaxFeeShareOfStop} === ${MAX_FEE_SHARE_OF_STOP}`);
  const configSrc = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
  ok("...and the literal is gone from the line it lived on",
    !/EXECUTOR_MAX_FEE_SHARE_OF_STOP\s*\|\|\s*0\.25/.test(configSrc));
  ok("...and the env read goes through the clamp", /clampFeeShareOfStop\(process\.env/.test(configSrc));
}

console.log("\nIT REFUSES, AND THE REFUSAL NAMES GAS");
{
  const base = { ...DEFAULTS, minSolPerTrade: MIN_CLIP_ETH, fixedSol: CHEAPEST_CLIP_ETH,
    maxSolPerTrade: CHEAPEST_CLIP_ETH, dailySolCap: 0.112, dailyLossLimitSol: 0.0336, bankrollSol: 0.05 };
  const call = { mint: "m", symbol: "C", stop: 0.86, target: 1.6, conviction: 31 };
  const floor = feeFloorFor({ feeReserveSol: legEth(GAS_PRICE_GWEI), effectiveStopFrac: 0.14, maxFeeShareOfStop: MAX_FEE_SHARE_OF_STOP });

  const without = planEntry({ call, cfg: { ...base, feeFloorSolPerTrade: 0 }, state: freshState(0) });
  ok("without the floor a median-conviction call buys", without.action === "buy", `${without.sol} ETH`);
  const with_ = planEntry({ call, cfg: { ...base, feeFloorSolPerTrade: floor }, state: freshState(0) });
  ok("with it, a clip under the floor is REFUSED", with_.action === "skip", with_.reason?.slice(0, 70));
  ok("...and the refusal says the flat toll is why",
    /gas legs|flat toll/.test(with_.reason || ""), with_.reason?.slice(0, 90));
  ok("...and names the floor it missed", (with_.reason || "").includes(floor.toFixed(6)));
  ok("the refusal is a skip, never a smaller buy", with_.sol == null || with_.sol === 0);
}

console.log("\nNO RAIL MAY EVER MAKE A POSITION LARGER — SWEPT ACROSS EVERY CONVICTION");
{
  const base = { ...DEFAULTS, minSolPerTrade: MIN_CLIP_ETH, fixedSol: CHEAPEST_CLIP_ETH,
    maxSolPerTrade: CHEAPEST_CLIP_ETH, dailySolCap: 0.112, dailyLossLimitSol: 0.0336, bankrollSol: 0.05 };
  const floors = [0, 0.001, 0.004, 0.005836, 0.008, 0.0112];
  let worst = null;
  for (let conviction = 0; conviction <= 100; conviction += 1) {
    const call = { mint: "m", symbol: "C", stop: 0.86, target: 1.6, conviction };
    let prevSize = Infinity;
    for (const f of floors) {
      const p = planEntry({ call, cfg: { ...base, feeFloorSolPerTrade: f }, state: freshState(0) });
      const size = p.action === "buy" ? p.sol : 0;
      if (size > prevSize + 1e-12) { worst = { conviction, floor: f, size, prevSize }; break; }
      prevSize = size;
    }
    if (worst) break;
  }
  ok("raising the fee floor never raises the size, for any conviction from 0 to 100",
    worst === null,
    worst ? `conviction ${worst.conviction}: floor ${worst.floor} sized ${worst.size} > ${worst.prevSize}` : "swept 101 convictions x 6 floors");

  /* The specific mutation: the derived number must not be read where conviction floors. */
  const strategySrc = fs.readFileSync(new URL("./strategy.mjs", import.meta.url), "utf8");
  const convictionBlock = strategySrc.slice(strategySrc.indexOf("if (convictionScale < 1)"),
    strategySrc.indexOf("SIZE DOWN TO EACH RAIL"));
  ok("the conviction floor does not read the fee floor",
    !/feeFloorSolPerTrade/.test(convictionBlock),
    "it must keep reading the static minSolPerTrade");
  ok("the fee floor is read in the refusal", /Math\.max\(staticFloor, feeFloor\)/.test(strategySrc));
  const pollerSrc = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("...and the ladder breaks at the same number planEntry refuses at",
    /Math\.max\(CFG\.minSolPerTrade, feeFloor\)/.test(pollerSrc));
  ok("the poller solves it per call rather than configuring it",
    /feeFloorFor\(\{/.test(pollerSrc) && !/feeFloorSolPerTrade:\s*0\.\d/.test(pollerSrc));
  assert.ok(/clampFeeShareOfStop\(process\.env\.EXECUTOR_MAX_FEE_SHARE_OF_STOP\)/.test(pollerSrc),
    "the poller's own override must go through the clamp too");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
