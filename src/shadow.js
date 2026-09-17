import db from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { canonicalAddress } from "./canonical.js";
import { CLAIM_SAMPLE_FLOOR } from "./improvement-constants.js";
import { pricePolicy, POLICY_DEFAULTS } from "../executor/trade-policy.mjs";
import { expectedRoundTripPct, CHEAPEST_CLIP_ETH } from "../executor/live-thresholds.mjs";

/**
 * THE SHADOW BOOK — grading the desk on what it REFUSED.
 *
 * The desk has always been graded on its calls. It has published none, so it has never
 * been graded at all — and that is precisely the condition under which "we are being
 * appropriately careful" and "we are missing everything" look identical from the inside.
 *
 * ZCAT is why this exists. The owner hand-picked it, the desk refused it, and it went
 * +98.8% in the next few hours. One winner does not prove a refusal wrong — that is
 * outcome bias, and a desk that abandons a rule because one skipped coin ran will end
 * up with no rules at all. But a 100% refusal rate cannot be right either, and there is
 * no way to tell those apart by argument.
 *
 * So every refusal is written down with the price at the moment of refusal, and the
 * monitor that already walks open calls prices them again later. Then the question
 * stops being rhetorical: of the coins this desk turned down, how many doubled and how
 * many went to zero? A desk whose refusals mostly die is calibrated. A desk whose
 * refusals mostly run is expensive, and the size of the mistake is a number rather
 * than a feeling.
 *
 * This costs nothing to keep. The refusal already happened; recording it is one row.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS shadow (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  stage       TEXT NOT NULL,        -- screen | seat | mandate | compliance
  reason      TEXT,
  safety      INTEGER NOT NULL DEFAULT 1,
  price_at    REAL,
  mcap_at     REAL,
  refused_at  INTEGER NOT NULL,
  -- filled in later by the monitor
  price_now   REAL,
  peak_price  REAL,
  checked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shadow_mint ON shadow(mint, id DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_open ON shadow(refused_at DESC);
`);

/** Don't record the same coin's refusal twice in a short window — lanes overlap. */
const seenRecently = (mint, withinMs = 6 * 3600e3) =>
  !!db.prepare("SELECT 1 FROM shadow WHERE mint=? AND refused_at > ? LIMIT 1")
    .get(mint, Date.now() - withinMs);

/**
 * Record a refusal. Called wherever the desk says no and knows the price it said no at
 * — without that price the row is useless, so a refusal we cannot price is not stored.
 */
export function recordRefusal({ mint, symbol, stage, reason, safety = true, priceUsd, mcapUsd }) {
  mint = canonicalAddress(mint);
  if (!mint || !(priceUsd > 0)) return null;
  if (seenRecently(mint)) return null;
  db.prepare(`INSERT INTO shadow (mint,symbol,stage,reason,safety,price_at,mcap_at,refused_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(mint, symbol ?? null, stage, String(reason ?? "").slice(0, 200),
         safety ? 1 : 0, priceUsd, mcapUsd ?? null, Date.now());
  return true;
}

/** Coins refused recently enough to still be worth pricing again. */
export const openShadows = (maxAgeH = 48, limit = 40) =>
  db.prepare(`SELECT * FROM shadow WHERE refused_at > ?
              ORDER BY (checked_at IS NULL) DESC, refused_at DESC LIMIT ?`)
    .all(Date.now() - maxAgeH * 3600e3, limit);

export function markChecked(id, priceNow) {
  const row = db.prepare("SELECT price_at, peak_price FROM shadow WHERE id=?").get(id);
  if (!row) return;
  const peak = Math.max(row.peak_price ?? 0, priceNow ?? 0, row.price_at ?? 0);
  db.prepare("UPDATE shadow SET price_now=?, peak_price=?, checked_at=? WHERE id=?")
    .run(priceNow ?? null, peak, Date.now(), id);
}

/**
 * THE SCORECARD. What did the desk's refusals actually do?
 *
 * ── THREE THINGS THIS FUNCTION GOT WRONG, ALL IN THE SAME DIRECTION ─────────────────
 *
 * It is the only function in this repo capable of talking the desk into LOOSENING its
 * refusal bar. On a chain where 66.8% of wallets lose, that is how a selection desk
 * joins them, so its errors are not symmetric and none of them were caught by a test.
 *
 *   1. NO SAMPLE FLOOR. It returned "REFUSALS ARE RUNNING — the bar is costing more than
 *      it saves" with no minimum n, and penthouse.js emitted that at graded >= FIVE, in
 *      a repo that requires a hundred settled trades before it will claim an edge
 *      (src/perf.js edgeClaimable). Five coins is not evidence; it is a coin flip with a
 *      recommendation attached. It now reads CLAIM_SAMPLE_FLOOR — the same number — and
 *      reports a SHORTFALL ("41 of 100 graded") rather than a projection.
 *
 *   2. IT COMPARED PEAK AGAINST LAST. `wouldHaveBanked` counted rows whose PEAK cleared
 *      +50%; `died` counted rows whose LAST price was under -50%; and then the verdict
 *      compared the two counts. A coin that spiked 60% and went to zero scored in BOTH,
 *      and since a peak is far easier to clear than a terminal collapse, the comparison
 *      leaned toward "refusals are running" by construction. Peak and last are now
 *      reported SIDE BY SIDE and never differenced.
 *
 *   3. THE +50% BAR WAS MONEY THIS DESK CANNOT TAKE. It was justified as "half the
 *      position comes off at the desk's target" — but this executor has NO partial exit:
 *      trade-policy.mjs closes in full, and strategy.mjs sets scaleOutPct 0 with "never
 *      emits sell_part". So the headline number counted profit from a scale-out that
 *      does not exist. It is replaced by `wouldHavePaidUnderPolicy`, which runs the
 *      recorded prices through pricePolicy — the SAME function the executor and the desk
 *      record share byte-for-byte — and nets this chain's own round trip off the result.
 *
 * WHAT IS STILL WEAK, SAID RATHER THAN HIDDEN: the table stores three prices, not a
 * series. `peak_price` is a SPARSE POLL MAXIMUM — markChecked only updates it when the
 * monitor happens to look, at most a dozen rows a pass — so it is a lower bound on the
 * true peak and the replay below sees a three-point path, not the path. It is named
 * peakSeenAtPoll now so nothing reads it as the real high.
 */
export function scorecard({ sinceH = 168, floor = CLAIM_SAMPLE_FLOOR } = {}) {
  const rows = db.prepare(
    "SELECT * FROM shadow WHERE checked_at IS NOT NULL AND refused_at > ?")
    .all(Date.now() - sinceH * 3600e3);
  if (!rows.length) return {
    graded: 0, floor, floorsFrom: "src/improvement-constants.js CLAIM_SAMPLE_FLOOR",
    verdictClaimable: false, why: `0 of ${floor} graded — no verdict`,
    note: "no refusals have been priced again yet",
  };

  const move = (r) => ((r.price_now - r.price_at) / r.price_at) * 100;
  const peak = (r) => ((r.peak_price - r.price_at) / r.price_at) * 100;
  const peaks = rows.map(peak);

  /* THE POLICY THAT ACTUALLY RUNS, REPLAYED. Three points is all the table has: the
     price at refusal, the sparse poll peak, and the last price. Walking them through
     pricePolicy in order gives the policy its chance to arm breakeven (1.35x), arm the
     25% trail (1.5x) and take profit (2x) before the last price arrives — which is the
     whole difference between "it peaked above a bar" and "this desk would have banked
     it". Friction is charged once, from this chain's own curve. */
  const FRICTION = expectedRoundTripPct(CHEAPEST_CLIP_ETH) / 100;
  const replay = (r) => {
    const entry = Number(r.price_at);
    if (!(entry > 0)) return null;
    const high = Number(r.peak_price) > 0 ? Number(r.peak_price) : entry;
    const last = Number(r.price_now) > 0 ? Number(r.price_now) : entry;
    let position = {
      entry, high: 0, pendingHigh: 0, stop: entry * 0.75, target: null,
      openedAtMs: null, holdMaxMs: null,
    };
    const cfg = { ...POLICY_DEFAULTS, honorDeskTarget: false };
    /* The peak is offered TWICE because pricePolicy commits a new high only on a second
       witness — a real run printed it more than once, and a sparse poll that saw it at
       all is evidence of exactly that. Then the last price arrives. */
    for (const mark of [high, high, last]) {
      const d = pricePolicy({ position, mark, nowMs: 0, config: cfg });
      position = d.position;
      if (d.action === "sell") return (mark / entry) * (1 - FRICTION) - 1;
    }
    return (last / entry) * (1 - FRICTION) - 1;
  };
  const paid = rows.map(replay).filter((x) => x != null);
  const wouldHavePaidUnderPolicy = paid.filter((x) => x > 0).length;
  const medianPaidPct = paid.length
    ? Number([...paid].sort((a, b) => a - b)[Math.floor(paid.length / 2)].toFixed(4)) * 100 : null;

  /* PEAK AND LAST, SIDE BY SIDE, NEVER DIFFERENCED. */
  const peakedOver2x = peaks.filter((p) => p >= 100).length;
  const peakedOver50 = peaks.filter((p) => p >= 50).length;
  const diedOnLast = rows.filter((r) => move(r) <= -50).length;

  const byStage = {};
  for (const r of rows) {
    const k = r.stage;
    byStage[k] ??= { n: 0, peakedOver50: 0, peakedOver2x: 0, diedOnLast: 0 };
    byStage[k].n++;
    if (peak(r) >= 50) byStage[k].peakedOver50++;
    if (peak(r) >= 100) byStage[k].peakedOver2x++;
    if (move(r) <= -50) byStage[k].diedOnLast++;
  }

  const graded = rows.length;
  const claimable = graded >= floor;
  const pct = (n) => Math.round((n / graded) * 100);
  return {
    graded,
    floor,
    floorsFrom: "src/improvement-constants.js CLAIM_SAMPLE_FLOOR",
    pollCount: rows.filter((r) => r.checked_at != null).length,

    /* The headline: what this desk's own policy would have realised, net of friction. */
    wouldHavePaidUnderPolicy,
    paidPct: pct(wouldHavePaidUnderPolicy),
    medianPaidPct,
    frictionPct: Number((FRICTION * 100).toFixed(2)),

    /* The two raw columns, reported but never compared. */
    peakSeenAtPoll: { over50: peakedOver50, over2x: peakedOver2x,
      over50Pct: pct(peakedOver50), over2xPct: pct(peakedOver2x),
      medianPct: Number(peaks.slice().sort((a, b) => a - b)[Math.floor(peaks.length / 2)].toFixed(1)),
      note: "a SPARSE POLL maximum — a lower bound on the true high, not the high" },
    last: { died: diedOnLast, diedPct: pct(diedOnLast),
      note: "terminal price at the last poll" },

    byStage,

    /* THE VERDICT IS A CLAIM, SO IT OBEYS THE CLAIM FLOOR. Below it there is no verdict
     * at all — not a weaker one — and the shortfall is reported rather than a
     * projection of what the number might become. */
    verdictClaimable: claimable,
    why: claimable
      ? (wouldHavePaidUnderPolicy > diedOnLast
        ? "REFUSALS WOULD HAVE PAID under this desk's own policy — the bar is costing more than it saves"
        : diedOnLast > wouldHavePaidUnderPolicy * 2
          ? "refusals are dying as intended — the bar is earning its keep"
          : "mixed — not enough separation to move the bar on")
      : `${graded} of ${floor} graded — no verdict`,
  };
}

