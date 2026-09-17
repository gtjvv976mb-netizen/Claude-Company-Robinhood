/**
 * THE SIMULATOR — what the risk engine actually does to a stream of calls.
 *
 * Runs strategy.mjs (the same code the bot trades with) over synthetic but
 * deliberately UNFLATTERING memecoin price paths, tick by tick, so stops and
 * trails trigger path-dependently the way they would live.
 *
 * The honest framing, stated up front because it is the whole point:
 *   This does NOT prove the bot makes money. Profit comes from the desk's call
 *   quality — the hit rate and the size of the winners — which is an empirical
 *   question no simulation can answer for you. What this DOES measure is what
 *   the risk engine contributes GIVEN a call quality: it runs the same call
 *   stream through a naive bot (buy, hold until the desk says exit) and the
 *   risk-managed bot (stop, scale, trail, brakes), and reports the difference.
 *   That difference is the part the bot is responsible for.
 *
 * ── THREE THINGS THIS FILE GOT WRONG FOR AS LONG AS IT HAS EXISTED ──────────────────
 *
 * All three flattered or maligned the engine on numbers belonging to a different chain,
 * and the file is PUBLISHED to the viewer (scripts/build-viewer.mjs), so they were a
 * shipped artifact, not a private note.
 *
 *   1. THE CLOCK NEVER MOVED. stepPosition() was called with no `nowMs`, so
 *      trade-policy.mjs computed heldMs ≈ 0 on every step and the band window — THIS
 *      DESK'S PRIMARY EXIT, "this desk sells on the clock" — never fired once. The
 *      engine was measured with its main exit switched off. It now runs on a real clock:
 *      one step is one hour and a run is 240 of them, so the 120-hour band lands at step
 *      120 with room on either side. The band is DESK-AUTHORED (src/bands.js), so it is
 *      given to BOTH arms — handing it only to the managed arm would book the desk's own
 *      instruction as the risk engine's contribution.
 *
 *   2. THE ROUND TRIP WAS CHARGED TWICE, from a constant that was Solana's. `COST`
 *      was documented as a round trip and then applied on the way in AND on the way out,
 *      so a 6% constant became ~12%. It is charged ONCE now, and it comes from this
 *      chain's own measured cost curve (expectedRoundTripPct) at the clip actually
 *      traded: 7.35% all-in at the cheapest clip of 0.0112 ETH.
 *
 *   3. THE RAILS WERE SET AT SOLANA'S SCALE. strategy.mjs's DEFAULTS carry 0.05 per
 *      trade, a 0.5 daily cap and a 0.15 daily loss limit. Against a 0.0112 ETH clip not
 *      one of those brakes can ever bind, so the portfolio half of the engine was
 *      measured doing nothing. They now come from live-thresholds.mjs LIVE_CAPS — the
 *      same object poller.mjs runs on.
 *
 * WHAT IS STILL NOT HONEST, SAID PLAINLY RATHER THAN QUIETLY FIXED:
 *   The PRICE DISTRIBUTION below is still Solana-shaped — a pump.fun-grade tail that
 *   hands ~6% of calls a 2.5-11.5x runner. Robinhood Chain's own base rates say the
 *   median graduate ends 85% below its first-hour price, and of 106 coins in the desk's
 *   shadow book only 4% ever touched 2x. So this file models a friendlier world than the
 *   one the bot trades in, and its absolute P&L is therefore not a forecast of anything.
 *   Re-anchoring the distribution needs a measurement nobody has taken yet; until then
 *   the DELTA between the two arms is the only number here worth reading, and even that
 *   is conditional on a tail this chain may not have.
 *   The step duration (one hour) is a modelling choice, not a measurement — and giving
 *   the clock a unit forced a question the old file never had to answer. The per-step
 *   noise (5.5-10.5%) was DIMENSIONLESS when a step meant nothing; declaring a step to be
 *   an hour declares that noise hourly, which is very high. It is left at the inherited
 *   value and exposed as --vol rather than quietly retuned, because picking a number here
 *   would be inventing the measurement this header says nobody has taken. Read the
 *   stop-out count as an UPPER BOUND: a 25% stop under 8%-an-hour noise is hit by the
 *   noise, not by the thesis.
 *
 *   node simulate.mjs [--trials 400] [--calls 60] [--winrate 0.28] [--seed 7]
 *   node simulate.mjs --droprate 2 --voidrate 1     # the sequencer failure sweep
 */
import { fileURLToPath } from "node:url";
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
import {
  expectedRoundTripPct, CHEAPEST_CLIP_ETH, MIN_CLIP_ETH, LIVE_CAPS,
  ROUND_TRIP_GAS, GAS_PRICE_GWEI, HOLD_WINDOWS, DROP_RATE_PCT,
} from "./live-thresholds.mjs";

/* ONE STEP IS ONE HOUR, AND A RUN IS TEN DAYS OF THEM. The band window is 120 hours on
   every band (src/bands.js: the shortest hold that is not measurably loss-making on this
   chain — 41 days traded gave 1h −14.71%, 24h −7.36%, 72h −2.31%, 120h +2.19%). At 240
   one-hour steps the band exit lands at step 120, with as much path after it as before;
   at the old 240 steps of unspecified duration it landed on the last step, where it
   would have measured nothing even once the clock was passed in. */
export const STEP_MS = 3600e3;
export const STEPS = 240;
export const BAND_HOLD_MS = HOLD_WINDOWS * 3600e3;

/* THE DESK'S BRACKET, AT THIS CHAIN'S NUMBERS. The −38%/+1.9x that used to be here was
   inherited from the Solana desk. src/bands.js measured this fork's horizon holding the
   bracket fixed at −25%/+1.6x, so that is the bracket those hold numbers belong to. */
export const DESK_STOP_FRAC = 0.75;
export const DESK_TARGET_MUL = 1.6;

/* THE SIMULATOR'S OWN DAY ROLL. strategy.mjs exported rollDay once; it does not now —
   the rolling 24h rails moved to the journal, which sums risk_events over a window, and
   this file was never updated. Both repos' simulators have been dead on import ever
   since, which is why nothing has been able to answer "what does the risk engine
   contribute" for as long as that has been true.
   Modelled here rather than re-added to strategy.mjs: trading code should not grow a
   function that exists for a simulation. This is a discrete reset at the window
   boundary — the shape the original call site (rollDay(state, now, 86400e3)) implies —
   and it is the SIM's model of the rails, not a claim about the live implementation. */
export function rollDay(state, now, windowMs) {
  if (state.dayStartedAt == null) state.dayStartedAt = now;
  if (now - state.dayStartedAt < windowMs) return state;
  state.dayStartedAt = now;
  state.deployedTodaySol = 0;
  state.realizedTodaySol = 0;
  return state;
}

// deterministic RNG so a reported number can be reproduced
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

/** One call's price path: [p0, p1, ...] over `steps` polls.
 *  STILL SOLANA-SHAPED — see the header. The tail here is pump.fun's, not this chain's. */
export const INHERITED_VOL_LO = 0.055, INHERITED_VOL_SPAN = 0.05;
export function makePath(rand, { steps = STEPS, winrate = 0.28, volLo = INHERITED_VOL_LO, volSpan = INHERITED_VOL_SPAN } = {}) {
  const u = rand();
  // Outcome classes, roughly the shape of live memecoin call outcomes:
  //   rug/fade (most), chop, modest winner, runner (rare, carries the tail)
  let endMul;
  if (u < 0.34) endMul = 0.05 + rand() * 0.25;                 // rug / bleed to near zero
  else if (u < 1 - winrate) endMul = 0.45 + rand() * 0.45;      // fade
  else if (u < 1 - winrate * 0.22) endMul = 1.15 + rand() * 1.1; // modest winner
  else endMul = 2.5 + rand() * 9;                               // runner (the tail)

  const drift = Math.log(endMul) / steps;
  const vol = volLo + rand() * volSpan;   // memecoin-grade noise, PER STEP (see header)
  const path = [1];
  for (let i = 1; i <= steps; i++) {
    // box-muller
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    path.push(Math.max(1e-6, path[i - 1] * Math.exp(drift + vol * z)));
  }
  return path;
}

/** Where the desk would publish its exit: its own stop/target breached and the monitor
 *  catching it with a realistic lag, or the band window closing — whichever is first.
 *  The band belongs to the CALL, so it reaches the naive arm too. */
export function deskExitStep(path, stop, target, lag, bandStep = Math.round(BAND_HOLD_MS / STEP_MS)) {
  for (let i = 1; i < path.length; i++) {
    if (path[i] <= stop || (target != null && path[i] >= target))
      return Math.min(path.length - 1, i + lag, bandStep);
  }
  return Math.min(path.length - 1, bandStep);
}

/** The gas cost of one swap leg, in ETH, at a modelled gas price. */
export const legGasEth = (gasGwei = GAS_PRICE_GWEI) => (ROUND_TRIP_GAS / 2) * gasGwei * 1e-9;
/** A cancel is 21,000 gas — see evm-executor.mjs CANCEL_GAS_LIMIT. */
export const cancelGasEth = (gasGwei = GAS_PRICE_GWEI) => 21_000 * gasGwei * 1e-9;

/**
 * THE SEQUENCER'S OWN FAILURE MODES, which are not the same failure.
 *
 *   A DROP is a TIME cost. The sequencer accepts nothing and returns no receipt; the
 *   executor reconciles by nonce, sends a cancel and REBUILDS the intent next tick
 *   (evm-executor.mjs _sendCancel / _settleReceipt: "may be rebuilt next tick"). So a
 *   drop does not lose the position — it re-enters later, at whatever the price has
 *   done in the meantime. The gas is 21,000 units, 0.058% of a 0.0112 clip: rounding.
 *   The delay is the cost, and on a falling path it is the whole cost.
 *
 *   A VOID is a MONEY cost, and it is worse on the way out than on the way in. The
 *   compliance filter returns status 0x0 with no logs and the gas burned, and a voided
 *   send is marked a finalized failure and NEVER retried. A voided ENTRY burns one leg
 *   and leaves no position. A voided EXIT burns one leg AND LEAVES THE POSITION OPEN
 *   with nothing to close it — position-scale, not gas-scale, and the hazard the
 *   charter's red team singles out. Modelling voids on the entry alone would model the
 *   benign half and understate the risk in the flattering direction.
 *
 * NEITHER RATE IS MEASURED. exec.dropRatePct is registered null with CANARY provenance
 * precisely so nobody reads it as measured. Nothing this model prints may be written
 * back into it, or into SEND_DROP_PAUSE_PCT — that one is a REFUSAL GATE, and feeding a
 * refusal gate a simulated cost is this repo's own gate-doubles-as-cost lint.
 */
export const FAILURE_MODEL_HELP =
  "the sequencer failure model needs BOTH --droprate and --voidrate, in percent, and has " +
  "no defaults: exec.dropRatePct is registered null (CANARY) and there is no measurement " +
  "to default to. Pass e.g. --droprate 2 --voidrate 1; a sweep is printed, never a point " +
  "estimate, and no value from it may be written back into a threshold or a refusal gate.";

export function runOne({
  managed, calls, rand, cfg, deskLag,
  dropRate = 0, voidRate = 0, gasGwei = GAS_PRICE_GWEI, dropDelaySteps = 1,
  /* The two legs are separable because they are DIFFERENT failures with different costs,
     and a test that cannot isolate the sell leg cannot pin the expensive one. Both
     default to voidRate, so an ordinary run still models one rate on both legs. */
  voidEntryRate = null, voidExitRate = null,
}) {
  const voidIn = voidEntryRate == null ? voidRate : voidEntryRate;
  const voidOut = voidExitRate == null ? voidRate : voidExitRate;
  const state = freshState(0);
  let realized = 0, wins = 0, losses = 0, stopped = 0, scaled = 0, taken = 0, skippedByCaps = 0;
  let peak = 0, equity = 0, maxDD = 0;
  let drops = 0, voidedEntries = 0, voidedExits = 0, strandedPositions = 0;
  const bandStep = Math.round(BAND_HOLD_MS / STEP_MS);

  for (let n = 0; n < calls; n++) {
    const path = makePath(rand, { winrate: cfg._winrate, volLo: cfg._volLo, volSpan: cfg._volSpan });
    const entry = path[0];
    const stop = entry * DESK_STOP_FRAC;
    const target = entry * DESK_TARGET_MUL;

    // Calls arrive over TIME. Feeding the engine a fake never-rolling day meant the
    // rolling deploy cap filled after a handful of trades and skipped the rest
    // of the run — the sample was a fraction of what the header claimed. Space calls
    // CALL_GAP_H apart and roll the day properly.
    const now = n * cfg._callGapH * 3600e3;
    const call = {
      mint: "m" + n, symbol: "C" + n, size_sol: cfg.maxSolPerTrade, stop, target, ts: n,
      openedAtMs: now, hold_max_ms: BAND_HOLD_MS, hold_band: "very_high",
    };
    rollDay(state, now, 86400e3);
    const plan = planEntry({ call, cfg, state });
    if (plan.action !== "buy") { skippedByCaps++; continue; }

    /* A VOIDED ENTRY: one leg of gas burned, no position, nothing to retry. */
    if (voidIn > 0 && rand() * 100 < voidIn) {
      voidedEntries++;
      const cost = -legGasEth(gasGwei);
      realized += cost; state.realizedTodaySol += cost;
      equity += cost; peak = Math.max(peak, equity); maxDD = Math.min(maxDD, equity - peak);
      losses++;
      continue;
    }
    /* A DROPPED ENTRY: a cancel's gas, and re-entry that many steps later — at the
       price the path has by then, which is the part that actually costs. */
    let startStep = 0, dropCost = 0;
    if (dropRate > 0 && rand() * 100 < dropRate) {
      drops++;
      dropCost = cancelGasEth(gasGwei);
      startStep = Math.min(dropDelaySteps, path.length - 1);
    }
    taken++;

    const fill = path[startStep];
    state.deployedTodaySol += plan.sol;
    state.openCount++;
    const pos = openPosition({ call: { ...call, openedAtMs: now + startStep * STEP_MS },
      sol: plan.sol, fillPrice: fill, cfg });
    const exitAt = deskExitStep(path, stop, target, deskLag, bandStep);

    let qty = pos.qty, gross = 0, done = false, stranded = false;
    for (let i = startStep + 1; i < path.length && !done; i++) {
      const mark = path[i];
      const deskExit = i >= exitAt ? { code: "desk" } : null;
      const nowMs = now + i * STEP_MS;

      if (!managed) {
        // The naive bot: no local risk at all. It holds until the desk speaks — which
        // now includes the desk's own band clock, because that travels on the call.
        if (deskExit) {
          if (voidOut > 0 && rand() * 100 < voidOut) { voidedExits++; stranded = true; done = true; break; }
          gross += qty * mark; qty = 0; done = true;
        }
        continue;
      }
      const d = stepPosition({ pos, mark, deskExit, cfg, nowMs });
      if (d.action === "sell") {
        /* A VOIDED SELL is never retried, so the position is STRANDED: it rides the
           rest of the path with nothing left to close it. */
        if (voidOut > 0 && rand() * 100 < voidOut) { voidedExits++; stranded = true; done = true; break; }
        gross += qty * mark; qty = 0; done = true;
        if (d.reason.startsWith("stop") || d.reason.startsWith("ratcheted")) stopped++;
      } else if (d.action === "sell_part") {
        const part = qty * d.fraction;
        gross += part * mark; qty -= part; scaled++;
      }
    }
    if (stranded) { strandedPositions++; gross += qty * path[path.length - 1] - legGasEth(gasGwei); qty = 0; }
    else if (qty > 0) gross += qty * path[path.length - 1];

    /* THE ROUND TRIP IS CHARGED ONCE. It was charged on the proceeds AND on the outlay,
       which turned a constant documented as a round trip into two of them. */
    const cost = cfg.costPctFor(plan.sol);
    const net = gross * (1 - cost) - plan.sol - dropCost;
    realized += net;
    state.realizedTodaySol += net;
    state.openCount--;
    net >= 0 ? wins++ : losses++;

    equity += net;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }
  return { realized, wins, losses, stopped, scaled, maxDD, taken, skippedByCaps,
    drops, voidedEntries, voidedExits, strandedPositions };
}

/** The config the run uses: strategy defaults, with every money number re-based onto
 *  this chain's registry rather than the inherited Solana scale. */
export function simConfig({ winrate = 0.28, callGapH = 8, clipEth = CHEAPEST_CLIP_ETH,
  volLo = INHERITED_VOL_LO, volSpan = INHERITED_VOL_SPAN } = {}) {
  return {
    ...DEFAULTS,
    maxSolPerTrade: LIVE_CAPS.maxEthPerTrade,
    dailySolCap: LIVE_CAPS.dailyEthCap,
    dailyLossLimitSol: LIVE_CAPS.dailyLossLimitEth,
    maxOpenPositions: LIVE_CAPS.maxOpenPositions,
    minSolPerTrade: MIN_CLIP_ETH,
    fixedSol: clipEth,
    costPctFor: (clip) => expectedRoundTripPct(clip > 0 ? clip : clipEth) / 100,
    _winrate: winrate,
    _callGapH: callGapH,
    _volLo: volLo,
    _volSpan: volSpan,
  };
}

export const agg = (rows) => {
  const s = rows.map((r) => r.realized).sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  return {
    meanEth: mean,
    medianEth: s[Math.floor(s.length / 2)],
    p10: s[Math.floor(s.length * 0.1)], p90: s[Math.floor(s.length * 0.9)],
    profitableRuns: rows.filter((r) => r.realized > 0).length / rows.length,
    worstDD: Math.min(...rows.map((r) => r.maxDD)),
    avgTaken: sum("taken"), avgSkipped: sum("skippedByCaps"),
    avgStops: sum("stopped"), avgScales: sum("scaled"),
    avgDrops: sum("drops"), avgVoidedEntries: sum("voidedEntries"),
    avgVoidedExits: sum("voidedExits"), avgStranded: sum("strandedPositions"),
  };
};

/* ── CLI ─────────────────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const has = (k) => process.argv.indexOf("--" + k) > 0;
  const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? Number(process.argv[i + 1]) : d; };

  const TRIALS = arg("trials", 400), CALLS = arg("calls", 60);
  const CALL_GAP_H = arg("gaph", 8);   // hours between calls (3/day at 8h)
  const WINRATE = arg("winrate", 0.28), SEED = arg("seed", 7), DESK_LAG = arg("desklag", 6);
  const CLIP = arg("clip", CHEAPEST_CLIP_ETH);
  const VOL = arg("vol", INHERITED_VOL_LO);
  const cfg = simConfig({ winrate: WINRATE, callGapH: CALL_GAP_H, clipEth: CLIP, volLo: VOL });
  const COST = cfg.costPctFor(CLIP);

  /* THE FAILURE MODEL IS OPT-IN AND TAKES NO DEFAULT. Half of a sequencer failure model
     is worse than none: a default rate reads as a measurement the moment it is printed. */
  if (has("droprate") !== has("voidrate")) { console.error("\n" + FAILURE_MODEL_HELP + "\n"); process.exit(2); }
  const FAILURES = has("droprate") && has("voidrate");
  const DROP = arg("droprate", 0), VOID = arg("voidrate", 0);

  const f = (v) => (v >= 0 ? "+" : "") + v.toFixed(5);
  const pct = (v) => (v * 100).toFixed(0) + "%";

  const sweep = FAILURES ? [0, 0.5, 1, 2].map((m) => ({ m, drop: DROP * m, vd: VOID * m })) : [{ m: 1, drop: 0, vd: 0 }];

  console.log(`\nSIMULATION — ${TRIALS} runs x ${CALLS} calls, desk win rate ${pct(WINRATE)}, seed ${SEED}`);
  console.log(`Chain 4663. Clip ${CLIP} ETH, round trip ${(COST * 100).toFixed(2)}% charged ONCE (live-thresholds expectedRoundTripPct).`);
  console.log(`Caps: ${cfg.maxSolPerTrade} ETH/trade, ${cfg.dailySolCap} ETH/day, ${cfg.dailyLossLimitSol} ETH daily loss, ${cfg.maxOpenPositions} open.`);
  console.log(`Clock: ${STEPS} steps x ${STEP_MS / 3600e3}h; the ${HOLD_WINDOWS}h band exit lands at step ${Math.round(BAND_HOLD_MS / STEP_MS)}.`);
  console.log(`Desk bracket ${Math.round((1 - DESK_STOP_FRAC) * 100)}% stop / ${DESK_TARGET_MUL}x target, given to both arms.`);
  console.log(`\n  !! THE PRICE DISTRIBUTION IS STILL SOLANA-SHAPED — ~6% of calls draw a 2.5-11.5x`);
  console.log(`     runner. This chain's median graduate ends -85%, and 4% of 106 graded shadow`);
  console.log(`     rows ever touched 2x. Absolute P&L below is NOT a forecast. Read the DELTA.`);
  console.log(`     The one-hour step is a modelling choice; --vol ${VOL} is then noise PER HOUR,`);
  console.log(`     inherited and not retuned, so the stop-out count is an UPPER BOUND.`);

  for (const s of sweep) {
    const naive = [], managed = [];
    for (let t = 0; t < TRIALS; t++) {
      const opts = { calls: CALLS, cfg, deskLag: DESK_LAG, dropRate: s.drop, voidRate: s.vd };
      naive.push(runOne({ ...opts, managed: false, rand: rng(SEED + t) }));
      managed.push(runOne({ ...opts, managed: true, rand: rng(SEED + t) }));
    }
    const N = agg(naive), M = agg(managed);
    if (FAILURES) {
      const tag = DROP_RATE_PCT == null ? "UNMEASURED — modelled" : "measured";
      console.log(`\n── drop ${s.drop.toFixed(2)}% / void ${s.vd.toFixed(2)}%  (${tag}; ${s.m}x the rates you passed) ──`);
    } else {
      console.log(`\n── no sequencer failure model (pass --droprate and --voidrate to add one) ──`);
    }
    console.log(`                         NAIVE (hold to desk exit)      RISK-MANAGED`);
    console.log(`  mean P&L (ETH)              ${f(N.meanEth).padEnd(22)}${f(M.meanEth)}`);
    console.log(`  median P&L (ETH)            ${f(N.medianEth).padEnd(22)}${f(M.medianEth)}`);
    console.log(`  10th pct (bad run)          ${f(N.p10).padEnd(22)}${f(M.p10)}`);
    console.log(`  90th pct (good run)         ${f(N.p90).padEnd(22)}${f(M.p90)}`);
    console.log(`  runs that made money        ${pct(N.profitableRuns).padEnd(22)}${pct(M.profitableRuns)}`);
    console.log(`  worst drawdown (ETH)        ${N.worstDD.toFixed(5).padEnd(22)}${M.worstDD.toFixed(5)}`);
    console.log(`  trades taken / skipped      ${(N.avgTaken.toFixed(1) + " / " + N.avgSkipped.toFixed(1)).padEnd(22)}${M.avgTaken.toFixed(1)} / ${M.avgSkipped.toFixed(1)}`);
    console.log(`  avg stops / scale-outs      ${"—".padEnd(22)}${M.avgStops.toFixed(1)} / ${M.avgScales.toFixed(1)}`);
    if (FAILURES)
      console.log(`  drops / voided in,out       ${(N.avgDrops.toFixed(1) + " / " + N.avgVoidedEntries.toFixed(1) + "," + N.avgVoidedExits.toFixed(1)).padEnd(22)}${M.avgDrops.toFixed(1)} / ${M.avgVoidedEntries.toFixed(1)},${M.avgVoidedExits.toFixed(1)}  (stranded ${M.avgStranded.toFixed(1)})`);
    console.log(`  RISK ENGINE DELTA           ${f(M.meanEth - N.meanEth)} ETH mean, drawdown ` +
      `${(M.worstDD - N.worstDD >= 0 ? "reduced" : "worsened")} by ${Math.abs(M.worstDD - N.worstDD).toFixed(5)}`);
  }

  console.log(`\n  Profit is a function of the DESK'S call quality (win rate above), not of this`);
  console.log(`  bot. Re-run with --winrate to see the same engine on a better or worse stream.`);
  if (FAILURES)
    console.log(`  NOTHING HERE MAY BE WRITTEN BACK into exec.dropRatePct or SEND_DROP_PAUSE_PCT.\n` +
      `  The first is registered null on purpose; the second is a refusal gate, and a gate\n` +
      `  fed a simulated cost is this repo's own gate-doubles-as-cost lint.\n`);
  else console.log("");
}
