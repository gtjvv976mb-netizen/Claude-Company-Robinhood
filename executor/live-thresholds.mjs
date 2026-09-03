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

export const SWAP_GAS = defineThreshold("swap.gasUnits", 227_860,
  { ...M("2026-09-04", "eth_estimateGas on a real built swap, one route, one sample"),
    unit: "gas", live: true,
    note: "ONE sample on ONE route. Widen before sizing anything on it." });

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
