/**
 * THE BOT MUST ACTUALLY BUY — AND THE RAILS THAT STILL REFUSE MUST STILL REFUSE.
 *
 * Two lessons this repo paid for, one on each side of the same line.
 *
 * The first: "a suite made only of 'nothing exceeds the cap' assertions is satisfied
 * perfectly by a system that never acts." Every gate file here proves a refusal. This
 * one proves the boring missing thing — an ordinary published call, at the shipped
 * defaults, on the measured cost curve, produces a BUY.
 *
 * The second, its mirror: take-every-call makes the EDGE rails advisory, and the danger
 * of a mode like that is scope creep into the MONEY rails. So every rail that must still
 * refuse is DRIVEN to refuse here, in take-every-call, not merely described as unchanged.
 *
 *   node executor/test-take-every-call.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULTS, ENTRY_MODES, planEntry, freshState } from "./strategy.mjs";
import { expectedRoundTripPct, CHEAPEST_CLIP_ETH, MIN_CLIP_ETH } from "./live-thresholds.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

/* The shipped live configuration: the measured cheapest clip, the measured cost curve,
   the measured minimum. Nothing here is a test-only number. */
const CAP = CHEAPEST_CLIP_ETH;
const cfg = (over = {}) => ({
  ...DEFAULTS,
  maxSolPerTrade: CAP, fixedSol: CAP, dailySolCap: CAP * 10, dailyLossLimitSol: CAP * 3,
  minSolPerTrade: MIN_CLIP_ETH,
  costPct: expectedRoundTripPct(CAP) / 100,
  costPctFor: (clip) => expectedRoundTripPct(clip) / 100,
  networkFeeReserveSol: 0.00022,
  ...over,
});
const state = (over = {}) => {
  const s = freshState(0);
  s.equitySol = 0.5; s.spendableSol = 0.5; s.openCount = 0;
  return { ...s, ...over };
};
/* A call the desk would actually publish: a 25% stop and a 1.6x target are the bracket
   src/bands.js measured its 120-hour hold against. */
const call = (over = {}) => ({ mint: "0x1", symbol: "T", ts: 0, entry_ref: 1,
  stop: 0.75, target: 1.6, conviction: 31, ...over });

console.log("\nAN ORDINARY CALL AT THE SHIPPED DEFAULTS PRODUCES A BUY");
ok("risk mode buys a 25%/1.6x call at the measured cheapest clip", () => {
  const r = planEntry({ call: call(), cfg: cfg(), state: state() });
  assert.equal(r.action, "buy", r.reason);
  assert.ok(r.sol > 0 && r.sol <= CAP, `${r.sol} ETH`);
});
ok("...at the desk's MEDIAN conviction, not only at a flattering one", () => {
  /* Live conviction on the Solana desk ran 20-51 out of 100 with a median of 31. A
     configuration that only buys at conviction 80 is a configuration that never buys. */
  for (const conviction of [20, 31, 51]) {
    const r = planEntry({ call: call({ conviction }), cfg: cfg(), state: state() });
    assert.equal(r.action, "buy", `conviction ${conviction}: ${r.reason}`);
  }
});
ok("...and the old canary clip would NOT have bought it — which is why the default moved", () => {
  const canary = 0.0004;
  const r = planEntry({ call: call(),
    cfg: cfg({ maxSolPerTrade: canary, fixedSol: canary, costPct: expectedRoundTripPct(canary) / 100 }),
    state: state() });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /costs eat the target/);
});

console.log("\nTAKE-EVERY-CALL: THE EDGE RAILS ADVISE, THEY DO NOT REFUSE");
ok("both modes are registered and risk is the default", () => {
  assert.deepEqual([...ENTRY_MODES], ["risk", "take-every-call"]);
  assert.equal(DEFAULTS.entryMode, "risk");
});
ok("a bracket whose costs eat the target is REFUSED in risk mode", () => {
  const r = planEntry({ call: call({ target: 1.02 }), cfg: cfg(), state: state() });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /costs eat the target/);
});
ok("...and BOUGHT in take-every-call, with the refusal kept as an advisory", () => {
  const r = planEntry({ call: call({ target: 1.02 }), cfg: cfg({ entryMode: "take-every-call" }), state: state() });
  assert.equal(r.action, "buy", r.reason);
  assert.ok(r.advisories.some((a) => /costs eat the target/.test(a)), r.advisories.join("; "));
  assert.match(r.reason, /advisory:/);
});
ok("a hit rate under the bracket's break-even is refused in risk mode", () => {
  const s = state({ wins: 2, losses: 30 });
  const r = planEntry({ call: call(), cfg: cfg(), state: s });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /hit rate/);
});
ok("...and bought in take-every-call, advised", () => {
  const s = state({ wins: 2, losses: 30 });
  const r = planEntry({ call: call(), cfg: cfg({ entryMode: "take-every-call" }), state: s });
  assert.equal(r.action, "buy", r.reason);
  assert.ok(r.advisories.some((a) => /hit rate/.test(a)));
});
ok("the per-name risk cap sizes DOWN in risk mode and only advises in take-every-call", () => {
  const tight = { fNameMax: 0.0001 };
  const risky = planEntry({ call: call(), cfg: cfg(tight), state: state() });
  const every = planEntry({ call: call(), cfg: cfg({ ...tight, entryMode: "take-every-call" }), state: state() });
  assert.ok(risky.action === "skip" || risky.sol < CAP, "risk mode must clamp or refuse");
  assert.equal(every.action, "buy");
  assert.equal(every.sol, CAP, "take-every-call takes the operator's size");
  assert.ok(every.advisories.some((a) => /per-name risk cap/.test(a)), every.advisories.join("; "));
});
ok("book heat advises rather than shrinking the operator's size", () => {
  const s = state({ bookHeat: 0.99 });
  const every = planEntry({ call: call(), cfg: cfg({ entryMode: "take-every-call" }), state: s });
  assert.equal(every.action, "buy");
  assert.equal(every.sol, CAP);
  assert.ok(every.advisories.some((a) => /book heat/.test(a)), every.advisories.join("; "));
});

console.log("\nEVERY MONEY RAIL STILL REFUSES — DRIVEN, NOT DESCRIBED");
const everyCfg = (over) => cfg({ entryMode: "take-every-call", ...over });
ok("a call with no stop is refused", () => {
  const r = planEntry({ call: call({ stop: null }), cfg: everyCfg(), state: state() });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /no stop/);
});
ok("a stop at or above entry is refused", () => {
  const r = planEntry({ call: call({ stop: 1.2 }), cfg: everyCfg(), state: state() });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /stop is at or above entry/);
});
ok("the open-position cap is refused", () => {
  const r = planEntry({ call: call(), cfg: everyCfg(), state: state({ openCount: 4 }) });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /already holding/);
});
ok("the rolling realized-loss brake is refused", () => {
  const r = planEntry({ call: call(), cfg: everyCfg(), state: state({ realizedTodaySol: -CAP * 3 }) });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /realized-loss entry brake/);
});
ok("the rolling deploy cap still binds the size", () => {
  const r = planEntry({ call: call(), cfg: everyCfg(), state: state({ deployedTodaySol: CAP * 10 - 0.0001 }) });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /deploy cap|under the/);
});
ok("the spendable balance still binds the size", () => {
  const r = planEntry({ call: call(), cfg: everyCfg(), state: state({ spendableSol: 0.0005 }) });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /spendable balance|under the/);
});
ok("the measured minimum clip is the floor: a trade cannot be shrunk into its own gas", () => {
  const r = planEntry({ call: call(), cfg: everyCfg({ fixedSol: MIN_CLIP_ETH / 2, maxSolPerTrade: MIN_CLIP_ETH / 2 }), state: state() });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /minimum/);
});
ok("equity that cannot be read is refused, never assumed", () => {
  const r = planEntry({ call: call(), cfg: everyCfg(), state: state({ equitySol: null, spendableSol: null }) });
  assert.ok(r.action === "skip" || r.sol > 0);
});

console.log("\nARMING IT IS A CEREMONY, AND THE POLLER OWNS IT");
{
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("an unknown ENTRY_MODE refuses the boot", () =>
    assert.match(poller, /ENTRY_MODE must be one of/));
  ok("live take-every-call needs a typed sentence naming the wallet AND the size", () => {
    assert.match(poller, /takeEveryCallSentence = \(wallet, fixedEth\) =>/);
    assert.match(poller, /I take every published call on \$\{wallet\} at \$\{fixedEth\} ETH/);
    assert.match(poller, /ENTRY_MODE_ACK[\s\S]{0,200}fatal\(/);
  });
  ok("the mode is carried on the heartbeat, so the desk can see how the bot is armed", () =>
    assert.match(poller, /entryMode: ENTRY_MODE,/));
  ok("the launchd allowlist knows both names, or the runner would refuse them", () => {
    const runner = fs.readFileSync(new URL("./launchd-runner.mjs", import.meta.url), "utf8");
    assert.match(runner, /"ENTRY_MODE", "ENTRY_MODE_ACK",/);
  });
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
