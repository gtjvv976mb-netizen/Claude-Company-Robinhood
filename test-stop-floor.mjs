/**
 * A STOP INSIDE THE ROUND TRIP IS A LOSS THE DESK HAS ALREADY BOOKED.
 *
 * On 2026-09-03 the Solana bot refused four consecutive live calls — HeeHaw, TOAD, USWS
 * and a second HeeHaw — with the same sentence: "entry round trip plus worst-case fees
 * is already at/below the authored stop". Their stops sat 5% to 6.5% below entry
 * against a conservative cost near 9%.
 *
 * On chain 4663 the cost model changed SHAPE, not only size. Slippage on both legs is
 * still proportional (1 - 0.97^2 = 5.91% at 300bps), but the network term is a FLAT
 * gas toll: 660,996 gas for both legs (median of 9 Kyber round trips, measured
 * 2026-09-04, executor/live-thresholds.mjs), $0.54 at 0.326 gwei, ~$1.15 at the
 * 0.706 gwei base fee of 2026-09-04, ~$8 at the >5 gwei intraday spikes. $1.15 is
 * 0.04% of a $2,600 clip and 19.2% of a $6 one — so the floor is a function of the
 * clip, and the flat 12% (config.js minStopDistancePct, VOID here per
 * live-thresholds.mjs) is only the fallback for a coin whose round trip was not
 * measured. The Risk seat is told the floor and why; this is the deterministic check
 * behind that request — a prompt asks, a gate decides — and there is ONE ruler,
 * risk-rails.js stopFloorDetail(), read by compliance and by the seat alike.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { cfg } from "./src/config.js";
import { complianceCheck } from "./src/agents/compliance.js";
import { stopFloorDetail } from "./src/agents/risk-rails.js";
import { gasUsdRoundTrip, gasShareOfClipPct, ROUND_TRIP_GAS_UNITS } from "./src/execution-gates.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE GAS TERM IS PRICED FROM THE MEASURED ROUND TRIP, NEVER TYPED");
{
  /* VALIDATE THE RULER on a case whose answer is already known: 660,996 gas at
     0.326 gwei is 0.00021548 ETH — live-thresholds.mjs's own note — which is $0.54 at
     ~$2,500/ETH. Then the day this was written: 0.706 gwei at $2,450 = ~$1.14. */
  const thresholds = fs.readFileSync(new URL("./executor/live-thresholds.mjs", import.meta.url), "utf8");
  const measuredUnits = Number((thresholds.match(/"swap\.roundTripGasUnits",\s*([0-9_]+)/) || [])[1]?.replace(/_/g, ""));
  ok("the gas units match the executor's measured constant", measuredUnits === ROUND_TRIP_GAS_UNITS,
    `${ROUND_TRIP_GAS_UNITS} vs live-thresholds ${measuredUnits}`);
  const eth0326 = ROUND_TRIP_GAS_UNITS * 0.326e-9;
  ok("660,996 gas at 0.326 gwei is 0.00021548 ETH", Math.abs(eth0326 - 0.00021548) < 1e-8, eth0326.toFixed(8));
  const usd = gasUsdRoundTrip({ gasPriceGwei: 0.706, ethUsd: 2_450 });
  ok("at 0.706 gwei and $2,450/ETH a round trip costs about $1.14", usd > 1.10 && usd < 1.20, `$${usd.toFixed(4)}`);
  ok("an unreadable gas price prices to null, not to zero",
    gasUsdRoundTrip({ gasPriceGwei: null, ethUsd: 2_450 }) === null && gasUsdRoundTrip({ gasPriceGwei: 0.7, ethUsd: 0 }) === null);
  const small = gasShareOfClipPct({ clipUsd: 6, gasUsd: 1.15 });
  const large = gasShareOfClipPct({ clipUsd: 2_600, gasUsd: 1.15 });
  ok("the same $1.15 is 19.2% of a $6 clip and 0.04% of a $2,600 one",
    Math.abs(small - 19.17) < 0.05 && large < 0.05, `${small.toFixed(2)}% vs ${large.toFixed(3)}%`);
}

console.log("\nTHE FIXED GAS TERM DOMINATES A SMALL CLIP — THE ONE RULER SAYS SO");
{
  /* A $6 clip on a DEEP pool (round trip 0.02%, the CASHCAT measurement) at $1.15 of
     gas. The proportional terms are tiny; gas alone is 19.2% of the position, so any
     honest floor is at least that. The number printed is the ruler's own. */
  const ev = { symbol: "T", mint: "0x" + "ab".repeat(20), pair: { priceUsd: 1 },
    exitProbe: { ok: true, roundTripLossPct: 0.02, gasUsdRoundTrip: 1.15 } };
  const d = stopFloorDetail(ev, cfg, { positionUsd: 6 });
  ok("the floor for a $6 clip at $1.15 round-trip gas is at least 19%", d.floorPct >= 19,
    `${d.floorPct.toFixed(2)}% (gas ${d.gasPct.toFixed(2)}% of $${d.sizeUsd}, pool ${d.rtPct}%, slippage ${d.slippagePct.toFixed(2)}%)`);
  ok("...and it is the measured ruler, not the flat fallback", d.measured === true);
  ok("gas is the dominant term", d.gasPct > d.slippagePct && d.gasPct > d.rtPct,
    `gas ${d.gasPct.toFixed(2)}% > slippage ${d.slippagePct.toFixed(2)}% > pool ${d.rtPct}%`);
  const big = stopFloorDetail(ev, cfg, { positionUsd: 2_600 });
  ok("the same coin at a $2,600 clip needs far less", big.floorPct < d.floorPct / 2,
    `${big.floorPct.toFixed(2)}% at $2,600 vs ${d.floorPct.toFixed(2)}% at $6`);
  ok("an unmeasured round trip falls back to the flat floor and says so",
    stopFloorDetail({ exitProbe: {} }, cfg).measured === false &&
    stopFloorDetail({ exitProbe: {} }, cfg).floorPct === Number(cfg.minStopDistancePct));

  /* And the GATE refuses a 15% stop on that clip — 15% would be "wide" on Solana. */
  const size = 6, stopPct = 15;
  const gasUsd = 1.15, rt = 0.02;
  const codes = complianceCheck({
    pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
    risk: { entry_price: 1, stop_price: 1 - stopPct / 100, position_size_usd: size,
      max_loss_usd: size * (stopPct / 100 + rt / 100) + gasUsd },
    ticket: { entry_zone_low: 1, entry_zone_high: 1.02, stop_price: 1 - stopPct / 100,
      take_profit: [{ price: 3, pct_to_sell: 100 }], thesis: "t", invalidation: "the creator sells" },
    ev,
  }).violations;
  const inside = codes.find((x) => x.code === "stop_inside_costs");
  ok("compliance refuses a 15% stop on a $6 clip as inside the costs", !!inside, codes.map((x) => x.code).join(",") || "no violation");
  ok("...and the refusal names the gas share of the position",
    !!inside && /gas is \$1\.15 \(19\.\d+% of a \$6\.00 position\)/.test(inside.detail), inside?.detail?.slice(0, 160));
}

console.log("\nTHE FOUR LIVE REFUSALS WOULD STILL BE CAUGHT BEFORE PUBLICATION");
{
  const ticketFor = (stopPct) => ({
    entry_zone_low: 1, entry_zone_high: 1.02,
    stop_price: 1 - stopPct / 100,
    take_profit: [{ price: 1.3, pct_to_sell: 100 }],
    thesis: "t", invalidation: "the creator sells",
  });
  const evFor = () => ({ symbol: "T", mint: "0x" + "cd".repeat(20), pair: { priceUsd: 1 },
    exitProbe: { ok: true, roundTripLossPct: 2 } });
  /* The fixture has to clear the checks BEFORE this one or it never reaches the gate
     under test — risk_arithmetic_mismatch fires first if max_loss_usd does not equal
     size x the cost-adjusted stop distance. That is the point of asserting on the code,
     not on a count: an unrelated violation must not be able to masquerade as this one. */
  const codes = (stopPct) => {
    const size = 50;
    return complianceCheck({
      pm: { decision: "PROPOSE" }, redteam: { verdict: "survived" },
      risk: { entry_price: 1, stop_price: 1 - stopPct / 100, position_size_usd: size,
        max_loss_usd: size * (stopPct / 100 + 0.02) },
      ticket: ticketFor(stopPct), ev: evFor(),
    }).violations.map((x) => x.code);
  };
  // The stops those four calls actually carried.
  for (const [name, stopPct] of [["HeeHaw", 5], ["TOAD", 5], ["USWS", 6.5]])
    ok(`${name}'s ${stopPct}% stop is refused as inside the costs`,
      codes(stopPct).includes("stop_inside_costs"), codes(stopPct).join(",") || "no violation");
  const wide = codes(25);
  ok("a 25% stop — ordinary for a coin that moves 20% in minutes — is not refused for this",
    !wide.includes("stop_inside_costs"), wide.join(",") || "clean");
  const floorFor50 = stopFloorDetail(evFor(), cfg, { positionUsd: 50 }).floorPct;
  ok("...and neither is one exactly at this coin's own floor",
    !codes(Number(floorFor50.toFixed(2)) + 0.01).includes("stop_inside_costs"), `${floorFor50.toFixed(2)}%`);
}

console.log("\nTHE SEAT THAT PICKS THE STOP IS TOLD, TOO");
{
  const src = fs.readFileSync(new URL("./src/agents/decision.js", import.meta.url), "utf8");
  ok("the Risk seat is given the floor", /stopFloorDetail\(ev, cfg\)/.test(src) && /minStopDistancePct/.test(src));
  ok("...and told what happens if the honest level is closer than it",
    /cannot be traded at this size on this desk/.test(src),
    "moving the level to fit is explicitly refused");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
