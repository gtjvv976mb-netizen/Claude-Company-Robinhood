/**
 * A SIZE THAT CANNOT BE EXECUTED IS NOT AN OFFER.
 *
 * Gas does not scale with trade size, so below a certain notional it eats the trade —
 * and on Robinhood Chain that is the whole cost model: a round trip measured ~661k gas
 * for both legs on 2026-09-04, a flat ~$0.54 whether the clip is $6 or $6,000. On the
 * Solana desk this was measured live: every call for a day was offered between 0.0015
 * and 0.0092 SOL and every one was correctly refused by the executor as "costs eat the
 * target" — the floor was publishing arithmetically impossible trades and the bot was
 * right to decline them. The columns are ETH now (bankroll_eth / fixed_eth, 2026-09-05)
 * and the executable floor is MIN_EXECUTABLE_ETH (0.01 ETH without a gas quote); the
 * shape of the failure is the same.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/exec-size-test.db";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

const copy = await import("./src/copy.js");
const db = (await import("./src/lib/store.js")).default;

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const FLOOR = 7;
const FLOOR_ETH = copy.MIN_EXECUTABLE_ETH;
copy.settingsFor(FLOOR);   // materialise the row
const setFloor = (bankrollEth, fixedEth = 0) =>
  db.prepare("UPDATE copy_settings SET bankroll_eth=?, fixed_eth=?, appetite='aggressive' WHERE floor_no=?")
    .run(bankrollEth, fixedEth, FLOOR);

// A call the desk sized at a fraction of a large paper book — the shape that produced
// 0.0015 SOL offers in production: 0.034% of book on a 0.4 ETH bankroll is 0.000136 ETH.
const tinyCall = {
  id: 1, mint: "0x00000000000000000000000000000000000000a1", symbol: "DOGE-1", category: "memecoin", launchpad: "PONS",
  conviction: 55, entry_ref: 0.000334, stop: 0.000246, target: 0.00044,
  liq_at_call: 200000, mcap_at_call: 400000,
  desk_size_usd: 3.4, desk_equity_usd: 10000,     // 0.034% of book
};

console.log(`\nAN UNEXECUTABLE SIZE IS LIFTED TO ONE THAT WORKS (floor ${FLOOR_ETH} ETH)`);
// 0.4 ETH bankroll (the DEFAULT_BANKROLL_ETH), aggressive = 3% = 0.012 ETH per trade: room to lift.
setFloor(0.4);
const lifted = copy.decide(FLOOR, tinyCall);
ok("the call is still offered", lifted.verdict === "offered", lifted.reason);
ok("...at a size that can clear flat gas", lifted.sizeEth >= FLOOR_ETH,
  `${lifted.sizeEth} ETH — the uncapped size was 0.000136 ETH, where a $0.54 round trip is the whole trade`);
ok("...and the lift is disclosed in the reason", /gas does not eat the trade/.test(lifted.reason || ""));

console.log("\nTHE LIFT NEVER EXCEEDS THE RISK THE TENANT CHOSE");
// 0.3 ETH bankroll: the capped size is 0.0001 ETH (just enough not to round to nothing)
// and aggressive = 3% = 0.009 ETH per trade, under the 0.01 floor — so no room to lift.
setFloor(0.3);
const refused = copy.decide(FLOOR, tinyCall);
ok("a bankroll too small to trade is told so, not handed an impossible trade",
  refused.verdict === "skipped" && /gas eats the trade/.test(refused.reason),
  refused.reason);

console.log("\nAN EXPLICIT FIXED SIZE IS THE TENANT'S CHOSEN RISK");
// The house seed's shape (0.05 ETH bankroll / 0.016 ETH fixed — the ETH translation of
// the owner's 0.6/0.2 SOL, awaiting owner confirmation): the appetite percentage alone
// is 0.0015 ETH, under the floor, but the owner stated a size. Fixed means fixed.
setFloor(0.05, 0.016);
const fixedFloor = copy.decide(FLOOR, tinyCall);
ok("a floor with a fixed size is offered that size, at or above the executable minimum",
  fixedFloor.verdict === "offered" && fixedFloor.sizeEth === 0.016 && fixedFloor.sizeEth >= FLOOR_ETH,
  `${fixedFloor.verdict} ${fixedFloor.sizeEth ?? ""} — ${(fixedFloor.reason || "").slice(0, 90)}`);
ok("...and it is not reported as lifted", !/lifted to/.test(fixedFloor.reason || ""), fixedFloor.reason);
setFloor(0.3, 0);
const noFixed = copy.decide(FLOOR, tinyCall);
ok("...and without one, the same tiny bankroll is still refused honestly",
  noFixed.verdict === "skipped" && /gas eats the trade/.test(noFixed.reason), noFixed.reason);

console.log("\nA NORMAL SIZE IS UNTOUCHED");
// 10 ETH aggressive on a memecoin at conviction 55: 10 × 3% × 0.25 × 0.55 = 0.04125 ETH,
// under the team's 2% book cap (0.2 ETH) and above the floor — nothing to lift.
setFloor(10);
const normal = copy.decide(FLOOR, { ...tinyCall, desk_size_usd: 200, desk_equity_usd: 10000 });
ok("a size already above the floor is not lifted",
  normal.verdict === "offered" && normal.sizeEth > FLOOR_ETH &&
  !/gas does not eat/.test(normal.reason || ""),
  `${normal.sizeEth} ETH (expected 0.0413)`);
ok("the SOL alias still reads the same number for one release", normal.sizeSol === normal.sizeEth);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
