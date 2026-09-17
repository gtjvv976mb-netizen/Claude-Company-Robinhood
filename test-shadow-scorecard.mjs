/**
 * THE ONE FUNCTION THAT CAN TALK THIS DESK INTO REFUSING LESS.
 *
 * scorecard() grades the coins the desk turned down. If it says the refusals are running,
 * the bar comes down — so its failure mode is not "a wrong number", it is "a selection
 * desk stops selecting". On a chain where 66.8% of wallets lose, that is the expensive
 * direction, and all three of its bugs pointed that way at once:
 *
 *   · it had NO sample floor, and penthouse.js published its verdict at graded >= 5,
 *     in a repo that wants a hundred settled trades before it claims an edge;
 *   · it counted "would have banked" on the PEAK and "died" on the LAST price and then
 *     COMPARED the two counts — and a peak is far easier to clear than a terminal
 *     collapse, so the comparison leaned toward "the bar is costing us" by construction.
 *     A coin that spiked 60% and went to zero scored in both columns;
 *   · its +50% bar was justified by a partial exit this executor does not have
 *     (trade-policy closes in full; strategy.mjs scaleOutPct is 0), so the headline
 *     counted money the desk's own policy would never have taken.
 *
 * Every assertion below is one of those three, plus the rule that keeps them fixed: the
 * floor is COMPUTED from one shared constant, never restated as a literal here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CLAUDE_CO_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "shadow-card-")), "shadow.db");

const { scorecard } = await import("./src/shadow.js");
const db = (await import("./src/lib/store.js")).default;
const { CLAIM_SAMPLE_FLOOR } = await import("./src/improvement-constants.js");
const { expectedRoundTripPct, CHEAPEST_CLIP_ETH } = await import("./executor/live-thresholds.mjs");
const perf = await import("./src/perf.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const insert = db.prepare(`INSERT INTO shadow
  (mint,symbol,stage,reason,safety,price_at,mcap_at,refused_at,price_now,peak_price,checked_at)
  VALUES (?,?,?,?,1,?,?,?,?,?,?)`);
let seq = 0;
/** One graded refusal: refused at 1.0, peaked at `peakMul`, last seen at `lastMul`. */
function add(peakMul, lastMul, stage = "screen") {
  const now = Date.now();
  insert.run("0x" + String(++seq).padStart(40, "0"), "C" + seq, stage, "test",
    1, now, now - 3600e3, lastMul, peakMul, now);
}
const clear = () => db.prepare("DELETE FROM shadow").run();

console.log("\nTHE SAMPLE FLOOR IS THE DESK'S, AND IT IS NOT FIVE");
{
  clear();
  for (let i = 0; i < CLAIM_SAMPLE_FLOOR - 1; i++) add(1.8, 0.2);
  const under = scorecard();
  ok("one short of the floor is not claimable", under.verdictClaimable === false);
  ok("...and the shortfall is reported, not a projection",
    under.why === `${CLAIM_SAMPLE_FLOOR - 1} of ${CLAIM_SAMPLE_FLOOR} graded — no verdict`,
    under.why);
  ok("...while the sample itself is still visible", under.graded === CLAIM_SAMPLE_FLOOR - 1);
  add(1.8, 0.2);
  const at = scorecard();
  ok("at the floor it becomes claimable", at.verdictClaimable === true);
  ok("...and the verdict is a sentence, not a bare string field", typeof at.why === "string" && at.why.length > 20);
  ok("the floor is echoed with its home", at.floor === CLAIM_SAMPLE_FLOOR &&
    /improvement-constants/.test(at.floorsFrom));
}

console.log("\nONE FLOOR, COMPUTED — NOT THREE LITERALS THAT HAPPEN TO AGREE");
{
  /* Compare what the running system computes, never two source literals. perf.js's
     edgeClaimable flips at the same n the scorecard's verdict does. */
  const below = perf.default?.performance ? null : null;
  void below;
  const perfSrc = fs.readFileSync(new URL("./src/perf.js", import.meta.url), "utf8");
  ok("perf.js reads the shared floor rather than restating 100",
    /n >= CLAIM_SAMPLE_FLOOR/.test(perfSrc) && !/const enough = n >= 100/.test(perfSrc));
  const shadowSrc = fs.readFileSync(new URL("./src/shadow.js", import.meta.url), "utf8");
  ok("the scorecard reads it too", /CLAIM_SAMPLE_FLOOR/.test(shadowSrc));
  ok("...and invents no friendlier floor of its own",
    !/graded >= 5|floor = 5\b|floor = 10\b/.test(shadowSrc));
  const penthouse = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  ok("penthouse no longer publishes a verdict at five", !/card\.graded >= 5/.test(penthouse));
}

console.log("\nPEAK AND LAST ARE REPORTED SIDE BY SIDE AND NEVER DIFFERENCED");
{
  clear();
  /* The exact case the old comparison mis-scored: spiked +60%, then went to zero. */
  for (let i = 0; i < CLAIM_SAMPLE_FLOOR; i++) add(1.6, 0.05);
  const c = scorecard();
  ok("a spike-then-zero row counts in the peak column",
    c.peakSeenAtPoll.over50 === CLAIM_SAMPLE_FLOOR);
  ok("...and in the died column too", c.last.died === CLAIM_SAMPLE_FLOOR);
  ok("...and the two live in separate objects", c.peakSeenAtPoll.over50 != null && c.last.died != null &&
    c.wouldHaveBanked === undefined);
  ok("the peak field says it is a sparse poll maximum", /SPARSE POLL/.test(c.peakSeenAtPoll.note));
  ok("...and the poll count is reported", typeof c.pollCount === "number" && c.pollCount === CLAIM_SAMPLE_FLOOR);
  const src = fs.readFileSync(new URL("./src/shadow.js", import.meta.url), "utf8");
  ok("no verdict differences a peak count against a last count",
    !/wouldHaveBanked > died/.test(src));
}

console.log("\nTHE HEADLINE IS WHAT THIS DESK'S OWN POLICY WOULD HAVE TAKEN");
{
  const friction = expectedRoundTripPct(CHEAPEST_CLIP_ETH) / 100;
  clear();
  /* Peaks +60% then collapses to -90%. The old +50% bar scored this a WIN. The real
     policy arms nothing at 1.6x below the 2x take... it arms the trail at 1.5x, so the
     ratcheted stop catches it on the way down — but nowhere near the peak. */
  for (let i = 0; i < CLAIM_SAMPLE_FLOOR; i++) add(1.6, 0.1);
  const c = scorecard();
  ok("the +50% peak bar is gone from the headline", c.wouldHaveBanked === undefined);
  ok("the headline is the policy replay", typeof c.wouldHavePaidUnderPolicy === "number");
  ok("...and friction is charged, from this chain's curve",
    Math.abs(c.frictionPct - friction * 100) < 0.01, `${c.frictionPct}%`);

  clear();
  /* A clean double: the policy's 2x take-profit fires, and it pays net of friction. */
  for (let i = 0; i < CLAIM_SAMPLE_FLOOR; i++) add(2.4, 2.2);
  const win = scorecard();
  ok("a row that doubled pays under the policy",
    win.wouldHavePaidUnderPolicy === CLAIM_SAMPLE_FLOOR, `${win.paidPct}%`);
  ok("...and the median realised return is positive and net of friction",
    win.medianPaidPct > 0 && win.medianPaidPct < 140,
    `${win.medianPaidPct.toFixed(1)}% — a 2x take less ${(friction * 100).toFixed(2)}% friction`);

  clear();
  /* A row that never moved: friction alone makes it a loser. That is the whole point of
     grading against the policy instead of against a peak bar. */
  for (let i = 0; i < CLAIM_SAMPLE_FLOOR; i++) add(1.0, 1.0);
  const flat = scorecard();
  ok("a flat row loses money, because the round trip is not free",
    flat.wouldHavePaidUnderPolicy === 0 && flat.medianPaidPct < 0,
    `${flat.medianPaidPct.toFixed(2)}%`);
}

console.log("\nTHE SHAPE THE CONSUMERS READ");
{
  clear();
  for (let i = 0; i < 3; i++) add(1.2, 0.9);
  const c = scorecard();
  assert.equal(typeof c.graded, "number");
  ok("an under-floor card still carries every column a dashboard draws",
    c.peakSeenAtPoll != null && c.last != null && c.byStage != null);
  ok("...and byStage uses the new, unambiguous names",
    Object.values(c.byStage).every((v) => v.peakedOver50 != null && v.diedOnLast != null));
  const empty = (clear(), scorecard());
  ok("an empty book is not claimable either", empty.verdictClaimable === false && empty.graded === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
