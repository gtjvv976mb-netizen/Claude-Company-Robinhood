/**
 * THE COST GATE THAT MUST NOT BECOME A QUALITY GATE.
 *
 * The red team and the PM are this desk's two Opus seats and the largest line items in a
 * workup — the note beside redteam's effort records xhigh thinking alone as a third of
 * the whole bill. Both ran unconditionally, so a coin all five analysts had scored into
 * the ground still bought an adversary to attack a thesis nobody held.
 *
 * Skipping them is safe for exactly one reason: below the floor there is no PM decision
 * that publishes, so the expensive stages can only record the same no more expensively.
 * Everything here exists to keep that reason true — a cost saving that quietly tightened
 * the bar would be the wrong trade, on a desk that was just told to be MORE open.
 *
 *   node test-conviction-floor.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};
const desk = fs.readFileSync(new URL("./src/desk.js", import.meta.url), "utf8");
const block = desk.slice(desk.indexOf("DO NOT BUY TWO OPUS SEATS"), desk.indexOf('emit("stage", { stage: "redteam"'));

console.log("\nIT ONLY EVER SKIPS");
ok("the branch returns a KILL, never an approval", () => {
  assert.match(block, /outcome: "killed"/);
  assert.ok(!/finalDecision: "APPROVED"|outcome: "decided"/.test(block),
    "this path must not be able to produce a tradeable record");
});
ok("it runs BEFORE the two Opus seats, which is the whole saving", () => {
  const floorAt = desk.indexOf("const convictionFloor");
  const redteamAt = desk.indexOf("await runRedTeam(");
  const pmAt = desk.indexOf("await runPM(");
  assert.ok(floorAt > 0 && floorAt < redteamAt && floorAt < pmAt,
    "the gate must precede runRedTeam and runPM or it saves nothing");
});
ok("the record carries the score that caused it, so the decision is auditable", () =>
  assert.match(block, /weighted,/));
ok("it is recorded for evaluation like any other kill", () =>
  assert.match(block, /recordEvaluation\(rec\)/));

console.log("\nIT DOES NOT TIGHTEN THE BAR");
ok("the floor sits well BELOW neutral", () => {
  const m = block.match(/DESK_CONVICTION_FLOOR \?\? (\d+)/);
  assert.ok(m, "could not read the default");
  const floor = Number(m[1]);
  assert.ok(floor < 50, `${floor} is at or above the neutral composite of 50 — that is a quality gate, not a cost gate`);
  assert.ok(floor <= 35, `${floor} is high enough to cut marginal coins the desk was told to look at`);
});
ok("zero disables it entirely", () => assert.match(block, /convictionFloor > 0 &&/));
ok("it is tunable without a code change", () => assert.match(block, /process\.env\.DESK_CONVICTION_FLOOR/));

console.log("\nTHE SCORE IT GATES ON MEANS WHAT THE TEST ASSUMES");
const { composite } = await import("./src/agents/composite.js");
ok("an empty bench is neutral 50, not 0 — so a missing seat cannot trip the floor", () =>
  assert.equal(composite({}), 50));
ok("five confident negatives land under the floor", () => {
  const bad = Object.fromEntries(["forensics", "liquidity", "flow", "technical", "narrative"]
    .map((k) => [k, { score: 15, confidence: 0.9 }]));
  assert.ok(composite(bad) < 30, `scored ${composite(bad).toFixed(1)}`);
});
ok("a merely lukewarm bench does NOT trip it", () => {
  const meh = Object.fromEntries(["forensics", "liquidity", "flow", "technical", "narrative"]
    .map((k) => [k, { score: 45, confidence: 0.6 }]));
  assert.ok(composite(meh) >= 30,
    `scored ${composite(meh).toFixed(1)} — the mandate ranks the team's maybes and this must not eat them`);
});
ok("one loud bear cannot drag a positive bench under the floor", () => {
  const mixed = { narrative: { score: 70, confidence: 0.8 }, forensics: { score: 65, confidence: 0.8 },
    flow: { score: 60, confidence: 0.7 }, liquidity: { score: 10, confidence: 0.9 },
    technical: { score: 10, confidence: 0.9 } };
  assert.ok(composite(mixed) >= 30, `scored ${composite(mixed).toFixed(1)}`);
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
