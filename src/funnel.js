/**
 * THE FUNNEL — a standing population of coins, not a pipeline that runs and empties.
 *
 * The desk used to be stateless. Every pass swept the market, ranked it, screened it,
 * paid for eight workups, published or refused, and then THREW ALL OF IT AWAY. The next
 * pass began from nothing and re-derived the same facts about the same coins.
 *
 * On a slow asset that is merely wasteful. On memecoins it is the wrong shape entirely,
 * for one reason that costs real money: when a position finally closes, the desk has
 * nothing ready. It starts a cold sweep, screens, buys eight workups, and arrives at a
 * decision four minutes later — in a market where the move it was chasing is measured in
 * minutes. The desk was always researching the market it had just missed.
 *
 * So coins now LIVE here, in stages, and a pass ADVANCES the population rather than
 * recreating it:
 *
 *     watch      seen and ranked. Free. Hundreds.
 *       |        the free safety screen
 *     screened   passed every hard safety check. Free. Dozens.
 *       |        the paid workup — the expensive gate, and the narrow one
 *     studied    the seats have spoken. Costs money. A handful.
 *       |        eligibility, conviction, the book
 *     ready      would trade right now if a slot were open. Usually one or two.
 *
 * The point of holding `ready` is that the desk is never caught cold: the instant the
 * book frees, there is already a researched, ranked, still-fresh name to act on.
 *
 * WHICH MAKES FRESHNESS THE WHOLE PROBLEM. A standing population is a population of
 * increasingly old beliefs, and a stale belief about a memecoin is not a slightly worse
 * belief — the liquidity that was there is gone, the authority that was renounced is
 * back, the story that was live is dead. Every stage therefore carries an expiry, and
 * the two kinds of expiry are deliberately NOT the same length:
 *
 *   - SAFETY facts expire fast and hard. A screen older than a few minutes is not
 *     evidence, and a coin whose screen has expired falls back to `watch` — never
 *     forward, never held, no exceptions and no grace for a coin the desk likes.
 *   - CONVICTION expires slower, because a thesis about a narrative is about something
 *     that changes in hours rather than seconds. But a big price move expires it early:
 *     something happened, and the desk's written answer is to a question nobody is
 *     asking any more.
 *
 * Nothing in this file costs a cent. It is bookkeeping — which stage each coin is in and
 * whether its stage is still true. The money is spent by the caller, on a much shorter
 * list than it used to consider.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ROOT } from "./config.js";
import { PAD_QUOTA, PREFERRED_PAD, cellOf } from "./categories.js";
import { canonicalAddress, canonicalLaunchpad } from "./canonical.js";

const db = new DatabaseSync(process.env.CLAUDE_CO_DB || path.join(ROOT, "claude-co.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS funnel (
  mint TEXT PRIMARY KEY,
  symbol TEXT, name TEXT, launchpad TEXT,
  cell_key TEXT, band TEXT, coin_type TEXT,
  stage TEXT NOT NULL DEFAULT 'watch',
  first_seen INTEGER, last_seen INTEGER, stage_since INTEGER,
  score REAL, mcap REAL, liq REAL, vol24 REAL, h1 REAL, age_h REAL,
  screened_at INTEGER, screen_kill TEXT,
  studied_at INTEGER, verdict TEXT, conviction REAL, thesis TEXT, h1_at_study REAL,
  seen_count INTEGER DEFAULT 0, promotions INTEGER DEFAULT 0, demotions INTEGER DEFAULT 0,
  drop_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_funnel_stage ON funnel(stage);
CREATE INDEX IF NOT EXISTS idx_funnel_seen ON funnel(last_seen);
`);

/* The live table predates this column, so add it in place rather than by recreating —
 * the funnel's whole value is the history it holds. */
for (const [col, decl] of [["eligible", "INTEGER"]])
  try { db.exec(`ALTER TABLE funnel ADD COLUMN ${col} ${decl}`); } catch { /* already there */ }

const MIN = 60_000;

/* THE CLOCKS. Every one of these is a claim about how fast a specific KIND of fact
 * rots, and they are separated because they rot at genuinely different speeds. */
export const TTL = {
  /* A safety screen. Short and non-negotiable: liquidity is pulled in one block, and
   * a freeze authority can be re-enabled the moment somebody wants it to be. Anything
   * older than this is not stale evidence, it is no evidence. */
  screen: Number(process.env.FUNNEL_SCREEN_TTL_MIN || 12) * MIN,

  /* A paid verdict. Longer, because it is a claim about a narrative and a holder base
   * rather than about a number that changes per block — but still inside the hour,
   * because on this desk an hour is a long time. */
  study: Number(process.env.FUNNEL_STUDY_TTL_MIN || 40) * MIN,

  /* Gone from the sweep entirely. Not a judgement — the desk simply cannot see it any
   * more, and acting on a coin you have lost sight of is how you buy a delisting. */
  unseen: Number(process.env.FUNNEL_UNSEEN_DROP_MIN || 25) * MIN,
};

/* A price move that expires a verdict early, however recent it is. The desk wrote its
 * answer about a coin at one price; a coin 20% away is a different question. */
export const RESTALE_MOVE_PCT = Number(process.env.FUNNEL_RESTALE_MOVE_PCT || 20);

export const STAGES = ["watch", "screened", "studied", "ready"];
const rank = (s) => STAGES.indexOf(s);

/**
 * Record everything the sweep saw.
 *
 * Free, and called on every pass. Coins already in the funnel keep their stage and get
 * a refreshed market snapshot; coins never seen before enter at `watch`.
 *
 * The market fields are refreshed even for coins deep in the funnel, on purpose: that
 * refresh is what lets a price move expire a verdict that is still inside its TTL.
 *
 * The cap band and coin type are DERIVED HERE rather than taken from the caller. They
 * used to be read off the coin, which quietly worked in tests — where they were passed
 * in by hand — and was null for every coin against the live market, because nothing
 * assigns them until the board is built further downstream. The whole board spread then
 * collapsed into one nameless cell: 294 coins swept, "across 1 cells". A fact that can
 * be computed from the coin belongs to the thing that stores it, not to whoever
 * remembers to attach it.
 */
export function observe(coins) {
  const now = Date.now();
  let added = 0, refreshed = 0;
  const ins = db.prepare(`
    INSERT INTO funnel (mint,symbol,name,launchpad,cell_key,band,coin_type,stage,
                        first_seen,last_seen,stage_since,score,mcap,liq,vol24,h1,age_h,seen_count)
    VALUES (?,?,?,?,?,?,?,'watch',?,?,?,?,?,?,?,?,?,1)`);
  const upd = db.prepare(`
    UPDATE funnel SET last_seen=?, score=?, mcap=?, liq=?, vol24=?, h1=?, age_h=?,
                      seen_count=seen_count+1, symbol=?, launchpad=?,
                      cell_key=COALESCE(?,cell_key), band=COALESCE(?,band), coin_type=COALESCE(?,coin_type)
    WHERE mint=?`);

  for (const raw of coins) {
    if (!raw?.mint) continue;
    // One spelling per coin: the funnel is keyed on the address, and a coin arriving
    // lowercase from one feed and EIP-55 from another must not become two rows.
    const c = { ...raw, mint: canonicalAddress(raw.mint), launchpad: canonicalLaunchpad(raw.launchpad) };
    const p = c.pair ?? {};
    const cell = c.cellKey ? { key: c.cellKey, band: c.band, type: c.coinType } : cellOf(c);
    const f = [
      c.score ?? 0,
      p.marketCap ?? p.fdv ?? null,
      p.liquidity?.usd ?? null,
      p.volume?.h24 ?? null,
      p.priceChange?.h1 ?? null,
      p.pairCreatedAt ? (now - p.pairCreatedAt) / 3.6e6 : null,
    ];
    const exists = db.prepare("SELECT mint FROM funnel WHERE mint=?").get(c.mint);
    if (exists) {
      upd.run(now, ...f, p.baseSymbol ?? null, c.launchpad ?? null,
              cell?.key ?? null, cell?.band ?? null, cell?.type ?? null, c.mint);
      refreshed++;
    } else {
      ins.run(c.mint, p.baseSymbol ?? null, p.baseName ?? null, c.launchpad ?? null,
              cell?.key ?? null, cell?.band ?? null, cell?.type ?? null, now, now, now, ...f);
      added++;
    }
  }
  return { added, refreshed, total: added + refreshed };
}

/**
 * Expire what has gone stale, and drop what the desk can no longer see.
 *
 * Demotion is always to the stage BELOW, never out — a coin whose screen expired is not
 * suspect, it is simply unverified again, and the cheap screen will re-earn it on the
 * next pass at no cost. The only thing removed outright is a coin that has fallen off
 * the sweep, because that is the one case where the desk has no way to re-check it.
 */
export function decay() {
  const now = Date.now();
  const out = { screenExpired: 0, studyExpired: 0, movedOut: 0, dropped: 0 };

  /* SAFETY FIRST, AND HARDEST. Anything at `screened` or above whose screen has aged
   * out goes back to `watch`. This runs before the conviction checks deliberately: a
   * coin must never sit at `ready` on a safety screen nobody has re-run. */
  out.screenExpired = db.prepare(`
    UPDATE funnel SET stage='watch', stage_since=?, demotions=demotions+1,
                      drop_reason='screen expired — safety facts are only as good as the clock'
    WHERE stage IN ('screened','studied','ready') AND (screened_at IS NULL OR screened_at < ?)`
  ).run(now, now - TTL.screen).changes;

  // A verdict that has simply aged out. Back to `screened`: the safety work still
  // stands, only the judgement is old, so re-study is the cheaper repair.
  out.studyExpired = db.prepare(`
    UPDATE funnel SET stage='screened', stage_since=?, demotions=demotions+1,
                      drop_reason='verdict aged out'
    WHERE stage IN ('studied','ready') AND (studied_at IS NULL OR studied_at < ?)`
  ).run(now, now - TTL.study).changes;

  // ...and one that is technically fresh but is now about a different price.
  out.movedOut = db.prepare(`
    UPDATE funnel SET stage='screened', stage_since=?, demotions=demotions+1,
                      drop_reason='price moved out from under the verdict'
    WHERE stage IN ('studied','ready') AND h1_at_study IS NOT NULL AND h1 IS NOT NULL
      AND ABS(h1 - h1_at_study) >= ?`
  ).run(now, RESTALE_MOVE_PCT).changes;

  // Lost sight of it. The only outright removal.
  out.dropped = db.prepare("DELETE FROM funnel WHERE last_seen < ?").run(now - TTL.unseen).changes;
  return out;
}

/** Coins owed a free safety screen: never screened, or screened too long ago. */
export function dueForScreen(limit = 200) {
  return db.prepare(`
    SELECT * FROM funnel WHERE stage='watch' AND score > 0
    ORDER BY score DESC LIMIT ?`).all(limit);
}

/**
 * Record what the free screen decided. A kill holds the coin at `watch`, with a reason.
 *
 * A PASS RESTORES A VERDICT THE DESK HAS ALREADY PAID FOR, and that is not a softening
 * of the safety rule — it is what makes the safety rule affordable.
 *
 * The two clocks are 12 minutes and 40 minutes apart for good reasons, but the first
 * version simply demoted on the shorter one and left it there. Measured against the
 * live desk: `studied` and `ready` sat at exactly 0 through 300+ workups, because every
 * paid verdict was thrown away the moment the FREE check timed out underneath it. The
 * warm bench — the entire point of building a funnel — could never exist, and the desk
 * was buying the same answers again on a twelve-minute cycle.
 *
 * So a coin that re-passes the screen goes back to where its still-fresh verdict had
 * earned it. Safety is not being inherited here: the screen was just re-run, this
 * instant, and a kill still holds the coin at `watch` no matter what the desk paid to
 * learn about it. What is inherited is only the JUDGEMENT, which has its own clock and
 * its own price-move test, both re-checked below.
 */
export function recordScreen(mint, kill) {
  mint = canonicalAddress(mint);
  const now = Date.now();
  if (kill) {
    db.prepare(`UPDATE funnel SET screened_at=?, screen_kill=?, stage='watch' WHERE mint=?`)
      .run(now, String(kill), mint);
    return "held";
  }
  const row = db.prepare(
    "SELECT studied_at, eligible, h1, h1_at_study FROM funnel WHERE mint=?").get(mint);

  const verdictStillGood = row?.studied_at > now - TTL.study
    && (row.h1_at_study == null || row.h1 == null
        || Math.abs(row.h1 - row.h1_at_study) < RESTALE_MOVE_PCT);
  const stage = verdictStillGood ? (row.eligible ? "ready" : "studied") : "screened";

  db.prepare(`UPDATE funnel SET screened_at=?, screen_kill=NULL, stage=?,
                                stage_since=?, promotions=promotions+1 WHERE mint=? AND stage='watch'`)
    .run(now, stage, now, mint);
  return stage === "screened" ? "promoted" : "restored";
}

/**
 * Who gets the expensive seats — chosen from the STANDING screened pool.
 *
 * This is the change that makes the funnel worth having. The old cycle picked from
 * whatever a single sweep happened to surface in the last ninety seconds. This picks
 * from every coin that has passed a still-valid safety screen, however long ago it
 * entered — so a good name found twenty minutes ago is still a candidate instead of
 * having been forgotten and re-discovered.
 *
 * The board spread and the preferred-pad quota both still apply, for the same reasons
 * they apply anywhere else: one per cell before doubling up, and the pad carrying the
 * volume gets the majority of the attention. The pad is PREFERRED_PAD (PONS V2 on 4663)
 * — until 2026-09-05 this defaulted to "pump.fun", which no coin here carries, so the
 * quota pass took nothing and the PONS preference the copy promises did not exist.
 */
export function dueForStudy(limit = 8, { padQuota = PAD_QUOTA, pad = PREFERRED_PAD } = {}) {
  const now = Date.now();
  const pool = db.prepare(`
    SELECT * FROM funnel
    WHERE stage='screened' AND screened_at > ?
    ORDER BY score DESC`).all(now - TTL.screen);

  const picked = [], seen = new Set(), perCell = new Map();
  const take = (r) => { seen.add(r.mint); perCell.set(r.cell_key, (perCell.get(r.cell_key) ?? 0) + 1); picked.push(r); };

  /* Spread by the THINNEST cell, not by a round number.
   *
   * The obvious version counts rounds and takes from cells whose tally equals the round
   * index. It works for one pass and breaks the moment there are two: the quota pass
   * leaves every touched cell on 1, the general pass starts counting at 0, matches
   * nothing, and returns early. Measured — a budget of four came back with two, which
   * is the desk quietly under-spending the seats it was told to fill.
   *
   * So each round asks what the FEWEST picks any still-available cell has, and takes one
   * from each cell sitting at that number. Same one-per-cell-before-doubling-up
   * guarantee, but it composes across passes because it reads the real tallies instead
   * of assuming where they started. */
  const fill = (want, filter) => {
    while (picked.length < want) {
      const avail = pool.filter((r) => !seen.has(r.mint) && filter(r));
      if (!avail.length) break;
      const thinnest = Math.min(...avail.map((r) => perCell.get(r.cell_key) ?? 0));
      let took = false;
      for (const r of avail) {
        if (picked.length >= want) break;
        if ((perCell.get(r.cell_key) ?? 0) !== thinnest) continue;
        take(r);                                    // take() bumps the cell, so one per round
        took = true;
      }
      if (!took) break;
    }
  };
  // Both sides through the alias table: a row written by the sweep says "pons", the
  // constant says "pons-v2", and the quota must not miss on the spelling.
  const want = canonicalLaunchpad(pad);
  fill(Math.min(limit, Math.ceil(limit * padQuota)), (r) => canonicalLaunchpad(r.launchpad) === want);
  const fromPad = picked.length;
  fill(limit, () => true);

  picked.padMix = { [pad]: fromPad, other: picked.length - fromPad };
  return picked;
}

/** Record a paid verdict, and promote or demote on what it said. */
export function recordStudy(mint, { eligible, verdict, conviction, thesis }) {
  mint = canonicalAddress(mint);
  const now = Date.now();
  const row = db.prepare("SELECT h1 FROM funnel WHERE mint=?").get(mint);
  db.prepare(`
    UPDATE funnel SET studied_at=?, verdict=?, conviction=?, thesis=?, h1_at_study=?,
                      eligible=?, stage=?, stage_since=?, promotions=promotions+?
    WHERE mint=?`
  ).run(now, verdict ?? null, conviction ?? null, thesis ?? null, row?.h1 ?? null,
        eligible ? 1 : 0, eligible ? "ready" : "studied", now, eligible ? 1 : 0, mint);
  return eligible ? "ready" : "studied";
}

/**
 * The warm bench: researched, still fresh, and tradeable the moment a slot opens.
 *
 * The whole funnel exists to keep this list non-empty. Every guarantee it carries is
 * re-checked here against the clock rather than trusted from the stage column, because
 * a row can be written `ready` and be minutes past its screen by the time anyone reads
 * it — and this is the exact query whose answer gets money put behind it.
 */
export function readyPool(limit = 5) {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM funnel
    WHERE stage='ready' AND screened_at > ? AND studied_at > ?
      AND (h1_at_study IS NULL OR h1 IS NULL OR ABS(h1 - h1_at_study) < ?)
    ORDER BY conviction DESC, score DESC LIMIT ?`
  ).all(now - TTL.screen, now - TTL.study, RESTALE_MOVE_PCT, limit);
}

/** Take a coin out of the funnel — it has been traded, or the desk refused it outright. */
export function retire(mint, reason) {
  db.prepare("UPDATE funnel SET stage='watch', stage_since=?, drop_reason=? WHERE mint=?")
    .run(Date.now(), reason, canonicalAddress(mint));
}

/**
 * The shape of the funnel right now.
 *
 * Reading the drop-off between stages is how you tell "the market offered nothing" from
 * "the desk is strangling itself" — two failures that look identical from outside, and
 * which cost a full day to separate by hand once already.
 */
export function census() {
  const now = Date.now();
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of db.prepare("SELECT stage, COUNT(*) n FROM funnel GROUP BY stage").all())
    if (r.stage in byStage) byStage[r.stage] = r.n;

  const q = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;
  return {
    ...byStage,
    total: Object.values(byStage).reduce((a, b) => a + b, 0),
    fresh: {
      screened: q("SELECT COUNT(*) n FROM funnel WHERE stage='screened' AND screened_at > ?", now - TTL.screen),
      ready: readyPool(99).length,
    },
    killedAtScreen: q("SELECT COUNT(*) n FROM funnel WHERE screen_kill IS NOT NULL"),
    topKills: db.prepare(`
      SELECT screen_kill k, COUNT(*) n FROM funnel WHERE screen_kill IS NOT NULL
      GROUP BY screen_kill ORDER BY n DESC LIMIT 6`).all(),
    /* The board, as the owner specified it: cap band x coin type. Published from the
     * funnel because this is now where the population actually lives. */
    board: db.prepare(`
      SELECT band, coin_type, COUNT(*) n,
             SUM(CASE WHEN stage IN ('screened','studied','ready') THEN 1 ELSE 0 END) live
      FROM funnel WHERE band IS NOT NULL GROUP BY band, coin_type ORDER BY live DESC, n DESC`).all(),
    padMix: db.prepare(`
      SELECT COALESCE(launchpad,'other') pad, COUNT(*) n FROM funnel
      GROUP BY pad ORDER BY n DESC LIMIT 6`).all(),
    ttlMinutes: { screen: TTL.screen / MIN, study: TTL.study / MIN, unseen: TTL.unseen / MIN },
  };
}

/** Test seam only — never called by the desk. */
export function _reset() { db.exec("DELETE FROM funnel"); }
