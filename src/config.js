import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

// Minimal .env loader so the desk has no dotenv dependency.
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);

export const CHARTER = fs.readFileSync(path.join(ROOT, "DESK.md"), "utf8");

/* THE CHAIN. Robinhood Chain, an Arbitrum Nitro L2: chainId 4663 (0x1237), ~100ms
 * blocks, first-come-first-served ordering with no priority auction. Measured
 * 2026-09-05: eth_chainId on the public RPC returned 0x1237; eth_gasPrice 0x18fd5e90
 * (0.42 gwei) at 20:5x UTC and 0x17a77350 forty minutes later — it moved 0.02 → 0.7 gwei
 * over the two weeks before, and spikes past 5 gwei, so it is read per ticket and never
 * cached anywhere in src/. */
export const CHAIN_ID = 4663;
export const CHAIN_HEX = "0x1237";

export const cfg = {
  /* RH_RPC is the desk's read endpoint; RH_RPC_SECONDARY an optional second provider the
     evidence reads fall back to on a 429. `rpc` stays as an alias so the files not yet
     ported off Solana names (index.js doctor, perf.js, passes.js, leasing.js) keep
     resolving a URL rather than `undefined` — they get a method-not-found through the
     ordinary {ok:false} path. See docs/HANDOFF-data-sources.md. */
  rhRpc: process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com",
  rhRpcSecondary: process.env.RH_RPC_SECONDARY || "",
  get rpc() { return this.rhRpc; },
  chainId: CHAIN_ID,
  birdeyeKey: process.env.BIRDEYE_API_KEY || "",

  equityUsd: num("DESK_EQUITY_USD", 10000),
  maxRiskPct: num("DESK_MAX_RISK_PCT", 1.0),
  maxBookRiskPct: num("DESK_MAX_BOOK_RISK_PCT", 4.0),
  maxCandidates: num("DESK_MAX_CANDIDATES", 8),
  /* THE SIZE THE EXIT PROBE MEASURES AT — and it must resemble the size actually
   * traded, or the desk vetoes coins on a cost nobody pays. It has come down twice:
   * $500 (chosen against the $10,000 notional book above), then $200, now $75.
   *
   * The executor sizes at ~$3.40 with a hard cap near $10, so $75 still prices about
   * twenty tenants copying one call at once — which is the reason to probe above your
   * own clip at all. But it no longer vetoes the micro-caps this desk now hunts: at
   * the $12,000 liquidity floor below, $75 round-trips at 2.5%, well inside the 8%
   * ceiling, while a real $3.40 clip costs 0.11%. */
targetSizeUsd: num("DESK_TARGET_SIZE_USD", 75),

  // Deterministic screen floors. These kill before any token is spent.
  screen: {
    /* LOWERED FOR MICRO-CAPS, and only safe because the probe came down with it.
     *
     * $75,000 -> $25,000 was measured against the live market: the survivor curve
     * went flat below $25k, so nothing more was admitted. That measurement assumed
     * the OTHER floors (volume $50k, txns 200) were unchanged — and those are what
     * were actually excluding the sub-$1m coins this desk now wants.
     *
     * At $12,000 a real $3.40 clip round-trips at 0.11% and the $75 probe at 2.5%.
     * The pool is thin enough to be drained by a determined seller, which is exactly
     * what liq_collapse, cannot_exit, holder concentration and the freeze-authority
     * check are for. Those did not move and must not.
     *
     * Note this is DEPTH, not market cap: a $1m-cap coin is a claim about price x
     * supply, while liquidity is the money actually in the pool to sell into. They
     * are routinely an order of magnitude apart. */
minLiquidityUsd: num("DESK_MIN_LIQUIDITY_USD", 12000),
    // 24h here quietly strangled the sniper lane: the free screen killed every
    // coin the ignition path is FOR. The research's floor is one hour past
    // migration (rugs express inside the first hour); 1.5h keeps a margin.
    minPairAgeHours: num("DESK_MIN_PAIR_AGE_HOURS", 1.5),
    minVolume24hUsd: num("DESK_MIN_VOL24_USD", 15000),
    maxVolToLiqRatio: num("DESK_MAX_VOL_LIQ", 40),   // above this, suspect wash
    minTxns24h: num("DESK_MIN_TXNS24", 60),
    maxFdvToLiqRatio: num("DESK_MAX_FDV_LIQ", 250),  // thin float propping a fat FDV

    /* THE CEILING — $10m, now $3m. This desk hunts the coins that can still re-rate.
     *
     * A memecoin thesis is a claim that a coin can multiply. At $3m a 2x needs a few
     * million of fresh money; at $30m it needs sixty, which is somebody else's
     * business. The upside lives well below this line, and the whole point of coming
     * down here is that a 2x is an ordinary afternoon rather than a bull market.
     *
     * A ceiling on the OPPORTUNITY, not on safety. What decides whether a position
     * can be LEFT is the liquidity floor and the exit probe, and an unknown market
     * cap never fails this check — an unreadable number must not become an
     * execution. */
/* The board runs $10k to $20m. Below $10k there is not enough coin to trade and
     * the pool is one wallet; above $20m is somebody else's business. */
    /* $5k, the floor of the nano sleeve. It sat at $10k while the nano band starts at
     * $5k, so the smallest half of the band the owner asked for was refused as
     * "too_small" by a number nobody had moved. */
    minMarketCapUsd: num("DESK_MIN_MCAP_USD", 5_000),
    /* $10m, matching the top of the very-high sleeve (categories.js). The two numbers
     * are one taxonomy: a ceiling above the last sleeve creates calls no floor can
     * receive, which is the exact failure the sleeve test was written to catch. */
    maxMarketCapUsd: num("DESK_MAX_MCAP_USD", 10_000_000),
  },

  // Slippage the desk refuses to accept on a round trip at target size.
  /* INHERITED FROM SOLANA AND DECLARED VOID FOR 4663 by executor/live-thresholds.mjs
   * (screen.minLiquidityUsd, screen.minStopDistancePct, bands.floors, bands.holdWindows,
   * exec.*). The numbers below are kept AS THEY WERE so the screen keeps a shape and the
   * tests that assert their internal consistency keep passing; they are not a
   * measurement of this chain. Measured here so far, 2026-09-04/05: a deep pool
   * round-trips at 0.015-0.018% and a thin one at 8.92%; CASHCAT at 0.01 ETH came back
   * 0.63% AHEAD through two different pools. Re-measurement is the executor lane's
   * campaign; until it lands, assertLiveReady refuses to arm on these. */
  maxRoundTripSlippagePct: num("DESK_MAX_RT_SLIPPAGE", 8),
  /* Mirrors of the executor's own stop-floor inputs, read by risk-rails.js
     stopFloorDetail() so the Risk seat is told the number the bot will check a stop
     against. Verbatim from MAIN config.js:118-122 (HANDOFF-agents item 2); the fee
     share is a policy fraction, not a measurement of this chain. */
  /* The desk's own access token is never a position: it opens a floor. Read once so the
     screen (evidence.js) and the executor's scope guard refuse it by address. */
  accessToken: (process.env.CLAUDECO_RH_TOKEN || "0x7039986CaC6C7885b53f10c7492E653055470ab9").toLowerCase(),
  executorSlippageBps: num("EXECUTOR_SLIPPAGE_BPS", 300),
  executorMaxFeeShareOfStop: Number(process.env.EXECUTOR_MAX_FEE_SHARE_OF_STOP || 0.25),

    /* THE STOP THAT COSTS ALONE WOULD TRIGGER.
     *
     * A stop closer to entry than the cost of getting in and out is not a stop; it is a
     * guaranteed exit charged to the book. The executor refuses those before signing,
     * and on 2026-09-03 it refused four consecutive live calls for exactly this —
     * HeeHaw, TOAD and USWS carried stops 5% to 6.5% below entry against a conservative
     * round-trip cost of about 9%. The desk was authoring trades its own bot could
     * prove were already lost.
     *
     * The number: the executor applies its slippage tolerance to BOTH legs
     * (1 - 0.97^2 = 5.91% at 300bps), adds a worst-case network fee near 2%, and pump.fun
     * itself takes about 1.25% a side on the small bands. Round to a floor of 12%, which
     * clears all three with room for the measured round trip on top. */
    minStopDistancePct: num("DESK_MIN_STOP_DISTANCE_PCT", 12),

  /* REWEIGHTED FOR THE MARKET THIS DESK IS ACTUALLY IN.
   *
   * Narrative was the LOWEST-weighted seat at 0.14 — on a memecoin desk, where the
   * story is not a tiebreak, it is the asset. Nothing else about a two-hour-old coin
   * with a $200k cap is informative: it has no chart worth reading, no revenue, and a
   * book thin enough that "liquidity analysis" mostly restates the screen. What it
   * has is a dev, an X account, and either real people talking or one script pasted
   * four hundred times. That is the whole question.
   *
   * So narrative — the seat holding Grok's first-party read of X — becomes the
   * heaviest. Forensics stays near the top because it answers a different question
   * that never stops mattering: can this be used against a holder by design.
   * Technical falls hardest; a coin younger than a trading session has no tape to
   * analyse and a "technical read" of one is astrology with a candlestick chart. */
  /* THE CHART IS THE LEAST INFORMATIVE THING ABOUT A MEMECOIN.
   *
   * Narrative was originally the LOWEST seat at 0.14 and technical the fourth at 0.16 —
   * weights that belong to an asset with fundamentals, where price action summarises
   * what a market of informed participants concluded. A six-hour-old coin has no such
   * market: its chart is a few hours of the same attention the narrative seat is
   * reading, redrawn as candles. Weighting both is double-counting the weaker copy.
   *
   * What actually moves these: whether the lore is real and traceable, whether a trend
   * is live and this coin is early to it, whether an endorsement is a genuine person
   * with reach or a bought post — and, separately, whether the thing can rug you.
   *
   * So narrative dominates, forensics holds its ground because "can this be used
   * against a holder" never stops mattering at any weight, flow answers whether the
   * buyers are people or one wallet in a wig, and the chart keeps a token weight
   * rather than none: a coin that has already gone vertical is still worth knowing
   * about, and zero would mean never hearing it. */
  /* THE SEATS NOW ASK MEMECOIN QUESTIONS, SO THE WEIGHTS FOLLOW THEM.
   *
   * forensics stopped being the mint/freeze seat — those are deterministic kills in the
   * free screen now, and a paid model re-checking a boolean is waste. What it asks
   * instead is who owns the float and would they sell it out from under you: bundling,
   * the middle of the book, and the creator's record. That is a harder question and a
   * more decisive one, so it holds its weight rather than losing it.
   *
   * liquidity keeps a small share because on this desk it mostly confirms what the
   * screen measured. It matters when a pool can be DRAINED, not when a whale would
   * move it — the bot trades $3 to $10. */
  weights: {
    narrative: 0.38,   // lore, trend, endorsement — on a memecoin this IS the asset
    forensics: 0.26,   // who owns the float, and have they rugged before
    flow: 0.24,        // a crowd, or a machine wearing one
    liquidity: 0.09,   // can it be exited at OUR size; the screen already measured it
    technical: 0.03,   // the chart, which on a 6-hour-old coin is attention redrawn
  },

  // Defaults are the economical tier; env vars UPGRADE a seat, they no longer rescue
  // the bill. Measured 2026-08-29: all-Opus ran $1.29-1.44 a workup, and three seats
  // were most of it — Red Team thinking at xhigh (31% of all spend by itself),
  // Narrative dragging ~41k tokens of raw web results in per run, and five analysts
  // filling bounded schemas on the priciest model in the house. Judgment seats keep
  // Opus; evidence-shaped verdicts do not need it.
  models: {
    scout:      process.env.DESK_MODEL_SCOUT      || "claude-haiku-4-5",
    forensics:  process.env.DESK_MODEL_FORENSICS  || "claude-sonnet-5",
    liquidity:  process.env.DESK_MODEL_LIQUIDITY  || "claude-sonnet-5",
    flow:       process.env.DESK_MODEL_FLOW       || "claude-sonnet-5",
    narrative:  process.env.DESK_MODEL_NARRATIVE  || "claude-sonnet-5",
    technical:  process.env.DESK_MODEL_TECHNICAL  || "claude-sonnet-5",
    redteam:    process.env.DESK_MODEL_REDTEAM    || "claude-opus-5",
    risk:       process.env.DESK_MODEL_RISK       || "claude-sonnet-5",
    pm:         process.env.DESK_MODEL_PM         || "claude-opus-5",
    execution:  process.env.DESK_MODEL_EXECUTION  || "claude-sonnet-5",
  },

  effort: {
    scout: "low",
    forensics: "high",
    liquidity: "medium",
    flow: "high",
    narrative: "medium",
    technical: "medium",
    redteam: "high",    // the adversary keeps the strongest MODEL; xhigh thinking alone
                        // was ~14k output tokens a run and a third of the whole bill
    risk: "high",
    pm: "high",
    execution: "medium",
  },

  // The desk stops paying, not the process: past this 24h spend, cycles skip their
  // model stages and say so on the tape. Monitoring (prices, exits) costs nothing
  // and keeps running.
  /* Raised 25 -> 40 at the owner's request, to get a cycle through TONIGHT.
   *
   * Today's $25 was consumed by the 5-minute scanner before the lane reserve existed
   * (163 workups, 138 of them killed at the screen), so every cycle since has started
   * and halted with no money to work with. The reserve fixes this from tomorrow on
   * its own — it is a rolling 24h window — but it cannot refund what is already
   * spent, and the autotrader has never once been exercised on a real call.
   *
   * $40 buys roughly 140 workups at the measured $0.126 each. The per-cycle ceiling
   * of $10 still bounds any single cycle, and the reserve still stops the scanner
   * taking more than 55%, so this raises the ceiling without loosening either brake. */
  dailyBudgetUsd: Number(process.env.DESK_DAILY_BUDGET_USD || 90),
};

/**
 * FLOORS THAT SCALE WITH THE COIN, because a flat one is a ban on small coins.
 *
 * Measured on a live sweep of 302: the micro band saw 60 coins and passed TWO. Forty-four
 * of the 58 deaths were `thin_liquidity` against a flat $12,000 floor — which asks a
 * $30k-cap coin for a liquidity-to-cap ratio of forty percent. No real micro-cap clears
 * that, so the owner's "at least 5 per category" was arithmetically impossible in the
 * band they most want, and the desk was quietly a large-cap desk wearing a memecoin
 * charter.
 *
 * The same shape of bug has bitten before: an ABSOLUTE step applied to a quantity that
 * spans two orders of magnitude prices the small end out entirely. Bands here run from
 * $10k to $20m — a 2000x range — so any single number is wrong at one end or the other.
 *
 * WHAT THE FLOOR IS ACTUALLY FOR decides where to put it. It is a cheap proxy for "can
 * our size get out", asked before the desk pays to measure the real thing. Round-trip
 * cost on a constant-product pool is about 4X/L, and the desk probes at $75 while the
 * executor trades $3-$10:
 *
 *     L = $5,000   $75 probe -> 6.0%   (inside the 8% ceiling)   $10 clip -> 0.8%
 *     L = $3,000   $75 probe -> 10.0%  (over the ceiling)
 *
 * So ~$5k is where the probe itself stops clearing, and that is the honest floor for a
 * micro-cap — not $12k.
 *
 * The floors RISE with market cap on purpose. A $30k coin with $5k of liquidity is
 * ordinary; a $15m coin with $5k of liquidity is a fiction, and the suspicion belongs to
 * the RATIO, which maxFdvToLiqRatio already catches independently.
 *
 * NONE OF THIS TOUCHES SAFETY. The measured exit probe (cannot_exit, round-trip loss
 * against maxRoundTripSlippagePct) is unchanged and absolute, as are honeypot mechanics,
 * live mint and freeze authority, and the unverified-is-not-safe rule. This lowers a
 * PROXY so that more small coins reach the real test; it does not lower the real test.
 */
/* One row per sleeve, and `ageH` is the youngest the desk will look at in that band.
 *
 * The age floor used to be one flat 1.5 hours for everything, which is a coherent rule
 * for a desk hunting day-old coins and an incoherent one for a desk asked to trade a
 * $9k coin inside thirty minutes: it refused, twice over, the exact population the
 * nano and micro sleeves exist for. It is now the band's own number. The larger bands
 * keep a real floor — a $5m coin an hour old is a different kind of claim.
 *
 * `vol` and `txns` are 24-HOUR floors. A coin four minutes old has no 24-hour history
 * and never will in time to matter, so a coin inside its band's hunt window is judged
 * on its minute tape instead (see wouldSurviveScreen). Neither path touches the real
 * test: the measured Jupiter round-trip, live mint and freeze authority, holder
 * concentration and honeypot mechanics are unchanged and absolute. */
import { bandForMarketCap } from "./bands.js";

export const BAND_FLOORS = {
  nano:      { liq: 2_000,  vol: 1_500,  txns: 10, ageH: 0.02 },  // $5k-$20k, from a minute old
  micro:     { liq: 4_000,  vol: 3_000,  txns: 20, ageH: 0.05 },  // $20k-$60k
  low:       { liq: 5_000,  vol: 4_000,  txns: 25, ageH: 0.25 },  // $60k-$100k
  medium:    { liq: 8_000,  vol: 8_000,  txns: 40, ageH: 0.5 },   // $100k-$500k
  high:      { liq: 12_000, vol: 12_000, txns: 60, ageH: 1 },     // $500k-$1m
  very_high: { liq: 15_000, vol: 15_000, txns: 60, ageH: 1.5 },   // $1m-$10m
};

/**
 * The floors that apply to THIS coin.
 *
 * An unreadable market cap falls back to the flat configured floors — the strictest
 * reading — because an unknown number must never be handed the most permissive band.
 * That is the same rule the rest of the desk follows everywhere else.
 */
export function floorsFor(mcap) {
  const flat = { liq: cfg.screen.minLiquidityUsd, vol: cfg.screen.minVolume24hUsd,
    txns: cfg.screen.minTxns24h, ageH: cfg.screen.minPairAgeHours };
  if (mcap == null || !(mcap > 0)) return flat;
  /* ONE TAXONOMY. These boundaries were hardcoded here and drifted a full rung out of
     step with CAP_BANDS on 2026-09-03: the screen called a $250k coin "low" while the
     desk called it "medium" and the sleeves disagreed with both. The bands are defined
     in exactly one place now, and this reads them. */
  const band = bandForMarketCap(mcap);
  return band ? BAND_FLOORS[band] : flat;
}

/** The RPC URL may embed an API key. Never print it raw — mask it wherever it is shown. */
export const maskRpc = (u = cfg.rpc) =>
  String(u).replace(/([?&]api-key=)[^&]+/i, "$1***").replace(/\/\/([^@/]+:)[^@]+@/, "//$1***@");

/* Well-known tokens on chain 4663, used as quote assets / routing anchors. Lower-case
 * for comparison; the aggregator accepts either case for real tokens but is strict
 * about the NATIVE sentinel — the wrong-case sentinel answered 400 'tokenIn invalid'
 * on 2026-09-04, so it is stored exactly as Kyber wants it. USDG is six-decimal. */
export const TOKENS = {
  NATIVE: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  WETH: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  USDG: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  PONS: "0x39dbed3a2bd333467115de45665cc57f813c4571",
};
export const TOKEN_DECIMALS = { [TOKENS.WETH]: 18, [TOKENS.USDG]: 6, [TOKENS.PONS]: 18 };
/** Legacy alias. The two names some untouched files still import; both now point at
 *  the chain's quote assets so a stale import resolves to a real address, not undefined. */
export const MINTS = { SOL: TOKENS.WETH, USDC: TOKENS.USDG };
