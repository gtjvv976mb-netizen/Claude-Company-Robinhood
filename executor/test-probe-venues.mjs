import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE PROBE MUST MEASURE THE MARKET THE BOT TRADES ─────────────────────────
 * probe-measure-4663.mjs produces the numbers that arm live trading. It defaulted
 * to --dexes pons-v2-dex,uniswap-v4-robinhood, which is not where this bot trades
 * and is not where the liquidity is:
 *
 *   - evm-swap.mjs routes through KyberSwap's AGGREGATOR. It is venue-agnostic;
 *     the only allowlist on the trading path is scope-guard.mjs, on TOKENS.
 *   - Measured 2026-09-06: of 60 pools, 15 carry WETH on a side. Those two venues
 *     hold one of them between them — pons-v2-dex holds zero, because its pair
 *     allowlist carries native ETH and not WETH.
 *
 * The result was a one-pool, one-tier sample. Across all venues the same run
 * samples seven pools spanning all four liquidity tiers, and the thin ones lose
 * 84-99% on a round trip — the fact screen.minLiquidityUsd exists to encode, and
 * one that a single pool could never have revealed. */
const probe = fs.readFileSync(new URL("./probe-measure-4663.mjs", import.meta.url), "utf8");
const swap = fs.readFileSync(new URL("./evm-swap.mjs", import.meta.url), "utf8");

const dexLine = probe.match(/const DEXES = new Set\(String\(args\.dexes \|\| "([^"]*)"\)/);
assert.ok(dexLine, "could not read the probe's venue default");
assert.equal(dexLine[1], "",
  `the probe must default to every venue, not ${JSON.stringify(dexLine[1])} — the bot routes through an aggregator`);

/* An empty default must actually MEAN "any venue" downstream, not "match nothing". */
assert.match(probe, /DEXES\.size === 0 \|\| DEXES\.has\(p\.dex\)/,
  "an empty venue set must be read as 'any venue'");
assert.equal(new Set("".split(",").filter(Boolean)).size, 0, "sanity: the default parses to an empty set");
assert.equal(new Set("pons-v2-dex".split(",").filter(Boolean)).size, 1, "sanity: --dexes still narrows");

/* The premise: the trading path really is venue-agnostic. If that ever stops being
   true, this test should fail rather than the probe silently measuring the wrong
   market again. */
assert.match(swap, /aggregator-api\.kyberswap\.com/,
  "the premise of measuring every venue is that the executor routes through an aggregator");
assert.ok(!/ALLOWED_DEX|venueAllowlist|onlyDex/.test(swap),
  "no venue allowlist on the trading path — if one appears, narrow the probe to match it");

console.log("probe venues: every venue by default, matching the aggregator the executor routes through");
