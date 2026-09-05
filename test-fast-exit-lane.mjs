/**
 * A THIRTY-MINUTE POSITION CHECKED EVERY TEN MINUTES.
 *
 * The exit check ran on one flat ten-minute timer for every band, and the bands do not
 * have one flat life. A nano call is held between one and thirty MINUTES, so it was
 * looked at about three times before it closed; a coin that doubled and gave it back
 * inside one gap was recorded, and PUBLISHED, at whatever it happened to be worth when
 * the timer next fired. You cannot sell high at ten-minute resolution on a
 * thirty-minute position.
 *
 * Nothing new is fetched. The sub-tick already reads a price for every live call every
 * 45 seconds to write witness marks; only the DECISION was waiting for the slow timer.
 *
 * What must stay true, and is asserted here: the fast lane may fire ONLY on the price
 * policy. The chain-failure exits — an authority appearing, a round trip gone roachy,
 * liquidity collapsing — are facts about the token that this tick does not observe, and
 * a tick that closed a call on evidence it never read would be worse than a late exit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluateExit } from "./src/calls.js";
import { needsFastExitLane, FAST_LANE_MIN_PASSES, exitClockBlocks, blocksFor, BLOCK_MS } from "./src/penthouse.js";
import { CAP_BANDS } from "./src/bands.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const MIN = 60_000, HOUR = 60 * MIN;

console.log("\nWHICH CALLS CANNOT WAIT FOR THE SLOW TIMER");
{
  const slow = 10 * MIN;
  for (const [key, b] of Object.entries(CAP_BANDS)) {
    const call = { hold_band: key, hold_max_ms: b.holdMaxMs };
    const fastWanted = b.holdMaxMs / slow < FAST_LANE_MIN_PASSES;
    ok(`${key} (holds up to ${Math.round(b.holdMaxMs / MIN)}m) -> ${fastWanted ? "fast lane" : "slow pass"}`,
      needsFastExitLane(call, { monitorMs: slow }) === fastWanted,
      `${(b.holdMaxMs / slow).toFixed(0)} chances on the slow timer`);
  }
  ok("nano and micro are the fast ones today",
    needsFastExitLane({ hold_max_ms: CAP_BANDS.nano.holdMaxMs }, { monitorMs: slow }) &&
    needsFastExitLane({ hold_max_ms: CAP_BANDS.micro.holdMaxMs }, { monitorMs: slow }) &&
    !needsFastExitLane({ hold_max_ms: CAP_BANDS.very_high.holdMaxMs }, { monitorMs: slow }));
  ok("a call with no clock is never fast-laned, rather than defaulting into one",
    !needsFastExitLane({ hold_max_ms: null }) && !needsFastExitLane({ hold_max_ms: 0 }) &&
    !needsFastExitLane({}) && !needsFastExitLane(null));
  // The rule is a ratio, so retuning either clock retunes the lane rather than lying.
  ok("slowing the monitor pulls more bands onto the fast lane",
    needsFastExitLane({ hold_max_ms: 5 * HOUR }, { monitorMs: 60 * MIN }), "5h hold vs a 1h timer");
  ok("...and speeding it up pushes them off",
    !needsFastExitLane({ hold_max_ms: 30 * MIN }, { monitorMs: MIN }), "30m hold vs a 1m timer");
}

console.log("\nTHE CLOCKS ARE STATED IN THE CHAIN'S BLOCKS");
{
  /* Chain 4663 seals a block every ~100 ms (100.6 ms over 10,000 blocks, measured
   * 2026-09-04). The hold windows are the owner's and are NOT re-derived; only the
   * comparison is read in blocks. The numbers below are the ones the code must print. */
  ok("the block clock is 100 ms", BLOCK_MS === 100, `${BLOCK_MS} ms`);
  ok("a ten-minute monitor pass is 6,000 blocks", blocksFor(10 * MIN) === 6_000, `${blocksFor(10 * MIN)}`);
  ok("a nano hold (30 m) is 18,000 blocks", blocksFor(CAP_BANDS.nano.holdMaxMs) === 18_000,
    `${blocksFor(CAP_BANDS.nano.holdMaxMs)}`);
  const nanoClocks = exitClockBlocks({ hold_max_ms: CAP_BANDS.nano.holdMaxMs }, { monitorMs: 10 * MIN, subTickSecs: 45 });
  ok("a nano call gets 3 slow passes and 40 sub-ticks",
    nanoClocks.slowPasses === 3 && nanoClocks.subTicks === 40,
    `hold ${nanoClocks.holdBlocks} blocks / slow ${nanoClocks.slowBlocks} = ${nanoClocks.slowPasses}; ` +
    `/ sub-tick ${nanoClocks.subTickBlocks} = ${nanoClocks.subTicks}`);
  const vh = exitClockBlocks({ hold_max_ms: CAP_BANDS.very_high.holdMaxMs }, { monitorMs: 10 * MIN });
  ok("a very-high call gets 144 slow passes over its 864,000 blocks",
    vh.holdBlocks === 864_000 && vh.slowPasses === 144, `${vh.holdBlocks} blocks, ${vh.slowPasses} passes`);
  ok("the fast-lane verdict is the same ratio read in blocks",
    needsFastExitLane({ hold_max_ms: CAP_BANDS.nano.holdMaxMs }, { monitorMs: 10 * MIN }) ===
    (nanoClocks.slowPasses < FAST_LANE_MIN_PASSES));
  ok("no clock, no blocks", exitClockBlocks({}) === null && blocksFor(0) === null && blocksFor("soon") === null);
}

console.log("\nA PRICE-ONLY READ MAY FIRE ON PRICE, AND ON NOTHING ELSE");
{
  // Exactly what the fast lane passes: a mark, and an explicit "I did not read flags".
  const tick = (mark) => ({ mark, flagsReadable: false });
  const call = { id: 1, entry_ref: 1, stop: 0.8, target: 2, opened_at: Date.now() - MIN,
    hold_band: "nano", hold_max_ms: CAP_BANDS.nano.holdMaxMs,
    flags_at_call: JSON.stringify(["mint_authority"]), liq_at_call: 50_000 };

  const stopped = evaluateExit(call, tick(0.7));
  ok("a stop breached on the tick closes the call", stopped.fire === true, stopped.code);
  ok("...and it is a price exit, not a chain exit",
    ["stop_hit", "take_profit", "target_hit", "thesis_expired"].includes(stopped.code), stopped.code);
  ok("a mark inside the band holds", evaluateExit(call, tick(1.05)).fire === false);

  /* THE POINT OF flagsReadable: false. The call was opened knowing about
     mint_authority. A tick that reads no flags at all must not conclude that the
     authority "appeared" and fire an unconditional exit on evidence it never gathered. */
  const blind = evaluateExit(call, tick(1.05));
  ok("a tick that read no flags never fires authority_appeared", blind.code !== "authority_appeared");
  const wouldHave = evaluateExit(call, { mark: 1.05, flags: [], flagsReadable: true });
  ok("...while a real read that finds the flag GONE is still not an exit either",
    wouldHave.fire === false, "only a NEW control is an exit");
  const appeared = evaluateExit(call, { mark: 1.05, flags: ["mint_authority", "freeze_authority"], flagsReadable: true });
  ok("...and a real read that finds a NEW control still fires, on the slow pass",
    appeared.fire === true && appeared.code === "authority_appeared", appeared.code);

  // The other two chain triggers must stay dormant on a null input, not read null as 0.
  ok("a missing round-trip reading is not a cannot_exit",
    evaluateExit(call, tick(1.05)).code !== "cannot_exit");
  ok("a missing liquidity reading is not a liq_collapse",
    evaluateExit(call, tick(1.05)).code !== "liq_collapse");
  ok("...but a real collapse still fires on the slow pass",
    evaluateExit(call, { mark: 1.05, liqUsd: 1_000, flagsReadable: false }).code === "liq_collapse");
}

console.log("\nTHE BAND'S CLOCK IS ACTED ON, NOT ONLY RECORDED");
{
  const nano = { id: 2, entry_ref: 1, stop: 0.8, target: 5,
    opened_at: Date.now() - (CAP_BANDS.nano.holdMaxMs + MIN),
    hold_band: "nano", hold_max_ms: CAP_BANDS.nano.holdMaxMs, flags_at_call: null };
  const r = evaluateExit(nano, { mark: 1.4, flagsReadable: false });
  ok("a nano call past its window closes on the tick, target or no target",
    r.fire === true, `${r.code}: ${r.detail}`);
}

console.log("\nONE EXIT PATH, SO THE TWO CLOCKS CANNOT DRIFT");
{
  const src = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  ok("both the slow pass and the tick close through fireExit",
    (src.match(/fireExit\(/g) || []).length >= 3, `${(src.match(/fireExit\(/g) || []).length} references`);
  ok("fireExit refuses a call another pass already closed",
    /const closedRow = closeCall\([\s\S]{0,120}if \(!closedRow\) return false/.test(src));
  assert.match(src, /lane: "subtick"/, "the fast exits are labelled, so the record says which clock closed them");
  ok("the tick states it read no flags", /evaluateExit\(row, \{ mark: cons\.priceUsd, flagsReadable: false \}\)/.test(src));
  ok("only a live, short-clock call is fast-laned",
    /row\?\.status === "live" && needsFastExitLane\(row\)/.test(src));
  ok("a call closed on the tick is counted and reported", /fastClosed\+\+/.test(src) && /return \{ marked, confirmed, fastClosed \}/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
