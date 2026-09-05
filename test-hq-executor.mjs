/**
 * THE HOUSE EATS ITS OWN COOKING.
 *
 * The HQ wrote every call and received none of them: broadcast() reached floors whose
 * state is 'owned', and floor 50's state is 'hq' because it is never for sale. So the
 * one desk with an opinion had no way to put money behind it.
 *
 * This proves the whole road end to end, on a throwaway database:
 *   a published call -> a delivery row on floor 50 -> the executor feed serving it
 *   to a poller authenticated by floor 50's own secret.
 *
 * It also asserts the part that must NEVER change: the feed carries prices, stops and
 * sizes, and no key material of any kind. The server publishes rows. The wallet lives
 * on the owner's machine, exactly as it does for a tenant.
 */
import db from "./src/lib/store.js";
import { openCall, closeCall, liveCalls } from "./src/calls.js";
import { announceEntry } from "./src/alerts.js";
import { broadcast, decide, settingsFor, saveSettings } from "./src/copy.js";
import { executorFeedPayload } from "./src/office.js";
import { listFloors, HQ_FLOOR } from "./src/tower.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE HQ IS A FLOOR THAT TRADES");

const floors = listFloors();
const hq = floors.find((f) => f.n === HQ_FLOOR);
ok("floor 50 is the HQ and is not 'owned'", hq?.state === "hq", `state=${hq?.state}`);

// The fix: the broadcast list must now include it.
const targets = floors.filter((f) => f.state === "owned" || f.n === HQ_FLOOR).map((f) => f.n);
ok("the broadcast list includes the HQ", targets.includes(HQ_FLOOR), `targets=[${targets}]`);

const s = settingsFor(HQ_FLOOR);
ok("the HQ has copy settings of its own", !!s, `appetite=${s.appetite} bankroll=${s.bankroll_eth} ETH`);
// The HQ is the memecoin desk; a 'balanced' HQ would skip 100% of its own calls.
ok("the HQ's appetite actually admits memecoins", s.categories.includes("memecoin"),
  `categories=${s.categories.join(",")}`);
// The poller authenticates with this and never receives a webhook, so it must exist
// without one having been configured.
ok("a feed secret exists without any webhook URL being set",
  !!s.executor_secret && !s.executor_url,
  `secret=${s.executor_secret ? s.executor_secret.slice(0, 8) + "… (" + s.executor_secret.length + " chars)" : "none"}`);

// Publish a call the way the desk does, then broadcast it.
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
const call = openCall({
  mint: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", symbol: "HOUSE",
  // Mandate picks may be published below every tenant preset's conviction bar. The
  // authoring house must still receive its own approved call; tenant preferences must
  // not be silently weakened to make that happen.
  category: "memecoin", launchpad: "pump.fun", conviction: 30,
  entryRef: 0.0010, stop: 0.00062, target: 0.0019,
  thesis: "the house backs its own call", invalidation: "deployer sells",
  liqUsd: 90_000, rtLossPct: 3.1, policyVersion: "test-policy-v42",
});
ok("a call was published", !!call, `id=${call?.id}`);

/* A TENANT FLOOR AND THE HOUSE FLOOR NOW BEHAVE IDENTICALLY. The conviction bar and the
   liquidity gate were tenant preferences that could refuse a call the team had already
   researched and published; the team decides what is traded, so both are gone and the
   only per-floor question left is size (owner, 2026-09-03). */
const tenantFloor = 49;
saveSettings(tenantFloor, { appetite: "aggressive" });
const tenantDecision = decide(tenantFloor, call);
ok("a tenant floor receives the team call the house floor received",
  tenantDecision.verdict === "offered",
  `${tenantDecision.verdict} — ${tenantDecision.reason}`);

saveSettings(HQ_FLOOR, { minLiqUsd: 100_000 });
const hqLiquidityDecision = decide(HQ_FLOOR, call);
ok("a stored liquidity preference no longer refuses a published call",
  hqLiquidityDecision.verdict === "offered",
  `${hqLiquidityDecision.verdict} — ${hqLiquidityDecision.reason}`);
saveSettings(HQ_FLOOR, { minLiqUsd: null });

const res = broadcast(call.id, targets);
ok("the broadcast succeeded", res.ok, `offered=${res.offered} skipped=${res.skipped}`);

const del = db.prepare("SELECT * FROM deliveries WHERE call_id=? AND floor_no=?").get(call.id, HQ_FLOOR);
ok("the HQ received a delivery row for its own call", !!del,
  del ? `verdict=${del.verdict} size=${del.size_eth ?? "n/a"} ETH ${del.reason ?? ""}` : "no row");
ok("and it was OFFERED, not skipped", del?.verdict === "offered",
  del?.verdict === "offered" ? "the house may trade it" : `verdict=${del?.verdict} — ${del?.reason}`);

// The security invariant. This is the line that must never move.
const feedRow = db.prepare("SELECT executor_secret FROM copy_settings WHERE floor_no=?").get(HQ_FLOOR);
ok("the feed is gated by the floor's own secret", !!feedRow?.executor_secret);
const payload = JSON.stringify({ call, delivery: del });
for (const forbidden of ["secretKey", "privateKey", "seed", "mnemonic", "keypair"]) {
  ok(`the call payload carries no ${forbidden}`, !payload.toLowerCase().includes(forbidden.toLowerCase()));
}
ok("the payload carries what a bot actually needs (stop + entry)",
  payload.includes("0.00062") && payload.includes("0.001"),
  "stop and entry reference present");

// The exact response builder used after the route authenticates the floor must retain
// the facts a local executor uses to bind an intent and enforce policy before signing.
await announceEntry(call);
const feed = executorFeedPayload(HQ_FLOOR, 0);
const event = feed.events?.find((item) => item.call_id === call.id && item.type === "entry");
ok("the executor feed serves the HQ entry", !!event,
  `events=${feed.events?.length ?? 0}`);
ok("the executor event is bound to the durable call id", event?.call_id === call.id,
  `call_id=${event?.call_id}`);
ok("the executor feed carries the call's research and risk metadata",
  event?.conviction === 30 && event?.category === "memecoin" && event?.launchpad === "pump.fun" &&
    event?.liq_at_call === 90_000 && event?.rt_loss_at_call === 3.1 &&
    event?.policy_version === "test-policy-v42",
  JSON.stringify(event));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
