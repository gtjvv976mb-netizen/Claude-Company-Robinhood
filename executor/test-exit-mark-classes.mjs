import assert from "node:assert/strict";
import fs from "node:fs";
import { confirmExitMarkFailureWitness, clearExitMarkFailureWitness, EXIT_MARK_FAILURE_POLICY }
  from "./exit-trigger.mjs";

/* ── A THIRTY-SECOND OUTAGE MUST NOT SELL THE BOOK ────────────────────────────
 * The latch is a real defence: an order service answering "no route" forever would
 * otherwise hide a breached stop. But the sell it fires carries kind "risk-data",
 * and validateExecutableExitOrder applies NO price condition to that — stop, target
 * and take-profit are never consulted. So the latch is a PRICE-BLIND, FULL-SIZE
 * market liquidation, and it was fired by two failed HTTP calls fifteen seconds
 * apart, across every open position at once, because the aggregator is a common
 * dependency. A winner twenty minutes from its take-profit went out with the rest.
 *
 * The fix does not weaken the defence. A routing verdict — the service answered and
 * has no route — keeps the two-tick fuse exactly. Only evidence that says nothing
 * about the pool needs to persist. */
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };
const T0 = 1_800_000_000_000;
const tick = (pos, at, failureClass) =>
  confirmExitMarkFailureWitness(pos, { observedAt: at, reason: "x", failureClass },
    { maxGapMs: 60_000 });

ok("a routing verdict still latches on two consecutive ticks — the defence is intact", () => {
  const pos = {};
  assert.equal(tick(pos, T0, "no-route").confirmed, false, "one failure only freezes new exposure");
  const second = tick(pos, T0 + 15_000, "no-route");
  assert.equal(second.confirmed, true, "the second consecutive routing verdict latches");
  assert.equal(second.trigger.kind, "risk-data");
  assert.equal(second.trigger.witnesses, 2);
});

ok("an unclassified failure uses the strict routing fuse, not the lenient one", () => {
  const pos = {};
  tick(pos, T0, undefined);
  assert.equal(tick(pos, T0 + 15_000, undefined).confirmed, true,
    "forgetting to classify must not buy a ten-minute delay on a real suppression attempt");
});

ok("two transport failures thirty seconds apart do NOT sell anything", () => {
  const pos = {};
  assert.equal(tick(pos, T0, "transport").confirmed, false);
  assert.equal(tick(pos, T0 + 15_000, "transport").confirmed, false,
    "an HTTP 500 twice is a fact about the network, not about the position");
  assert.equal(tick(pos, T0 + 30_000, "transport").confirmed, false);
});

ok("a transport outage that really persists DOES latch — a silent service is still stopped out", () => {
  const pos = {};
  /* The latch fires once and CLEARS the chain, so a later tick is a fresh count of
     one. Record the first confirmation rather than the last tick — my first version of
     this assertion read the last one and called working code broken. */
  let first = null, firstAtMs = null;
  for (let t = 0; t <= 11 * 60_000 && !first; t += 15_000) {
    const r = tick(pos, T0 + t, "transport");
    if (r.confirmed) { first = r; firstAtMs = t; }
  }
  assert.ok(first, "a hostile service that simply refuses to answer must not win indefinitely");
  assert.ok(first.trigger.witnesses >= EXIT_MARK_FAILURE_POLICY.transport.witnesses);
  assert.ok(first.trigger.observedAt - first.trigger.firstObservedAt >= EXIT_MARK_FAILURE_POLICY.transport.minSpanMs);
  /* And it must take MINUTES, not the two ticks it used to take. */
  assert.ok(firstAtMs >= EXIT_MARK_FAILURE_POLICY.transport.minSpanMs,
    `latched after ${firstAtMs}ms — a transport blip must never latch in seconds`);
  assert.ok(firstAtMs <= 11 * 60_000, "but it must still latch eventually");
});

ok("an ETH/USD oracle gap is treated as evidence about Chainlink, not about the pool", () => {
  const pos = {};
  assert.equal(tick(pos, T0, "oracle").confirmed, false);
  assert.equal(tick(pos, T0 + 15_000, "oracle").confirmed, false);
});

ok("one good mark clears the chain", () => {
  const pos = {};
  for (let t = 0; t < 9 * 60_000; t += 15_000) tick(pos, T0 + t, "transport");
  clearExitMarkFailureWitness(pos);
  assert.equal(pos.pendingExitMarkFailure, undefined);
  assert.equal(tick(pos, T0 + 9 * 60_000, "transport").confirmed, false, "the count restarts from one");
});

ok("a change of failure class restarts the chain rather than continuing it", () => {
  const pos = {};
  for (let t = 0; t < 9 * 60_000; t += 15_000) tick(pos, T0 + t, "transport");
  const switched = tick(pos, T0 + 9 * 60_000, "no-route");
  assert.equal(switched.confirmed, false, "different evidence is not the same evidence continuing");
  assert.equal(tick(pos, T0 + 9 * 60_000 + 15_000, "no-route").confirmed, true,
    "...and then the routing fuse applies from there");
});

ok("a gap longer than maxGapMs breaks the chain", () => {
  const pos = {};
  tick(pos, T0, "no-route");
  assert.equal(tick(pos, T0 + 120_000, "no-route").confirmed, false, "not consecutive");
});

/* ── THE FAILURES MUST ACTUALLY BE CLASSIFIED AT THE SOURCE ─────────────────── */
ok("evm-swap tags transport failures and routing verdicts differently", () => {
  const swap = fs.readFileSync(new URL("./evm-swap.mjs", import.meta.url), "utf8");
  assert.match(swap, /failureClass: kind/, "errors carry a class");
  assert.match(swap, /unreachable: \$\{e\?\.message \|\| e\}`, "transport"\)/,
    "DNS/TLS/timeout is transport");
  assert.match(swap, /\$\{body\?\.message \?\? "no body"\}`, "transport"\)/, "an HTTP status is transport");
  assert.match(swap, /no route for \$\{tokenIn\} -> \$\{tokenOut\} at \$\{amountIn\}`, "no-route"\)/,
    "an answered request with no route is a verdict about the position");
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  assert.match(poller, /failureClass: error\?\.failureClass/, "the poller passes the class through");
  assert.match(poller, /\{ failureClass: "oracle" \}/, "an ETH/USD gap is classified");
});

/* ── AND THE FORCED SALE MUST BE BOUNDED ────────────────────────────────────── */
ok("the exit leg passes a price-impact cap, so a liquidation is not unbounded", () => {
  const ex = fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8");
  const sell = ex.slice(ex.indexOf('direction: "sell"') - 400, ex.indexOf('direction: "sell"') + 200);
  assert.match(sell, /maxPriceImpactPct: this\.cfg\.maxExitPriceImpactPct/,
    "MAX_EXIT_PRICE_IMPACT_PCT was parsed, clamped and allowlisted while being read by nothing");
  assert.match(ex, /maxExitPriceImpactPct: null,/, "and it is a declared config key");
  const swap = fs.readFileSync(new URL("./evm-swap.mjs", import.meta.url), "utf8");
  /* Matching SOURCE, where the template expression between the two words is ~70
     characters, not the ~7 of the rendered message. */
  assert.match(swap, /price impact .{0,140}exceeds cap/i,
    "the refusal message poller.mjs's manualExitRequired branch matches on must exist");
  const poller2 = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  assert.match(poller2, /\/price impact \.\* exceeds cap\/i\.test\(error\.message\)/,
    "...and the branch that turns it into manualExitRequired is still there");
});

console.log(`\n${n} exit-mark evidence checks passed`);
