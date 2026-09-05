/**
 * THE IGNITION LANE — what is moving on PONS right now.
 *
 * The desk's research is expensive and slow by design: eleven model calls, forty cents
 * and eight minutes to judge one coin. That is the right shape for a thesis and the
 * wrong shape for a $9k coin that doubles in five minutes, and the owner asked for
 * both. So this lane does no thinking at all. It is arithmetic over free data —
 * GeckoTerminal's new-pool listing for chain 4663 and its minute candles per pool
 * (pons-live.js; ~13-20 new pools a minute measured 2026-09-05) — and its only job is
 * to answer "which of the coins launched this hour is actually moving", cheaply
 * enough to ask again every minute.
 *
 * What it costs: about six HTTP requests plus one minute-tape per shortlisted coin.
 * No model is called. Nothing here can spend a cent of the research budget.
 *
 * What it is NOT: a decision. Ignition ranks; the desk still decides, and every safety
 * gate downstream still runs. A coin arriving through this lane is a coin the desk has
 * been told to LOOK at sooner, not one it has been told to buy.
 */
import { CAP_BANDS } from "./categories.js";
import { asCandidate, momentumFor, newLaunches, recentlyTraded, padPools } from "./data/pons-live.js";
import { emit } from "./lib/bus.js";

/* HOW LONG A BAND IS WORTH HUNTING IN.
 *
 * A coin's hold window says how long the desk stays in; this says how long after birth
 * the desk is still interested in getting in. They are deliberately different numbers:
 * a nano coin four hours old has already had its move, whatever its market cap says,
 * and a $5m coin two days old is perfectly ordinary. The multiple is generous —
 * twelve times the hold window — because the point is to exclude the archaeology the
 * old keyword sweep was returning (median age twenty-five days), not to be clever. */
const HUNT_WINDOW_MULTIPLE = 12;
const huntWindowMs = (band) => (CAP_BANDS[band]?.holdMaxMs ?? 0) * HUNT_WINDOW_MULTIPLE;

/** Coins whose tape is worth pulling. Free: nothing here makes a request. */
export function shortlist(candidates, { now = Date.now(), limit = 40 } = {}) {
  const eligible = [];
  for (const c of candidates) {
    const band = c?.live?.band;
    if (!band || c.live.banned) continue;
    const createdAt = c.pair?.pairCreatedAt;
    const ageMs = createdAt ? now - createdAt : null;
    // An unreadable age is not a disqualification — the desk's standing rule for a
    // number it could not measure — but it does not earn the freshness bonus either.
    if (ageMs != null && ageMs > huntWindowMs(band)) continue;
    /* A coin nobody has traded in the last ten minutes is not igniting, whatever its
       market cap. This is the cheapest possible liveness test and it removes most of
       the listing before a single tape is pulled. GeckoTerminal has no last-trade
       stamp; its five-minute transaction count is the same question asked differently,
       and a pool with none is skipped on the same grounds. */
    const lastTradeAt = c.live.lastTradeAt;
    if (lastTradeAt != null && now - lastTradeAt > 10 * 60_000) continue;
    const m5 = c.pair?.txns?.m5;
    if (lastTradeAt == null && m5 && (m5.buys + m5.sells) === 0) continue;
    eligible.push({ candidate: c, ageMs });
  }
  /* Rank for ATTENTION, not for merit: this only decides whose minute tape gets pulled,
     and the tape is what actually judges. Youth first, because the whole point of this
     lane is to be early, then the crowd signal pump.fun gives away for free. */
  const scored = eligible.map(({ candidate, ageMs }) => {
    const band = candidate.live.band;
    const window = huntWindowMs(band) || 1;
    const freshness = ageMs == null ? 0.35 : Math.max(0, 1 - ageMs / window);
    // The crowd signal the feed gives away for free: pump.fun's reply count on Solana,
    // GeckoTerminal's distinct five-minute buyers here. Both saturate around sixty.
    const crowd = candidate.live.replyCount ?? candidate.live.buyers5m ?? 0;
    const replies = Math.min(1, crowd / 60);
    // A coin already well below its own high is a late look, not an early one.
    const ath = candidate.live.athMarketCap;
    const nearHigh = ath > 0 && candidate.pair.marketCap > 0
      ? Math.min(1, candidate.pair.marketCap / ath) : 0.5;
    return { candidate, ageMs, attention: freshness * 2 + replies + nearHigh };
  });
  scored.sort((a, b) => b.attention - a.attention);
  return scored.slice(0, Math.max(0, limit)).map((s) => s.candidate);
}

/**
 * What the tape says. Pure, and deliberately readable as a sentence: every number that
 * moves the score is one a person can check against the chart afterwards.
 *
 * Positive score means "moving up on rising volume, not yet exhausted". A coin can
 * score well and still be a terrible trade — that is what the rest of the desk is for.
 */
export function ignitionScore(momentum, { band } = {}) {
  if (!momentum) return null;
  const reasons = [];
  let score = 0;
  const add = (points, why) => { if (points) { score += points; reasons.push(why); } };

  const p5 = momentum.pct5m ?? 0, p15 = momentum.pct15m ?? 0, p30 = momentum.pct30m ?? 0;
  // The five-minute move is the one that matters for a thirty-minute horizon; the
  // longer windows are there to tell a fresh move from the tail of an old one.
  add(Math.max(-25, Math.min(45, p5 * 1.5)), `5m ${p5.toFixed(1)}%`);
  add(Math.max(-15, Math.min(25, p15 * 0.5)), `15m ${p15.toFixed(1)}%`);
  // A coin already up hugely over thirty minutes is not early. Mild, deliberate penalty.
  if (p30 > 120) add(-12, `already +${Math.round(p30)}% over 30m`);

  const accel = momentum.volAccel;
  if (accel != null) add(Math.max(-10, Math.min(25, (accel - 1) * 12)),
    `volume ${accel.toFixed(2)}x its prior five minutes`);
  // A silent prior window with real volume now IS the ignition case, not a missing ratio.
  else if (momentum.vol5mUsd > 0) add(14, "volume from a standing start");

  // Money actually changing hands. A 200% move on $40 of volume is a chart artefact.
  const vol = momentum.vol5mUsd ?? 0;
  add(vol >= 25_000 ? 12 : vol >= 5_000 ? 7 : vol >= 500 ? 2 : -8,
    `$${Math.round(vol).toLocaleString()} traded in five minutes`);

  const dd = momentum.drawdownFromHighPct ?? 0;
  if (dd < -35) add(-14, `${Math.round(-dd)}% off its high already`);

  /* Too short a tape is not evidence of anything — and "short" is a span, not a row
     count. This read `momentum.minutes`, which was the NUMBER OF CANDLES: a coin that
     traded in forty scattered minutes across two days scored as a mature tape, while a
     coin genuinely four minutes into its life scored the same as one four candles into
     a quiet week. The feed omits minutes nobody traded, so the two are unrelated. */
  const cover = momentum.coverageMins ?? 0;
  if (cover < 5) add(-6, `only ${cover.toFixed(0)} minutes of tape`);
  /* A LIVE FIVE-MINUTE WINDOW, OR NO CREDIT FOR ONE. If the last print is older than
     the window it is supposed to describe, vol5mUsd is a number about the past. */
  if (momentum.stalenessMins != null && momentum.stalenessMins > 5)
    add(-10, `last trade ${Math.round(momentum.stalenessMins)} minutes ago`);

  return { score: Math.round(score), reasons, band: band ?? null };
}

/**
 * One pass: read pump.fun, shortlist, pull tapes, rank.
 *
 * Returns every candidate it scored, ranked, plus the raw counts — a caller that wants
 * only the top few can slice, and the counts are what makes the lane auditable in a log.
 */
export async function ignitionSweep({ freshPages = 2, tradedPages = 1, padPages = 1,
  tapes = 40, tapeMinutes = 40, concurrency = 4, now = Date.now() } = {}) {
  const [fresh, traded, pad] = await Promise.all([
    newLaunches({ pages: freshPages }).catch(() => []),
    recentlyTraded({ pages: tradedPages }).catch(() => []),
    padPools({ pages: padPages }).catch(() => []),
  ]);
  const seen = new Map();
  for (const row of [...traded, ...fresh, ...pad]) {
    const c = asCandidate(row, { now });
    if (c && !seen.has(c.mint)) seen.set(c.mint, c);
  }
  const all = [...seen.values()];
  const picked = shortlist(all, { now, limit: tapes });
  // The tape is keyed by POOL: GeckoTerminal serves candles per pool, not per token.
  const momentum = await momentumFor(picked.map((c) => c.pool),
    { limit: tapeMinutes, concurrency, now });

  const ranked = [];
  for (const c of picked) {
    const mo = momentum.get(c.pool) ?? null;
    const scored = ignitionScore(mo, { band: c.live.band });
    if (!scored) continue;
    ranked.push({ ...c, momentum: mo, ignition: scored });
  }
  ranked.sort((a, b) => b.ignition.score - a.ignition.score);

  const bands = {};
  for (const c of all) if (c.live.band) bands[c.live.band] = (bands[c.live.band] || 0) + 1;
  const result = { seen: all.length, onBoard: Object.values(bands).reduce((a, b) => a + b, 0),
    shortlisted: picked.length, scored: ranked.length, bands, ranked };
  emit("ignition:sweep", { seen: result.seen, onBoard: result.onBoard, shortlisted: result.shortlisted,
    scored: result.scored, bands, top: ranked.slice(0, 5).map((r) => ({
      symbol: r.pair.baseSymbol, band: r.live.band, score: r.ignition.score,
      pct5m: r.momentum?.pct5m ?? null, mcap: r.pair.marketCap })) });
  return result;
}
