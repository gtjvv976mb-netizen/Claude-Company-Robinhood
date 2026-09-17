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

/* ── re-measured on this chain, 2026-09-07 and 2026-09-13 ───────────────────
 *
 * Each of these was VOID (inherited from Solana, value null) until measured here, and
 * assertLiveReady() refused to arm on them — correctly. The measurements below are the
 * desk's own: the 2026-09-07 RH-universe sweep that set src/config.js's floors, the
 * 41-day hold-window backtest in src/bands.js, the 18-round-trip PONS impact table
 * above, and probe-measure-4663.mjs run for 240s on 2026-09-13 (24 round trips, 24
 * re-quotes, 118 gas samples). None is a Solana number scaled; each names its method.
 *
 * WHAT A "MEASURED" ENTRY MEANS HERE. It means the number was derived from a reading
 * taken against chain 4663 and the derivation is written beside it, so the next person
 * can re-run it. It does not mean the number is optimal, and every one of them should be
 * re-measured once the executor has a closed sample of its own. */

/* The clip the cost curve above is cheapest at: 0.0112 ETH (test-rh-sizing.mjs proves
   the interior minimum sits between 0.005 and 0.03). Every default that decides how much
   money moves reads this rather than restating it. */
export const CHEAPEST_CLIP_ETH = defineThreshold("size.cheapestClipEth", 0.0112,
  { ...M("2026-09-07", "argmin over the measured cost curve expectedRoundTripPct(clip): flat gas " +
    "(660,996 units at 0.309 gwei) plus the PONS 67th-percentile impact table, interpolated on log clip; " +
    "7.35% all-in at 0.0112 ETH against 9.16% at 0.004 and 55% at 0.0004"),
    unit: "ETH", live: true,
    note: "the desk's default per-trade size and the smallest clip the round trip is not mostly gas at; " +
      "the operator raises it with the caps ceremony, never by editing this" });

/* The smallest position worth opening at all: the clip at which two gas legs are ~5% of
   the position at the 2026-09-13 median gas price (and ~11% at the 0.33 gwei of 09-04).
   The route-sizing ladder in poller.mjs halves a clip that fails the round-trip ceiling
   and stops here rather than shrinking a trade into its own gas. */
export const MIN_CLIP_ETH = defineThreshold("size.minClipEth", 0.004,
  { ...M("2026-09-13", "660,996 gas × 0.0844 gwei (median of 118 samples over 240s) = 0.0000558 ETH, " +
    "1.4% of 0.004 ETH; at the 2026-09-04 reading of 0.309 gwei it is 0.000204 ETH, 5.1%"),
    unit: "ETH", live: true });

/* THE OPERATOR'S LIVE CAPS, IN ONE PLACE BECAUSE TWO READERS NEED THEM.
   poller.mjs owned this arithmetic alone while it was the only reader. simulate.mjs is
   the second: a simulation run at Solana's 0.05/0.5/0.15 against a 0.0112 ETH clip never
   binds a portfolio brake, so it measured an engine whose rails were switched off — the
   caps have to be the SAME numbers the live process uses, not a restatement of them.
   Every one is derived from the measured cheapest clip above rather than chosen, so a
   re-measurement of that one number moves the whole ladder. */
/* HOW MANY OBSERVATIONS A NEW REFUSAL CLAUSE MUST ACCUMULATE BEFORE IT MAY KILL.
   Deliberately ASSUMED and live:false, and both are the honest labels: this is not a
   measurement of chain 4663, it is the desk's own claim floor (src/improvement-constants
   CLAIM_SAMPLE_FLOOR, which src/perf.js edgeClaimable also reads) applied to the
   executor's gates so one bar governs both halves of the company. Registering it as
   measured would be a lie assertLiveReady() has no way to catch, and live:false is
   correct because it decides no trade — it decides when a human is allowed to turn one
   on. A lint that cries wolf gets switched off, so a gate that has not earned its
   promotion does not get one. */
export const GATE_PROMOTION_SAMPLE = defineThreshold("gates.promotionSampleFloor", 100,
  { provenance: P.ASSUMED, live: false, unit: "observations",
    note: "a new refusal clause records pass/would_refuse/unreadable until it clears this, " +
      "then a human reads observations-report.mjs and promotes it deliberately" });

/* THE SHARE OF THE RISKED DISTANCE THAT NETWORK FEES MAY EAT.
 *
 * ASSUMED and live:false, and both labels are the honest ones. Nobody has measured that
 * a quarter is the right share on chain 4663 — it is the desk's policy constant, and
 * src/agents/risk-rails.js stopFloorDetail() already solves the PUBLISHED stop floor from
 * it. This is its home; src/config.js imports it, the same direction SLIPPAGE_BPS and
 * MIN_STOP_DISTANCE_PCT already travel. Do not launder it to MEASURED to satisfy
 * assertLiveReady(): it is not a gate, it is the constant a derived gate is solved from,
 * and that gate must earn its own promotion. INHERITED would be the wrong label too, and
 * not a kinder one: in this registry INHERITED means VOID UNTIL RE-MEASURED and BLOCKING
 * (thresholds.mjs, and test-thresholds.mjs holds every inherited row to value === null,
 * live === true). A null here would delete the floor this constant derives, which is the
 * opposite of what marking it honestly is for. ASSUMED — "a starting guess nobody has
 * checked" — is exactly what 0.25 is on this chain.
 *
 * IT WAS ENV-LOOSENABLE, WHICH IS THE BUG. src/config.js read
 * `Number(process.env.EXECUTOR_MAX_FEE_SHARE_OF_STOP || 0.25)` with no clamp, so
 * share=1 quartered the floor this constant derives and share=0 deleted it outright — a
 * safety number an environment variable could switch off. Configuration may TIGHTEN a
 * safety number and never loosen it, so the clamp below admits (0, 0.25] and throws on
 * anything else rather than falling back to a default the operator did not ask for. */
export const MAX_FEE_SHARE_OF_STOP = defineThreshold("exec.maxFeeShareOfStop", 0.25,
  { provenance: P.ASSUMED, live: false, unit: "fraction",
    note: "the share of the risked distance network fees may consume; risk-rails' " +
      "stopFloorDetail() solves the published stop floor from it, and the executor's " +
      "fee floor is solved from the same number so the two halves cannot disagree" });

/** An override may only ever TIGHTEN. (0, 0.25]; anything else throws at boot. */
export function clampFeeShareOfStop(raw) {
  if (raw == null || raw === "") return MAX_FEE_SHARE_OF_STOP;
  const v = Number(raw);
  if (!Number.isFinite(v))
    throw new Error(`EXECUTOR_MAX_FEE_SHARE_OF_STOP must be a number, got "${raw}"`);
  if (!(v > 0))
    throw new Error(`EXECUTOR_MAX_FEE_SHARE_OF_STOP must be above 0 — 0 deletes the fee floor entirely`);
  if (v > MAX_FEE_SHARE_OF_STOP)
    throw new Error(`EXECUTOR_MAX_FEE_SHARE_OF_STOP may only tighten: ${v} is above the ` +
      `${MAX_FEE_SHARE_OF_STOP} the desk derives its published stop floor from`);
  return v;
}

export const LIVE_CAPS = Object.freeze({
  maxEthPerTrade: CHEAPEST_CLIP_ETH,
  dailyEthCap: Number((CHEAPEST_CLIP_ETH * 10).toFixed(6)),
  dailyLossLimitEth: Number((CHEAPEST_CLIP_ETH * 3).toFixed(6)),
  maxOpenPositions: 4,
});

export const MIN_LIQUIDITY_USD = defineThreshold("screen.minLiquidityUsd", 2_000,
  { ...M("2026-09-07", "DexScreener sweep of the desk's own on-board RH universe: liquidity p10 $6.6k / " +
    "p50 $13.4k; the OPENNESS_LEVELS.open floor in src/config.js admits 59% of that sample where the " +
    "pump.fun-scaled $8k admitted 12%. The per-coin exit is measured separately by the $75 round-trip " +
    "probe (cannot_exit at 8%) and the on-chain sell simulation, which is what actually decides " +
    "exitability — this floor only says 'too quiet to bother with'"),
    unit: "USD", live: true,
    note: "consumed by src/config.js BAND_FLOORS (scaled per band); the executor itself has no liquidity " +
      "screen and trusts the desk's per-coin round-trip measurement carried on the call" });

export const MIN_STOP_DISTANCE_PCT = defineThreshold("screen.minStopDistancePct", 14,
  { ...M("2026-09-13", "the executor's own entry guard, solved at the default clip: conservative return = " +
    "(1 − round trip) × (1 − slippage)² − 2 legs of gas / clip. At 0.0112 ETH: PONS 67th-percentile " +
    "impact interpolated to 5.2%, slippage 300 bps a leg (5.91% over both), gas 0.00022 ETH (2.0%), " +
    "probe noise 0.9% — conservative return 87.2%, so a stop closer than 12.8% is triggered by the costs " +
    "alone; rounded up to 14. The desk's own bands author -25%, which clears it with room"),
    unit: "%", live: true,
    note: "the flat fallback only; src/agents/risk-rails.js stopFloorDetail() derives each coin's floor from " +
      "its OWN measured round trip and gas, and compliance refuses a ticket under it" });

/* 300 bps, AND THE FIRST NUMBER I DERIVED HERE WAS WRONG — the way it was wrong is the
 * reason this entry is long.
 *
 * probe-measure-4663.mjs re-quoted 24 routes about 30 blocks (~3 s) apart on 2026-09-13
 * and measured an adverse drift of 2 bps at p95, with 22 of 24 moving in the buyer's
 * favour. Two bps. On a chain with no public mempool, FCFS ordering and refunded
 * priority fees there is no sandwich to pay for either, so 150 bps looked like 75× the
 * measured need and Solana's 300 looked like an inherited habit.
 *
 * Then the executor's real preflight was run against live pools at 150 bps and the
 * router reverted: "Return amount is not enough". Quote-to-quote drift over three
 * seconds is NOT the quantity slippage protects. The bytes are quoted, built, simulated
 * and only then sent, and the pool keeps moving across every one of those steps — on
 * memecoin pools whose own hour can be ±30%, a 1.5% move inside that window is ordinary.
 * Measured the same day at 50/100/150/300/1000 bps on five live pools, the chain returns
 * within 0-3 bps of the quote WHEN IT IS CALM; the refusal came from a pool that was not.
 *
 * So the number is 300, and it is 300 for a second reason that matters more than the
 * first: src/config.js executorSlippageBps is 300, and the desk's stop floor
 * (risk-rails.js stopFloorDetail) prices every published stop against it. An executor
 * trading tighter than the desk authored for is the two halves disagreeing about one
 * fact, which is the failure this fork has now found four times. One number, both sides.
 *
 * The cost of 300 over 150 is bounded and known: 5.91% of round-trip haircut instead of
 * 2.98%, which the entry ceiling and the stop floor below both already carry. */
export const SLIPPAGE_BPS = defineThreshold("exec.slippageBps", 300,
  { ...M("2026-09-13", "prepareSwap run against five live pools (scpinu, DOGE-1, AC, CROSSRATE, LSBK) at " +
    "0.0112 and 0.05 ETH and at 50/100/150/300/1000 bps: the executed calldata returns 0-3 bps under the " +
    "quote in calm conditions, and a live 150 bps attempt reverted with 'Return amount is not enough' " +
    "when the pool moved between the quote and the simulation. Quote-to-quote drift over 3s was 2 bps " +
    "at p95 (24 re-quotes) and is NOT the quantity being protected against. 300 also equals " +
    "src/config.js executorSlippageBps, which the desk's stop floor is computed from"),
    unit: "bps", live: true,
    note: "the desk and the executor must price slippage identically or the desk authors stops its own " +
      "bot proves unfillable — the Solana desk refused four consecutive live calls that way on 2026-09-03" });

export const MAX_PRICE_IMPACT_PCT = defineThreshold("exec.maxPriceImpactPct", 10,
  { ...M("2026-09-13", "evm-swap.mjs measures impact as the rate at the clip against the rate at 2% of the " +
    "clip, per leg. Half the measured PONS round trips: 2.0% at 0.005 ETH and 4.1% at 0.05 ETH at the " +
    "67th percentile, 3.1% and 4.9% at the worst rows; probe-measure-4663.mjs 2026-09-13 read TWINE " +
    "2.9%/5.1%/8.9% and ZFORGE 0.7%/1.7%/10.7% round trips at 0.005/0.05/0.5 ETH. 10% per leg refuses " +
    "only a pool thinner than the desk's own 8% round-trip ceiling would have admitted"),
    unit: "%", live: true,
    note: "the ENTRY cap; the exit cap (maxExitPriceImpactPct, 50) is deliberately looser so a stop can " +
      "still fire into a draining pool" });

export const BAND_FLOORS = defineThreshold("bands.floors",
  Object.freeze({ level: "open", base: { liq: 2_000, vol: 50, txns: 5, ageH: 0.1 },
    shape: { nano: 0.25, micro: 0.5, low: 0.625, medium: 1, high: 1.5, very_high: 1.875 } }),
  { ...M("2026-09-07", "DESK_OPENNESS levels measured on the desk's DexScreener RH universe (17 on-board " +
    "coins): strict $8k/$8k/40 admitted 2 (12%), balanced 9 (53%), open $2k/$50/5 admitted 10 (59%), " +
    "wide 14 (82%); on pump.fun a live coin does $8k an hour, here the median on-board coin does $322 " +
    "a DAY, so the old bar was scaled to another market. The per-band shape is the owner's"),
    live: true,
    note: "the authority is src/config.js OPENNESS_LEVELS / BAND_SHAPE; this registers that they were " +
      "measured here and are not pump.fun's" });

export const HOLD_WINDOWS = defineThreshold("bands.holdWindows", 120,
  { ...M("2026-09-07", "two independent measurements on RH prices. (1) median best move within a window: " +
    "1.14% at 30m, 1.85% at 1h, 4.21% at 6h, 6.32% at 3d, 12.96% at 7d, against an all-in round trip of " +
    "7.35% at the cheapest clip. (2) the same 41 days traded, bracket fixed at -25%/+1.6x, varying only " +
    "the hold, over 730 published calls: 1h -14.71%, 6h -12.43%, 24h -7.36%, 72h -2.31%, 120h +2.19%, " +
    "240h +8.85%. Monotonic; the sign flips between 72h and 120h, so 120h is the shortest window that is " +
    "not measurably loss-making"),
    unit: "h", live: true,
    note: "applied in src/bands.js (HOLD_MAX_MS) and executor/trade-policy.mjs (maxAgeHours); " +
      "test-hold-clock.mjs pins the two together. Longer holds measured better still, but 41 days holds " +
      "only ~8 non-overlapping 120h periods, so that extra confidence is the same weeks counted twice" });

/* THE GATE, NOT THE COST MODEL (lessons-lint gate-doubles-as-cost). The cost model is
   gas × the live gas price, computed per tick in poller.mjs. This is the fee above which
   a signature is REFUSED: a 650,000-gas leg (a PONS swap's estimate × 1.3) at a maxFeePerGas
   of 3 gwei (the executor bids 2× the consensus gas price, so that is a 1.5 gwei reading).
   Below it every ordinary day clears; above it only the spike regime is refused. */
/* A NUMBER, NOT A BIGINT. Every threshold is serialized into the Codex review bundle and
   the heartbeat, and JSON.stringify throws on a BigInt — the registry is read by more
   things than the executor. 2e15 is exact in a double (well under 2^53) and every
   consumer converts with BigInt() at the point of comparison. */
export const MAX_NETWORK_FEE = defineThreshold("exec.maxNetworkFeeWei", 2_000_000_000_000_000,
  { ...M("2026-09-13", "eth_gasPrice sampled 118× over 240s: median 0.0844 gwei, p99 0.0884, max 0.0891; " +
    "documented range 0.02 → 0.7 gwei over the two weeks to 2026-09-04 with spikes past 5 gwei; " +
    "0.41 → 0.80 gwei between two runs fifteen minutes apart on 2026-09-05. The ceiling is the worst-case " +
    "fee of one 650,000-gas leg at a 3 gwei maxFeePerGas: 0.00195 ETH, rounded to 0.002 — ~18% of the " +
    "cheapest clip, and only ever reached in the >1.5 gwei spike regime"),
    unit: "wei", live: true,
    note: "compared, never multiplied: sizing charges expectedNetworkFeeWei (poller.mjs), which is the " +
      "measured round-trip gas at the gas price both providers report right now" });

/* ── the nonce machine's own unknowns, measured by the executor itself ─────────
 *
 * evm-executor.mjs treats "no receipt past deadline_block" as a sequencer drop and
 * CANCELS the nonce. Three facts decide whether that machine is tuned or guessing: how
 * long inclusion takes, how often a submitted transaction never appears, and whether the
 * sequencer honours a same-nonce replacement at all. All three need a funded burner and
 * a REAL send, which a read-only campaign cannot produce.
 *
 * They were registered VOID and `live: true`, which meant the executor could not arm
 * until someone sent a transaction — with an executor that could not arm. That is a gate
 * that can never open. The Solana desk's answer to the same knot was a real, tiny,
 * deliberate round trip before the first call (its live-roundtrip-test.mjs; "30 mainnet
 * transactions say the bytes are right"), and it is the answer here: live-roundtrip-4663.mjs
 * sends a self-transfer and one buy-then-sell through the very same EvmExecutor, into a
 * separate journal, and prints these three as M() lines with the tx hashes as the method.
 * The running executor also records every send's latency and outcome in journal meta
 * `send_stats` (evm-executor.mjs) and carries them on the heartbeat, so the numbers keep
 * being measured for as long as it trades.
 *
 * Until then the machine ASSUMES NOTHING about them: deadlineBlocks is bounded at 300, a
 * dropped cancel is resent, and after maxCancelResends the intent is quarantined rather
 * than retried forever. So these are `live: false` — they describe the machine's tuning,
 * they do not decide whether a trade happens or how much money moves — and they carry the
 * CANARY provenance so nobody reads them as measured. */
export const INCLUSION_LATENCY_MS = defineThreshold("exec.inclusionLatencyMs", null,
  { provenance: P.CANARY, unit: "ms", live: false,
    note: "submit → receipt latency at 100ms blocks. Measured by live-roundtrip-4663.mjs and by every " +
      "live send (journal meta send_stats). deadlineBlocks=300 (~30s) bounds the wait meanwhile." });

export const DROP_RATE_PCT = defineThreshold("exec.dropRatePct", null,
  { provenance: P.CANARY, unit: "%", live: false,
    note: "share of submitted transactions that never receive a receipt. Measured by the same two paths; " +
      "poller.mjs pauses entries when the rolling drop rate over the last sends exceeds SEND_DROP_PAUSE_PCT." });

export const NONCE_REPLACEMENT_HONOURED = defineThreshold("exec.nonceReplacementHonoured", null,
  { provenance: P.CANARY, live: false,
    note: "whether a same-nonce, higher-fee replacement is accepted by the sequencer. Priority fees are " +
      "refunded and there is no fee auction, so nothing in the chain's design promises it. The cancel path " +
      "assumes nothing: a dropped cancel is resent, and after maxCancelResends the intent is quarantined." });
