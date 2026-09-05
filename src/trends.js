import { searchPairs } from "./data/dexscreener.js";
import { emit } from "./lib/bus.js";
import { cfg } from "./config.js";
import { grokTrendScan, hasGrok } from "./lib/grok.js";
import * as store from "./lib/store.js";
import { liveCallFor } from "./calls.js";

/**
 * FRONT-RUNNING THE LORE — discovery, run backwards.
 *
 * Every other lane starts on-chain: sweep the pairs that already exist, rank them, then
 * ask whether the story behind one is real. That is structurally late. A coin only
 * reaches a pair feed once it carries volume and liquidity, and by then whatever made
 * it interesting happened hours ago. The desk has been reading echoes.
 *
 * This lane starts on X. Grok reads what is ACCELERATING right now — a clip, a phrase,
 * a public figure doing something absurd, a season arriving — and returns the literal
 * words a launcher would put in a ticker. Then we search the chain for coins wearing
 * those words.
 *
 * The mechanism this exploits is the naming race, and it has one property that makes it
 * tradeable: A RACE PAYS EXACTLY ONE WINNER. When an event fires, dozens of coins
 * launch claiming the name; one takes the liquidity and the rest go to zero. So finding
 * the theme early is only half the job — backing the WINNER is the other half, and
 * backing a loser is worse than never having seen the trend at all.
 *
 * Two disciplines carried over from the rest of the desk:
 *   - This lane FINDS candidates. It does not judge them. Everything it surfaces still
 *     goes through the same screen, the same seats and the same compliance veto as a
 *     coin found any other way. Being early is not a reason to skip the gauntlet — it
 *     is the condition under which people most want to.
 *   - A theme with no coin yet is a real and useful answer. It means the desk saw the
 *     story before the market did, which is the whole point; it is worth recording and
 *     re-checking, not worth inventing a coin for.
 */

/** Themes we have already hunted recently, so a scan is not re-bought every cycle. */
const recentlyHunted = new Map();      // theme -> ts
const HUNT_TTL_MS = Number(process.env.TREND_HUNT_TTL_MINS || 90) * 60000;

/** Stage weighting. Being early IS the edge, so a peaked trend is worth almost nothing. */
const STAGE_SCORE = { just_broke: 40, building: 30, peaking: 5, over: -50 };
const REACH_SCORE = { niche: 6, notable: 14, mainstream: 8 };   // mainstream is often already late

/**
 * Search the chain for coins wearing a theme's words.
 *
 * Free — DexScreener's search endpoint — so a theme that turns up nothing costs only a
 * request. This chain only, and old coins are dropped: a token that predates the event
 * cannot be a coin launched FOR it, however well its name happens to match.
 */
/**
 * The coins the launchpad feed is listing for this theme, by pool name.
 *
 * DexScreener indexes a coin once it has a pool worth indexing, which is minutes to
 * hours after birth — and this lane's entire purpose is to be there before the crowd.
 * A theme Grok reports as "just broke" is answered on PONS by launches that are
 * three minutes old and invisible to a search engine; GeckoTerminal lists them at
 * birth (pons-live.js). Free, and additive: a failure here leaves the DexScreener
 * search below exactly as it was.
 */
async function padCoinsForTheme(terms, { maxAgeHours }) {
  const { newLaunches, padPools, asCandidate } = await import("./data/pons-live.js");
  const [fresh, pad] = await Promise.all([
    newLaunches({ pages: 2 }).catch(() => []), padPools({ pages: 2 }).catch(() => []),
  ]);
  const needles = terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
  const out = [];
  for (const row of [...fresh, ...pad]) {
    const hay = String(row?.attributes?.name ?? "").toLowerCase();
    const matchedTerm = needles.find((n) => hay.includes(n));
    if (!matchedTerm) continue;
    const c = asCandidate(row, {});
    if (!c || c.live.banned) continue;
    /* Only coins the desk could actually trade. Without this the race is won by
       whatever is biggest — the coin the money already found, and off the desk's
       board besides. */
    if (!c.live.band) continue;
    if (c.pair.ageHours != null && c.pair.ageHours > maxAgeHours) continue;
    out.push({
      mint: c.mint, address: c.mint, symbol: c.pair.baseSymbol, name: c.pair.baseName,
      liquidityUsd: c.pair.liquidityUsd ?? c.pair.marketCap ?? 0,
      marketCap: c.pair.marketCap, ageHours: c.pair.ageHours,
      buysH1: c.pair.txns?.h1?.buys ?? 0, matchedTerm, launchpad: c.launchpad ?? "pons",
    });
  }
  return out;
}

export async function coinsForTheme(theme, { maxAgeHours = 72 } = {}) {
  const terms = (theme.search_terms ?? []).filter((t) => typeof t === "string" && t.trim().length >= 2).slice(0, 5);
  const seen = new Map();
  // pump.fun first: its rows are the youngest, and the first entry for a mint wins.
  for (const c of await padCoinsForTheme(terms, { maxAgeHours }).catch(() => []))
    if (!seen.has(c.mint)) seen.set(c.mint, c);
  for (const term of terms) {
    // searchPairs is already filtered to this chain and returns a bare array.
    const pairs = await searchPairs(term.trim()).catch(() => []);
    for (const p of pairs) {
      const mint = p.baseToken?.address?.toLowerCase();
      if (!mint || seen.has(mint)) continue;
      const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : null;
      // A coin older than the event it supposedly claims is a name collision, not a
      // launch for this theme. Unknown age is kept — unreadable is not disqualifying.
      if (ageH != null && ageH > maxAgeHours) continue;
      seen.set(mint, {
        mint, address: mint, symbol: p.baseToken?.symbol, name: p.baseToken?.name,
        ageHours: ageH, liquidityUsd: p.liquidity?.usd ?? 0,
        marketCap: p.marketCap ?? p.fdv ?? null,
        volume24: p.volume?.h24 ?? 0,
        buysH1: p.txns?.h1?.buys ?? 0,
        matchedTerm: term,
      });
    }
  }
  return [...seen.values()];
}

/**
 * Of the coins racing for one theme, which is WINNING?
 *
 * Depth is the signal that settles a naming race, because it is the one thing the
 * crowd cannot fake cheaply: the coin the money picked is the coin with the money in
 * it. Recent buying breaks ties among the shallow. Everything else the race produces
 * is exit liquidity, and is marked as such so no other lane picks it up by accident.
 */
export function raceWinner(coins) {
  if (!coins.length) return { winner: null, losers: [] };
  const ranked = [...coins].sort((a, b) =>
    (b.liquidityUsd - a.liquidityUsd) || (b.buysH1 - a.buysH1));
  return { winner: ranked[0], losers: ranked.slice(1) };
}

/**
 * ONE PASS: read the trend, hunt each theme, return what to work up.
 *
 * Returns candidates in the shape the cycle already understands, so nothing downstream
 * has to know this lane exists — they are ordinary candidates that happen to have been
 * found early, and they face exactly the same gauntlet.
 */
export async function scanTrends({ maxThemes = 4, maxAgeHours = 72 } = {}) {
  if (!hasGrok()) return { ok: false, error: "no grok key", candidates: [] };

  const scan = await grokTrendScan({ limit: maxThemes + 2 }).catch(() => null);
  if (!scan?.ok) return { ok: false, error: scan?.error ?? "trend scan failed", candidates: [] };

  const now = Date.now();
  const fresh = (scan.themes ?? []).filter((t) => {
    if (t.stage === "over") return false;                 // the coins for it already ran
    const last = recentlyHunted.get(t.theme);
    return !(last && now - last < HUNT_TTL_MS);
  }).slice(0, maxThemes);

  const candidates = [];
  const empty = [];
  for (const t of fresh) {
    recentlyHunted.set(t.theme, now);
    const coins = await coinsForTheme(t, { maxAgeHours }).catch(() => []);
    if (!coins.length) {
      // The desk saw the story before the market did. That is the lane working, not
      // failing — worth saying out loud, and worth looking again shortly.
      empty.push(t.theme);
      recentlyHunted.set(t.theme, now - HUNT_TTL_MS + 15 * 60000);   // re-check in 15m
      emit("trend:no_coin_yet", { theme: t.theme, stage: t.stage,
        note: "the story is live and nothing has been launched for it yet" });
      continue;
    }
    const { winner, losers } = raceWinner(coins);
    emit("trend:race", { theme: t.theme, stage: t.stage, contenders: coins.length,
      winner: winner.symbol, winnerLiq: Math.round(winner.liquidityUsd) });

    if (liveCallFor(winner.mint) || store.recentlyJudged(winner.mint)) continue;

    const stage = STAGE_SCORE[t.stage] ?? 0;
    const reach = REACH_SCORE[t.reach] ?? 0;
    // A race with many contenders is a stronger signal that the EVENT is real — the
    // crowd voted with launches — even though it makes each individual coin riskier.
    const crowd = Math.min(18, coins.length * 3);
    candidates.push({
      mint: winner.mint,
      symbol: winner.symbol,
      trendScore: stage + reach + crowd,
      theme: t.theme,
      stage: t.stage,
      whyNow: `trend front-run · "${t.theme}" (${t.stage}, ${t.reach ?? "?"} reach) · ` +
        `${t.what_happened ?? ""} · winning a ${coins.length}-coin race on "${winner.matchedTerm}"` +
        (losers.length ? ` · ${losers.length} rivals are the exit liquidity` : ""),
      liquidityUsd: winner.liquidityUsd,
      marketCap: winner.marketCap,
      ageHours: winner.ageHours,
      rivals: losers.length,
    });
  }

  candidates.sort((a, b) => b.trendScore - a.trendScore);
  emit("trend:hunted", { themes: fresh.length, candidates: candidates.length,
    storiesWithNoCoinYet: empty.length });
  return { ok: true, themes: fresh, candidates, empty };
}
