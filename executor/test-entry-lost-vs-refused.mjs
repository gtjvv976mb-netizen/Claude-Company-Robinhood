import assert from "node:assert/strict";
import fs from "node:fs";
import { executorHeartbeatHealth } from "./heartbeat-health.mjs";

/* ── A CALL REFUSED AND A CALL LOST ARE NOT THE SAME EVENT ────────────────────
 * When an entry fails pre-signature the poller advances the feed cursor past it.
 * That is deliberate and correct: a stuck entry must never become head-of-line
 * denial of every later EXIT. But it means the call is gone permanently — and
 * the log said "entry acknowledged without a trade" whether the call had been
 * screened out on its merits or dropped to an aggregator 500.
 *
 * Those need different responses. Refusals are the system working. Losses are
 * calls the desk published and this bot dropped on the floor, and how many there
 * are is exactly what decides whether a retry queue is worth building. It was
 * unmeasurable, so it now has a counter on the heartbeat instead of a guess. */
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");

/* THE WINDOW IS STRUCTURAL, NOT A BYTE COUNT. This file used to slice a fixed 1600/1800
   characters from the comment anchor, which is a window that silently shrinks every time
   a line is added inside the branch: adding the retry-queue call pushed the refused
   branch out of the slice and failed an assertion about code that was still correct and
   still right where it had always been. The branch runs from its comment to the
   `continue` that ends it — that is the real extent, and it stays the real extent
   however much is written inside it. */
const BRANCH_START = "BUT A CALL REFUSED AND A CALL LOST";
const branchBlock = () => {
  const start = poller.indexOf(BRANCH_START);
  assert.ok(start > 0, "could not locate the lost-vs-refused branch");
  const end = poller.indexOf("continue;", poller.indexOf("S.cursor = Number(ev.id);", start));
  assert.ok(end > start, "could not locate the end of the branch");
  return poller.slice(start, end + "continue;".length);
};

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

ok("a transient failure class is counted as LOST, not as a refusal", () => {
  const block = branchBlock();
  assert.match(block, /const lost = cls === "transport" \|\| cls === "oracle";/,
    "the classes evm-swap already tags are what distinguish the two");
  assert.match(block, /S\.entriesLostToFailure = \(S\.entriesLostToFailure \|\| 0\) \+ 1;/);
  assert.match(block, /S\.entriesRefused = \(S\.entriesRefused \|\| 0\) \+ 1;/);
  assert.match(block, /\$\{lost \? "LOST" : "SKIP"\}/, "and the log line says which happened");
  assert.match(block, /not refused on its merits/,
    "a lost call must say so, or it reads as the screen working");
});

ok("the cursor still advances in BOTH cases — exits are never held behind an entry", () => {
  const block = branchBlock();
  const advances = [...block.matchAll(/S\.cursor = Number\(ev\.id\);/g)];
  assert.equal(advances.length, 1, "one advance, taken on every path out of this branch");
  /* UNCONDITIONAL, and asserted as such. Counting the advances and checking they come
     after the log is not enough — wrapping them in `if (!lost)` satisfies both while
     reintroducing exactly the head-of-line blocking the cursor advance exists to
     prevent, and that mutation passed the first version of this test. */
  const logAt = block.indexOf('${lost ? "LOST" : "SKIP"}');
  const advanceAt = block.indexOf("S.cursor = Number(ev.id);");
  assert.ok(advanceAt > logAt, "the advance comes after the log");
  const between = block.slice(block.indexOf(";", logAt), advanceAt);
  assert.doesNotMatch(between, /\bif\s*\(/,
    "nothing may make the cursor advance conditional — a lost call still must not hold later exits");
  assert.match(block.slice(advanceAt),
    /^S\.cursor = Number\(ev\.id\);\s*\n\s*save\(\);\s*\n\s*continue;/,
    "advance, save, continue — in that order, guarded by nothing");
});

ok("both counters reach the heartbeat", () => {
  assert.match(poller, /entriesLostToFailure: S\.entriesLostToFailure \|\| 0,/);
  assert.match(poller, /entriesRefused: S\.entriesRefused \|\| 0,/);
  const sites = [...poller.matchAll(/entriesLostToFailure: S\.entriesLostToFailure/g)];
  assert.equal(sites.length, 2, "both heartbeat construction sites carry them, or one lies by omission");
});

ok("the heartbeat reports them as numbers, defaulting to 0", () => {
  const bare = executorHeartbeatHealth({});
  assert.equal(bare.entriesLostToFailure, 0);
  assert.equal(bare.entriesRefused, 0);
  const live = executorHeartbeatHealth({ entriesLostToFailure: 3, entriesRefused: 11 });
  assert.equal(live.entriesLostToFailure, 3);
  assert.equal(live.entriesRefused, 11);
});

ok("a non-numeric value cannot poison the report", () => {
  const junk = executorHeartbeatHealth({ entriesLostToFailure: "lots", entriesRefused: null });
  assert.equal(junk.entriesLostToFailure, 0);
  assert.equal(junk.entriesRefused, 0);
});

console.log(`\n${n} lost-vs-refused checks passed`);
