/**
 * A DRAINED POOL IS NOT A PRICE SOURCE.
 *
 * Measured on 24 coins from the ignition shortlist, 14 were discarded before any
 * evidence was gathered with "no pool agrees with the median" — 58% of the desk's own
 * shortlist, thrown away for free. All 14 were one shape: a pump.fun coin that had
 * GRADUATED. The real market is on pumpswap with real money in it; the bonding curve it
 * left behind stays listed for ever at the launch price of about $0.0000417 with zero
 * liquidity. An unweighted median gave the empty listing an equal vote, landed between
 * the two on a price neither pool quotes, and then rejected both for disagreeing with
 * it. With exactly two pools that is the general failure, not a special case.
 *
 * The vote now excludes pools holding no money and anchors on the liquidity-weighted
 * median. What this function guards against is unchanged and tested below: a pool
 * quoting nonsense must not set the mark, and a genuinely disputed mark must still be
 * reported as disputed for the Jupiter cross-check and the exit probe to kill.
 */
import { consensus } from "./src/data/dexscreener.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const pool = (dexId, priceUsd, usd) => ({ chainId: "robinhood", dexId, priceUsd: String(priceUsd), liquidity: { usd } });

console.log("\nTHE GRADUATED COIN, EXACTLY AS MEASURED");
{
  // XST on 2026-09-03: $247,346 of pumpswap against a curve holding nothing.
  const r = consensus([pool("pumpswap", 0.008676, 247346), pool("pumpfun", 0.00004147, 0)]);
  ok("it prices instead of failing", r.ok === true, r.error || "priced");
  ok("...at the price the money is actually at", r.priceUsd === 0.008676, `$${r.priceUsd}`);
  ok("...counting only the funded pool's depth", r.liquidityUsd === 247346, `$${r.liquidityUsd}`);
  ok("...and saying the dead listing was set aside", r.drainedPoolsIgnored === 1);
  ok("a single funded pool reports no spread", r.priceSpreadPct === 0, `${r.priceSpreadPct}%`);
}

console.log("\nDEPTH DECIDES, NOT A HEAD COUNT");
{
  // Three dust pools quoting nonsense cannot outvote the one pool holding the money.
  const r = consensus([
    pool("pumpswap", 0.01, 400000),
    pool("dust1", 0.001, 40), pool("dust2", 0.0012, 25), pool("dust3", 0.0009, 10),
  ]);
  ok("the deep pool sets the mark, outnumbered three to one", r.ok && r.priceUsd === 0.01, `$${r.priceUsd}`);
  ok("...and the dust is recorded as rejected", r.poolsRejected.length === 3, `${r.poolsRejected.length} rejected`);
  // Equal depths must behave exactly as the plain median always did.
  const even = consensus([pool("a", 100, 1000), pool("b", 110, 1000)]);
  ok("two equally deep pools 10% apart still both count", even.ok && even.poolsUsed === 2, `${even.poolsUsed} pools`);
}

console.log("\nWHAT THE GUARD IS FOR IS STILL GUARDED");
{
  /* The RAY failure: a pool REPORTING great depth while quoting 5,000x the real market.
     Depth-weighting cannot catch that on its own and never claimed to — what must
     survive is that the disagreement is visible, so gather()'s Jupiter cross-check
     (which KILLS at a 25% gap) and the measured exit probe can refuse the coin. */
  const r = consensus([pool("broken", 5000, 900000), pool("real", 1, 300000)]);
  ok("a deep broken pool is still reported, not hidden", r.ok === true);
  ok("...and the real pool is named in the rejections, for the record",
    r.poolsRejected.some((p) => p.dex === "real"), JSON.stringify(r.poolsRejected.map((p) => p.dex)));
  ok("a coin with no priced pool at all still fails",
    consensus([]).ok === false && consensus([pool("x", 0, 100)]).ok === false);
  ok("a non-Solana pair is not a vote", consensus([{ chainId: "base", priceUsd: "5", liquidity: { usd: 9e6 } }]).ok === false);
}

console.log("\nA COIN WHOSE VENUES REPORT NO LIQUIDITY IS PRICED, NOT BLINDED");
{
  // If NOTHING reports liquidity the old unweighted behaviour must still apply, or the
  // fix would trade one silent funnel loss for another.
  const r = consensus([pool("a", 10, 0), pool("b", 10.5, 0), pool("c", 11, 0)]);
  ok("all-zero liquidity still produces a mark", r.ok === true && r.priceUsd === 10.5, `$${r.priceUsd}`);
  ok("...and none are counted as drained, because none were set aside",
    r.drainedPoolsIgnored === 0, `${r.drainedPoolsIgnored}`);
  const missing = consensus([{ chainId: "robinhood", dexId: "a", priceUsd: "7" },
    { chainId: "robinhood", dexId: "b", priceUsd: "7.2" }]);
  ok("a pool with no liquidity field at all is still priced", missing.ok === true, `$${missing.priceUsd}`);
}

console.log("\nTHE OLD RULE WOULD HAVE FAILED EVERY ONE OF THESE");
{
  /* The mutation check: rebuild the pre-fix vote and confirm it really does discard the
     graduated coin. Without this the test above proves only that the new code works,
     not that it fixed anything. */
  const oldConsensus = (pairs, tolerancePct = 25) => {
    // The old RULE is what is being rebuilt, not the old chain: the vote shape is the
    // mutation under test, so it reads this chain's pairs like the new one does.
    const sol = pairs.filter((p) => p.chainId === "robinhood" && Number(p.priceUsd) > 0);
    const byLiq = [...sol].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const prices = byLiq.slice(0, 8).map((p) => Number(p.priceUsd)).sort((a, b) => a - b);
    const median = prices.length % 2 ? prices[(prices.length - 1) / 2]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
    const kept = byLiq.filter((p) => Math.abs(Number(p.priceUsd) - median) / median * 100 <= tolerancePct);
    return { ok: kept.length > 0, median };
  };
  const graduated = [pool("pumpswap", 0.008676, 247346), pool("pumpfun", 0.00004147, 0)];
  ok("the old vote discarded the graduated coin", oldConsensus(graduated).ok === false,
    `old median $${oldConsensus(graduated).median}, quoted by neither pool`);
  ok("...and the new vote keeps it", consensus(graduated).ok === true);
  const outvoted = [pool("pumpswap", 0.01, 400000), pool("d1", 0.001, 40), pool("d2", 0.0012, 25), pool("d3", 0.0009, 10)];
  const oldMark = oldConsensus(outvoted).median;
  ok("the old vote let three dust pools set the mark, a tenth of the real price",
    oldMark < 0.002 && oldMark > 0.0005, `old mark $${oldMark} against a real $0.01`);
  ok("...and the new vote follows the money", consensus(outvoted).priceUsd === 0.01);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
