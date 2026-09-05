/**
 * PONS, LIVE — the launch feed and the minute tape for chain 4663.
 *
 * Replaces pumpfun-live.js. Same shape of module — a listing, a candidate shaper, a
 * minute tape and a pure momentum ruler — with two sources instead of one:
 *
 *   GECKOTERMINAL, the only free indexer that lists a pons-v2 pool at birth (DexScreener
 *   had not indexed ROBINGOY at all). Probed 2026-09-05, not assumed:
 *     /networks/robinhood/new_pools?page=N          200, 20 rows a page, ~13-20 pools/min
 *     /networks/robinhood/dexes/pons-v2/pools       200, 20 rows, all dex "pons-v2"
 *     /networks/robinhood/trending_pools            200, dexes uniswap-v3/v4, pons-v2-dex,
 *                                                   bankr-robinhood, uniswap-pools-trade …
 *     /pools/{pool}/ohlcv/minute?aggregate=1&limit=40&currency=usd
 *                                                   200, rows [ts_sec,o,h,l,c,volUsd]
 *                                                   NEWEST FIRST — reversed here.
 *     /pools/{pool}/trades?trade_volume_in_usd_greater_than=500
 *                                                   200, kind buy|sell, tx_from_address,
 *                                                   volume_in_usd, block_timestamp.
 *   A row's quote token for a native-paired launch is 0xeeee…eeee and is labelled WETH.
 *
 *   THE CHAIN ITSELF, with no third party in the path. PONS V2 factory
 *   0x7eD598Bc… emits topic0 0x308c390e… on every launch with three indexed addresses
 *   and EMPTY data — decoded on a real receipt (block 0x34097a4): topic1 the token,
 *   topic2 the creator, topic3 the curve proxy, which answers quoteToken() and token().
 *   The Uniswap V4 PoolManager emits Initialize(id, currency0, currency1, fee,
 *   tickSpacing, hooks, sqrtPriceX96, tick) — 4 in 300 blocks at the moment of writing —
 *   and that is the zero-third-party discovery path for graduated pools.
 *
 * Everything degrades to empty. A desk that cannot reach GeckoTerminal keeps running on
 * the chain feed and the DexScreener sweep; nothing here is on the critical path.
 */
import { getJson } from "../lib/http.js";
import { CAP_BANDS } from "../categories.js";
import { TOKENS } from "../config.js";
import { getLogs, read, blockTimeMs, blockNumber, call, LOG_SPAN, V4_POOL_MANAGER, PONS_V2_HOOK } from "./evm.js";
import { topicAddress, decodeAddress, decodeUint, encodeCall, word, toHex, lower, isAddress, TOPIC_TRANSFER, ZERO_ADDRESS } from "../lib/evm.js";

const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const HEADERS = { accept: "application/json;version=20230302" };
export const PAGE_ROWS = 20;

export const PONS_V2_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
export const PONS_V1_FACTORY = "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb";
export const TOPIC_PONS_LAUNCH = "0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980";
export const TOPIC_V4_INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const SEL_QUOTE_TOKEN = "0x217a4b70";
const SEL_TOKEN = "0xfc0c546a";
/* Graduation views guessed and REFUSED by a live curve proxy on 2026-09-05:
   readyToGraduate(), sellableTokens(), graduated(), isGraduated(), curveProgress(),
   tokensSold(), totalRaised(), remainingTokens(), creator(), pool() — every one
   reverted. They are still tried, because a future curve implementation may answer,
   and a null with the reason is what the bundle carries until one does. */
const CURVE_VIEWS = {
  readyToGraduate: "0xc68360a5", sellableTokens: "0x808bcddc", graduated: "0xe7c2b772",
  curveProgress: "0xcc0643e7", tokensSold: "0x518ab2a8", totalRaised: "0xc5c4744c",
};

/* null and "" are ABSENT, not zero: Number(null) is 0, and a null market_cap_usd read
   as $0 put every fixture coin off the board before the first test ran. */
const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const isoMs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const tokenIdAddr = (id) => (typeof id === "string" ? lower(id.replace(/^robinhood_/, "")) : null);

/* ── which launchpad ────────────────────────────────────────────────────────── */

/**
 * GeckoTerminal dex id → the launchpad venue named in EVIDENCE-CONTRACT.md
 * (launchpad.venue: pons | hood.fun | pools.trade | none | unknown), plus whether the
 * pool is the pad's own curve. The mapping is from dex ids SEEN on 2026-09-05
 * (/networks/robinhood/dexes lists 39); `pons-v2` rows sat at $4k-$12k reserve with a
 * native quote, the shape of a live curve, and `pons-v2-dex` appeared in trending —
 * read as the graduated hook pools. That split is an inference from the ids, not a
 * documented contract, and the chain-native reads below are the authority when the
 * two disagree.
 */
export const DEX_VENUES = {
  "pons-v2": { venue: "pons", curve: true, version: "v2" },
  "pons-v2-dex": { venue: "pons", curve: false, version: "v4" },
  "pons-dot-family": { venue: "pons", curve: false, version: "v3" },
  "pons": { venue: "pons", curve: false, version: "v3" },
  "hoodit": { venue: "hood.fun", curve: true, version: null },
  "hood-fun": { venue: "hood.fun", curve: true, version: null },
  "uniswap-pools-trade": { venue: "pools.trade", curve: false, version: "v4" },
  "bankr-robinhood": { venue: "bankr", curve: false, version: null },
  "uniswap-v4-robinhood": { venue: "none", curve: false, version: "v4" },
  "uniswap-v3-robinhood": { venue: "none", curve: false, version: "v3" },
  "uniswap-v2-robinhood": { venue: "none", curve: false, version: "v2" },
};
export function venueOf(dexId) {
  if (!dexId) return { venue: "unknown", curve: false, version: null };
  if (DEX_VENUES[dexId]) return DEX_VENUES[dexId];
  /* An id this table has not seen. The chain suffix is stripped before the pad words are
     looked for — "o1-launchpad-robinhood" appeared in new_pools on 2026-09-05 and the
     unstripped test called it a curve on the "hood" inside "robinhood". An unknown pad
     IS read as a curve (fail closed toward on_curve); an unknown plain dex is not. */
  const bare = String(dexId).replace(/-?robinhood$/i, "");
  return { venue: "unknown", curve: /pons|hood|curve|launchpad|fun$/i.test(bare), version: null };
}
/** The launchpad label the rest of the desk keys on (funnel, board, classify). */
export const launchpadOf = (dexId) => { const v = venueOf(dexId).venue; return v === "none" || v === "unknown" ? null : v; };

/* ── GeckoTerminal listings ─────────────────────────────────────────────────── */

async function page(path, pageNo, { timeoutMs = 9000 } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await getJson(`${GT}/${path}${sep}page=${pageNo}`, { headers: HEADERS, timeoutMs, label: `gt/${path.split("?")[0]}` });
  return Array.isArray(r.data?.data) ? r.data.data : [];
}
async function listing(path, pages) {
  const wanted = Math.max(1, Math.min(10, Math.floor(pages) || 1));
  const results = await Promise.allSettled(Array.from({ length: wanted }, (_, i) => page(path, i + 1)));
  const seen = new Map();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const p of r.value) { const a = lower(p?.attributes?.address); if (a && !seen.has(a)) seen.set(a, p); }
  }
  return [...seen.values()];
}

/** Every pool GeckoTerminal has just seen created — the top of the funnel. */
export const newLaunches = ({ pages = 2 } = {}) => listing("new_pools", pages);
/** The PONS V2 book only. */
export const padPools = ({ pages = 2, dex = "pons-v2" } = {}) => listing(`dexes/${dex}/pools`, pages);
/** Where a move in progress is visible. */
export const recentlyTraded = ({ pages = 1 } = {}) => listing("trending_pools", pages);

/** The band a market cap sits in, or null when it is off the desk's board entirely. */
export function bandOf(usdMarketCap) {
  const mc = num(usdMarketCap);
  if (mc == null || !(mc > 0)) return null;
  for (const [band, b] of Object.entries(CAP_BANDS)) if (mc >= b.lo && mc < b.hi) return band;
  return null;
}

/**
 * One GeckoTerminal pool as the rest of the desk expects to see it.
 *
 * Mirrors dexscreener.shapePair so a GT-sourced coin flows into the funnel, the board
 * and the screen without any of them learning a second dialect. Market cap is
 * fdv_usd when market_cap_usd is null (a PONS supply is fixed at 1e9, so the two are
 * the same number). liquidityUsd is reserve_in_usd — for a curve that is the quote
 * asset sitting in it, the money that can be sold into before graduation.
 */
export function asCandidate(pool, { now = Date.now() } = {}) {
  const at = pool?.attributes;
  const address = lower(at?.address);
  const base = tokenIdAddr(pool?.relationships?.base_token?.data?.id);
  if (!at || !address || !base) return null;
  const dexId = pool?.relationships?.dex?.data?.id ?? null;
  const v = venueOf(dexId);
  const quote = tokenIdAddr(pool?.relationships?.quote_token?.data?.id);
  const [baseSymbol, quoteSymbol] = String(at.name ?? "").split(" / ").map((s) => s.trim());
  const mcap = num(at.market_cap_usd) ?? num(at.fdv_usd);
  const createdAt = isoMs(at.pool_created_at);
  const ageHours = createdAt ? (now - createdAt) / 3.6e6 : null;
  const tx = at.transactions ?? {};
  const txns = {};
  for (const k of ["m5", "m15", "m30", "h1", "h6", "h24"]) if (tx[k]) txns[k] = { buys: num(tx[k].buys) ?? 0, sells: num(tx[k].sells) ?? 0, buyers: num(tx[k].buyers), sellers: num(tx[k].sellers) };
  const vol = {}; for (const [k, x] of Object.entries(at.volume_usd ?? {})) vol[k] = num(x);
  const chg = {}; for (const [k, x] of Object.entries(at.price_change_percentage ?? {})) chg[k] = num(x);
  return {
    mint: base, address: base,
    launchpad: launchpadOf(dexId),
    onCurve: v.curve,
    source: "pons-live",
    pool: address,
    pair: {
      dex: dexId,
      version: v.version,
      pairAddress: address,
      url: `https://www.geckoterminal.com/robinhood/pools/${address}`,
      baseSymbol: baseSymbol || null,
      baseName: null,
      baseAddress: base,
      quoteSymbol: quote === lower(TOKENS.NATIVE) ? "ETH" : (quoteSymbol || null),
      quoteAddress: quote,
      priceUsd: num(at.base_token_price_usd),
      priceNative: num(at.base_token_price_native_currency),
      liquidityUsd: num(at.reserve_in_usd),
      fdv: num(at.fdv_usd),
      marketCap: mcap,
      pairCreatedAt: createdAt,
      ageHours: ageHours == null ? null : Number(ageHours.toFixed(2)),
      volume: vol,
      txns,
      priceChange: chg,
      imageUrl: null, socials: [], websites: [],
    },
    live: {
      band: bandOf(mcap),
      venue: v.venue,
      graduated: !v.curve,
      creator: null,
      lastTradeAt: null,
      buyers5m: txns.m5?.buyers ?? null,
      verified: false, banned: false,
    },
    raw: pool,
  };
}

/* ── the minute tape ────────────────────────────────────────────────────────── */

/** Pure: GeckoTerminal's ohlcv_list (newest first) → the desk's tape, OLDEST FIRST. */
export function shapeCandles(list, { interval = "1m" } = {}) {
  const rows = (Array.isArray(list) ? list : [])
    .map((k) => ({ ts: num(k?.[0]) != null ? num(k[0]) * 1000 : null, open: num(k?.[1]), high: num(k?.[2]),
      low: num(k?.[3]), close: num(k?.[4]), volume: num(k?.[5]) ?? 0 }))
    .filter((k) => k.ts != null && k.close > 0)
    .sort((a, b) => a.ts - b.ts);
  return {
    interval,
    tape: rows,
    // The contract's shape for the technical seat: {t,o,h,l,c,volUsd}, newest last.
    bars: rows.map((k) => ({ t: k.ts, o: k.open, h: k.high, l: k.low, c: k.close, volUsd: k.volume })),
    // Bars with real trades. GT omits empty minutes, so every row it returns traded;
    // a caller that forward-fills must not count the fill.
    barsCovered: rows.filter((k) => k.volume > 0).length,
  };
}

/** The minute tape for a POOL (not a token). Oldest first. */
export async function candles(pool, { limit = 40, aggregate = 1, currency = "usd" } = {}) {
  const r = await getJson(`${GT}/pools/${pool}/ohlcv/minute?aggregate=${aggregate}&limit=${Math.max(2, Math.min(1000, limit))}&currency=${currency}`,
    { headers: HEADERS, timeoutMs: 9000, label: "gt/ohlcv" });
  return shapeCandles(r.data?.data?.attributes?.ohlcv_list, { interval: `${aggregate}m` });
}

/** Pure: GT trade rows → the whale-flow shape whales.js scores. */
export function shapeTrades(rows, { minUsd = 500 } = {}) {
  return (Array.isArray(rows) ? rows : []).map((t) => t?.attributes ?? {}).map((a) => ({
    wallet: lower(a.tx_from_address) ?? null,
    side: a.kind === "buy" ? "buy" : a.kind === "sell" ? "sell" : null,
    usd: num(a.volume_in_usd),
    tokens: num(a.kind === "buy" ? a.to_token_amount : a.from_token_amount),
    signature: a.tx_hash ?? null,
    block: num(a.block_number),
    at: isoMs(a.block_timestamp),
    evidenceKind: "indexer_trade_usd",
    valueBasis: "GeckoTerminal volume_in_usd at execution",
  })).filter((t) => t.wallet && t.side && t.usd != null && t.usd >= minUsd);
}

/** Pool trades at or above `minUsd`, largest first. */
export async function trades(pool, { minUsd = 500 } = {}) {
  const r = await getJson(`${GT}/pools/${pool}/trades?trade_volume_in_usd_greater_than=${Math.max(0, Math.floor(minUsd))}`,
    { headers: HEADERS, timeoutMs: 9000, label: "gt/trades" });
  if (!r.ok) return { ok: false, error: r.error, trades: [] };
  return { ok: true, trades: shapeTrades(r.data?.data, { minUsd }).sort((a, b) => b.usd - a.usd) };
}

/**
 * What the last half hour actually did. Ported unchanged from the Solana desk: pure,
 * windows cut on timestamps (a "1m" candle is not a minute — the feed omits minutes
 * nobody traded), `now` defaults to the last candle so the reading is about the tape.
 */
export function momentumFrom(tape, { now = null } = {}) {
  if (!Array.isArray(tape) || tape.length < 3) return null;
  const last = tape.at(-1);
  if (!(last?.close > 0) || last.ts == null) return null;
  const end = now ?? last.ts;
  const MIN = 60_000;
  const inWindow = (from, to) => tape.filter((k) => k.ts > end - to * MIN && k.ts <= end - from * MIN);
  const sumVol = (rows) => rows.reduce((a, k) => a + (k.volume || 0), 0);
  const closeAt = (minsAgo) => {
    const cut = end - minsAgo * MIN;
    let found = null;
    for (const k of tape) { if (k.ts <= cut) found = k; else break; }
    return found?.close ?? null;
  };
  const pct = (mins) => { const then = closeAt(mins); return then > 0 ? ((last.close / then) - 1) * 100 : null; };
  const recent = inWindow(0, 5);
  const prior = inWindow(5, 15);
  const recentVol = sumVol(recent);
  const priorVol = prior.length ? sumVol(prior) / 2 : 0;
  const coverageMins = (last.ts - tape[0].ts) / MIN;
  const high = Math.max(...tape.map((k) => k.close));
  return {
    candles: tape.length,
    coverageMins: Number(coverageMins.toFixed(1)),
    stalenessMins: now == null ? null : Number(((now - last.ts) / MIN).toFixed(1)),
    lastPriceUsd: last.close,
    pct5m: pct(5), pct15m: pct(15), pct30m: pct(30),
    vol5mUsd: recentVol,
    volPrior5mUsd: priorVol,
    volAccel: priorVol > 0 ? recentVol / priorVol : null,
    drawdownFromHighPct: high > 0 ? ((last.close / high) - 1) * 100 : null,
  };
}

/** The minute tape for many POOLS at once, bounded so a sweep cannot melt the host. */
export async function momentumFor(pools, { limit = 40, concurrency = 4, now = null } = {}) {
  const out = new Map();
  const list = typeof pools === "string" ? [pools] : (Array.isArray(pools) ? pools : []);
  const queue = [...new Set(list)].filter(Boolean);
  const workers = Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, async () => {
    for (let p = queue.pop(); p; p = queue.pop()) {
      try { out.set(p, momentumFrom((await candles(p, { limit })).tape, { now })); }
      catch { out.set(p, null); }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ── the chain-native feed ──────────────────────────────────────────────────── */

/** Pure: one PONS V2 launch log → {token, creator, curve, block, tx}. Null if not one. */
export function decodeLaunchLog(log) {
  if (!log || lower(log.topics?.[0]) !== TOPIC_PONS_LAUNCH || (log.topics?.length ?? 0) < 4) return null;
  return {
    token: topicAddress(log.topics[1]), creator: topicAddress(log.topics[2]), curve: topicAddress(log.topics[3]),
    block: Number(log.blockNumber), tx: log.transactionHash, logIndex: Number(log.logIndex ?? 0), factory: lower(log.address),
  };
}

/** PONS V2 launches in [fromBlock, toBlock], decoded, oldest first. */
export async function launchLogs({ fromBlock, toBlock = null, maxSpans = 3, creator = null } = {}) {
  const head = toBlock ?? await blockNumber();
  if (head == null) return { ok: false, error: "head unreadable", launches: [] };
  const from = fromBlock ?? Math.max(0, head - LOG_SPAN);
  const topics = [TOPIC_PONS_LAUNCH, null, creator ? "0x" + word(creator) : null];
  const r = await getLogs({ address: PONS_V2_FACTORY, topics, fromBlock: from, toBlock: head, maxSpans });
  return { ok: r.ok, error: r.error ?? null, complete: r.complete, fromBlock: r.fromBlock, toBlock: r.toBlock,
    launches: r.logs.map(decodeLaunchLog).filter(Boolean) };
}

/** The launch that created `token`, searched backwards from `toBlock` in spans. */
export async function launchFor(token, { toBlock = null, maxSpans = 12 } = {}) {
  const head = toBlock ?? await blockNumber();
  if (head == null) return null;
  const topics = [TOPIC_PONS_LAUNCH, "0x" + word(token)];
  let hi = head;
  for (let i = 0; i < maxSpans && hi >= 0; i++) {
    const lo = Math.max(0, hi - LOG_SPAN + 1);
    const r = await getLogs({ address: PONS_V2_FACTORY, topics, fromBlock: lo, toBlock: hi, maxSpans: 1 });
    const hit = r.logs.map(decodeLaunchLog).find(Boolean);
    if (hit) return hit;
    if (!r.ok) return null;
    hi = lo - 1;
  }
  return null;
}

/** The curve proxy's readable state. Each view is null with a reason when it reverts. */
export async function curveState(curve) {
  if (!isAddress(curve)) return { ok: false, error: "no curve address" };
  const [q, t] = await Promise.all([call(curve, SEL_QUOTE_TOKEN), call(curve, SEL_TOKEN)]);
  const out = { ok: q.ok && t.ok, curve: lower(curve), quoteToken: q.ok ? decodeAddress(q.data) : null,
    token: t.ok ? decodeAddress(t.data) : null, views: {}, error: q.ok && t.ok ? null : (q.error || t.error) };
  for (const [k, sel] of Object.entries(CURVE_VIEWS)) {
    const r = await call(curve, sel, { attempts: 1 });
    out.views[k] = r.ok ? { value: decodeUint(r.data)?.toString() ?? null } : { value: null, reason: `reverted (${r.error})` };
  }
  return out;
}

/**
 * What the launch transaction did with the supply. Read from the token's OWN Transfer
 * logs in that receipt — the ERC-20 event is the one ABI every token shares:
 *   vault    = where the mint went (the first Transfer from the zero address)
 *   curve    = the curve proxy from the launch log
 *   exempt   = supply that left vault/curve in the launch tx to anyone else: the
 *              creator's pre-buy and any exempt list, whatever the launcher calls it
 *   firstBlockBuyers = those recipients, with their share
 * The launcher's own CurveBuy-style events (topics 0xec36bf57…, 0xdcacba5e… on the
 * receipt read 2026-09-05) carry no public ABI and are not decoded.
 */
export function launchFromReceipt(receipt, { token, curve, supply }) {
  const t = lower(token), c = lower(curve);
  const logs = (receipt?.logs ?? []).filter((l) => lower(l.address) === t && lower(l.topics?.[0]) === TOPIC_TRANSFER && l.topics.length >= 3);
  if (!logs.length) return { ok: false, error: "no token Transfer in the launch receipt", exemptShareOfSupplyPct: null };
  const mint = logs.find((l) => topicAddress(l.topics[1]) === ZERO_ADDRESS);
  /* No mint in this receipt means the supply was created in an earlier transaction and
     the launch moved it from a holder this function cannot name. Without the vault the
     "inside" set is unknowable, so the share is UNMEASURED — null with the reason —
     never 0, which is what an empty buyer list would have read as. */
  if (!mint) return { ok: false, error: "no mint Transfer in the launch receipt — vault unknown, exempt share unmeasured",
    vault: null, curve: c, deployerTx: receipt.from ? lower(receipt.from) : null,
    exemptShareOfSupplyPct: null, exemptReason: "no mint Transfer in the launch receipt; the vault is unknown so exempt flows cannot be told from routing",
    firstBlockBuyers: [], launchTxLogs: receipt.logs?.length ?? 0 };
  const vault = topicAddress(mint.topics[2]);
  const total = BigInt(supply ?? (mint ? decodeUint(mint.data) : 0n) ?? 0n);
  const inside = new Set([c, vault].filter(Boolean));
  const buyers = new Map();
  for (const l of logs) {
    const from = topicAddress(l.topics[1]), to = topicAddress(l.topics[2]);
    if (from === ZERO_ADDRESS || !inside.has(from) || inside.has(to) || to === ZERO_ADDRESS) continue;
    buyers.set(to, (buyers.get(to) ?? 0n) + (decodeUint(l.data) ?? 0n));
  }
  const pct = (n) => total > 0n ? Number((Number(n * 1_000_000n / total) / 10_000).toFixed(2)) : null;
  const firstBlockBuyers = [...buyers].map(([address, units]) => ({ address, pctOfSupply: pct(units) })).sort((a, b) => b.pctOfSupply - a.pctOfSupply);
  const exempt = [...buyers.values()].reduce((a, b) => a + b, 0n);
  return { ok: true, vault, curve: c, deployerTx: receipt.from ? lower(receipt.from) : null,
    exemptShareOfSupplyPct: total > 0n ? pct(exempt) : null,
    exemptReason: total > 0n ? null : "supply unreadable",
    firstBlockBuyers, launchTxLogs: receipt.logs?.length ?? 0 };
}

export async function launchTxFacts(txHash, { token, curve, supply }) {
  const r = await read("eth_getTransactionReceipt", [txHash]);
  if (!r.ok || !r.data) return { ok: false, error: r.error ?? "receipt unavailable", exemptShareOfSupplyPct: null };
  return { ...launchFromReceipt(r.data, { token, curve, supply }), block: Number(r.data.blockNumber), gasUsed: Number(r.data.gasUsed) };
}

/* ── Uniswap V4 Initialize: the zero-third-party discovery path ─────────────── */

/** Pure: one PoolManager Initialize log → its fields. Null if not one. */
export function decodeInitializeLog(log) {
  if (!log || lower(log.topics?.[0]) !== TOPIC_V4_INITIALIZE || (log.topics?.length ?? 0) < 4) return null;
  const d = String(log.data ?? "0x").slice(2);
  const wordAt = (i) => (d.length >= (i + 1) * 64 ? BigInt("0x" + d.slice(i * 64, (i + 1) * 64)) : null);
  const tickRaw = wordAt(4);
  const tick = tickRaw == null ? null : (tickRaw >= 1n << 255n ? Number(tickRaw - (1n << 256n)) : Number(tickRaw));
  return {
    poolId: lower(log.topics[1]),
    currency0: topicAddress(log.topics[2]) ?? ZERO_ADDRESS,
    currency1: topicAddress(log.topics[3]) ?? ZERO_ADDRESS,
    fee: wordAt(0) == null ? null : Number(wordAt(0)),
    tickSpacing: wordAt(1) == null ? null : Number(wordAt(1)),
    // word 2 is the hooks address, right-aligned in its 32 bytes
    hooks: d.length >= 192 ? ("0x" + d.slice(2 * 64 + 24, 3 * 64)).toLowerCase() : null,
    sqrtPriceX96: wordAt(3)?.toString() ?? null,
    tick,
    block: Number(log.blockNumber), tx: log.transactionHash,
  };
}

/** Whether an initialised pool looks like a memecoin launch rather than plumbing. */
export function isLaunchPool(p) {
  if (!p) return false;
  const quotes = new Set([ZERO_ADDRESS, TOKENS.WETH, TOKENS.USDG].map(lower));
  return p.hooks === PONS_V2_HOOK || quotes.has(p.currency1) || quotes.has(p.currency0);
}

/** New V4 pools since `fromBlock` (≤ maxSpans × 10k blocks). */
export async function v4NewPools({ fromBlock, toBlock = null, maxSpans = 2 } = {}) {
  const head = toBlock ?? await blockNumber();
  if (head == null) return { ok: false, error: "head unreadable", pools: [] };
  const from = fromBlock ?? Math.max(0, head - 600);
  const r = await getLogs({ address: V4_POOL_MANAGER, topics: [TOPIC_V4_INITIALIZE], fromBlock: from, toBlock: head, maxSpans });
  return { ok: r.ok, error: r.error ?? null, complete: r.complete, fromBlock: r.fromBlock, toBlock: r.toBlock,
    pools: r.logs.map(decodeInitializeLog).filter(Boolean) };
}

/**
 * Has `token` graduated into a V4 pool? Two bounded log queries on the PoolManager,
 * one per currency position (native sorts below every token, so a native pair puts
 * the token at currency1). Returns the earliest matching pool with its block time.
 */
export async function graduationFor(token, { fromBlock, toBlock = null, maxSpans = 12 } = {}) {
  const head = toBlock ?? await blockNumber();
  if (head == null || fromBlock == null) return { ok: false, error: "no block range", graduated: null };
  const t = "0x" + word(token);
  const [a, b] = await Promise.all([
    getLogs({ address: V4_POOL_MANAGER, topics: [TOPIC_V4_INITIALIZE, null, null, t], fromBlock, toBlock: head, maxSpans }),
    getLogs({ address: V4_POOL_MANAGER, topics: [TOPIC_V4_INITIALIZE, null, t], fromBlock, toBlock: head, maxSpans }),
  ]);
  const pools = [...a.logs, ...b.logs].map(decodeInitializeLog).filter(Boolean).sort((x, y) => x.block - y.block);
  const complete = a.complete && b.complete;
  if (!pools.length) return { ok: a.ok && b.ok, complete, graduated: complete ? false : null, pools: [],
    error: complete ? null : "scan budget exhausted before the range was covered" };
  const first = pools[0];
  return { ok: true, complete, graduated: true, graduatedAt: await blockTimeMs(first.block), pool: first, pools };
}
