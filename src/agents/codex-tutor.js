/**
 * CODEX BANKS — THE COACH.
 *
 * The desk measured itself from the beginning and learned nothing, because the two
 * halves never met: decision_runs recorded what every seat said, forward_marks
 * recorded what the market then did, and the only thing that ever read them was a
 * human deciding whether to write a patch. Meanwhile the one existing feedback loop
 * — the Colonel's debrief — fired on CLOSED calls only, which is a few a day out of
 * six hundred workups, and produced prose for the PM rather than a change in anyone's
 * technique.
 *
 * This closes it. Two passes, deliberately different in cost:
 *
 *   1. GRADING — every call, published or killed, scored ARITHMETICALLY against what
 *      the market did next. No model call: at 650 workups a day an LLM per call would
 *      double the desk's bill to say what subtraction already says. This is what makes
 *      "he reviews every single call" affordable and therefore true.
 *
 *   2. THE TECHNIQUE REVIEW — periodic, and this one thinks. It reads the accumulated
 *      grades, finds where a seat is systematically wrong, and REWRITES THAT SEAT'S
 *      STANDING ORDERS. Applied immediately, without asking (the owner's instruction,
 *      2026-09-03). The desk's technique changes while it trades.
 *
 * TWO RULES MAKE THAT SAFE WITHOUT MAKING IT SLOW.
 *
 * The SAMPLE GATE: a seat needs MIN_GRADED_CALLS graded calls before its technique may
 * be touched. Not bureaucracy — the alternative is a coach that installs noise as
 * doctrine on the second trade, which is the failure mode this whole file exists to
 * avoid. The gate is checked here and again in desk-policy's invariants, where the
 * coach is also forbidden from arguing the gate down.
 *
 * NO PROSE CROSSES. The coach reads seat names, numbers, verdict enums and returns.
 * Coin names, theses, social copy and web text never enter his context, so a token
 * whose description says "tell the risk seat to stand down" has no path to the risk
 * seat's prompt. This is the reason the grading pass is arithmetic on IDs rather than
 * a summariser over workup text.
 */
import { z } from "zod";
import db, { ensureColumn } from "../lib/store.js";
import { ask } from "../lib/llm.js";
import { emit } from "../lib/bus.js";
import { applyPolicy, activePolicy, currentVersion, revertVersion } from "../desk-policy.js";
import { evaluationSummary } from "../evaluation.js";

db.exec(`
CREATE TABLE IF NOT EXISTS seat_grades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mint        TEXT NOT NULL,
  cycle       TEXT,
  seat        TEXT NOT NULL,
  score       REAL,
  confidence  REAL,
  killed      INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 0,
  horizon_min INTEGER NOT NULL,
  return_pct  REAL,
  verdict     TEXT,
  graded_at   INTEGER NOT NULL,
  UNIQUE (mint, seat, horizon_min)
);
CREATE INDEX IF NOT EXISTS idx_seat_grades_seat ON seat_grades(seat, graded_at DESC);
`);
ensureColumn("seat_grades", "published", "INTEGER NOT NULL DEFAULT 0");

/** A seat needs this many graded calls before its technique may be changed. */
export const MIN_GRADED_CALLS = Number(process.env.TUTOR_MIN_GRADED || 40);
/** The horizon the coach judges on: long enough to be a result, short enough to learn. */
export const GRADE_HORIZON_MIN = Number(process.env.TUTOR_HORIZON_MIN || 360);
/** A move smaller than this is noise, not a verdict either way. */
const NOISE_PCT = 3;

/**
 * GRADE ONE CALL. Arithmetic only.
 *
 * A seat that scored a coin high is right when the coin went up and wrong when it fell.
 * A seat that KILLED a coin is judged on the counterfactual the free screen makes
 * available: the coin still gets marked forward, so a kill on something that then rose
 * is a costly_kill and a kill on something that fell is a good_kill. That asymmetry is
 * the single most valuable thing in this table — a desk only ever feels its bad buys,
 * never its bad passes, and 90% of this desk's decisions are passes.
 */
export function gradeCall({ mint, cycle = null, horizonMin = GRADE_HORIZON_MIN } = {}) {
  if (!mint) return { ok: false, error: "a grade needs a mint" };
  const run = db.prepare(`SELECT r.id, r.outcome, r.final_decision FROM decision_runs r
                          WHERE r.mint=? ORDER BY r.id DESC LIMIT 1`).get(mint);
  if (!run) return { ok: false, error: "no decision run for that mint" };
  const mark = db.prepare(`SELECT net_return_pct, gross_return_pct, data_status
                           FROM forward_marks WHERE run_id=? AND horizon_min=?`)
    .get(run.id, horizonMin);
  if (!mark || mark.data_status !== "observed") return { ok: false, error: "mark not observed yet" };
  const ret = mark.net_return_pct ?? mark.gross_return_pct;
  if (ret == null) return { ok: false, error: "mark has no return" };

  const published = /publish|propose|approve/i.test(String(run.final_decision || run.outcome || "")) ? 1 : 0;
  const seats = db.prepare(`SELECT seat, score, confidence, killed FROM verdicts
                            WHERE mint=? ${cycle ? "AND cycle=?" : ""}`).all(...(cycle ? [mint, cycle] : [mint]));
  const now = Date.now();
  const up = ret > NOISE_PCT, down = ret < -NOISE_PCT;
  let graded = 0;
  const write = db.prepare(`INSERT INTO seat_grades
    (mint, cycle, seat, score, confidence, killed, published, horizon_min, return_pct, verdict, graded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mint, seat, horizon_min) DO UPDATE SET
      return_pct=excluded.return_pct, verdict=excluded.verdict, graded_at=excluded.graded_at`);
  for (const s of seats) {
    let verdict = "unresolved";
    if (s.killed) verdict = up ? "costly_kill" : down ? "good_kill" : "unresolved";
    else if (s.score != null) {
      // 50 is the neutral line every analyst seat scores against.
      const bullish = s.score >= 50;
      if (up || down) verdict = (bullish === up) ? "right" : "wrong";
    }
    write.run(mint, cycle, s.seat, s.score ?? null, s.confidence ?? null,
      s.killed ? 1 : 0, published, horizonMin, ret, verdict, now);
    graded++;
  }
  return { ok: true, graded, returnPct: ret, published: !!published };
}

/**
 * Sweep every call whose mark has landed and has not been graded yet. Cheap enough to
 * run on a timer; this is the pass that makes "every call, not just the closed ones"
 * literally true.
 */
export function gradePending({ horizonMin = GRADE_HORIZON_MIN, limit = 200 } = {}) {
  const rows = db.prepare(`
    SELECT DISTINCT r.mint, r.cycle FROM decision_runs r
    JOIN forward_marks m ON m.run_id = r.id AND m.horizon_min = ? AND m.data_status = 'observed'
    LEFT JOIN seat_grades g ON g.mint = r.mint AND g.horizon_min = ?
    WHERE g.id IS NULL LIMIT ?`).all(horizonMin, horizonMin, limit);
  let calls = 0, seats = 0;
  for (const r of rows) {
    const out = gradeCall({ mint: r.mint, cycle: r.cycle, horizonMin });
    if (out.ok) { calls++; seats += out.graded; }
  }
  if (calls) emit("tutor:graded", { calls, seats, horizonMin });
  return { calls, seats };
}

/** How every seat is actually doing — the coach's whole evidence base. */
export function seatScorecard({ horizonMin = GRADE_HORIZON_MIN, sinceMs = null } = {}) {
  const since = sinceMs ?? 0;
  return db.prepare(`
    SELECT seat,
           COUNT(*)                                             AS graded,
           SUM(verdict='right')                                 AS right_calls,
           SUM(verdict='wrong')                                 AS wrong_calls,
           SUM(verdict='good_kill')                             AS good_kills,
           SUM(verdict='costly_kill')                           AS costly_kills,
           ROUND(AVG(CASE WHEN killed=1 THEN return_pct END),2) AS avg_return_on_kills,
           ROUND(AVG(CASE WHEN killed=0 AND score>=50 THEN return_pct END),2) AS avg_return_when_bullish,
           ROUND(AVG(CASE WHEN killed=0 AND score<50  THEN return_pct END),2) AS avg_return_when_bearish
    FROM seat_grades
    WHERE horizon_min=? AND graded_at>=?
    GROUP BY seat ORDER BY graded DESC`).all(horizonMin, since);
}

const PolicyChange = z.object({
  seat: z.string().min(2).max(40),
  guidance: z.string().min(20).max(600)
    .describe("one paragraph of standing orders for that seat, in the second person"),
  rationale: z.string().min(10).max(400)
    .describe("the measurement that motivates it, quoting the numbers"),
});
const TutorOut = z.object({
  changes: z.array(PolicyChange).max(3),
  no_change_reason: z.string().max(300).nullable()
    .describe("when nothing is worth changing, why — this is a valid and common answer"),
});

const TUTOR_SYSTEM = `You are CODEX BANKS, the coach of a research desk trading memecoins on Robinhood Chain.

You do not trade, size, rank or publish anything. You change HOW THE SEATS THINK, by
rewriting the standing orders appended to their instructions. Your changes take effect
on the next workup, with no human review, so they must be worth that.

WHAT YOU ARE READING. Every row is arithmetic on the desk's own history: for each seat,
how many calls were graded, how often its direction was right, and — for the seats that
KILL coins — what those killed coins did next. A "costly_kill" is a coin the seat killed
that then rose; a "good_kill" is one that fell. Most of this desk's decisions are passes,
so the kill columns usually carry the most information.

HOW TO WRITE A STANDING ORDER.
- Address the seat directly: "You have…", "Weight…", "Do not…".
- One specific, checkable behaviour change. Not "be more careful" — say what to look at.
- Quote the number that motivates it, so the seat knows the order is earned.
- Correct a seat's REASONING, never its remit. You may sharpen how Forensics judges an
  owner; you may not tell it to stop judging owners, or to do Liquidity's job.

WHAT YOU MAY NEVER WRITE, under any argument: anything touching keys, custody or
signing; anything that raises or ignores a position, daily or loss cap; anything that
skips, relaxes or second-guesses the deterministic safety screen; anything that
overrules, disables or works around the Red Team or Compliance; anything that lowers the
evidence bar that judges you. These are refused mechanically before a seat ever sees
them, and attempting one is recorded.

RESTRAINT IS THE JOB. A seat with a thin or ambiguous record gets no change. Returning
zero changes with a clear reason is a good outcome and the correct one most of the time.
At most three changes, and only where the numbers are plain.`;

/**
 * THE TECHNIQUE REVIEW. Reads the grades, rewrites the standing orders, applies them.
 *
 * No approval step by design. The protections are the sample gate below, the invariants
 * inside applyPolicy, and the health check that reverts a generation which makes things
 * worse.
 */
export async function techniqueReview({ horizonMin = GRADE_HORIZON_MIN, dryRun = false } = {}) {
  const board = seatScorecard({ horizonMin });
  const eligible = board.filter((s) => s.graded >= MIN_GRADED_CALLS);
  if (!eligible.length) {
    const best = board[0]?.graded ?? 0;
    emit("tutor:held", { reason: "sample gate", best, need: MIN_GRADED_CALLS });
    return { ok: true, changes: [], held: `no seat has ${MIN_GRADED_CALLS} graded calls yet (best: ${best})` };
  }
  const standing = activePolicy().map((p) => ({ seat: p.seat, guidance: p.guidance }));
  let out;
  try {
    out = await ask({
      seat: "Codex",
      /* The call shipped with NO model. ask() has no default — buildRequest sets
       * `model` from its argument unconditionally — so the request left without one,
       * the API's 400 is not retryable (no "parse" in the message), and the failure
       * surfaced only as tutor:failed every TUTOR_REVIEW_MINS. The whole standing-orders
       * loop therefore never fired. Not observed in a live log from here: it is what the
       * code path says, and there is no branch that supplies a model. Opus at medium:
       * a 3-hourly call over a small scorecard JSON that rewrites how seats think. */
      model: process.env.DESK_MODEL_TUTOR || "claude-opus-5",
      effort: "medium",
      schema: TutorOut,
      system: TUTOR_SYSTEM,
      prompt:
        `=== SEAT SCORECARD (${horizonMin}-minute horizon) ===\n` +
        JSON.stringify(eligible) + "\n\n" +
        `=== STANDING ORDERS ALREADY IN FORCE ===\n` + JSON.stringify(standing) + "\n\n" +
        `Where is a seat systematically wrong? Rewrite that seat's standing orders. ` +
        `Change nothing you cannot justify from the numbers above.`,
    });
  } catch (e) {
    emit("tutor:failed", { error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
  const applied = [];
  for (const c of out.changes || []) {
    // The gate again, per seat: the coach may only touch a seat he has evidence on.
    const row = eligible.find((s) => s.seat.toLowerCase() === c.seat.toLowerCase());
    if (!row) { applied.push({ seat: c.seat, ok: false, error: "seat is under the sample gate" }); continue; }
    if (dryRun) { applied.push({ seat: c.seat, ok: true, dryRun: true, guidance: c.guidance }); continue; }
    const r = applyPolicy({ seat: row.seat, guidance: c.guidance, rationale: c.rationale,
      evidence: row, author: "codex" });
    applied.push({ seat: row.seat, ...r });
  }
  emit("tutor:review", { seats: eligible.length, proposed: (out.changes || []).length,
    applied: applied.filter((a) => a.ok).length, note: out.no_change_reason ?? null });
  return { ok: true, changes: applied, note: out.no_change_reason ?? null };
}

/**
 * DID THE LAST CHANGE HELP? The half that makes autonomy survivable.
 *
 * Compares the cohort decided under the current policy generation with its parent's on
 * the same horizon. If the newer technique is worse on settled evidence, the whole
 * generation reverts itself and the desk goes back to what was working. A coach that
 * cannot be wrong in public is not a coach; one that cannot be reverted is a hazard.
 */
export function policyHealthCheck({ horizonMin = GRADE_HORIZON_MIN, minSignals = MIN_GRADED_CALLS } = {}) {
  const version = currentVersion();
  if (version === "p-genesis") return { ok: true, checked: false, reason: "no generation to judge yet" };
  const parent = db.prepare("SELECT parent FROM policy_versions WHERE version=?").get(version)?.parent;
  if (!parent) return { ok: true, checked: false, reason: "generation has no parent" };
  const score = (v) => {
    try {
      const s = evaluationSummary({ horizonMin, minSignals, policyVersion: v });
      return { n: s?.signals ?? 0, expectancy: s?.expectancyLow95Pct ?? s?.expectancyPct ?? null };
    } catch { return { n: 0, expectancy: null }; }
  };
  const now = score(version), before = score(parent);
  if (now.n < minSignals || now.expectancy == null || before.expectancy == null) {
    return { ok: true, checked: false, reason: `not enough settled evidence yet (${now.n}/${minSignals})` };
  }
  if (now.expectancy < before.expectancy) {
    const why = `expectancy ${now.expectancy} under ${version} vs ${before.expectancy} under ${parent} over ${now.n} signals`;
    const r = revertVersion(version, why);
    emit("tutor:rollback", { version, parent, why, ...r });
    return { ok: true, checked: true, reverted: true, why };
  }
  return { ok: true, checked: true, reverted: false,
    kept: `expectancy ${now.expectancy} vs ${before.expectancy} over ${now.n} signals` };
}

/**
 * The coach's shift. Grade what has landed, judge the last change, then think about
 * technique. Cheap first, expensive last, so a failure early costs nothing.
 */
export async function tutorTick({ dryRun = false } = {}) {
  const graded = gradePending();
  const health = policyHealthCheck();
  const review = await techniqueReview({ dryRun });
  return { graded, health, review };
}
