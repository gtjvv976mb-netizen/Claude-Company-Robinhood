/**
 * A MEASUREMENT MAY NEVER REFUSE A TRADE.
 *
 * gate_observations exists so a new refusal clause can be run against real calls, have
 * its would-have-refused rate read back, and only then be promoted to killing. That makes
 * the writer a piece of code which runs on the entry path for the sole purpose of
 * recording something — and the one way it can do harm is by throwing. A full disk, a
 * locked database, a schema that has not migrated: none of those is a reason to stop
 * buying, and a recorder that turns them into one is strictly worse than no recorder.
 *
 * So the load-bearing assertion in this file is the boring one: a journal whose database
 * is closed still RETURNS from recordGateObservation. Everything else here is about not
 * poisoning the sample the promotion decision reads — a typo'd verdict, a mixed-in
 * enforcing row, a floor invented locally instead of read from the registry.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionJournal, GATE_VERDICTS } from "./journal.mjs";
import { summarise, deciles, parseSince } from "./observations-report.mjs";
import { GATE_PROMOTION_SAMPLE } from "./live-thresholds.mjs";
import { threshold } from "./thresholds.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-obs-"));
const open = (name) => new ExecutionJournal(path.join(dir, name), { wallet: "0x" + "1".repeat(40) });

console.log("\nTHE TABLE EXISTS, AND AN OLDER JOURNAL GAINS IT WITHOUT LOSING ROWS");
{
  const j = open("fresh.sqlite");
  ok("a fresh journal has the table",
    j.recordGateObservation({ gate: "exit_route_unproven", verdict: "pass" }).ok === true);
  ok("...and reads it back", j.gateObservations({ gate: "exit_route_unproven" }).length === 1);
  j.close();

  /* Re-opening is the migration path a real upgrade takes. */
  const again = new ExecutionJournal(path.join(dir, "fresh.sqlite"), { wallet: "0x" + "1".repeat(40) });
  ok("re-opening keeps the rows", again.gateObservations().length === 1);
  again.recordGateObservation({ gate: "approve_unprovable", verdict: "unreadable" });
  ok("...and accepts new ones", again.gateObservations().length === 2);
  again.close();
}

console.log("\nA MEASUREMENT MAY NEVER REFUSE A TRADE");
{
  const j = open("closed.sqlite");
  j.close();
  let threw = false, result = null;
  try { result = j.recordGateObservation({ gate: "exit_route_unproven", verdict: "pass" }); }
  catch { threw = true; }
  ok("a closed database does not throw into the caller", threw === false);
  ok("...it reports the failure instead", result && result.ok === false && typeof result.error === "string",
    result ? result.error.slice(0, 60) : "");
  let readThrew = false, rows = null;
  try { rows = j.gateObservations(); } catch { readThrew = true; }
  ok("reading a closed database does not throw either", readThrew === false && Array.isArray(rows));
}

console.log("\nTHE VERDICT ENUM IS CHECKED BEFORE THE DATABASE IS TOUCHED");
{
  const j = open("enum.sqlite");
  const bad = j.recordGateObservation({ gate: "g", verdict: "would-refuse" });   // hyphen, not underscore
  ok("a typo'd verdict is refused", bad.ok === false && /verdict must be one of/.test(bad.error));
  ok("...and nothing was written", j.gateObservations().length === 0);
  ok("an unnamed gate is refused", j.recordGateObservation({ verdict: "pass" }).ok === false);
  for (const v of GATE_VERDICTS)
    ok(`"${v}" is accepted`, j.recordGateObservation({ gate: "g", verdict: v }).ok === true);
  ok("the enum has exactly the three states", GATE_VERDICTS.length === 3);
  j.close();
}

console.log("\nFILTERING, SHAPE, AND THE ENFORCING FLAG");
{
  const j = open("filter.sqlite");
  const t0 = 1_000_000_000_000;
  j.recordGateObservation({ gate: "a", verdict: "pass", now: t0 });
  j.recordGateObservation({ gate: "a", verdict: "would_refuse", now: t0 + 10_000, value: { measured: 12.5 } });
  j.recordGateObservation({ gate: "b", verdict: "pass", now: t0 + 20_000, enforcing: true });
  ok("filters by gate", j.gateObservations({ gate: "a" }).length === 2);
  ok("filters by window", j.gateObservations({ sinceMs: t0 + 15_000 }).length === 1);
  const [row] = j.gateObservations({ gate: "b" });
  ok("enforcing round-trips as a boolean", row.enforcing === true);
  const [wr] = j.gateObservations({ gate: "a" }).filter((r) => r.verdict === "would_refuse");
  ok("the measured value round-trips as an object", wr.value && wr.value.measured === 12.5);
  ok("an observe-only row is not marked enforcing",
    j.gateObservations({ gate: "a" }).every((r) => r.enforcing === false));
  j.close();
}

console.log("\nTHE PROMOTION VERDICT IS THE SAMPLE FLOOR, AND IT IS THE DESK'S");
{
  const rows = (n, verdict = "pass") => Array.from({ length: n }, () => ({ gate: "g", verdict, value: null, enforcing: false }));
  const under = summarise(rows(GATE_PROMOTION_SAMPLE - 1));
  ok("one short of the floor is NOT PROMOTABLE", under.promotable === false && /^NOT PROMOTABLE/.test(under.verdict),
    under.verdict);
  const at = summarise(rows(GATE_PROMOTION_SAMPLE));
  ok("at the floor it is PROMOTABLE", at.promotable === true && /^PROMOTABLE/.test(at.verdict), at.verdict);
  ok("the floor comes from the registry, not a literal here", at.floor === GATE_PROMOTION_SAMPLE);

  const t = threshold("gates.promotionSampleFloor");
  ok("...registered ASSUMED, because it is policy and not a measurement",
    String(t.provenance).toLowerCase() === "assumed", String(t.provenance));
  ok("...and live:false, because it decides no trade", t.live === false);
}

console.log("\nTHE REPORT SEPARATES UNREADABLE FROM BOTH SIDES");
{
  const mk = (verdict, value = null) => ({ gate: "g", verdict, value, enforcing: false });
  const s = summarise([
    ...Array.from({ length: 70 }, () => mk("pass", { measured: 1 })),
    ...Array.from({ length: 20 }, () => mk("would_refuse", { measured: 9 })),
    ...Array.from({ length: 10 }, () => mk("unreadable", { reason: "HTTP 429" })),
  ]);
  ok("unreadable is its own column, not folded into pass",
    s.pass === 70 && s.wouldRefuse === 20 && s.unreadable === 10);
  ok("...and its rate is reported", Math.abs(s.unreadablePct - 10) < 1e-9);
  ok("...with the reasons behind it", s.unreadableReasons["HTTP 429"] === 10);
  ok("the measured values give deciles", s.deciles && s.deciles.n === 90 && s.deciles.min === 1 && s.deciles.max === 9);
  ok("deciles of nothing is null", deciles([]) === null);
  ok("enforcing rows are counted separately so a promotion is not measured against itself",
    summarise([mk("pass"), { ...mk("pass"), enforcing: true }]).enforcing === 1);
}

console.log("\nTHE SPAN PARSER, AND THE TOOL'S PLACE IN THE MANIFESTS");
{
  const now = 1_000_000_000_000;
  ok("7d", parseSince("7d", now) === now - 7 * 86400e3);
  ok("36h", parseSince("36h", now) === now - 36 * 3600e3);
  ok("90m", parseSince("90m", now) === now - 90 * 60e3);
  ok("a bare number is days", parseSince("3", now) === now - 3 * 86400e3);
  ok("no span is the beginning of time", parseSince(null) === 0);
  let threw = false;
  try { parseSince("last tuesday"); } catch { threw = true; }
  ok("nonsense is refused, not silently zero", threw);

  const install = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
  ok("the tool ships with the release", /TOOL_FILES=\([^)]*observations-report\.mjs/.test(install));
  ok("...and is NOT in the trading runtime",
    !/RUNTIME_FILES=\([^)]*observations-report/.test(install));
  const runner = fs.readFileSync(new URL("./launchd-runner.mjs", import.meta.url), "utf8");
  ok("...nor in the runner's runtime list", !/observations-report/.test(runner));
  const health = fs.readFileSync(new URL("./heartbeat-health.mjs", import.meta.url), "utf8");
  ok("...nor in the trading runtime health check", !/observations-report/.test(health));
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("...and the poller never imports it", !/observations-report/.test(poller));
  const report = fs.readFileSync(new URL("./observations-report.mjs", import.meta.url), "utf8");
  ok("the report never recommends promoting, it only reports",
    /does not recommend promoting/.test(report));
  assert.ok(!/privateKey|KEY_FILE|signTransaction/.test(report), "a reporting tool takes no key");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
