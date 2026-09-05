import db from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { canonicalAddress } from "./canonical.js";

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
 * Reported by PEAK as well as by last price, because the two answer different
 * questions: peak is what a take-profit rule would have caught, last is what holding
 * would have returned. This desk sells into strength, so peak is the honest measure of
 * what a refusal cost — and quoting only the last price would flatter the desk by
 * pretending it would have round-tripped every winner.
 */
export function scorecard({ sinceH = 168 } = {}) {
  const rows = db.prepare(
    "SELECT * FROM shadow WHERE checked_at IS NOT NULL AND refused_at > ?")
    .all(Date.now() - sinceH * 3600e3);
  if (!rows.length) return { graded: 0, note: "no refusals have been priced again yet" };

  const move = (r) => ((r.price_now - r.price_at) / r.price_at) * 100;
  const peak = (r) => ((r.peak_price - r.price_at) / r.price_at) * 100;
  const peaks = rows.map(peak);
  /* TWO BARS, because this desk exits in two places and one bar would lie about it.
   * Half the position comes off at the desk's target — call it +50% — long before the
   * 2x rule closes the rest. Grading only on 2x scored ZCAT's +98.8% as a miss by 1.2
   * points, when in truth half of it would have been banked and the remainder would
   * have trailed out well above entry. A scorecard that cannot see the money the
   * strategy actually takes is not measuring the strategy. */
  const wouldHaveBanked = peaks.filter((p) => p >= 50).length;
  const wouldHaveHit2x = peaks.filter((p) => p >= 100).length;
  const died = rows.filter((r) => move(r) <= -50).length;

  const byStage = {};
  for (const r of rows) {
    const k = r.stage;
    byStage[k] ??= { n: 0, banked: 0, hit2x: 0, died: 0 };
    byStage[k].n++;
    if (peak(r) >= 50) byStage[k].banked++;
    if (peak(r) >= 100) byStage[k].hit2x++;
    if (move(r) <= -50) byStage[k].died++;
  }

  return {
    graded: rows.length,
    wouldHaveBanked,
    bankedPct: Math.round((wouldHaveBanked / rows.length) * 100),
    wouldHaveHit2x,
    hit2xPct: Math.round((wouldHaveHit2x / rows.length) * 100),
    died,
    diedPct: Math.round((died / rows.length) * 100),
    medianPeakPct: Number(peaks.sort((a, b) => a - b)[Math.floor(peaks.length / 2)].toFixed(1)),
    byStage,
    /* The line that matters. A desk whose refusals mostly die is calibrated; one whose
     * refusals mostly double is expensive, and now says so in its own numbers. */
    verdict: wouldHaveBanked > died
      ? "REFUSALS ARE RUNNING — the bar is costing more than it saves"
      : died > wouldHaveBanked * 2
        ? "refusals are dying as intended — the bar is earning its keep"
        : "mixed — not enough separation to move the bar on",
  };
}
