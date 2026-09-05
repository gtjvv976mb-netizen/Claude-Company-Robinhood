/**
 * MURDOCK — the Regime seat. Reads the weather; flies or doesn't.
 *
 * The one B-grade mechanism the research endorsed that the desk couldn't run:
 * time-series momentum as a MARKET-REGIME VETO. When both ETH and BTC are
 * negative over their trailing ~25 days, trend is against every long on the
 * established sleeve — the sleeve whose returns actually correlate with the
 * majors. ETH, not SOL: chain 4663 is ETH-quoted (WETH pairs, ETH gas, PONS
 * graduation measured in ETH), so its weather is Ethereum's. It is a veto, not an alpha signal: MURDOCK never says "buy",
 * only "not in this weather".
 *
 * Deterministic code, no model cost. CoinGecko's free API, cached an hour —
 * the weather does not change by the minute, and neither should the bill.
 */
import { getJson } from "../lib/http.js";

const CG = "https://api.coingecko.com/api/v3";
const LOOKBACK_DAYS = 25;

let cache = { at: 0, value: null };

async function trailingReturn(coin) {
  const r = await getJson(`${CG}/coins/${coin}/market_chart?vs_currency=usd&days=30&interval=daily`,
    { label: `regime/${coin}`, timeoutMs: 15000 });
  if (!r.ok) return null;
  const prices = (r.data?.prices ?? []).map((x) => x[1]);
  if (prices.length < LOOKBACK_DAYS + 1) return null;
  const then = prices[prices.length - 1 - LOOKBACK_DAYS];
  const now = prices[prices.length - 1];
  return then > 0 ? (now / then - 1) * 100 : null;
}

/** The current weather. Fails open: unknown weather never grounds the desk. */
export async function regime() {
  if (cache.value && Date.now() - cache.at < 3600e3) return cache.value;
  const [eth, btc] = await Promise.all([trailingReturn("ethereum"), trailingReturn("bitcoin")]);
  const known = eth != null && btc != null;
  const value = {
    ethRet25d: eth != null ? Number(eth.toFixed(1)) : null,
    btcRet25d: btc != null ? Number(btc.toFixed(1)) : null,
    // Legacy name some readers still print; same number as ethRet25d.
    solRet25d: eth != null ? Number(eth.toFixed(1)) : null,
    regime: !known ? "unknown"
      : eth < 0 && btc < 0 ? "risk_off"
      : eth > 0 && btc > 0 ? "risk_on"
      : "mixed",
    asOf: Date.now(),
  };
  if (known) cache = { at: Date.now(), value };
  return value;
}
