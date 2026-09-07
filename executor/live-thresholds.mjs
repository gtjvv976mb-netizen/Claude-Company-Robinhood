/**
 * THE DESK'S NUMBERS, EACH WITH ITS PROVENANCE.
 *
 * Split honestly. What was actually measured against chain 4663 on 2026-09-03/04 is
 * marked `measured` and may trade. Everything carried over from the Solana desk is
 * marked `inherited` and is VOID until re-measured here — those entries are on the live
 * path, so `assertLiveReady()` refuses to arm the executor while any of them remain.
 *
 * That refusal is the point. The Solana numbers all carry convincing justifications,
 * which is precisely why they would otherwise survive the port unexamined.
 */
import { defineThreshold, PROVENANCE as P } from "./thresholds.mjs";

const M = (at, method) => ({ provenance: P.MEASURED, at, method });
const VOID = (note) => ({ provenance: P.INHERITED, note });

/* ── measured here, and therefore tradeable ─────────────────────────────── */

export const CHAIN_ID = defineThreshold("chain.id", 4663,
  { ...M("2026-09-04", "eth_chainId against rpc.mainnet.chain.robinhood.com returned 0x1237"), live: true });

export const BLOCK_MS = defineThreshold("chain.blockMs", 100.6,
  { ...M("2026-09-04", "10,000 blocks spanned 1006s between 53,654,185 and 53,664,185"),
    unit: "ms", live: true });

export const GAS_PRICE_GWEI = defineThreshold("chain.gasPriceGwei", 0.309,
  { ...M("2026-09-04", "eth_gasPrice returned 309,210,000 wei"), unit: "gwei", live: false,
    note: "a spot reading, not a distribution — re-read per trade, never cached as a constant" });

export const ROUND_TRIP_GAS = defineThreshold("swap.roundTripGasUnits", 660_996,
  { ...M("2026-09-04", "median of 9 KyberSwap-routed round trips (buy then sell the exact output) " +
    "across CASHCAT, PONS and AI at 0.01/0.05/0.2 ETH; range 618,079-823,333"),
    unit: "gas", live: true,
    note: "BOTH legs. At 0.326 gwei this is 0.00021548 ETH, about $0.54 — and it is FLAT, " +
      "not proportional. On Solana a round trip cost 4.5-5.6% of the trade at any size; here " +
      "the same $0.54 is 4.31% of a 0.005 ETH clip and 0.04% of a 0.5 ETH one. That inverts " +
      "the sizing logic: small clips are punished and large ones are nearly free, which is the " +
      "opposite of the regime every inherited threshold was tuned in." });

/* THE PROBE'S OWN NOISE, WHICH BOUNDS WHAT IT CAN RESOLVE.
   Measured: of nine units-consistent round trips, THREE returned negative — more ETH back
   than went in, to -0.869%. That is not arbitrage, it is the two legs being quoted moments
   apart against a moving pool. So a quote-based exit probe on this chain cannot resolve a
   cost below roughly a percent, and the Solana desk's probe only worked because the costs
   it measured (4.5-5.6%) sat far above its noise. Anything tighter has to be simulated
   on-chain with eth_call, or medianed over repeats. Registered so nobody reads a single
   sub-percent probe reading as a fact. */
export const EXIT_PROBE_NOISE_PCT = defineThreshold("probe.quoteNoisePct", 0.9,
  { ...M("2026-09-04", "spread of 9 round trips that should all have been positive: -0.869% to +0.665%"),
    unit: "%", live: false });

/* PONS ITSELF, MEASURED. The rows above were sampled chain-wide; these are the venue the
   desk is pointed at. 18 KyberSwap-quoted round trips (buy, then sell the exact quoted
   output) across six pons-v2-dex pools spanning three liquidity tiers, 2026-09-07:
     0.005 ETH — WHATC 2.664, NODAL 5.972, STOCKKIT 6.147, BELL 4.055, PORT -0.962, ZZZ 0.326
     0.05  ETH — 8.363, 9.865, 8.250, 4.926, 6.673, 0.387
     0.5   ETH — 42.200, 36.251, 25.045, 12.795, 12.329, 1.627
   Medians below. These are IMPACT ONLY — quote in, quote out — and exclude gas, which is
   flat and must be added at the clip being traded. PORT's negative reading is inside the
   0.9% quote-noise floor and is not a rebate. */
/* THESE ARE NOT MEDIANS, AND THEY WERE LABELLED AS ONE.
 *
 * Each value below is the 4th smallest of the six rows above it — about the 67th
 * percentile — not the median. The true medians are 3.360 / 7.462 / 18.920. The name and
 * the provenance string both said "median" and were wrong, and a downstream comment then
 * quoted them as medians when it set the liquidity haircut's boundaries.
 *
 * THE VALUES ARE KEPT AND THE LABEL IS CORRECTED, deliberately. This feeds a COST
 * estimate for a +EV gate, and the failure that matters there is understating cost —
 * that is the direction which makes a losing bracket look profitable. An upper-middle
 * quantile is the right conservatism for that job; the median would have been the
 * flattering choice. So the number stays, and it now says what it is. */
export const PONS_ROUND_TRIP_PCT = defineThreshold("roundTrip.ponsP67Pct",
  Object.freeze({ 0.005: 4.055, 0.05: 8.250, 0.5: 25.045 }),
  { ...M("2026-09-07", "18 KyberSwap-quoted round trips across 6 pons-v2-dex pools and 3 liquidity " +
    "tiers. The values registered are the 67th percentile (4th of 6): 4.055% at 0.005 ETH, 8.250% " +
    "at 0.05 ETH, 25.045% at 0.5 ETH. For reference the MEDIANS are 3.360/7.462/18.920 and the " +
    "worst rows are 6.147/9.865/42.200"),
    unit: "%", live: false,
    note: "impact only, gas excluded, and deliberately the 67th percentile rather than the median " +
      "because this feeds a cost estimate where understating is the dangerous direction. " +
      "Interpolate on log clip between the measured points; below 0.005 ETH hold the smallest " +
      "measured row rather than extrapolating toward zero, because the probe cannot resolve " +
      "below its 0.9% noise floor." });

/** The true medians of the same 18 round trips, registered so the two are never confused again. */
export const PONS_ROUND_TRIP_MEDIAN_PCT = defineThreshold("roundTrip.ponsMedianPct",
  Object.freeze({ 0.005: 3.360, 0.05: 7.462, 0.5: 18.920 }),
  { ...M("2026-09-07", "medians of the same 18 KyberSwap-quoted PONS round trips: " +
    "(2.664+4.055)/2, (6.673+8.250)/2, (12.795+25.045)/2"),
    unit: "%", live: false, note: "reference only — the cost path uses the 67th percentile above" });

/**
 * What a round trip costs, all-in, at a given clip — impact from the measured PONS table
 * plus the flat gas the chain charges whatever the size.
 *
 * This exists because strategy.mjs's costPct is the ONLY cost term in the +EV gate
 * (R_net = (target - cost) / (stop + cost)), and it shipped as Solana's 0.06 — a Jupiter
 * round trip on a chain where gas was proportional and negligible. Here gas is FLAT:
 * 660,996 units is 5.1% of a 0.004 ETH position and 0.4% of a 0.05 ETH one. A single
 * inherited constant cannot express that, and the direction of the error is the dangerous
 * one — 0.06 understates the true cost at every clip the operator is permitted to trade.
 *
 * A STARTUP ESTIMATE, NOT A PER-TRADE TRUTH. The live protection is the per-entry fee
 * gate and the round-trip loss ceiling, both of which read the actual quote. This only
 * has to be close enough that the +EV gate is not lying to itself.
 */
export function expectedRoundTripPct(clipEth, { gasGwei = GAS_PRICE_GWEI, impactPct = null } = {}) {
  const clip = Number(clipEth);
  if (!Number.isFinite(clip) || clip <= 0) throw new Error("clip must be a positive number of ETH");
  const rows = Object.entries(PONS_ROUND_TRIP_PCT).map(([k, v]) => [Number(k), Number(v)])
    .sort((a, b) => a[0] - b[0]);
  let impact = impactPct;
  if (impact == null) {
    if (clip <= rows[0][0]) impact = rows[0][1];
    else if (clip >= rows[rows.length - 1][0]) impact = rows[rows.length - 1][1];
    else {
      impact = rows[rows.length - 1][1];
      for (let i = 0; i + 1 < rows.length; i++) {
        const [x0, y0] = rows[i], [x1, y1] = rows[i + 1];
        if (clip < x0 || clip > x1) continue;
        const t = (Math.log(clip) - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
        impact = y0 + t * (y1 - y0);
        break;
      }
    }
  }
  const gasEth = ROUND_TRIP_GAS * Number(gasGwei) * 1e-9;
  return impact + (gasEth / clip) * 100;
}

export const ROUND_TRIP_DEEP_PCT = defineThreshold("roundTrip.deepPct", 0.017,
  { ...M("2026-09-04", "CASHCAT (~$5.9M liquidity), 0.1 ETH clip, three consecutive passes: 0.015-0.018%"),
    unit: "%", live: true });

export const ROUND_TRIP_THIN_PCT = defineThreshold("roundTrip.thinPct", 8.92,
  { ...M("2026-09-04", "Ordihood on a $50 clip; Chump Coin came back at ~2% on the same sweep"),
    unit: "%", live: true,
    note: "the distribution here is BIMODAL — deep pools are 100x cheaper than Solana, the tail is worse" });

export const LAUNCH_RATE_PER_MIN = defineThreshold("universe.newPoolsPerMin", 20,
  { ...M("2026-09-04", "GeckoTerminal returned ~20 pools created within the last minute, repeated"),
    unit: "pools/min", live: false });

/* ── inherited from Solana, void here, and blocking ─────────────────────── */

export const MIN_LIQUIDITY_USD = defineThreshold("screen.minLiquidityUsd", null,
  { ...VOID("The Solana floor was derived from four measured Jupiter round trips at $75 " +
    "(4.53%, 5.49%, 5.58%, 3.70%). This chain measured 0.015-0.018% deep and 8.92% thin, so the " +
    "floor that separated exitable from not is somewhere else entirely."), unit: "USD", live: true });

export const MIN_STOP_DISTANCE_PCT = defineThreshold("screen.minStopDistancePct", null,
  { ...VOID("12% on Solana, because slippage on both legs (5.91% at 300bps) plus worst-case fees " +
    "plus ~1.25% a side of launchpad tax came to ~9%. Every one of those terms is different here: " +
    "gas is $0.18 flat rather than proportional, and the round trip is two orders of magnitude " +
    "cheaper on a deep pool. Re-derive from a measured round trip, do not scale the old number."),
    unit: "%", live: true });

export const SLIPPAGE_BPS = defineThreshold("exec.slippageBps", null,
  { ...VOID("300bps on Solana. A centralized sequencer plausibly means no public mempool and so " +
    "little sandwich risk, which would let this run far tighter — but that is unconfirmed, and " +
    "slippage tolerance costs real money when guessed."), unit: "bps", live: true });

export const MAX_PRICE_IMPACT_PCT = defineThreshold("exec.maxPriceImpactPct", null,
  { ...VOID("5% on Solana. Uniswap v3 depth is range-dependent: a pool can read deep while being " +
    "empty just below the current tick, which has no Solana analogue."), unit: "%", live: true });

export const BAND_FLOORS = defineThreshold("bands.floors", null,
  { ...VOID("The six market-cap sleeves and their liquidity/volume/age floors were tuned against " +
    "pump.fun's population. PONS graduates ~1.1% of ~124k launches at ~20 new pools a minute; the " +
    "shape of that population is not the same and the boundaries move with it."), live: true });

export const HOLD_WINDOWS = defineThreshold("bands.holdWindows", null,
  { ...VOID("1-30min nano through 5-24h very_high, set against Solana's 400ms blocks and fee-auction " +
    "ordering. Blocks here are 100ms and ordering is first-come-first-served with no auction, so the " +
    "speed at which a position can be entered and left is different in kind."), live: true });

export const MAX_NETWORK_FEE = defineThreshold("exec.maxNetworkFeeWei", null,
  { ...VOID("The Solana ceiling was 2,000,000 lamports, derived from measured Jupiter priority fees " +
    "on a ~135k-CU transaction. There is NO priority auction here, so the concept it priced does not " +
    "exist — this needs re-deriving as a gas ceiling, and note the Solana build separately learned to " +
    "keep the refusal gate apart from the cost model."), unit: "wei", live: true });

/* ── the nonce machine's own unknowns, registered so assertLiveReady() blocks on them ──
 *
 * evm-executor.mjs treats "no receipt past deadline_block" as a sequencer drop and
 * CANCELS the nonce. Three facts decide whether that machine is tuned or guessing, and
 * none has been measured: how long inclusion takes (sets deadlineBlocks — 300 is a
 * guess), how often a submitted transaction simply never appears (sets how much of the
 * exit budget the cancel path will consume), and whether the sequencer honours a
 * same-nonce replacement at all on an FCFS chain with no fee auction (if it does not,
 * a cancel is only ever a second chance for the ORIGINAL to be dropped too, and the
 * bound on maxCancelResends is the only thing between the desk and a permanent
 * ambiguous latch). All three need a funded burner and a real send; the read-only
 * campaign in probe-measure-4663.mjs cannot produce them and says so. */
export const INCLUSION_LATENCY_MS = defineThreshold("exec.inclusionLatencyMs", null,
  { ...VOID("submit → receipt latency distribution at 100ms blocks; unmeasured — needs a funded " +
    "burner sending real 0-value self-transfers. deadlineBlocks=300 in evm-executor.mjs is a guess " +
    "pending this number."), unit: "ms", live: true });

export const DROP_RATE_PCT = defineThreshold("exec.dropRatePct", null,
  { ...VOID("share of submitted transactions that never receive a receipt (sequencer-level " +
    "rejection, documented generically for Arbitrum Nitro, never measured on 4663). Sets how " +
    "often the cancel path runs and therefore how much fee the exit budget must reserve."),
    unit: "%", live: true });

export const NONCE_REPLACEMENT_HONOURED = defineThreshold("exec.nonceReplacementHonoured", null,
  { ...VOID("whether a same-nonce, higher-fee replacement is accepted by the sequencer at all. " +
    "Priority fees are refunded and there is no fee auction, so nothing in the chain's design " +
    "promises it. Until measured, the cancel path assumes NOTHING about it: a dropped cancel is " +
    "resent, and after maxCancelResends the intent is quarantined rather than retried forever."),
    live: true });
