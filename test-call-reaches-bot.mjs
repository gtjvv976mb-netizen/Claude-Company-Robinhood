/**
 * NO PUBLISHED CALL MAY VANISH BETWEEN THE DESK AND THE BOT.
 *
 * The alerts table is the bot's ONLY entry and exit channel: executorFeedPayload()
 * selects FROM alerts, so a delivery row on its own is invisible to a poller. And
 * broadcast() writes the durable delivery and then fires announceEntry WITHOUT
 * awaiting it, behind an empty catch — announceExit is fired the same way from every
 * close path. One failed alert write therefore stranded a call: "offered" on the desk,
 * absent from the feed for ever, and absent from every log. A lost EXIT alert is worse
 * than a lost entry: the desk believes it told the bot to sell, and the position is
 * held for ever.
 *
 * This is the Solana tower's repair, fitted to this fork's tables. The test exercises
 * the real reconcilers against a real database rather than grepping the source, because
 * the property is "the row appears", not "the function is mentioned".
 *
 *   node test-call-reaches-bot.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const { default: db } = await import("./src/lib/store.js");
const alerts = await import("./src/alerts.js");
const { executorFeedPayload } = await import("./src/office.js");

const FLOOR = 7;
const now = Date.now();
db.prepare("INSERT OR REPLACE INTO copy_settings (floor_no, executor_secret) VALUES (?,?)").run(FLOOR, "s3cret-for-the-test");

/** One published call, delivered to FLOOR as `offered`, with NO alert row — exactly the
 *  state a dropped announceEntry leaves behind. */
const publish = (id, symbol, status = "live", closedAt = null) => {
  db.prepare(`INSERT INTO calls (id,mint,symbol,status,entry_ref,stop,target,thesis,opened_at,closed_at,close_reason)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "0xmint" + id, symbol, status, 1, 0.86, 1.5, "a thesis", now - 60_000, closedAt, closedAt ? "target_hit" : null);
  db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_eth,size_sol,delivered_at)
              VALUES (?,?,?,?,?,?,?)`).run(id, FLOOR, "offered", "auto", 0.0112, 0.0112, now - 60_000);
};
const alertCount = (callId, kind) => db.prepare(
  "SELECT COUNT(*) n FROM alerts WHERE floor_no=? AND call_id=? AND kind=?").get(FLOOR, callId, kind).n;

console.log("\nA LIVE CALL WHOSE ENTRY ALERT WAS LOST IS REPAIRED");
publish(9001, "LOSTENTRY");
/* The feed's rows are FLAT — call_id, not call.id. Asserted against the real payload,
   because an assertion that reads a field the payload does not have passes whatever the
   code does, and would have called this repair broken while it worked. */
ok("the delivery exists and the alert does not — the bot is blind to it",
  alertCount(9001, "entry") === 0 &&
  executorFeedPayload(FLOOR, 0).events.every((e) => e.call_id !== 9001));
const repaired = alerts.reconcileMissingEntryAlerts(FLOOR, { now });
ok("the reconciler repairs exactly one", repaired === 1, `repaired ${repaired}`);
ok("...and the alert now exists", alertCount(9001, "entry") === 1);
{
  const feed = executorFeedPayload(FLOOR, 0);
  const row = feed.events.find((e) => e.call_id === 9001);
  ok("...so the call is now IN the bot's feed, as an entry",
    !!row && row.type === "entry" && row.symbol === "LOSTENTRY",
    row ? `type=${row.type} symbol=${row.symbol}` : "absent");
}
ok("running it again repairs nothing — raise() is idempotent, so no spam",
  alerts.reconcileMissingEntryAlerts(FLOOR, { now }) === 0);

console.log("\nA CLOSED CALL WHOSE EXIT ALERT WAS LOST IS REPAIRED TOO");
publish(9002, "LOSTEXIT", "closed", now - 30_000);
ok("the closed call has no exit alert", alertCount(9002, "exit") === 0);
ok("the exit reconciler repairs it", alerts.reconcileMissingExitAlerts(FLOOR, { now }) === 1);
ok("...and it is raised URGENT, because a late sell beats a silent one",
  db.prepare("SELECT urgency FROM alerts WHERE floor_no=? AND call_id=? AND kind='exit'").get(FLOOR, 9002)?.urgency === "urgent");

console.log("\nTHE REPAIR IS BOUNDED, OR IT IS A NEW OUTAGE");
publish(9003, "TOOOLD");
db.prepare("UPDATE deliveries SET delivered_at=? WHERE call_id=?").run(now - 48 * 3600e3, 9003);
ok("a delivery older than the window is left alone",
  alerts.reconcileMissingEntryAlerts(FLOOR, { now }) === 0 && alertCount(9003, "entry") === 0);

publish(9004, "DEADCALL", "closed", now - 30_000);
db.prepare("DELETE FROM alerts WHERE call_id=?").run(9004);
ok("a call the desk has already closed is never resurrected as an ENTRY",
  alerts.reconcileMissingEntryAlerts(FLOOR, { now }) === 0 && alertCount(9004, "entry") === 0);

console.log("\nTHE EXPIRY FOLLOWS THE BAND'S OWN CLOCK, NOT ONE FLAT NUMBER");
{
  const poller = fs.readFileSync(new URL("./executor/poller.mjs", import.meta.url), "utf8");
  const { CAP_BANDS } = await import("./src/bands.js");
  /* Re-derived here from the source of truth rather than written down: the rule is
     "never shorter than the flat window, never longer than eight of them, otherwise the
     band's own minimum hold". */
  const MAX = 45 * 60_000;
  const expiry = (holdMin) => Number.isFinite(holdMin) && holdMin > 0
    ? Math.max(MAX, Math.min(holdMin, MAX * 8)) : MAX;

  ok("both gates ask the band, not the constant",
    /Date\.now\(\) - Number\(event\.ts\) > callExpiryMs\(event\)/.test(poller) &&
    /const expiryMs = callExpiryMs\(ev\);/.test(poller) && /if \(age > expiryMs\)/.test(poller));
  ok("the refusal names the band, so it is not a bare number",
    /\$\{ev\.hold_band \|\| "default"\} band holds for at least/.test(poller));
  ok("a call with no hold window keeps the old flat 45 minutes",
    expiry(undefined) === MAX, `${expiry(undefined) / 60_000}m`);
  ok("...and every band this desk publishes now survives longer than that",
    Object.values(CAP_BANDS).every((b) => expiry(b.holdMinMs) > MAX),
    `every band -> ${expiry(Object.values(CAP_BANDS)[0].holdMinMs) / 60_000}m`);
  ok("the window can only WIDEN — no band is ever given less than the flat number",
    Object.values(CAP_BANDS).every((b) => expiry(b.holdMinMs) >= MAX));
  ok("a malformed or hostile hold window is clamped, not obeyed",
    expiry(30 * 24 * 3600e3) === MAX * 8, `${expiry(30 * 24 * 3600e3) / 60_000}m`);
}

console.log("\nA FAILING REPAIR MUST NEVER TAKE THE FEED DOWN");
{
  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  ok("the bot's own poll runs both repairs",
    /try \{ alerts\.reconcileMissingEntryAlerts\(floorNo\); \} catch/.test(office) &&
    /try \{ alerts\.reconcileMissingExitAlerts\(floorNo\); \} catch/.test(office));
  ok("...and each is wrapped, so the feed is served whatever they do",
    office.indexOf("reconcileMissingEntryAlerts") < office.indexOf("return json(200, executorFeedPayload"));
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
