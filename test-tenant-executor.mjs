/**
 * A TENANT FLOOR TRADES THE SAME ROAD THE HOUSE DOES.
 *
 * test-hq-executor.mjs proved the house's own floor receives its calls. Shipping the
 * bot to every floor means a LEASED floor with untouched defaults must receive a
 * published call as an executable offer, see it on its own secret-gated executor
 * feed with size, rules and verdicts, and never see key material. Every route is
 * parameterised by floor number; this pins that no house-only assumption crept in.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/tenant-executor-test.db";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const db = (await import("./src/lib/store.js")).default;
const { openCall, closeCall, liveCalls } = await import("./src/calls.js");
const alerts = await import("./src/alerts.js");
const { broadcast, decide, settingsFor, saveSettings, MIN_EXECUTABLE_ETH } = await import("./src/copy.js");
const { executorFeedPayload } = await import("./src/office.js");
const { listFloors } = await import("./src/tower.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nA LEASED FLOOR WITH DEFAULT SETTINGS");
const FLOOR = 7;
const WALLET = "0x7e57000000000000000000000000000000000007";   // an EVM tenant, lowercase as stored
db.prepare("UPDATE floors SET state='owned', owner=?, name=?, claimed_at=? WHERE n=?")
  .run(WALLET, "Seventh Floor Capital", Date.now(), FLOOR);
ok("floor 7 is leased", listFloors().find((f) => f.n === FLOOR)?.state === "owned");
const s = settingsFor(FLOOR);
ok("a fresh floor is seeded with the appetite this desk actually publishes for",
  s.appetite === "aggressive" && Number(s.bankroll_eth) > 0, `appetite=${s.appetite} bankroll=${s.bankroll_eth} ETH`);
ok("...and its own feed secret, with no webhook", !!s.executor_secret && !s.executor_url,
  `${s.executor_secret.length} chars`);

console.log("\nA PUBLISHED CALL REACHES THE TENANT AS AN EXECUTABLE OFFER");
for (const c of liveCalls()) closeCall(c.id, "test_reset", 1);
const call = openCall({
  mint: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "TNT",
  category: "memecoin", launchpad: "pump.fun", conviction: 62,
  entryRef: 0.0010, stop: 0.00075, target: 0.0021,
  thesis: "a tenant-grade call", invalidation: "volume dies",
  liqUsd: 120_000, rtLossPct: 1.2, policyVersion: "test-policy-v42",
  deskSizeUsd: 3.4, deskEquityUsd: 10_000,   // the house's tiny proportional allocation
});
const d = decide(FLOOR, call);
ok("the default tenant is OFFERED the call", d.verdict === "offered", `${d.verdict} — ${(d.reason || "").slice(0, 90)}`);
const SZ = (x) => Number(x.sizeEth ?? x.sizeSol);
ok(`...at a size that clears gas (>= MIN_EXECUTABLE_ETH ${MIN_EXECUTABLE_ETH})`, SZ(d) >= MIN_EXECUTABLE_ETH, `${SZ(d)} ETH`);
const res = broadcast(call.id, [FLOOR]);
ok("broadcast delivered to the tenant", res.ok && res.offered === 1, `offered=${res.offered} skipped=${res.skipped}`);
await alerts.announceEntry(call);
const feed = executorFeedPayload(FLOOR, 0);
const ev = (feed.events || []).find((e) => e.call_id === call.id && e.type === "entry");
ok("the tenant's executor feed serves the ENTRY", !!ev, ev ? `symbol=${ev.symbol} size=${ev.size_eth}` : "no event");
/* THE FEED CONTRACT (office → executor). The poller asserts payload.chain === 4663 before
   it acts; sizes ride as ETH decimal strings under fixed_eth / size_eth. */
ok("the feed names Robinhood Chain", feed.chain === 4663 && feed.cluster === "robinhood-4663",
  `chain=${feed.chain} cluster=${feed.cluster}`);
ok("...with the bot's sizing as an ETH decimal string and the floor's rules",
  ev && typeof ev.size_eth === "string" && Number(ev.size_eth) >= MIN_EXECUTABLE_ETH && feed.rules && "fixed_eth" in feed.rules &&
  typeof feed.rules.fixed_eth === "string" && !("fixed_sol" in feed.rules) && !("size_sol" in ev),
  ev ? `size ${ev.size_eth}, rules ${JSON.stringify(feed.rules)}` : "");
ok("...and the floor's verdicts ride the feed, sized in ETH", Array.isArray(feed.decisions) && feed.decisions[0]?.verdict === "offered" &&
  typeof feed.decisions[0].size_eth === "string" && !("size_sol" in feed.decisions[0]),
  feed.decisions?.[0] ? `${feed.decisions[0].symbol} ${feed.decisions[0].verdict} ${feed.decisions[0].size_eth}` : "no decisions");
const payload = JSON.stringify(feed).toLowerCase();
for (const forbidden of ["secretkey", "privatekey", "seed", "mnemonic", "keypair"])
  ok(`the tenant feed carries no ${forbidden}`, !payload.includes(forbidden));

console.log("\nAN EXPLICIT FIXED SIZE IS HONOURED ON A TENANT FLOOR TOO");
saveSettings(FLOOR, { fixedEth: 0.05 });
const fixed = decide(FLOOR, call);
ok("a tenant who states 0.05 ETH is offered at least the executable minimum",
  fixed.verdict === "offered" && SZ(fixed) >= MIN_EXECUTABLE_ETH, `${fixed.verdict} ${SZ(fixed)}`);

console.log("\nTHE EXIT FOLLOWS THE SAME ROAD");
closeCall(call.id, "target_hit", 0.0021);
if (typeof alerts.announceExit === "function") {
  await alerts.announceExit(call, { urgency: "unconditional", code: "target_hit", detail: "target reached — the desk is out" });
  const after = executorFeedPayload(FLOOR, ev?.id ?? 0);
  const exit = (after.events || []).find((e) => e.call_id === call.id && e.type === "exit");
  ok("the tenant's feed serves the EXIT for a call it was offered", !!exit, exit ? `id=${exit.id}` : "no exit event");
} else {
  ok("exit announcer is exported", false, "announceExit not found on alerts.js");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
