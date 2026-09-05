/**
 * ETH/USD FOR THE DESK — the number every size, band and gas figure hangs off.
 *
 * Nothing in src/ had an ETH price: the Solana desk priced its wallet off Jupiter's SOL
 * quote and the executor off Pyth. On chain 4663 the desk needs one to turn
 * cfg.targetSizeUsd into wei for the probe, to price gas, and to assign bands from
 * ETH-denominated launch reserves.
 *
 * Two sources, deliberately: CoinGecko's simple/price is the primary and is cached 60s
 * (the weather does not change by the second, and the free tier rate-limits). It is
 * cross-checked against the price KyberSwap implies on the SAME probe the exit check
 * already makes — amountInUsd / amountIn on a native leg — and the two must agree
 * within 2% or the reading is refused. Measured 2026-09-05: CoinGecko 2451.61, Kyber
 * implied 2452.00, 0.016% apart. A disagreement past 2% means one feed is stale or
 * wrong and the desk cannot say which, which is a reason to stop, not to average.
 *
 * Chainlink on 4663: docs.robinhood.com/chain/oracles returned an empty page to the
 * fetch on 2026-09-05, so no AggregatorV3 address is known here. UNVERIFIED; when one is
 * found it belongs in the executor's fair-price gate, verified with latestRoundData
 * before it is trusted, not silently added as a third voter here.
 */
import { getJson } from "../lib/http.js";

const CG = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd";
export const CACHE_MS = 60_000;
export const MAX_DIVERGENCE_PCT = 2;

let cache = { at: 0, eth: null, btc: null };

/** The cached CoinGecko reading, refreshed when older than CACHE_MS. */
export async function coingecko({ now = Date.now(), force = false } = {}) {
  if (!force && cache.eth && now - cache.at < CACHE_MS) return { ...cache, fresh: false };
  const r = await getJson(CG, { label: "coingecko/simple", timeoutMs: 10_000 });
  const eth = Number(r.data?.ethereum?.usd), btc = Number(r.data?.bitcoin?.usd);
  if (!r.ok || !(eth > 0)) return cache.eth ? { ...cache, fresh: false, stale: true, error: r.error } : { at: 0, eth: null, btc: null, error: r.error || "no price" };
  cache = { at: now, eth, btc: btc > 0 ? btc : null };
  return { ...cache, fresh: true };
}

/**
 * Pure: the verdict on two readings. Exported so the ruler can be checked against
 * cases whose answer is known before anything is measured with it.
 */
export function reconcile({ cgUsd, kyberUsd, cgAt, now = Date.now(), maxDivergencePct = MAX_DIVERGENCE_PCT }) {
  if (!(cgUsd > 0) && !(kyberUsd > 0)) return { ok: false, value: null, source: "none", stalenessSec: null, error: "no ETH/USD source answered" };
  if (!(cgUsd > 0)) return { ok: true, value: kyberUsd, source: "kyber_only", stalenessSec: 0, divergencePct: null,
    note: "CoinGecko did not answer; single-source mark" };
  const stalenessSec = cgAt ? Math.max(0, Math.round((now - cgAt) / 1000)) : null;
  if (!(kyberUsd > 0)) return { ok: true, value: cgUsd, source: "coingecko_only", stalenessSec, divergencePct: null,
    note: "no Kyber leg to cross-check against; single-source mark" };
  const divergencePct = Number((Math.abs(cgUsd - kyberUsd) / cgUsd * 100).toFixed(3));
  if (divergencePct > maxDivergencePct)
    return { ok: false, value: null, source: "disputed", stalenessSec, divergencePct,
      error: `CoinGecko $${cgUsd} and Kyber-implied $${kyberUsd.toFixed(2)} disagree by ${divergencePct}% (> ${maxDivergencePct}%) — the mark is unverifiable` };
  return { ok: true, value: cgUsd, source: "coingecko+kyber", stalenessSec, divergencePct, kyberUsd };
}

/**
 * The desk's ETH/USD: {ok, value, stalenessSec, source, divergencePct}. Pass the
 * Kyber-implied price from a probe already made; without one the reading is honestly
 * marked single-source.
 */
export async function ethUsd({ kyberImplied = null, now = Date.now() } = {}) {
  const cg = await coingecko({ now });
  return { ...reconcile({ cgUsd: cg.eth, kyberUsd: kyberImplied, cgAt: cg.at, now }), btcUsd: cg.btc ?? null };
}

/** For tests only. */
export const _resetCache = () => { cache = { at: 0, eth: null, btc: null }; };
