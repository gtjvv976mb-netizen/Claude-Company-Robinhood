/**
 * THE EXIT PROBE, ON KYBERSWAP — the aggregator every venue on chain 4663 routes through.
 *
 * Replaces jupiter.js. Same job: buy the desk's target size, then sell the EXACT output
 * straight back, and report the round trip. Two things are different here and both were
 * measured before a line was written:
 *
 *   - THE LOSS IS MEASURED ETH-AGAINST-ETH, never USD-against-USD. The aggregator prices
 *     ETH and the memecoin from different feeds, so a dollar comparison reports the gap
 *     between those feeds as if it were trading cost: the first rehearsal on this chain
 *     read "-2.8% lost buying", which is two price feeds disagreeing, not free money
 *     (executor/probe-roundtrip.mjs). Quote wei in, read wei back.
 *
 *   - GAS IS A FLAT TOLL, NOT A PERCENTAGE. Solana's cost scaled with the clip; here a
 *     round trip is two swaps of ~356k + ~478k gas (CASHCAT, 2026-09-05) at whatever
 *     eth_gasPrice says this minute. At 0.4 gwei that is $0.82; at the 5 gwei spikes it
 *     is $10. So the probe reports the pool cost (roundTripLossPct) and the gas toll
 *     (gasUsdRoundTrip) SEPARATELY, priced off the live gas price, and the seats are
 *     told to add them.
 *
 * Measured 2026-09-05, native → CASHCAT at 0.01 ETH: amountInUsd 24.52, amountOut
 * 97.0155 CASHCAT, gas 356,167 at 401,442,000 wei, one uniswap-v4 hop; the sell of that
 * exact output came back 0.0100633 ETH — a round trip 0.63% AHEAD, because the buy and
 * the sell routed through two different pools whose marks disagreed. Reported as
 * measured; the screen's ceiling is a ceiling, not a floor.
 *
 * KyberSwap charges no fee on aggregator-API swaps (extraFee came back empty). The
 * x-client-id header is the aggregator's request for attribution, not a key.
 */
import { getJson, postJson } from "../lib/http.js";
import { TOKENS } from "../config.js";

const AGG = "https://aggregator-api.kyberswap.com/robinhood/api/v1";
export const CLIENT_ID = "claude-company";
const HEADERS = { "x-client-id": CLIENT_ID };
/* A recipient the route builder needs and nothing is ever sent to. The zero address is
   rejected by the builder; 0xdead is a real burn address every explorer labels. */
export const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";

const RETRY_DELAYS_MS = [600, 1500, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (r) => !r.ok && /HTTP (429|5\d\d)/.test(String(r.error || ""));

/** Call `attempt` until it succeeds or the transient budget is spent. Exported for tests. */
export async function withRetry(attempt, { delays = RETRY_DELAYS_MS, wait = sleep } = {}) {
  let r = await attempt();
  for (const base of delays) {
    if (!transient(r)) return r;
    await wait(base + Math.floor(Math.random() * base * 0.5));
    r = await attempt();
  }
  return r;
}

const big = (v) => { try { return BigInt(v); } catch { return null; } };

/**
 * One route. amountIn is WEI / base units, as a string or BigInt. Returns the shaped
 * summary plus the raw routeSummary (the build endpoint needs it back verbatim).
 */
export async function quote({ tokenIn, tokenOut, amountIn, to = PROBE_FROM, gasInclude = true }) {
  const qs = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn), to,
    gasInclude: gasInclude ? "true" : "false" });
  const r = await withRetry(() => getJson(`${AGG}/routes?${qs}`, { headers: HEADERS, label: "kyber/routes", timeoutMs: 20000 }));
  if (!r.ok) return { ok: false, error: r.error };
  const s = r.data?.data?.routeSummary;
  if (!s?.amountOut) return { ok: false, error: r.data?.message || "no route" };
  const hops = (s.route || []).flat();
  return {
    ok: true,
    inAmount: String(s.amountIn),
    outAmount: String(s.amountOut),
    amountInUsd: s.amountInUsd != null ? Number(s.amountInUsd) : null,
    amountOutUsd: s.amountOutUsd != null ? Number(s.amountOutUsd) : null,
    gas: s.gas != null ? Number(s.gas) : null,
    // The aggregator's own gas price and USD figure, kept for cross-checking only; the
    // desk prices gas off a live eth_gasPrice it reads itself.
    gasPriceWei: s.gasPrice != null ? String(s.gasPrice) : null,
    gasUsdQuoted: s.gasUsd != null ? Number(s.gasUsd) : null,
    hops: hops.length || null,
    amms: hops.map((h) => h.exchange).filter(Boolean),
    pools: hops.map((h) => h.pool).filter(Boolean),
    /* THE IMPLIED PRICE. Kyber marks both legs in USD, so one quote carries an ETH/USD
       reading that eth-usd.js cross-checks against CoinGecko. Only meaningful when one
       side is native. */
    impliedEthUsd: tokenIn.toLowerCase() === TOKENS.NATIVE.toLowerCase() && s.amountInUsd && big(s.amountIn) > 0n
      ? Number(s.amountInUsd) / (Number(big(s.amountIn)) / 1e18) : null,
    routeSummary: s,
  };
}

/** Executable calldata for a route, for SIMULATION. Nothing here signs or sends. */
export async function build(routeSummary, { sender = PROBE_FROM, recipient = sender, slippageBps = 300 } = {}) {
  const r = await withRetry(() => postJson(`${AGG}/route/build`,
    { routeSummary, sender, recipient, slippageTolerance: Number(slippageBps) },
    { headers: HEADERS, label: "kyber/build", timeoutMs: 20000 }));
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data?.data;
  if (!d?.data || !d?.routerAddress) return { ok: false, error: r.data?.message || "build returned no calldata" };
  return { ok: true, routerAddress: d.routerAddress, data: d.data, gas: d.gas != null ? Number(d.gas) : null };
}

/**
 * The exitability probe: buy `quoteAmountWei` of the token with native ETH, then sell
 * everything received straight back. The round trip is the number that matters — a
 * token can quote a tight buy and still be a roach motel on the way out.
 *
 * roundTripLossPct is POOL cost only, ETH-vs-ETH. Gas is reported in units for the
 * caller (evidence.js) to price at the live gas price it reads on the same tick.
 */
export async function roundTrip({ tokenAddress, quoteAmountWei, quoteToken = TOKENS.NATIVE }) {
  const sent = big(quoteAmountWei);
  if (sent == null || sent <= 0n) return { ok: false, error: "quoteAmountWei must be a positive integer" };
  const buy = await quote({ tokenIn: quoteToken, tokenOut: tokenAddress, amountIn: sent });
  if (!buy.ok) return { ok: false, error: `buy leg: ${buy.error}` };

  const sell = await quote({ tokenIn: tokenAddress, tokenOut: quoteToken, amountIn: buy.outAmount });
  if (!sell.ok) return { ok: false, error: `sell leg: ${sell.error}`, buy };

  const back = big(sell.outAmount) ?? 0n;
  // Six decimals of percent, computed in integers so a 1e18 wei clip never loses precision.
  const lossPct = Number((sent - back) * 1_000_000n / sent) / 10_000;
  const gasUnits = (buy.gas ?? 0) + (sell.gas ?? 0);
  return {
    ok: true,
    buy: { ...buy, routeSummary: undefined },
    sell: { ...sell, routeSummary: undefined },
    quoteToken,
    quoteAmountWei: sent.toString(),
    tokensOut: buy.outAmount,
    weiBack: back.toString(),
    roundTripLossPct: Number(lossPct.toFixed(4)),
    // Kept as separate legs so a seat can see which side is the expensive one.
    buyImpactPct: buy.amountInUsd && buy.amountOutUsd ? Number(((buy.amountInUsd - buy.amountOutUsd) / buy.amountInUsd * 100).toFixed(3)) : null,
    sellImpactPct: sell.amountInUsd && sell.amountOutUsd ? Number(((sell.amountInUsd - sell.amountOutUsd) / sell.amountInUsd * 100).toFixed(3)) : null,
    gasUnitsRoundTrip: gasUnits || null,
    hops: (buy.hops ?? 0) + (sell.hops ?? 0) || null,
    impliedEthUsd: buy.impliedEthUsd,
    // The raw summaries, for a caller that wants to build and simulate the sell.
    _buyRoute: buy.routeSummary,
    _sellRoute: sell.routeSummary,
  };
}

/** Token prices via the aggregator's marks: one native→token quote per token. Cheap
 *  enough for a handful; not for a sweep. */
export async function price(addresses, { probeWei = 10n ** 15n } = {}) {
  const out = {};
  for (const a of addresses) {
    const q = await quote({ tokenIn: TOKENS.NATIVE, tokenOut: a, amountIn: probeWei });
    if (!q.ok || !q.amountOutUsd) { out[a] = null; continue; }
    const units = Number(big(q.outAmount) ?? 0n);
    out[a] = units > 0 ? { usdPrice: q.amountOutUsd / (units / 1e18), source: "kyber" } : null;
  }
  return out;
}
