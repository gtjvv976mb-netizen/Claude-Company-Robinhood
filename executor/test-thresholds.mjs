/**
 * AN UNMEASURED NUMBER MUST NOT BE ABLE TO TRADE.
 *
 * The Solana desk's thresholds are good numbers, each earned by a real measurement and
 * each carrying a comment that explains it. That is what makes them dangerous on a new
 * chain: a threshold with a convincing justification is the one nobody re-examines. Its
 * liquidity floor rests on four measured round trips at $75 — 4.53%, 5.49%, 5.58%,
 * 3.70%. The same probe here returned 0.015-0.018% on a deep pool and 8.92% on a thin
 * one. Two orders of magnitude, wearing a citation.
 *
 * So the re-derivation is not a task on a list, it is a gate: the executor does not arm
 * while anything on the live path still carries a Solana measurement. These assertions
 * are what stop that gate being quietly widened later.
 */
import { defineThreshold, thresholds, threshold, unmeasuredLiveThresholds,
  assertLiveReady, canaryThresholds, PROVENANCE } from "./thresholds.mjs";
import "./live-thresholds.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

console.log("\nA NUMBER MUST SAY WHERE IT CAME FROM");
{
  ok("a threshold with no provenance is refused",
    threw(() => defineThreshold("t.noprov", 1, {})));
  ok("an invented provenance is refused",
    threw(() => defineThreshold("t.bogus", 1, { provenance: "vibes" })));
  /* The weakest point in any provenance scheme is a claim of rigour with nothing
     behind it, so "measured" specifically must carry a date and a method. */
  ok("claiming 'measured' without a date or method is refused",
    threw(() => defineThreshold("t.bare", 1, { provenance: PROVENANCE.MEASURED })));
  ok("...and is accepted once it names both",
    !threw(() => defineThreshold("t.real", 1,
      { provenance: PROVENANCE.MEASURED, at: "2026-09-04", method: "eth_call" })));
  ok("the same name cannot be defined twice",
    threw(() => defineThreshold("t.real", 2,
      { provenance: PROVENANCE.MEASURED, at: "2026-09-04", method: "x" })));
  ok("an unknown name is an error, not undefined", threw(() => threshold("t.nothere")));
}

/* THE GATE REFLECTS THE REGISTRY — WHICHEVER WAY THE REGISTRY POINTS.
 *
 * This section used to assert that the gate was SHUT: "pending.length > 0" and
 * "refuses to arm". That was true, and it was a test of the current state rather than of
 * the mechanism — the shape this repo's own lessons file calls out ("Tests assert
 * invariants, never current defaults. A test that encodes today's tunable value turns
 * every honest retune into a false regression"). When the ten void numbers were measured
 * on 2026-09-07/13 the suite went red for the one reason it should never go red: the
 * work it exists to demand was done.
 *
 * The invariant is that the gate answers to the registry. So: with everything on the live
 * path measured it opens, and the moment ANY live threshold is not measured it shuts
 * again and names that one. The second half is proved by registering a void live
 * threshold here, which is also what a future unmeasured number will look like. */
console.log("\nTHE GATE ANSWERS TO THE REGISTRY, IN BOTH DIRECTIONS");
{
  const pending = unmeasuredLiveThresholds();
  ok("every live-path number is measured on this chain, so the gate opens",
    pending.length === 0 && assertLiveReady() === true,
    pending.length ? `${pending.length} still void: ${pending.map((t) => t.name).join(", ")}` : "0 void");

  /* One at a time is how a check gets disabled: someone fixes the first offender,
     re-runs, sees another, and reaches for the flag instead. So the refusal must list
     EVERY offender, and here there are two. */
  defineThreshold("t.voidLive", null,
    { provenance: PROVENANCE.INHERITED, live: true,
      note: "a stand-in for the next unmeasured number: registered by test-thresholds.mjs so the " +
        "refusal path is proved on a real registry entry rather than on a mock of one" });
  defineThreshold("t.assumedLive", 7,
    { provenance: PROVENANCE.ASSUMED, live: true, note: "a guess nobody has checked" });
  const nowPending = unmeasuredLiveThresholds();
  ok("an INHERITED live number shuts it again", nowPending.some((t) => t.name === "t.voidLive"));
  ok("...and so does an ASSUMED one, even though it carries a value",
    nowPending.some((t) => t.name === "t.assumedLive"));
  ok("...and it refuses to arm", threw(() => assertLiveReady()));

  let msg = "";
  try { assertLiveReady(); } catch (e) { msg = e.message; }
  for (const t of nowPending) ok(`${t.name} is named in the refusal`, msg.includes(t.name));
  ok("the refusal explains the two-orders-of-magnitude gap, not just the rule",
    /0\.015-0\.018%/.test(msg) && /4\.5-5\.6%/.test(msg));
  ok("a threshold that is not on the live path never shuts the gate",
    !nowPending.some((t) => t.live !== true));
}

/* THE THREE NUMBERS ONLY A REAL SEND CAN PRODUCE.
 *
 * inclusionLatencyMs, dropRatePct and nonceReplacementHonoured were registered `live:
 * true` and VOID, which is a gate that can never open: measuring them requires sending a
 * transaction, and sending requires an armed executor. They are now `canary` — null,
 * never claimed as measured, and off the live path — and the executor measures them from
 * its own sends (evm-executor.mjs send_stats) once it is running, exactly as the Solana
 * desk measured its equivalents with one deliberate live round trip. */
console.log("\nA GATE THAT NEEDS A SEND TO OPEN CANNOT GATE SENDS");
{
  const canary = canaryThresholds();
  ok("the three send-dependent numbers are registered as canary", canary.length === 3,
    canary.map((t) => t.name).join(", "));
  for (const name of ["exec.inclusionLatencyMs", "exec.dropRatePct", "exec.nonceReplacementHonoured"]) {
    const t = threshold(name);
    ok(`${name} is canary, null, and NOT on the live path`,
      t.provenance === PROVENANCE.CANARY && t.value === null && t.live === false);
    ok(`...and says how it gets measured`, /measured|send/i.test(t.note ?? ""));
  }
  ok("no canary threshold is ever counted as measured",
    !thresholds().some((t) => t.provenance === PROVENANCE.CANARY && t.provenance === PROVENANCE.MEASURED));
}

console.log("\nWHAT IS MEASURED IS MEASURED ON THIS CHAIN");
{
  const measured = thresholds().filter((t) => t.provenance === PROVENANCE.MEASURED && t.name.includes("."));
  ok("every measured threshold names its method", measured.every((t) => t.method), `${measured.length} of them`);
  ok("...and a date", measured.every((t) => t.at));
  const chain = threshold("chain.id");
  ok("the chain it was measured against is this one", chain.value === 4663, String(chain.value));
  const swap = threshold("swap.roundTripGasUnits");
  ok("the round-trip gas names how many samples it is",
    /median of 9/.test(swap.method ?? ""), swap.method?.slice(0, 52));
  /* The cost regime INVERTED between chains and the note has to say so, because every
     inherited threshold was tuned where cost was proportional to size. */
  ok("...and records that the cost is flat, not proportional",
    /FLAT/.test(swap.note ?? "") && /inverts/.test(swap.note ?? ""));
  const noise = threshold("probe.quoteNoisePct");
  ok("the probe's own noise floor is registered, so a sub-percent reading is not a fact",
    noise.value >= 0.5, `${noise.value}%`);
}

console.log("\nNOTHING INHERITED IS PRETENDING TO BE MEASURED");
{
  const inherited = thresholds().filter((t) => t.provenance === PROVENANCE.INHERITED);
  ok("every inherited threshold is void, not carrying a stale value",
    inherited.every((t) => t.value === null), `${inherited.length} inherited`);
  ok("...and every one explains what made it void here",
    inherited.every((t) => (t.note ?? "").length > 60));
  ok("...and every one blocks the live path",
    inherited.every((t) => t.live === true));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
