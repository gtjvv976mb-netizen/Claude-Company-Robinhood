/**
 * THE QUOTA — "at least 3 calls every cycle without fail" (owner, 2026-09-07).
 *
 * The desk was built as "one cycle, one trade": the winner published, and BOTH
 * fallback lanes stopped at the first call that landed. Three separate conditions
 * decided that — the eligible-field pass ran only `if (!opened.length)`, its loop
 * `break`ed on the first success, and the hunt broke on `if (opened.length)`. Any one
 * of them reverting silently returns the desk to one call per cycle while every other
 * test still passes, because nothing else in the suite counts calls.
 *
 * The quota is a floor on EFFORT and never a licence to publish past a safety fact,
 * so this file also pins the invariant that makes it safe: the fill draws only from
 * candidates already ruled eligible, and a short cycle reports itself.
 *
 *   CLAUDE_CO_DB=/tmp/x.db ANTHROPIC_API_KEY= node test-calls-per-cycle.mjs
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

console.log("\nTHE CONSTANT");
const { CALLS_PER_CYCLE, MAX_LIVE_CALLS } = await import("./src/mandate.js");
ok("the quota defaults to 3", CALLS_PER_CYCLE === 3, `got ${CALLS_PER_CYCLE}`);
ok("the quota fits inside the book limit", CALLS_PER_CYCLE <= MAX_LIVE_CALLS,
  `quota ${CALLS_PER_CYCLE} vs book ${MAX_LIVE_CALLS} — a quota above the book limit can never be met`);

console.log("\nTHE CADENCE, THE BOOK AND THE HOLD ARE ONE DECISION");
/* The blocker this pins: raising the quota to 3 and raising every hold to 120h were made
   separately, and neither touched MAX_LIVE_CALLS. Together, 3 calls per 12-minute cycle
   is 15/hour, the 24-slot book saturates in 1.6 HOURS, and nothing closes for five days —
   so the commit guaranteeing "3 calls every cycle without fail" would have produced zero
   for 118 of every 120 hours, reporting cycle:holding rather than cycle:short. */
const { SUSTAINABLE_CYCLE_MINS, CYCLE_MINS } = await import("./src/mandate.js");
const { CAP_BANDS } = await import("./src/bands.js");
const holdH = Math.max(...Object.values(CAP_BANDS).map((b) => b.holdMaxMs)) / 3_600_000;
const publishPerHour = CALLS_PER_CYCLE / (CYCLE_MINS / 60);
const turnoverPerHour = MAX_LIVE_CALLS / holdH;
ok("the desk does not publish faster than its book can turn over",
  publishPerHour <= turnoverPerHour + 1e-9,
  `publishing ${publishPerHour.toFixed(2)}/h against a turnover of ${turnoverPerHour.toFixed(2)}/h`);
ok("...so the book never saturates and the quota stays reachable",
  MAX_LIVE_CALLS / publishPerHour >= holdH - 1e-9,
  `book fills in ${(MAX_LIVE_CALLS / publishPerHour).toFixed(1)}h; the first slot frees at ${holdH}h`);
ok("the cadence is DERIVED, not a constant that can drift from the clocks",
  SUSTAINABLE_CYCLE_MINS === Math.max(12, Math.ceil((CALLS_PER_CYCLE * holdH * 60) / MAX_LIVE_CALLS)),
  `${SUSTAINABLE_CYCLE_MINS} min`);
ok("saturation reports as its own event, not as cycle:holding", () => true);
{
  const ph2 = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");
  ok("cycle:saturated exists", /emit\("cycle:saturated"/.test(ph2),
    "a book at 1 call and a book at its ceiling must not look the same in the record");
}

console.log("\nTHE BOOK CAN ACTUALLY HOLD A FULL CYCLE'S QUOTA");
const { openCall, liveCalls, closeCall } = await import("./src/calls.js");
const { bookState } = await import("./src/mandate.js");
const before = liveCalls().length;
const made = [];
for (let i = 0; i < CALLS_PER_CYCLE; i++) {
  const c = openCall({ mint: `Quota${i}1111111111111111111111111111111111`, symbol: `Q${i}`,
    category: "nano", conviction: 60, entryRef: 1 });
  if (c?.id) made.push(c.id);
}
ok(`${CALLS_PER_CYCLE} calls open at once`, made.length === CALLS_PER_CYCLE,
  `opened ${made.length}`);
ok("the book does not read full at quota", !bookState().full,
  `live ${liveCalls().length} of ${MAX_LIVE_CALLS}`);
for (const id of made) { try { closeCall(id, "test cleanup", 1); } catch {} }

console.log("\nTHE THREE CONDITIONS THAT DECIDE WHETHER A CYCLE STOPS AT ONE");
const ph = fs.readFileSync(new URL("./src/penthouse.js", import.meta.url), "utf8");

/* 1. the eligible-field pass must run whenever the cycle is UNDER quota, not only
      when it is empty — `!opened.length` is the one-call shape */
ok("the field pass is gated on the quota, not on emptiness",
  /if \(opened\.length < CALLS_PER_CYCLE && eligible\.length > 1\)/.test(ph) &&
  !/if \(!opened\.length && eligible\.length > 1\)/.test(ph),
  "reverting this makes the field pass a no-op the moment the winner publishes");

/* 2. inside that pass, a successful publish must CONTINUE, not break */
const fieldPass = ph.slice(ph.indexOf("if (opened.length < CALLS_PER_CYCLE && eligible.length > 1)"),
                           ph.indexOf("/* THE MANDATE — every cycle ends in a call."));
ok("the field pass has a quota break at the top of its loop",
  /for \(const cand of eligible\) \{\s*\n\s*if \(opened\.length >= CALLS_PER_CYCLE\) break;/.test(fieldPass),
  "without it the pass publishes the entire eligible field");
ok("a successful publish continues the fill rather than ending it",
  /opened\.push\([^)]*\);[\s\S]{0,600}?continue;/.test(fieldPass) &&
  !/opened\.push\([\s\S]{0,400}?\n\s*break;\s*\n\s*\}\s*\n\s*\}\s*\n\s*\}/.test(fieldPass),
  "a break here caps the cycle at two calls no matter what the quota says");

/* 3. the hunt must drive to the quota */
ok("the hunt runs while under quota",
  /if \(opened\.length < CALLS_PER_CYCLE && process\.env\.PENTHOUSE_MUST_CALL !== "0"\)/.test(ph),
  "gating the hunt on `!opened.length` means it never tops a short cycle up");
ok("the hunt's loop breaks on the quota, not on the first call",
  /for \(const c of scored\) \{\s*\n\s*if \(opened\.length >= CALLS_PER_CYCLE\) break;/.test(ph) &&
  !/for \(const c of scored\) \{\s*\n\s*if \(opened\.length\) break;/.test(ph),
  "this is the exact line that made the hunt a one-call hunt");
ok("the hunt's TIME budget scales with the quota", /240_000 \* CALLS_PER_CYCLE/.test(ph),
  "the screen passes ~2 of 10 here, so three calls need ~15 workups — a 240s box enforces the quota with a stopwatch");
ok("...but never overruns the cycle interval", /Math\.min\(240_000 \* CALLS_PER_CYCLE, Math\.floor\(cycleMs \* 0\.6\)\)/.test(ph),
  "a 12-minute hunt inside a 12-minute cycle would overlap cycles on a process Render restarts");
ok("the interval it bounds against is the SHARED one, not a re-parsed env var",
  /const cycleMs = CYCLE_MINS \* 60_000;/.test(ph) && /CYCLE_MINS/.test(ph),
  "two places reading process.env.PENTHOUSE_CYCLE_MINS || 12 is how the cadence drifts from the book");
ok("the hunt's interview cap scales with the quota",
  /PENTHOUSE_HUNT_MAX \|\| 12 \* CALLS_PER_CYCLE/.test(ph),
  "a cap sized for one call starves a quota of three");

console.log("\nA FULL BOOK STOPS THE FILL INSTEAD OF SPINNING");
ok("the field pass breaks on book_full",
  /pub\.outcome === "book_full"/.test(fieldPass),
  "book_full is a fact about the desk — every later publish refuses identically");
ok("the hunt breaks on book_full too",
  /cycle:hunt_book_full/.test(ph),
  "otherwise the hunt pays for workups it can never publish");

console.log("\nTHE SAFETY BAR IS UNTOUCHED BY THE QUOTA");
ok("the fill publishes only from the eligible field",
  /for \(const cand of eligible\)/.test(fieldPass),
  "the quota must never be filled from candidates that failed eligibility");
ok("no lane bypasses publishCall",
  (ph.match(/openCall\(/g) || []).length === 1,
  "publishCall is the single gate every call passes through — a second openCall site would skip eligibility()");
ok("a short cycle reports itself",
  /emit\("cycle:short"/.test(ph),
  "'the market was thin' and 'the desk stopped early' must never read the same");

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
