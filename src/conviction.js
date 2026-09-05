/**
 * THE CONVICTION SCREEN — the owner's own thesis, made mechanical.
 *
 * The owner's specification, verbatim in substance: a coin worth real size has whales
 * in it, and it matters WHICH whales; it is trending on X; its account is active with a
 * real following; and it sits between $100k and $500k of market cap. Then: study the
 * verified whales, learn what they buy and how they behave, and hunt the coins they
 * would most likely buy next.
 *
 * THE WHALE TERM IS EMPTY ON THIS CHAIN, AND SAYS SO. On the Solana desk the roster was
 * measured — callouts by accounts pump.fun itself had verified, wallets priced on chain,
 * multiples reported per call. Robinhood Chain has no equivalent source: the launchpads
 * verify nobody, the public smart-money leaderboard rendered "Top 0 ranked" when
 * fetched (nockterminal.com/wallets, 2026-09-05), and the chain's own profit
 * distribution is flat — the top ten wallets took 0.9% of $330M of gains and no named
 * durably-profitable PONS wallet surfaced anywhere (Bitquery, 2026-07-28 and 2026-09-03).
 * So `verified_callouts` is empty here, and a roster read from it would silently score
 * every coin "no verified whale" while 54 of the owner's weighted points sat
 * unreachable. Rather than let the absence masquerade as a judgement, whaleCap is 0:
 * whales add nothing, the score explains the gap in `missing`, and the reader schema is
 * kept so a future on-chain proven-address roster (addresses whose PONS curve buys later
 * graduated, written to the same columns) turns the term back on by raising the cap —
 * see docs/HANDOFF-agents.md. The remaining terms — band, X trend, the account — are
 * the owner's thesis expressed as arithmetic, not evidence, until the shadow book has
 * graded enough of them. Every score carries its reasons so a scorecard can ask which
 * term actually predicted anything.
 *
 * Nothing here is a safety check and nothing here may loosen one. A coin with every
 * whale on earth in it still has to pass the screen, the exit probe and the contract
 * audit.
 */
import db from "./lib/store.js";
import { bandForMarketCap } from "./bands.js";

/* The callouts sweep owns `verified_callouts` and creates it. This module only READS
   it, and may be loaded in a process that never imported the sweep — a probe, a
   scorecard, a one-off. A reader that throws because a writer has not run yet is a
   reader that takes the whole process down for an empty table, so every read here
   degrades to "nothing seen" instead. */
const readRows = (sql, ...args) => {
  try { return db.prepare(sql).all(...args); }
  catch (error) {
    if (/no such table/i.test(String(error?.message))) return [];
    throw error;
  }
};

/** A call that doubled is the smallest result worth calling a hit on a memecoin. */
export const HIT_MULTIPLE = 2;
/** Below this many observed calls, a caller's hit rate is noise and is not used. */
export const MIN_CALLS_FOR_RECORD = 3;

/**
 * THE WHALE ROSTER, from what this desk has actually watched.
 *
 * One row per verified caller: how many distinct coins we have seen them call, how many
 * of those at least doubled afterwards, their median multiple, and the SOL their wallet
 * held when we last priced it. `proven` is deliberately conservative — a caller with two
 * lucky calls is not a proven caller.
 */
export function whaleRoster({ now = Date.now(), sinceMs = 30 * 24 * 3600e3, limit = 200 } = {}) {
  const rows = readRows(`
    SELECT caller, username,
           COUNT(*) AS calls,
           SUM(CASE WHEN multiple >= ? THEN 1 ELSE 0 END) AS hits,
           AVG(COALESCE(multiple, 1)) AS avg_multiple,
           MAX(COALESCE(multiple, 0)) AS best_multiple,
           MAX(wallet_sol_usd) AS wallet_usd,
           MAX(last_seen) AS last_seen
      FROM verified_callouts
     WHERE last_seen >= ?
     GROUP BY caller
     ORDER BY hits DESC, calls DESC
     LIMIT ?`, HIT_MULTIPLE, now - sinceMs, Math.max(1, Math.min(1000, limit)));

  return rows.map((r) => {
    const calls = Number(r.calls) || 0;
    const hits = Number(r.hits) || 0;
    const rated = calls >= MIN_CALLS_FOR_RECORD;
    return {
      caller: r.caller,
      username: r.username ?? null,
      calls, hits,
      // Null, not zero: "we have not watched them enough" and "they never hit" are
      // different facts, and only one of them is an opinion about the caller.
      hitRate: rated ? hits / calls : null,
      avgMultiple: r.avg_multiple != null ? Number(r.avg_multiple) : null,
      bestMultiple: r.best_multiple != null ? Number(r.best_multiple) : null,
      walletUsd: r.wallet_usd != null ? Number(r.wallet_usd) : null,
      lastSeen: Number(r.last_seen) || null,
      proven: rated && hits / calls >= 0.5,
    };
  });
}

/** Which rostered whales have been seen on this coin, best record first. */
export function whalesOn(mint, { roster = null, now = Date.now(), sinceMs = 30 * 24 * 3600e3 } = {}) {
  if (!mint) return [];
  const seen = readRows(
    "SELECT caller, username, multiple, wallet_sol_usd, called_at FROM verified_callouts WHERE mint=? AND last_seen >= ?",
    mint, now - sinceMs);
  if (!seen.length) return [];
  const byCaller = new Map((roster ?? whaleRoster({ now, sinceMs })).map((w) => [w.caller, w]));
  return seen
    .map((s) => ({
      caller: s.caller,
      username: s.username ?? null,
      multipleOnThisCall: s.multiple != null ? Number(s.multiple) : null,
      walletUsd: s.wallet_sol_usd != null ? Number(s.wallet_sol_usd) : null,
      calledAt: s.called_at ?? null,
      record: byCaller.get(s.caller) ?? null,
    }))
    .sort((a, b) => (b.record?.hitRate ?? -1) - (a.record?.hitRate ?? -1));
}

/* The owner's five characteristics, weighted. These numbers are a thesis, not a
   measurement — see the file header. They are gathered in one object so a later
   scorecard can retune them against the shadow book rather than hunting through code. */
export const CONVICTION_WEIGHTS = Object.freeze({
  provenWhale: 18,        // a whale with a real record is in it (unreachable: see whaleCap)
  unratedWhale: 7,        // a verified whale we have not watched long enough to rate
  whaleCap: 0,            // NO WHALE ROSTER ON THIS CHAIN YET — the term is honest at zero
                          // rather than penalising every coin identically; raise it only
                          // when a measured roster exists (file header, HANDOFF-agents.md)
  bandSweetSpot: 20,      // $100k-$500k, the owner's stated band
  bandAdjacent: 8,        // $60k-$100k or $500k-$1m
  bandEarly: 2,           // nano/micro: early, but not the stated band
  bandLate: -6,           // $1m+
  trend: { emerging: 20, building: 14, peaking: -6, fading: -18, none: 0 },
  velocityAccelerating: 8,
  mentionsHigh: 6,
  followers10k: 12, followers2k: 7, followers500: 3, followersThin: -8,
  engagingNow: 6,
  deletedHistory: -15,
});

/**
 * Score a candidate on the owner's conviction thesis.
 *
 * Pure: everything it needs is passed in, so it can be tested against cases whose answer
 * is known by hand. Returns a score, the reasons that made it, and the whales found —
 * never a verdict. Deciding what to do with a score belongs to the desk.
 */
export function convictionScore({ marketCapUsd = null, whales = [], xRead = null } = {}) {
  const W = CONVICTION_WEIGHTS;
  const reasons = [];
  let score = 0;
  const add = (points, why) => { if (points) { score += points; reasons.push(`${points > 0 ? "+" : ""}${points} ${why}`); } };

  // 1 and 2: how many whales, and WHO.
  const proven = whales.filter((w) => w.record?.proven);
  const unrated = whales.filter((w) => !w.record?.proven);
  const whalePoints = Math.min(W.whaleCap, proven.length * W.provenWhale + unrated.length * W.unratedWhale);
  if (whalePoints) {
    const names = proven.slice(0, 3).map((w) => w.username || String(w.caller).slice(0, 4)).join(", ");
    add(whalePoints, proven.length
      ? `${proven.length} proven whale${proven.length === 1 ? "" : "s"} in it${names ? ` (${names})` : ""}` +
        (unrated.length ? ` and ${unrated.length} unrated` : "")
      : `${unrated.length} verified whale${unrated.length === 1 ? "" : "s"} in it, none rated yet`);
  }

  // 5: the band. The owner's sweet spot is $100k-$500k.
  const band = bandForMarketCap(marketCapUsd);
  if (band === "medium") add(W.bandSweetSpot, "market cap is in the $100k-$500k band");
  else if (band === "low" || band === "high") add(W.bandAdjacent, `market cap is ${band}, next to the band`);
  else if (band === "nano" || band === "micro") add(W.bandEarly, `market cap is ${band}, earlier than the band`);
  else if (band === "very_high") add(W.bandLate, "market cap is above $1m, later than the band");

  // 3: the trend on X.
  const stage = xRead?.trend_stage ?? null;
  if (stage && W.trend[stage] != null) add(W.trend[stage], `X trend is ${stage}`);
  if (String(xRead?.velocity || "").toLowerCase().includes("accelerat")) add(W.velocityAccelerating, "X mentions accelerating");
  if (String(xRead?.mentions_level || "").toLowerCase() === "high") add(W.mentionsHigh, "high X mention volume");

  // 4: the account behind it — active, and followed.
  const followers = Number(xRead?.dev_followers);
  if (Number.isFinite(followers)) {
    if (followers >= 10_000) add(W.followers10k, `${followers.toLocaleString()} followers`);
    else if (followers >= 2_000) add(W.followers2k, `${followers.toLocaleString()} followers`);
    else if (followers >= 500) add(W.followers500, `${followers.toLocaleString()} followers`);
    else add(W.followersThin, `only ${followers.toLocaleString()} followers`);
  }
  if (xRead?.dev_engaging_now === true) add(W.engagingNow, "the account is replying to holders now");
  if (xRead?.deleted_history === true) add(W.deletedHistory, "signs of a wiped timeline");

  return {
    score: Math.round(score),
    band,
    whaleCount: whales.length,
    provenWhaleCount: proven.length,
    reasons,
    // What is MISSING is as informative as what is present: a coin scored without an X
    // read has not been judged on three of the owner's five characteristics.
    missing: [
      marketCapUsd == null ? "market cap" : null,
      xRead ? null : "X read",
      // The cap at zero means the term cannot be judged at all, and that is a different
      // fact from "no whale was seen": the first is about the desk, the second about the
      // coin. Say the first while it is true; fall back to the second once a roster exists.
      W.whaleCap === 0 ? "no whale roster on this chain yet"
        : whales.length ? null : "no verified whale seen on it",
    ].filter(Boolean),
  };
}

/**
 * The coins the rostered whales would most likely buy next: everything they have been
 * seen on recently, ranked by the owner's thesis. Free — it reads only what the callouts
 * sweep has already gathered.
 */
export function convictionBoard({ now = Date.now(), sinceMs = 24 * 3600e3, limit = 25, marketCaps = new Map() } = {}) {
  const roster = whaleRoster({ now });
  const mints = readRows(
    "SELECT DISTINCT mint, symbol FROM verified_callouts WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT ?",
    now - sinceMs, Math.max(1, Math.min(500, limit * 4)));
  return mints
    .map((m) => {
      const whales = whalesOn(m.mint, { roster, now, sinceMs });
      const scored = convictionScore({ marketCapUsd: marketCaps.get(m.mint) ?? null, whales });
      return { mint: m.mint, symbol: m.symbol ?? null, ...scored, whales };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
