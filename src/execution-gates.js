/**
 * Structural release gate for the retired browser RPC relay. Keeping the response
 * in a pure production helper lets CI exercise the exact value returned by Office
 * without opening a network listener.
 */
export function retiredBrowserRpcResponse() {
  return {
    status: 410,
    body: { error: "browser RPC relay retired; live signing is disabled" },
  };
}

/* THE GAS TERM, PRICED — and nothing more. The stop-distance ruler itself lives in ONE
 * place, src/agents/risk-rails.js stopFloorDetail(), which compliance and the Risk seat
 * both read; a second copy of that arithmetic here would be the drift the LESSONS file
 * warns about. What this file adds is the conversion the ruler is fed with:
 *
 *   round trip = 660,996 gas, BOTH legs (executor/live-thresholds.mjs ROUND_TRIP_GAS:
 *                median of 9 Kyber-routed round trips, 2026-09-04, range 618,079-823,333)
 *   at 0.326 gwei that was $0.54; at the 0.706 gwei base fee of 2026-09-04 it is ~$1.15;
 *   intraday spikes above 5 gwei make it ~$8 (market brief, 2026-09-05).
 *
 * $1.15 is 0.04% of a $2,600 clip and 19.2% of a $6 one, which is why the floor is a
 * function of the clip on this chain and a flat 12% (the Solana number, VOID here per
 * live-thresholds.mjs) is not. The gas price is an INPUT: eth_gasPrice moved
 * 0.02 -> 0.7 gwei in two weeks, so it is read per ticket and never cached. */
export const ROUND_TRIP_GAS_UNITS = 660_996;

/** Dollar cost of a full round trip at a gas price, priced through ETH/USD. Null when
 *  any input is unreadable — an unpriced gas term must never quietly become zero. */
export function gasUsdRoundTrip({ gasPriceGwei, ethUsd, gasUnits = ROUND_TRIP_GAS_UNITS }) {
  const gwei = Number(gasPriceGwei), eth = Number(ethUsd), units = Number(gasUnits);
  if (!(gwei > 0) || !(eth > 0) || !(units > 0)) return null;
  return (units * gwei * 1e-9) * eth;
}

/** The share of a clip that gas alone consumes, in percent. Null when unreadable. */
export function gasShareOfClipPct({ clipUsd, gasUsd }) {
  const clip = Number(clipUsd), gas = Number(gasUsd);
  if (!(clip > 0) || !(gas >= 0)) return null;
  return (gas / clip) * 100;
}
