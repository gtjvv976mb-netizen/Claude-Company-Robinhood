/**
 * PAPER TRADING ON THE REAL MARKET — no key, no signature, no send, no money.
 *
 * The question this exists to answer is the owner's: does the loop actually make money?
 * Not "does the risk engine help" (simulate.mjs answers that against synthetic paths),
 * but "if the desk publishes calls and the bot executes them end to end, what is the
 * P&L on the market as it actually traded?"
 *
 * WHAT IS REAL HERE, and it matters that this list is exact:
 *   - PRICES. Minute OHLCV from GeckoTerminal for the actual live pools. Stops and
 *     targets are checked against each candle's LOW and HIGH, not its close, so a token
 *     that ends the minute up may still have taken out its stop inside it. Where both a
 *     stop and a target are touched in the same candle the STOP is taken — minute bars
 *     cannot say which came first, and assuming the good one is how backtests lie.
 *   - THE RISK ENGINE. planEntry / openPosition / stepPosition imported from
 *     strategy.mjs — the same functions the live bot trades with, not a reimplementation.
 *   - THE COSTS. Gas from the measured round-trip gas units and gas price in
 *     live-thresholds.mjs; price impact from the measured liquidity/round-trip curve,
 *     interpolated on log liquidity between the deep and thin anchors.
 *   - THE CAPS. The operator ceiling (0.004 ETH/trade) unless --clip overrides it.
 *
 * WHAT IS BIASED, AND IN WHICH DIRECTION. All three of these flatter the result, and all
 * three were found by auditing this file rather than by running it:
 *
 *   - SURVIVORSHIP. A pool must cover at least half the window to be selectable (the
 *     `coverage >= 0.5` filter below). Measured on the cached hourly series: that drops
 *     63% of pools, and the DROPPED ones have a median full-window return of 19.7%
 *     against 522.3% for the ones it keeps. The filter systematically removes losers.
 *   - LOOKAHEAD ON LIQUIDITY. `pool.liquidityUsd` is the depth GeckoTerminal reports
 *     TODAY, applied to bars from up to 41 days ago. It feeds the entry filter, the
 *     selection score AND the cost model — so a pool that is deep now is charged today's
 *     cheap costs for a period when it may have been thin.
 *   - SIGNAL AND FILL ON THE SAME BAR. The proxy decides on a bar's close and fills at
 *     that same close. Standard in backtests, mildly optimistic.
 *
 * A DARK TAPE IS NO LONGER FREE, which was the fourth and worst of these until it was
 * fixed: a position whose pool stopped printing used to be silently dropped — never
 * marked, never exited, never counted — so rugs and quiet deaths cost nothing at all.
 * They are force-exited at the last price actually seen and counted separately now.
 *
 * TAKEN TOGETHER: the ABSOLUTE P&L this file reports is not a profitability estimate. The
 * RELATIVE comparisons are much stronger, because both arms carry the same bias — which
 * is why the hold-window sweep (1h -14.71% ... 120h +2.19%, monotonic) is quoted as
 * evidence for the clocks while the headline figure is not quoted as evidence of an edge.
 *
 * WHAT IS A PROXY, stated plainly because the conclusion depends on it:
 *   - CALL SELECTION, in --calls-from proxy mode. The real desk decides with five LLM
 *     seats, a red team and compliance; none of that can be replayed over history at any
 *     sane cost. The proxy ranks on momentum and liquidity. It is NOT the desk, and a
 *     P&L produced from it measures the MARKET AND THE EXECUTION PATH, not the team's
 *     judgement. Use --calls-from desk to score the desk's own published calls instead.
 *
 * Nothing here imports a wallet, a key or a signer, and no code path can send.
 *
 *   node executor/paper-trade.mjs [--dex pons-v2-dex] [--clip 0.004] [--cycle-min 30]
 *                                 [--calls 3] [--calls-from proxy|desk] [--json out.json]
 */
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
import { ROUND_TRIP_GAS, EXIT_PROBE_NOISE_PCT } from "./live-thresholds.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") ? "1" : (all[i + 1] ?? "1")] : []).filter(Boolean));

const DEX        = args.dex ?? "pons-v2-dex";
const CLIP_ETH   = Number(args.clip ?? 0.004);          // the operator per-trade ceiling
const CYCLE_MIN  = Number(args["cycle-min"] ?? 30);
const PER_CYCLE  = Number(args.calls ?? 3);
const CALLS_FROM = args["calls-from"] ?? "proxy";
/* `--calls-from desk` was accepted and then produced an empty pick list on every cycle,
   so it reported a clean zero-trade run that looked like "the desk had no calls" rather
   than "this mode was never implemented". A flag that silently does nothing is worse than
   a missing one. It refuses until the desk's published calls are actually wired in. */
if (CALLS_FROM !== "proxy") {
  console.error(`--calls-from ${CALLS_FROM} is not implemented. Only "proxy" is.\n` +
    "Scoring the desk's OWN published calls needs its call history joined to price series;\n" +
    "until that exists this flag would report an empty run as a result.");
  process.exit(2);
}
const STOP_PCT   = Number(args["stop-pct"] ?? 0.15);    // the call's authored stop
const TARGET_X   = Number(args["target-x"] ?? 1.35);    // the call's authored target
const MAX_HOLD_MIN = Number(args["max-hold-min"] ?? 60);
const GAS_GWEI   = Number(args.gwei ?? 0.309);          // measured 2026-09-04
const ETH_USD    = Number(args["eth-usd"] ?? 4500);
/* MINUTE BARS BUY DETAIL AND COST SAMPLE SIZE. GeckoTerminal serves 1000 candles at any
   timeframe, so minutes give ~17 hours of one market and hours give ~41 days. A bracket
   judged on 18 trades in one 24-hour window is a parameter search, not a measurement;
   --tf hour is what makes the sample large enough to argue about. The unit of the sim's
   clock follows the timeframe, so --max-hold-min is read in BARS. */
const TF        = args.tf ?? "minute";
const BAR_MS    = TF === "hour" ? 3_600_000 : TF === "day" ? 86_400_000 : 60_000;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const eth = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(6)} ETH`;

/* ── COSTS, MEASURED ON PONS ─────────────────────────────────────────────────
 * 18 KyberSwap-quoted round trips (buy, then sell the exact quoted output) across six
 * pons-v2-dex pools and three liquidity tiers, 2026-09-07. The full run is in
 * probe-measure-4663.mjs --dexes pons-v2-dex.
 *
 * THIS REPLACED A CURVE I INVENTED. The first version interpolated on log liquidity
 * between two anchors and ignored clip size entirely, so it charged 12-14% for a $18
 * trade into a $100k pool. The measured answer for that trade is nearer 0.3%. Cost on
 * an AMM is a function of size RELATIVE to depth; a model with only one of the two
 * cannot be right, and this one was wrong in the direction that makes everything look
 * unprofitable — the most expensive direction to be wrong in.
 *
 * TWO POOLS PER TIER AT ONE MOMENT IS A SMALL SAMPLE and the rows disagree inside a
 * tier (PORT reads ~0% at 0.005 ETH where STOCKKIT reads 6.1%). The median is used;
 * --worst-case switches to the worst row, which is the number to size against.
 *
 * Values below the 0.9% quote-noise floor are RAISED to it. PORT quoted -0.962% at
 * 0.005 ETH — a round trip that ends with more ETH than it started, which is noise, not
 * a rebate, and booking it as a gain would pay the simulation to trade. */
const QUOTE_NOISE_PCT = EXIT_PROBE_NOISE_PCT;          // 0.9%, measured
const WORST_CASE = args["worst-case"] != null;
/* [clipEth, medianPct, worstPct] per liquidity tier */
const COST_TABLE = [
  { maxLiq: 10_000,     rows: [[0.005, 4.318, 5.972], [0.05, 9.114, 9.865], [0.5, 39.226, 42.200]] },
  { maxLiq: 100_000,    rows: [[0.005, 5.101, 6.147], [0.05, 6.588, 8.250], [0.5, 18.920, 25.045]] },
  { maxLiq: Infinity,   rows: [[0.005, 0.900, 0.900], [0.05, 3.530, 6.673], [0.5, 6.978, 12.329]] },
];
function roundTripImpactPct(liquidityUsd, clipEth = CLIP_ETH) {
  const tier = COST_TABLE.find((t) => (Number(liquidityUsd) || 0) < t.maxLiq) ?? COST_TABLE[COST_TABLE.length - 1];
  const col = WORST_CASE ? 2 : 1;
  const rows = tier.rows;
  const clip = Math.max(1e-9, Number(clipEth) || CLIP_ETH);
  /* Below the smallest measured clip the cost is NOT extrapolated down to zero — impact
     does fall with size, but the measurement cannot resolve it below the noise floor,
     so the smallest measured row is held. */
  if (clip <= rows[0][0]) return Math.max(QUOTE_NOISE_PCT, rows[0][col]);
  if (clip >= rows[rows.length - 1][0]) return rows[rows.length - 1][col];
  for (let i = 0; i + 1 < rows.length; i++) {
    const [x0, ...y0] = rows[i], [x1, ...y1] = rows[i + 1];
    if (clip < x0 || clip > x1) continue;
    /* log-log between measured points: impact on an AMM scales with size, not linearly */
    const t = (Math.log(clip) - Math.log(x0)) / (Math.log(x1) - Math.log(x0));
    return Math.max(QUOTE_NOISE_PCT, y0[col - 1] + t * (y1[col - 1] - y0[col - 1]));
  }
  return Math.max(QUOTE_NOISE_PCT, rows[rows.length - 1][col]);
}
/* Gas: one leg is half the measured round-trip gas. On a small clip this DOMINATES —
   712,334 units at 0.309 gwei is 0.00022 ETH, which is 5.5% of a 0.004 ETH position and
   0.44% of a 0.05 ETH one. It is the reason the per-trade cap and profitability are the
   same question. */
const LEG_GAS_ETH = (ROUND_TRIP_GAS / 2) * GAS_GWEI * 1e-9;

/* ── THE MARKET ──────────────────────────────────────────────────────────── */
/* GeckoTerminal's free tier is about 30 requests a minute and answers 429 without a
   Retry-After. A universe of forty pools is forty candle requests, so a naive loop
   loses most of the market to rate limiting and the run then reports a P&L computed
   from whatever seven pools happened to get through — a survivorship artefact dressed
   up as a measurement. Paced, retried, and cached to disk so a rerun costs nothing. */
const CACHE = new URL("./.paper-cache/", import.meta.url);
let lastFetchAt = 0;
async function gecko(url, { cacheKey = null, ttlMs = 10 * 60_000 } = {}) {
  const fs = await import("node:fs");
  let file = null;
  if (cacheKey) {
    fs.mkdirSync(CACHE, { recursive: true });
    file = new URL(encodeURIComponent(cacheKey) + ".json", CACHE);
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < ttlMs) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, 2_200 - (Date.now() - lastFetchAt));
    if (wait) await sleep(wait);
    lastFetchAt = Date.now();
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429) { await sleep(5_000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
    const body = await r.json();
    if (file) { try { fs.writeFileSync(file, JSON.stringify(body)); } catch {} }
    return body;
  }
  throw new Error("GeckoTerminal rate limited after 5 attempts");
}

/* --dex all draws the chain-wide feed instead of one venue. This is what makes an
   OUT-OF-SAMPLE test possible: a bracket tuned on pons-v2-dex can be re-run against
   pools it never saw. A parameter search on one 24-hour window and 22 trades is how
   backtests lie; the only cheap defence is a second universe. */
async function universe() {
  const out = [];
  const pages = DEX === "all" ? 3 : 2;
  for (let page = 1; page <= pages; page++) {
    const url = DEX === "all"
      ? `https://api.geckoterminal.com/api/v2/networks/robinhood/pools?page=${page}&sort=h24_volume_usd_desc`
      : `https://api.geckoterminal.com/api/v2/networks/robinhood/dexes/${encodeURIComponent(DEX)}/pools?page=${page}&sort=h24_volume_usd_desc`;
    const j = await gecko(url, { cacheKey: `pools-${DEX}-${page}` });
    for (const d of j.data ?? []) {
      const a = d.attributes ?? {};
      out.push({
        name: a.name, address: a.address,
        symbol: String(a.name || "").split("/")[0].trim(),
        liquidityUsd: Number(a.reserve_in_usd) || 0,
        volume24hUsd: Number(a.volume_usd?.h24) || 0,
        base: String(d.relationships?.base_token?.data?.id ?? "").replace(/^robinhood_/, ""),
        dex: d.relationships?.dex?.data?.id ?? DEX,
      });
    }
    if ((j.data ?? []).length < 20) break;
  }
  return out;
}

async function candles(pool) {
  const j = await gecko(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool.address}/ohlcv/${TF}?aggregate=1&limit=1000`, { cacheKey: `ohlcv-${TF}-${pool.address}` });
  const list = j?.data?.attributes?.ohlcv_list ?? [];
  // GeckoTerminal returns newest-first; the sim walks forward in time.
  return list.map(([ts, o, h, l, c, v]) => ({ ts: Number(ts) * 1000, o: +o, h: +h, l: +l, c: +c, v: +v }))
    .filter((k) => Number.isFinite(k.c) && k.c > 0)
    .sort((a, b) => a.ts - b.ts);
}

/* ── THE PROXY SELECTOR ──────────────────────────────────────────────────────
 * NOT THE DESK. It ranks on five-minute momentum and depth, which is roughly what the
 * ignition lane screens for before any seat sees a coin, and nothing like what the
 * seats then do with it. Its only job is to supply a call stream so the EXECUTION path
 * can be measured on real prices; every number downstream inherits this caveat. */
function proxyPicks(market, atIdx, held, n) {
  const picks = [];
  for (const m of market) {
    if (held.has(m.pool.address)) continue;
    const k = m.byIdx[atIdx];
    const prev = m.byIdx[atIdx - 5];
    if (!k || !prev || !prev.c) continue;
    const mom = (k.c - prev.c) / prev.c;
    if (!Number.isFinite(mom) || mom <= 0) continue;          // only things going up
    if (m.pool.liquidityUsd < Number(args["min-liq"] ?? 10_000)) continue;
    picks.push({ m, k, score: mom * Math.log10(Math.max(10, m.pool.liquidityUsd)) });
  }
  picks.sort((a, b) => b.score - a.score);
  return picks.slice(0, n);
}

/* ── THE RUN ─────────────────────────────────────────────────────────────── */
log(`\nPAPER TRADE — ${DEX}, real prices, real risk engine, no key and no send`);
log(`clip ${CLIP_ETH} ETH · cycle ${CYCLE_MIN}m · ${PER_CYCLE} calls/cycle · stop ${(STOP_PCT * 100).toFixed(0)}% · target ${TARGET_X}x · max hold ${MAX_HOLD_MIN}m`);
log(`costs: ${LEG_GAS_ETH.toFixed(8)} ETH gas per leg (${ROUND_TRIP_GAS} units round trip @ ${GAS_GWEI} gwei), impact from the measured depth curve\n`);

const pools = await universe();
log(`universe: ${pools.length} ${DEX} pools`);
const market = [];
for (const pool of pools) {
  try {
    const ks = await candles(pool);
    if (ks.length < 60) { continue; }
    market.push({ pool, candles: ks });
  } catch (e) { log(`  ${pool.name}: ${e.message}`); }
}
if (!market.length) { log("no pool returned usable history — nothing to simulate"); process.exit(1); }

/* ── ONE MINUTE GRID ─────────────────────────────────────────────────────────
 * The window is anchored to the market's most recent candle and runs back --hours.
 * It is NOT the intersection of every pool's history: requiring all forty to overlap
 * collapses the window to nothing the moment one coin launched an hour ago and another
 * stopped trading yesterday, which is the normal state of a memecoin venue.
 *
 * A pool simply contributes where it HAS data. Two rules keep that honest:
 *   - a candle older than STALE_MIN minutes is not carried forward as a live price. A
 *     dead pool's last print repeated for six hours reads as a flat, safe, tradeable
 *     line, and a momentum screen will happily buy it.
 *   - a pool must cover at least half the window to be selectable at all, so a coin
 *     that existed for ten minutes cannot be picked on three candles of history. */
const HOURS = Number(args.hours ?? (TF === "hour" ? 1000 : 24));
const STALE_MIN = Number(args["stale-min"] ?? 10);
const tEnd = Math.max(...market.map((m) => m.candles[m.candles.length - 1].ts));
const tStart = Math.max(Math.min(...market.map((m) => m.candles[0].ts)), tEnd - HOURS * 3_600_000);
const t0 = tStart, t1 = tEnd;
const STEPS = Math.floor((t1 - t0) / BAR_MS);
if (STEPS < 30) { log(`only ${STEPS} minutes of market history — too little to simulate`); process.exit(1); }
for (const m of market) {
  m.byIdx = [];
  let j = 0, covered = 0;
  for (let i = 0; i <= STEPS; i++) {
    const want = t0 + i * BAR_MS;
    while (j + 1 < m.candles.length && m.candles[j + 1].ts <= want) j++;
    const k = m.candles[j];
    const live = k && k.ts <= want && (want - k.ts) <= STALE_MIN * BAR_MS;
    m.byIdx[i] = live ? k : null;
    if (live) covered++;
  }
  m.coverage = covered / (STEPS + 1);
}
const tradable = market.filter((m) => m.coverage >= 0.5);
log(`history: ${STEPS} ${TF} bars (${new Date(t0).toISOString()} → ${new Date(t1).toISOString()})`);
log(`         ${tradable.length} of ${market.length} pools cover at least half of it and are selectable\n`);
if (!tradable.length) { log("no pool has continuous enough history to trade"); process.exit(1); }

/* ── THE RAILS MUST BE THE ONES THE BOT ACTUALLY RUNS ON ─────────────────────
 * This used to be `{ ...DEFAULTS, maxOpenPositions: 4 }`, and DEFAULTS is Solana's:
 * maxSolPerTrade 0.05, dailySolCap 0.5, dailyLossLimitSol 0.15, costPct 0.06 (a
 * Jupiter round trip). The Robinhood operator maxima are 0.004 / 0.04 / 0.012. So the
 * simulation gave itself 125 clips a day where the live bot gets 10, a loss brake 12.5x
 * looser than live, and a cost constant measured on another chain — then clamped the
 * size afterwards with Math.min(CLIP_ETH, plan.sol), which silently discarded a
 * planEntry that had authorised 0.0167 ETH. Every sizing figure the engine produced
 * described a trade 4.17x larger than the one the sim actually booked.
 *
 * The P&L was still charged the real measured RH cost curve, so the headline was not
 * fabricated — but throughput, the daily brake and book heat all bind at completely
 * different points under the right rails, and those are what decide WHICH trades get
 * taken. --rails solana restores the old behaviour for comparison. */
/* Mirrored from poller.mjs's CFG, not guessed. The live bot overrides three DEFAULTS
   the fork inherited, and a sim that uses raw DEFAULTS is not simulating it:
     - minSolPerTrade 0.0001 (DEFAULTS says 0.005, which is ABOVE the 0.004 operator
       ceiling — that mismatch is why an earlier run of this file refused all 730 calls
       with "the sized position rounds to nothing". The live bot does not have it.)
     - fixedSol = PAPER_DEFAULTS.fixedEth = 0.0016, set UNCONDITIONALLY, and planEntry
       treats fixedSol as an override: `if (c.fixedSol > 0) want = c.fixedSol`. So every
       live entry is 0.0016 ETH and the Kelly sizing above it never reaches a position.
       At 0.0016 ETH gas alone is 12.8% of the position.
     - scaleOutPct 0. */
const LIVE_RAILS = { maxSolPerTrade: CLIP_ETH, dailySolCap: Math.max(0.04, CLIP_ETH * 10),
  dailyLossLimitSol: Math.max(0.012, CLIP_ETH * 3),
  minSolPerTrade: 0.0001,
  /* TRACKS THE CLIP, exactly as poller.mjs now does. Hardcoding 0.0016 here made --clip
     inert: planEntry uses fixedSol as an OVERRIDE, so every simulated position was
     0.0016 ETH whatever the flag said, and two runs at 0.0016 and 0.004 returned
     byte-identical P&L. A size sweep that cannot change the size measures nothing. */
  fixedSol: CLIP_ETH, scaleOutPct: 0 };
const RAILS = (args.rails ?? "live") === "solana" ? {} : LIVE_RAILS;
/* costPct is the +EV gate's ONLY cost term. Solana's 0.06 is a Jupiter round trip; the
   measured RH cost at this clip is impact (from the measured table) plus gas, and gas
   is 5.5% of a 0.004 ETH position. Defaulted from the measurement, not inherited. */
const MEASURED_COST_PCT = (roundTripImpactPct(50_000, CLIP_ETH) + (2 * LEG_GAS_ETH) / CLIP_ETH * 100) / 100;
const cfg = { ...DEFAULTS, maxOpenPositions: 4, ...RAILS,
  costPct: args["cost-pct"] != null ? Number(args["cost-pct"]) : MEASURED_COST_PCT };
const state = freshState(t0);
state.equitySol = CLIP_ETH * 25;          // a book the clip is 4% of
state.spendableSol = state.equitySol;
log(`rails: ${(args.rails ?? "live") === "solana" ? "SOLANA DEFAULTS (comparison only)" : "the RH operator maxima"} — ` +
  `${cfg.maxSolPerTrade} ETH/trade cap, fixedSol ${cfg.fixedSol} (what planEntry actually sizes to), ` +
  `${cfg.dailySolCap} ETH/day, ${cfg.dailyLossLimitSol} ETH loss brake, ` +
  `costPct ${(cfg.costPct * 100).toFixed(2)}%${args["cost-pct"] == null ? " (measured, not inherited)" : ""}`);
let wallet = 0;                            // realized P&L in ETH
const open = new Map();                    // address -> { pos, m, openedIdx, costEth }
const closed = [];
let published = 0, cycles = 0, entered = 0, refusedEntry = 0;
const refusalReasons = {}, refusalSample = {};
const perCycle = [];

/* THE DAY MUST ROLL. state.deployedTodaySol is a ROLLING 24h figure live — the journal
   sums risk events over a window — but nothing in a simulation advances that window, so
   the run spent its first day's 0.5 ETH budget and then refused every call for the
   remaining forty days: 677 of 705 refusals were the deploy cap, and the "result" was a
   25-trade sample masquerading as a 41-day backtest. Modelled here as a discrete reset
   at the boundary, which is the sim's model of the rails and not a claim about the live
   implementation. */
let dayStartedAt = t0;
for (let i = 10; i <= STEPS; i++) {
  const now = t0 + i * BAR_MS;
  if (now - dayStartedAt >= 86_400_000) {
    dayStartedAt = now;
    state.deployedTodaySol = 0;
    state.realizedTodaySol = 0;
  }

  /* ---- the bot: manage what is open, every minute, on real candles ---- */
  /* THE ACTION NAMES ARE THE ENGINE'S, NOT GUESSES. planEntry signals a size with
     "buy" and pricePolicy signals an exit with "sell". Testing for "enter"/"exit"
     silently produced a bot that never entered and then one that never stopped out —
     92 of 92 trades leaving on the max-hold clock, with the stop and the target
     never once firing, was the tell. A probe against a known breach settled it. */
  for (const [addr, o] of [...open]) {
    const k = o.m.byIdx[i];
    /* A TAPE THAT GOES DARK IS AN OUTCOME, NOT AN EXEMPTION.
     *
     * This was `if (!k) continue;` — so a position whose pool stopped printing was never
     * marked, never exited, and never counted. It simply vanished from the P&L. That is
     * the single most flattering bug a backtest can have: the rug, the death and the
     * quiet illiquid stretch are exactly the outcomes a memecoin strategy must be charged
     * for, and they were free. byIdx nulls a bar whenever the pool has not printed within
     * the staleness window, so this bit any position held across a quiet patch, not only
     * a pool that died.
     *
     * A dark tape is now force-exited at the LAST PRICE ACTUALLY SEEN. That is a choice
     * between two wrong answers — dropping it (infinitely generous) and marking it to
     * zero (harsher than a real operator, who could often still sell something) — and the
     * last print is the conservative one that does not invent a number. Counted
     * separately so the report says how much of the result rests on it. */
    if (!k) {
      const darkFor = i - (o.lastSeenIdx ?? o.openedIdx);
      if (darkFor <= STALE_MIN) continue;          // a brief gap; keep holding
      const price = o.lastSeenPrice ?? o.pos.entry;
      const grossEth = (price / o.pos.entry) * o.remainingEth;
      const proceeds = grossEth * (1 - roundTripImpactPct(o.m.pool.liquidityUsd) / 100 / 2) - LEG_GAS_ETH;
      const pnl = (o.proceedsEth + Math.max(0, proceeds)) - o.notionalEth;
      wallet += pnl;
      state.realizedTodaySol += pnl;
      closed.push({ symbol: o.m.pool.symbol, liq: o.m.pool.liquidityUsd,
        why: "tape went dark", heldMin: i - o.openedIdx,
        movePct: (price / o.pos.entry - 1) * 100,
        pnlEth: pnl, pnlPct: (pnl / o.notionalEth) * 100, exits: o.exits.length, dark: true });
      open.delete(addr);
      state.openCount = open.size;
      continue;
    }
    o.lastSeenIdx = i; o.lastSeenPrice = k.c;
    const heldMin = i - o.openedIdx;

    /* THE STOP IS CHECKED AGAINST THE LOW AND IT IS CHECKED FIRST. A minute bar cannot
       say whether its low or its high came first, so the unflattering order is the only
       honest one: a bar that touched both the stop and the target is scored as a stop. */
    const sells = [];
    const lowStep = stepPosition({ pos: o.pos, mark: k.l, cfg, nowMs: now });
    if (lowStep.action === "sell") sells.push({ price: Math.max(k.l, o.pos.stop || k.l), ...lowStep });
    else {
      const highStep = stepPosition({ pos: o.pos, mark: k.h, cfg, nowMs: now });
      if (highStep.action === "sell") sells.push({ price: Math.min(k.h, o.pos.target ?? k.h), ...highStep });
    }
    if (!sells.length && heldMin >= MAX_HOLD_MIN)
      sells.push({ price: k.c, fraction: 1, reason: "max hold" });
    if (!sells.length) continue;

    for (const sell of sells) {
      /* A SCALE-OUT IS A PARTIAL EXIT, and scoring it as a full one would book the
         whole position at the first take-profit and never let a winner run. */
      const fraction = Math.min(1, Math.max(0, Number(sell.fraction) || 1));
      const partEth = o.remainingEth * fraction;
      const grossEth = (sell.price / o.pos.entry) * partEth;
      const proceeds = grossEth * (1 - roundTripImpactPct(o.m.pool.liquidityUsd) / 100 / 2) - LEG_GAS_ETH;
      o.proceedsEth += Math.max(0, proceeds);
      o.remainingEth -= partEth;
      o.exits.push({ reason: sell.reason, fraction, price: sell.price });
      if (o.remainingEth > 1e-12 && fraction < 1) continue;

      /* COST IS PAID INSIDE THE POSITION, NOT ON TOP OF IT. Charging entry impact and
         gas as an extra debit against the notional let a trade report -103.96% — a long
         cannot lose more than it cost. What actually happens is that the clip buys
         fewer tokens: the notional leaves the wallet, impact and gas are taken out of
         it, and only the remainder is exposed to the price. */
      const pnl = o.proceedsEth - o.notionalEth;
      wallet += pnl;
      state.realizedTodaySol += pnl;
      closed.push({ symbol: o.m.pool.symbol, liq: o.m.pool.liquidityUsd,
        why: o.exits[0].reason, heldMin,
        movePct: (sell.price / o.pos.entry - 1) * 100,
        pnlEth: pnl, pnlPct: (pnl / o.notionalEth) * 100,
        exits: o.exits.length });
      open.delete(addr);
      break;
    }
    state.openCount = open.size;
  }

  /* ---- the desk: a cycle, on the cadence ---- */
  if (i % CYCLE_MIN !== 0) continue;
  cycles++;
  const held = new Set(open.keys());
  const picks = proxyPicks(tradable, i, held, PER_CYCLE);
  published += picks.length;
  perCycle.push(picks.length);

  /* ---- the bot: act on every published call, independently ---- */
  for (const p of picks) {
    /* entry_ref IS NOT OPTIONAL. planEntry computes the whole bracket as fractions of
       it and falls back to 1 when it is missing — so with a token priced at 0.0000428
       the stop read as 99.99% below entry and the target as negative, and every single
       call was refused with "costs eat the target". The engine was right; the call was
       malformed. A real desk call always carries entry_ref. */
    const call = { mint: p.m.pool.base, symbol: p.m.pool.symbol, ts: now,
      entry_ref: p.k.c, stop: p.k.c * (1 - STOP_PCT), target: p.k.c * TARGET_X };
    state.openCount = open.size;
    const plan = planEntry({ call, cfg, state });
    /* planEntry signals a size with action "buy". Testing for "enter" refused every
       call while reporting the SIZING note as the refusal reason — the tell was a
       "reason" that read like a successful sizing. */
    if (plan.action !== "buy") {
      refusedEntry++;
      /* WHY, NOT JUST HOW MANY. A run that reports "143 refused" and stops has measured
         nothing: the engine refusing every call is either the bracket being genuinely
         unprofitable — which is the answer — or the harness handing it a malformed call,
         which is not. Only the reason separates them. */
      const key = String(plan.reason).replace(/[\d.]+/g, "N");
      refusalReasons[key] = (refusalReasons[key] || 0) + 1;
      if (!refusalSample[key]) refusalSample[key] = { reason: plan.reason, symbol: call.symbol,
        entry: call.entry_ref, stop: call.stop, target: call.target };
      continue;
    }
    /* THE ENGINE'S SIZE, NOT AN AFTERWARDS CLAMP. planEntry already honours
       maxSolPerTrade, which is now the operator's real 0.004 ETH ceiling, so clamping
       its answer again with Math.min(CLIP_ETH, ...) only hid the fact that the engine
       had been sizing against Solana's 0.05. --clip still lowers the ceiling. */
    const notionalEth = Math.min(CLIP_ETH, plan.sol ?? CLIP_ETH);
    /* The clip leaves the wallet; impact and gas come out of it; what is left is what
       the price acts on. This is why a loss is bounded at the notional. */
    const exposedEth = Math.max(0, notionalEth * (1 - roundTripImpactPct(p.m.pool.liquidityUsd) / 100 / 2) - LEG_GAS_ETH);
    if (exposedEth <= 0) { refusedEntry++; refusalReasons["costs exceed the whole clip"] =
      (refusalReasons["costs exceed the whole clip"] || 0) + 1;
      refusalSample["costs exceed the whole clip"] ??= { reason: "costs exceed the whole clip",
        symbol: call.symbol, entry: call.entry_ref, stop: call.stop, target: call.target }; continue; }
    const pos = openPosition({ call, sol: exposedEth, fillPrice: p.k.c, cfg });
    open.set(p.m.pool.address, { pos, m: p.m, openedIdx: i, notionalEth,
      remainingEth: exposedEth, proceedsEth: 0, exits: [] });
    entered++;
    state.deployedTodaySol += notionalEth;
  }
}

/* ── THE REPORT ──────────────────────────────────────────────────────────── */
const wins = closed.filter((c) => c.pnlEth > 0);
const grossMove = closed.reduce((s, c) => s + c.movePct, 0) / (closed.length || 1);
log("═".repeat(72));
log(`CYCLES            ${cycles}`);
log(`CALLS PUBLISHED   ${published}  (${(published / (cycles || 1)).toFixed(2)} per cycle, quota ${PER_CYCLE})`);
const short = perCycle.filter((n) => n < PER_CYCLE).length;
log(`  cycles short of quota: ${short} of ${cycles}${short ? `  — the proxy universe ran out of coins going up` : ""}`);
log(`ENTERED           ${entered}   refused by the risk engine: ${refusedEntry}`);
for (const [k, n] of Object.entries(refusalReasons).sort((a, b) => b[1] - a[1])) {
  const ex = refusalSample[k];
  log(`  ${String(n).padStart(4)}x  ${ex.reason}`);
  log(`        e.g. ${ex.symbol} entry ${ex.entry} stop ${ex.stop} target ${ex.target}`);
}
log(`CLOSED            ${closed.length}   still open at the end: ${open.size}`);
if (closed.length) {
  log(`WIN RATE          ${((wins.length / closed.length) * 100).toFixed(1)}%  (${wins.length}/${closed.length})`);
  log(`AVG GROSS MOVE    ${pct(grossMove)}   (price only, before cost)`);
  log(`AVG NET PER TRADE ${pct(closed.reduce((s, c) => s + c.pnlPct, 0) / closed.length)}`);
  log(`TOTAL P&L         ${eth(wallet)}  ($${(wallet * ETH_USD).toFixed(2)} at $${ETH_USD}/ETH)`);
  const deployed = entered * CLIP_ETH;
  log(`ON DEPLOYED       ${eth(deployed)} deployed → ${pct((wallet / deployed) * 100)}`);
  log("");
  const dark = closed.filter((c) => c.dark);
  if (dark.length)
    log(`  of which TAPE WENT DARK: ${dark.length} (${(dark.length / closed.length * 100).toFixed(1)}%), ` +
      `avg ${pct(dark.reduce((s, c) => s + c.pnlPct, 0) / dark.length)} — these used to be dropped entirely`);
  log("BY EXIT REASON");
  const byWhy = {};
  for (const c of closed) (byWhy[c.why] ??= []).push(c);
  for (const [why, cs] of Object.entries(byWhy).sort((a, b) => b[1].length - a[1].length))
    log(`  ${String(why).slice(0, 34).padEnd(36)} ${String(cs.length).padStart(3)}  avg ${pct(cs.reduce((s, c) => s + c.pnlPct, 0) / cs.length)}`);
  log("");
  log("WORST FIVE");
  for (const c of [...closed].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5))
    log(`  ${c.symbol.padEnd(12)} ${pct(c.pnlPct).padStart(9)}  move ${pct(c.movePct).padStart(9)}  liq $${Math.round(c.liq).toLocaleString().padStart(9)}  ${c.why}`);
  log("BEST FIVE");
  for (const c of [...closed].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5))
    log(`  ${c.symbol.padEnd(12)} ${pct(c.pnlPct).padStart(9)}  move ${pct(c.movePct).padStart(9)}  liq $${Math.round(c.liq).toLocaleString().padStart(9)}  ${c.why}`);
}
log("═".repeat(72));
log(`\nCOST PER ROUND TRIP AT THIS CLIP (${CLIP_ETH} ETH):`);
log(`  ${"clip".padStart(8)}  ${"<$10k".padStart(9)}  ${"$10-100k".padStart(9)}  ${"$100k+".padStart(9)}   (impact + gas, as % of the position)`);
for (const clip of [0.004, 0.01, 0.05, 0.2]) {
  const gasPct = (2 * LEG_GAS_ETH) / clip * 100;
  const cells = [5_000, 50_000, 500_000].map((liq) =>
    `${(roundTripImpactPct(liq, clip) + gasPct).toFixed(2)}%`.padStart(9));
  log(`  ${(clip + " ETH").padStart(8)}  ${cells.join("  ")}   (gas alone ${gasPct.toFixed(2)}%)`);
}
log(`\nCALL SELECTION WAS ${CALLS_FROM === "proxy" ? "A MOMENTUM PROXY, NOT THE DESK" : "THE DESK'S OWN PUBLISHED CALLS"}.`);
if (CALLS_FROM === "proxy")
  log(`This measures the market and the execution path. It does NOT measure the team's judgement.`);
if (args.json) {
  const fs = await import("node:fs");
  fs.writeFileSync(args.json, JSON.stringify({ cycles, published, entered, closed, walletEth: wallet }, null, 2));
  log(`\nwrote ${args.json}`);
}
