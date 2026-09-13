/**
 * THE MACHINE MEASURES ITSELF, OR THREE OF ITS NUMBERS ARE GUESSES FOREVER.
 *
 * exec.inclusionLatencyMs, exec.dropRatePct and exec.nonceReplacementHonoured are facts
 * about what the sequencer does with a transaction from this wallet. They were
 * registered as live-path thresholds and VOID, which made a gate that could only open
 * after a send and could only be passed before one — the executor refused to arm until
 * they were measured, and measuring them needs an armed executor. They are `canary` now,
 * and every real send records its own outcome so the numbers accumulate as the bot
 * trades rather than waiting for someone to remember.
 *
 * What this file pins:
 *   1. the summary arithmetic, against records whose answers are known by hand;
 *   2. that a drop is counted as a drop and a landed cancel proves same-nonce
 *      replacement — the one question no read-only probe can answer;
 *   3. that the poller reads the rolling drop rate and pauses ENTRIES ONLY, because a
 *      sequencer that is dropping is exactly when an open position must still be exitable.
 *
 *   node executor/test-send-stats.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { summariseSendStats, SEND_STATS_MAX } from "./evm-executor.mjs";
import { threshold, canaryThresholds, PROVENANCE } from "./thresholds.mjs";
import "./live-thresholds.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

console.log("\nTHE SUMMARY, AGAINST RECORDS WHOSE ANSWER IS KNOWN BY HAND");
ok("no sends is null, not zero — an unmeasured rate is not a measured absence", () => {
  const s = summariseSendStats([]);
  assert.equal(s.sends, 0);
  assert.equal(s.dropRatePct, null);
  assert.equal(s.inclusionLatencyMs.median, null);
  assert.equal(s.nonceReplacementHonoured, null);
});
ok("a malformed or missing record is not a crash and not a measurement", () => {
  for (const bad of [null, undefined, "nonsense", 42, [null, {}, { outcome: "weird" }]])
    assert.equal(summariseSendStats(bad).sends, 0);
});
ok("four confirmed sends: median and p90 latency, zero drops", () => {
  const s = summariseSendStats([
    { kind: "entry", outcome: "confirmed", latencyMs: 100 },
    { kind: "entry", outcome: "confirmed", latencyMs: 200 },
    { kind: "risk_exit", outcome: "confirmed", latencyMs: 300 },
    { kind: "risk_exit", outcome: "confirmed", latencyMs: 400 },
  ]);
  assert.equal(s.sends, 4);
  assert.equal(s.confirmed, 4);
  assert.equal(s.dropped, 0);
  assert.equal(s.dropRatePct, 0);
  assert.equal(s.inclusionLatencyMs.median, 200);
  assert.equal(s.inclusionLatencyMs.max, 400);
  assert.equal(s.inclusionLatencyMs.samples, 4);
});
ok("a reverted send is a send that cost gas, not a drop", () => {
  const s = summariseSendStats([
    { kind: "entry", outcome: "confirmed", latencyMs: 100 },
    { kind: "entry", outcome: "reverted", latencyMs: 150 },
  ]);
  assert.equal(s.reverted, 1);
  assert.equal(s.dropped, 0);
  assert.equal(s.dropRatePct, 0, "a revert is the chain's answer; the transaction was included");
});
ok("one drop in four is 25%", () => {
  const s = summariseSendStats([
    { kind: "entry", outcome: "confirmed", latencyMs: 100 },
    { kind: "entry", outcome: "dropped", latencyMs: null },
    { kind: "entry", outcome: "confirmed", latencyMs: 120 },
    { kind: "entry", outcome: "confirmed", latencyMs: 140 },
  ]);
  assert.equal(s.dropped, 1);
  assert.equal(s.dropRatePct, 25);
  assert.equal(s.inclusionLatencyMs.samples, 3, "a drop has no latency and must not be counted as a fast one");
});
ok("the cancel is not itself a send being measured — it is the answer to one", () => {
  const s = summariseSendStats([
    { kind: "entry", outcome: "dropped", latencyMs: null },
    { kind: "cancel", outcome: "cancel-landed", latencyMs: 90 },
  ]);
  assert.equal(s.sends, 1, "one send was attempted; the cancel is the recovery, not a second attempt");
  assert.equal(s.dropRatePct, 100);
});

console.log("\nTHE ONE QUESTION NO READ-ONLY PROBE CAN ANSWER");
ok("a landed cancel proves the sequencer honours a same-nonce replacement", () => {
  const s = summariseSendStats([
    { kind: "entry", outcome: "dropped" },
    { kind: "cancel", outcome: "cancel-landed", latencyMs: 80 },
  ]);
  assert.equal(s.nonceReplacementHonoured, true);
  assert.equal(s.cancelsLanded, 1);
});
ok("a drop with no cancel yet landed is FALSE, not unknown — the evidence points that way", () => {
  assert.equal(summariseSendStats([{ kind: "entry", outcome: "dropped" }]).nonceReplacementHonoured, false);
});
ok("nothing dropped means the question was never asked, so the answer stays null", () => {
  assert.equal(summariseSendStats([{ kind: "entry", outcome: "confirmed", latencyMs: 10 }])
    .nonceReplacementHonoured, null);
});

console.log("\nTHE RECORD IS BOUNDED, AND THE REGISTRY KNOWS THESE ARE NOT MEASUREMENTS");
ok("the ring is bounded so a long-running executor cannot grow it without limit", () => {
  assert.ok(SEND_STATS_MAX > 0 && SEND_STATS_MAX <= 1000, String(SEND_STATS_MAX));
  const exec = fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8");
  assert.match(exec, /list\.slice\(-SEND_STATS_MAX\)/, "oldest out, newest kept");
});
ok("recording a send can never take a trade down", () => {
  const exec = fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8");
  const fn = exec.slice(exec.indexOf("_recordSend(sample)"), exec.indexOf("sendStats()"));
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \(error\) \{ this\.log/, "telemetry may lose detail; it may not throw into the money path");
});
for (const name of ["exec.inclusionLatencyMs", "exec.dropRatePct", "exec.nonceReplacementHonoured"]) {
  ok(`${name} is canary and off the live path, so it can never wedge the arming gate`, () => {
    const t = threshold(name);
    assert.equal(t.provenance, PROVENANCE.CANARY);
    assert.equal(t.live, false);
    assert.equal(t.value, null);
  });
}
ok("the three are exactly the canary set", () =>
  assert.deepEqual(canaryThresholds().map((t) => t.name).sort(),
    ["exec.dropRatePct", "exec.inclusionLatencyMs", "exec.nonceReplacementHonoured"]));

console.log("\nA DROPPING SEQUENCER PAUSES ENTRIES — AND ONLY ENTRIES");
{
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller reads the rolling rate and needs a real sample before acting", () => {
    assert.match(poller, /SEND_DROP_PAUSE_PCT = \d+/);
    assert.match(poller, /SEND_DROP_MIN_SAMPLES = \d+/);
    assert.match(poller, /stats\.sends >= SEND_DROP_MIN_SAMPLES && stats\.dropRatePct > SEND_DROP_PAUSE_PCT/);
  });
  ok("the check sits in onEntry, so exits and reconciliation are untouched", () => {
    const onEntry = poller.slice(poller.indexOf("async function onEntry"), poller.indexOf("async function sellAll"));
    assert.match(onEntry, /the sequencer dropped/);
    const sellAll = poller.slice(poller.indexOf("async function sellAll"), poller.indexOf("async function handleDeskExitEvent"));
    assert.ok(!/SEND_DROP_PAUSE_PCT/.test(sellAll), "an exit must never be blocked by the drop rate");
  });
  ok("the refusal names the numbers, so an operator can tell weather from a wedge", () =>
    assert.match(poller, /dropped \$\{stats\.dropped\} of the last \$\{stats\.sends\} sends/));
  ok("it clears itself: the rate is rolling, with no latch to remember to lift", () =>
    assert.match(poller, /until the rolling rate recovers/));
  ok("the stats ride on the heartbeat, so the desk sees what the wallet measured", () =>
    assert.match(poller, /sendStats: executor \? executor\.sendStats\(\) : null,/));
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
