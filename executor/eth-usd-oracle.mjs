/**
 * THE INDEPENDENT ETH/USD ANCHOR, READ FROM CHAINLINK ON CHAIN 4663.
 *
 * The desk rule ports unchanged from Solana: THE SWAP COUNTERPARTY MAY NOT AUTHOR THE
 * USD ANCHOR USED TO JUDGE ITS OWN ORDER. On Solana that meant Pyth, never Jupiter.
 * Here it means the Chainlink feed, never KyberSwap's `amountInUsd`.
 *
 * FOUND AND VERIFIED 2026-09-05. docs.robinhood.com/chain/oracles-and-price-feeds names
 * Chainlink and defers to docs.chain.link for addresses; the addresses page is built from
 * https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json (57 feeds).
 * The ETH / USD entry: proxy 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9, aggregator
 * 0x6091E64eb7138EEF066a80FD3A0d7427B91f2721, 8 decimals, heartbeat 86,400s, deviation
 * threshold 0.5%, path "eth-usd-shared-svr". Read live through the public RPC on
 * 2026-09-05 at block 54,714,740 (eth_call, no key, nothing sent): latestRoundData()
 * returned roundId 18446744073709553622 (phase 1, aggregator round 2006), answer
 * 245,522,190,000 ($2,455.22), updatedAt 1788535814, answeredInRound equal to roundId —
 * 34,540s (9.6h) old at the time of the read, which is ordinary for a 24h-heartbeat /
 * 0.5%-deviation feed; decimals() returned 8; description() returned "ETH / USD";
 * aggregator() on the proxy returned the aggregator above. (An earlier note in this
 * file quoted a different answer for the same updatedAt; a round has one answer, so
 * that note was wrong and this is the reading that was actually printed.) Both are
 * pinned below; the proxy is what is read (Chainlink rotates the aggregator behind it)
 * and the aggregator is asserted so a proxy pointed somewhere else refuses.
 *
 * THE FRESHNESS POLICY IS DIFFERENT IN KIND FROM PYTH'S. Pyth pushed every minute so a
 * three-minute cap tolerated one missed push. Chainlink here updates on 0.5% deviation
 * OR 24 hours, so an answer can be honestly a day old while being within 0.5% of the
 * truth. The staleness cap is therefore the heartbeat plus one hour of slack, and the
 * VALUE bound the caller can rely on is the 0.5% deviation, not the age.
 *
 * Both providers are read and must agree: same round, same answer (they are reading one
 * contract, so a one-round skew is the only honest disagreement, bounded below).
 */
import { both, fromHexNumber, wordAt, isAddress } from "./evm-rpc.mjs";

export const ETH_USD_FEED_PROXY = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
export const ETH_USD_FEED_AGGREGATOR = "0x6091e64eb7138eef066a80fd3a0d7427b91f2721";
export const ETH_USD_FEED_DECIMALS = 8;
export const ETH_USD_CACHE_SOURCE = "chainlink-eth-usd-4663-v1";

const SEL_LATEST_ROUND_DATA = "0xfeaf968c";
const SEL_DECIMALS = "0x313ce567";
const SEL_AGGREGATOR = "0x245a7bfc";

export const ETH_USD_ORACLE_POLICY = Object.freeze({
  // Heartbeat 86,400s on the feed itself (reference-data-directory, 2026-09-05), plus
  // an hour so a heartbeat update that is a few minutes late does not disarm stops.
  maxAgeMs: 86_400_000 + 3_600_000,
  maxFutureSkewMs: 60_000,
  // The two providers read the same contract; a one-round skew between them is the
  // only honest disagreement, and one round is at most the 0.5% deviation trigger.
  maxProviderDivergencePct: 0.6,
  maxRoundGap: 1,
  // The feed's deviation threshold: what the answer is good to, whatever its age.
  deviationPct: 0.5,
  // Chainlink publishes no confidence interval, so the recorded confidence is the
  // deviation threshold itself; a stored observation claiming anything wider is not a
  // reading this oracle produced (entry-quote-guard compares against this).
  maxConfidencePct: 0.5,
});

/**
 * Recover a previously agreed observation without letting the local write time
 * launder an already-old oracle update. The immutable updatedAt is the staleness
 * authority; `observedAt` only proves the cache was not written in the future.
 */
export function usableEthUsdCache(cache, { nowMs = Date.now(), maxAgeMs } = {}) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache) ||
      cache.source !== ETH_USD_CACHE_SOURCE) return null;
  const price = Number(cache.v);
  const observedAt = Number(cache.ts);
  const publishTime = Number(cache.publishTime);
  const ageCap = Number(maxAgeMs);
  const now = Number(nowMs);
  if (!Number.isFinite(price) || price <= 0 ||
      !Number.isSafeInteger(observedAt) || observedAt <= 0 ||
      !Number.isSafeInteger(publishTime) || publishTime <= 0 ||
      !Number.isFinite(ageCap) || ageCap <= 0 ||
      !Number.isFinite(now) || now <= 0) return null;
  const observedAgeMs = now - observedAt;
  const publishAgeMs = now - publishTime * 1_000;
  if (observedAgeMs < 0 || publishAgeMs < 0 ||
      observedAgeMs > ageCap || publishAgeMs > ageCap) return null;
  return { price, publishTime, observedAt, publishAgeMs };
}

/** Decode one latestRoundData() return and apply the freshness policy. Pure. */
export function parseLatestRoundData(ret, { nowMs = Date.now(), policy = ETH_USD_ORACLE_POLICY,
  decimals = ETH_USD_FEED_DECIMALS } = {}) {
  if (typeof ret !== "string" || ret.length < 2 + 64 * 5)
    throw new Error("ETH/USD latestRoundData returned fewer than five words");
  const roundId = wordAt(ret, 0);
  const answerWord = wordAt(ret, 1);
  const answer = answerWord >= (1n << 255n) ? answerWord - (1n << 256n) : answerWord;
  const updatedAt = Number(wordAt(ret, 3));
  const answeredInRound = wordAt(ret, 4);
  if (answer <= 0n) throw new Error("ETH/USD answer is not positive");
  if (answeredInRound < roundId) throw new Error("ETH/USD answer is from a stale round");
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error("ETH/USD updatedAt is invalid");
  const price = Number(answer) / 10 ** decimals;
  if (!Number.isFinite(price) || price <= 0) throw new Error("ETH/USD decoded price is invalid");
  const observedAt = Number(nowMs);
  const ageMs = observedAt - updatedAt * 1_000;
  if (!Number.isFinite(observedAt) || observedAt <= 0 || ageMs < -Number(policy.maxFutureSkewMs))
    throw new Error("ETH/USD updatedAt is too far in the future");
  if (ageMs > Number(policy.maxAgeMs))
    throw new Error(`ETH/USD answer is stale (${Math.round(ageMs / 1_000)}s old; heartbeat is 86,400s)`);
  return { price, roundId, publishTime: updatedAt, observedAt, ageMs, deviationPct: policy.deviationPct };
}

/**
 * Require two independent RPC views of the feed. The proxy must still route to the
 * pinned aggregator and report 8 decimals; both views must be fresh and agree.
 */
export async function independentEthUsdPrice(providers, {
  nowMs = Date.now(), policy = ETH_USD_ORACLE_POLICY, feed = ETH_USD_FEED_PROXY,
  aggregator = ETH_USD_FEED_AGGREGATOR,
} = {}) {
  if (!isAddress(feed)) throw new Error("ETH/USD feed address is invalid");
  const call = (data) => [{ to: feed, data }, "latest"];
  let rounds, decimalsWords, aggregatorWords;
  try {
    [rounds, decimalsWords, aggregatorWords] = await Promise.all([
      both(providers, "eth_call", call(SEL_LATEST_ROUND_DATA)),
      both(providers, "eth_call", call(SEL_DECIMALS)),
      both(providers, "eth_call", call(SEL_AGGREGATOR)),
    ]);
  } catch (error) {
    throw new Error(`independent ETH/USD oracle requires successful reads from both RPC providers: ${error.message}`);
  }
  for (const [index, word] of decimalsWords.entries()) {
    const d = Number(wordAt(word, 0));
    if (d !== ETH_USD_FEED_DECIMALS)
      throw new Error(`ETH/USD feed reports ${d} decimals on provider ${index + 1}, expected ${ETH_USD_FEED_DECIMALS}`);
  }
  for (const [index, word] of aggregatorWords.entries()) {
    const current = "0x" + word.slice(-40).toLowerCase();
    if (current !== aggregator.toLowerCase())
      throw new Error(`ETH/USD proxy routes to aggregator ${current} on provider ${index + 1}, expected ${aggregator} — re-verify the feed before trusting it`);
  }
  let primary, secondary;
  try {
    primary = parseLatestRoundData(rounds[0], { nowMs, policy });
    secondary = parseLatestRoundData(rounds[1], { nowMs, policy });
  } catch (error) {
    throw new Error(`independent ETH/USD oracle rejected an RPC view: ${error.message}`);
  }
  const low = Math.min(primary.price, secondary.price);
  const high = Math.max(primary.price, secondary.price);
  const divergencePct = low > 0 ? (high / low - 1) * 100 : Infinity;
  if (!Number.isFinite(divergencePct) || divergencePct > Number(policy.maxProviderDivergencePct))
    throw new Error(`independent ETH/USD RPC views diverge by ${divergencePct.toFixed(4)}% (cap ${policy.maxProviderDivergencePct}%)`);
  const roundGap = primary.roundId > secondary.roundId
    ? primary.roundId - secondary.roundId : secondary.roundId - primary.roundId;
  if (roundGap > BigInt(policy.maxRoundGap))
    throw new Error(`independent ETH/USD RPC views are ${roundGap} rounds apart`);
  return {
    price: (primary.price + secondary.price) / 2,
    observedAt: Number(nowMs),
    publishTime: Math.min(primary.publishTime, secondary.publishTime),
    // Chainlink publishes no confidence interval; the deviation threshold is the
    // honest analogue and it is a property of the feed, not of this read.
    confidencePct: policy.deviationPct,
    divergencePct,
    roundId: (primary.roundId < secondary.roundId ? primary.roundId : secondary.roundId).toString(),
    source: ETH_USD_CACHE_SOURCE,
  };
}

/** Explicit fetch of the two feed facts for a human-readable readiness line. */
export async function describeEthUsdFeed(providers) {
  const [ret] = await both(providers, "eth_call", [{ to: ETH_USD_FEED_PROXY, data: SEL_LATEST_ROUND_DATA }, "latest"]);
  const parsed = parseLatestRoundData(ret);
  return { feed: ETH_USD_FEED_PROXY, aggregator: ETH_USD_FEED_AGGREGATOR,
    decimals: ETH_USD_FEED_DECIMALS, answer: parsed.price, updatedAt: parsed.publishTime,
    ageSec: Math.round(parsed.ageMs / 1_000), roundId: parsed.roundId.toString() };
}

// Re-exported for callers that only need the number parsers.
export { fromHexNumber };
