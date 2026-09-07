/**
 * THE BOT MUST NOT DROP A CALL THE DESK PUBLISHED.
 *
 * The desk and the executor are two independent halves of one contract: the team makes
 * the calls, the bot executes them, and neither waits on the other. That only holds if
 * neither silently discards the other's output — and the bot did exactly that. An entry
 * that failed on an aggregator 500, an RPC fault or an oracle rotation was counted in
 * entriesLostToFailure and then abandoned: the feed cursor advanced past the event, so
 * the call was unrecoverable even though nothing about the coin had been judged.
 *
 * The queue that fixes it must clear four bars, and each is a test below:
 *   1. DURABLE — the fault that loses a call is the kind that also restarts a process.
 *   2. BOUNDED — a provider outage must not become unbounded state.
 *   3. NO NEW AUTHORITY — a retry re-enters through onEntry and faces every gate.
 *   4. HONEST — abandonment is counted and logged, never quiet.
 *
 *   node executor/test-entry-retry.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionJournal } from "./journal.mjs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-"));
const file = path.join(dir, "j.sqlite");
const wallet = "0xCAC7f130BA6bED24dEa8fC26EaB7bFfACe0d57F5";
let j = new ExecutionJournal(file, { wallet });

const ev = (id, symbol) => ({ id, event_id: `f50:${id}`, type: "entry", symbol,
  mint: `0x${String(id).padStart(40, "0")}`, ts: Date.now() });
const entry = (id, symbol, over = {}) => ({
  key: `f50:${id}`, event: ev(id, symbol), attempts: 1,
  firstAt: Date.now(), nextAt: Date.now() + 15_000, symbol, ...over,
});

console.log("\n1. DURABLE — the queue survives the restart that lost the call");
ok("a fresh journal owes nothing", () => assert.deepEqual(j.entryRetryQueue(), []));
j.saveEntryRetryQueue([entry(11, "AAA"), entry(12, "BBB")]);
ok("two queued calls read back", () => assert.equal(j.entryRetryQueue().length, 2));
j = new ExecutionJournal(file, { wallet, create: false });
const reopened = j.entryRetryQueue();
ok("the queue survives reopening the journal", () => assert.equal(reopened.length, 2));
ok("the event is carried intact, not just its id", () => {
  assert.equal(reopened[0].event.symbol, "AAA");
  assert.equal(reopened[0].event.type, "entry");
  assert.ok(reopened[0].event.mint, "the mint must survive — a retry cannot be rebuilt without it");
});

console.log("\n2. BOUNDED — an outage cannot become unbounded state");
const many = Array.from({ length: 200 }, (_, i) => entry(1000 + i, `S${i}`, { firstAt: 1_000 + i }));
const kept = j.saveEntryRetryQueue(many);
ok("the queue is capped", () => assert.equal(kept.length, 64));
ok("the FRESHEST survive a trim, because they are the ones still executable", () => {
  /* This asserted the opposite and was wrong, pinning the inversion it existed to
     prevent. The oldest entries are CLOSEST TO EXPIRY under MAX_CALL_AGE_MS — the
     likeliest to be refused as stale — while the newest are the ones that can still be
     won back. Keeping the oldest preserved exactly the calls about to be abandoned. */
  const firstAts = kept.map((e) => Number(e.firstAt));
  assert.equal(Math.max(...firstAts), 1_199, "the newest entry must survive");
  assert.equal(Math.min(...firstAts), 1_136, "and the trim must cut from the OLD end");
  assert.ok(!firstAts.includes(1_000), "the oldest entry is the first to be dropped");
});
ok("the cap persists, it is not merely a return value", () => assert.equal(j.entryRetryQueue().length, 64));

console.log("\n3. VALIDATED — a malformed entry is refused, a corrupt queue never blocks the poller");
ok("an entry without its event is refused", () =>
  assert.throws(() => j.saveEntryRetryQueue([{ attempts: 1, firstAt: Date.now() }]), /missing its event/));
ok("a negative attempt count is refused", () =>
  assert.throws(() => j.saveEntryRetryQueue([entry(9, "X", { attempts: -1 })]), /non-negative/));
ok("a non-array is refused", () => assert.throws(() => j.saveEntryRetryQueue("nope"), /must be an array/));
j.setMeta("entry_retry_queue", "{ not json");
ok("a corrupt queue reads as empty rather than throwing into the tick", () =>
  assert.deepEqual(j.entryRetryQueue(), []));
j.setMeta("entry_retry_queue", JSON.stringify([{ junk: true }, entry(77, "GOOD")]));
ok("a partially corrupt queue keeps the readable entries", () => {
  const q = j.entryRetryQueue();
  assert.equal(q.length, 1);
  assert.equal(q[0].symbol, "GOOD");
});

console.log("\n4. NO NEW AUTHORITY — the retry path is onEntry, gates and all");
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
ok("the drain calls onEntry rather than a private fast path", () =>
  assert.match(poller, /async function drainEntryRetries\(\)[\s\S]{0,2000}?await onEntry\(e\.event\)/));
ok("no second entry path exists", () =>
  assert.equal((poller.match(/await onEntry\(/g) || []).length, 2,
    "exactly two callers: the feed drain and the retry drain"));
ok("only transport and oracle faults are retried", () =>
  assert.match(poller, /const transient = cls === "transport" \|\| cls === "oracle";/));
ok("a refusal on the merits leaves the queue", () =>
  assert.match(poller, /RETRY \$\{recovered \? "RECOVERED" : "RESOLVED \(refused on its merits\)"\}/));
ok("a recovery is counted ONLY when a position actually opened", () => {
  /* entriesRecovered incremented on any non-throwing onEntry return, so every refusal —
     already holding, call too old, paused, hard-stopped — counted as a recovery and the
     one metric that exists to prove the queue works could not fail. */
  assert.match(poller, /const recovered = !heldBefore && !!S\.positions\[e\.event\?\.mint\];/);
  assert.match(poller, /if \(recovered\) S\.entriesRecovered = \(S\.entriesRecovered \|\| 0\) \+ 1;/);
  assert.match(poller, /else S\.entriesRetryRefused = \(S\.entriesRetryRefused \|\| 0\) \+ 1;/);
});
ok("...and the refused count reaches the heartbeat too", () =>
  assert.equal((poller.match(/entriesRetryRefused: S\.entriesRetryRefused \|\| 0/g) || []).length, 2));
ok("the age ceiling defers to MAX_CALL_AGE_MS instead of inventing a clock", () =>
  assert.match(poller, /now - Number\(e\.firstAt\) > MAX_CALL_AGE_MS/));
ok("retries run before the feed drain so a busy market cannot starve them", () => {
  const drain = poller.indexOf("await drainEntryRetries()");
  const feed = poller.indexOf("executor/feed?after=");
  assert.ok(drain > 0 && feed > 0 && drain < feed, "drainEntryRetries must precede the feed fetch");
});
ok("retries run AFTER manageOpen so existing risk still outranks new exposure", () => {
  const manage = poller.indexOf("await manageOpen();");
  const drain = poller.indexOf("await drainEntryRetries()");
  assert.ok(manage > 0 && manage < drain, "manageOpen must precede the retry drain");
});

console.log("\n5. HONEST — abandonment is counted and visible");
ok("expiry is counted", () => assert.match(poller, /S\.entriesRetryExpired = \(S\.entriesRetryExpired \|\| 0\) \+ 1/));
ok("exhaustion is counted", () => assert.match(poller, /S\.entriesRetryExhausted = \(S\.entriesRetryExhausted \|\| 0\) \+ 1/));
ok("recovery is counted", () => assert.match(poller, /S\.entriesRecovered = \(S\.entriesRecovered \|\| 0\) \+ 1/));
ok("all three reach the heartbeat", () => {
  assert.equal((poller.match(/entriesRecovered: S\.entriesRecovered \|\| 0/g) || []).length, 2);
  assert.equal((poller.match(/entriesRetryAbandoned:/g) || []).length, 2);
});
ok("a call that could not even be queued says so", () =>
  assert.match(poller, /NOT queued; this call is gone/));
/* THE LINE THE WHOLE FEATURE HANGS ON. Everything above tests the queue; this tests
   that anything is ever PUT in it. Without this assertion the entire file passes
   against a poller that still drops every lost call on the floor. */
ok("the lost branch enqueues the call", () =>
  assert.match(poller, /if \(lost\) \{[\s\S]{0,900}?queued = enqueueEntryRetry\(ev, error, cls\);/));
ok("only LOST calls are queued — a refusal on the merits is not owed a retry", () => {
  const m = poller.match(/\} else \{\s*\n\s*S\.entriesRefused[\s\S]{0,400}?\n\s*\}/);
  assert.ok(m, "could not locate the refused branch");
  assert.ok(!/enqueueEntryRetry/.test(m[0]),
    "queuing a refusal would retry a coin the screen already said no to");
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
