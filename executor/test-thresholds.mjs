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
  assertLiveReady, PROVENANCE } from "./thresholds.mjs";
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

console.log("\nTHE GATE IS SHUT, AND SAYS WHY");
{
  const pending = unmeasuredLiveThresholds();
  ok("the desk knows it is not ready to trade", pending.length > 0, `${pending.length} still void`);
  ok("...and refuses to arm", threw(() => assertLiveReady()));

  let msg = "";
  try { assertLiveReady(); } catch (e) { msg = e.message; }
  /* One at a time is how a check gets disabled: someone fixes the first offender,
     re-runs, sees another, and reaches for the flag instead. */
  for (const t of pending) ok(`${t.name} is named in the refusal`, msg.includes(t.name));
  ok("the refusal explains the two-orders-of-magnitude gap, not just the rule",
    /0\.015-0\.018%/.test(msg) && /4\.5-5\.6%/.test(msg));
}

console.log("\nWHAT IS MEASURED IS MEASURED ON THIS CHAIN");
{
  const measured = thresholds().filter((t) => t.provenance === PROVENANCE.MEASURED && t.name.includes("."));
  ok("every measured threshold names its method", measured.every((t) => t.method), `${measured.length} of them`);
  ok("...and a date", measured.every((t) => t.at));
  const chain = threshold("chain.id");
  ok("the chain it was measured against is this one", chain.value === 4663, String(chain.value));
  const swap = threshold("swap.gasUnits");
  ok("a one-sample measurement says so in its note", /ONE sample/.test(swap.note ?? ""), swap.note?.slice(0, 46));
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
