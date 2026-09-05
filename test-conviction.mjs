/**
 * THE CONVICTION SCREEN — the owner's thesis, checked against cases with known answers.
 *
 * "Coins which will definitely go 1000x" have, in the owner's words: whales in them, and
 * it matters WHICH whales; an X trend; an active account with a real following; and a
 * $100k-$500k market cap. This file checks that the arithmetic says what a person
 * reading that sentence would say, and — more importantly — that it never pretends to
 * know something it was not told. On this chain the whale term is exactly that case:
 * there is no roster, so it must score nothing and SAY so, not penalise every coin.
 */
import { convictionScore, whaleRoster, whalesOn, convictionBoard,
  CONVICTION_WEIGHTS, HIT_MULTIPLE, MIN_CALLS_FOR_RECORD } from "./src/conviction.js";
import db from "./src/lib/store.js";
import "./src/callouts.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const whale = (proven, username = "w") => ({ caller: username + "-wallet", username,
  record: { proven, hitRate: proven ? 0.7 : null, calls: proven ? 5 : 1 } });
const hot = { trend_stage: "emerging", velocity: "accelerating", mentions_level: "high",
  dev_followers: 24_000, dev_engaging_now: true };

console.log("\nTHE OWNER'S FIVE CHARACTERISTICS, EACH ONE COUNTING — EXCEPT THE ONE THIS CHAIN CANNOT MEASURE");
{
  const base = convictionScore({ marketCapUsd: 250_000 });
  const withWhales = convictionScore({ marketCapUsd: 250_000, whales: [whale(true), whale(true, "b")] });
  ok("whales add nothing while there is no roster", withWhales.score === base.score, `${base.score} -> ${withWhales.score}`);
  ok("...because the cap is zero, not because the weights are", CONVICTION_WEIGHTS.whaleCap === 0 && CONVICTION_WEIGHTS.provenWhale > 0,
    `cap ${CONVICTION_WEIGHTS.whaleCap}, proven ${CONVICTION_WEIGHTS.provenWhale}`);
  ok("...and the score says why", withWhales.missing.includes("no whale roster on this chain yet"), withWhales.missing.join("; "));
  ok("the sweet-spot band beats every other band",
    convictionScore({ marketCapUsd: 250_000 }).score > convictionScore({ marketCapUsd: 80_000 }).score &&
    convictionScore({ marketCapUsd: 250_000 }).score > convictionScore({ marketCapUsd: 9_000 }).score &&
    convictionScore({ marketCapUsd: 250_000 }).score > convictionScore({ marketCapUsd: 5_000_000 }).score,
    "$250k scores above $80k, $9k and $5m");
  ok("a coin already above $1m is marked down, not up",
    convictionScore({ marketCapUsd: 5_000_000 }).score < 0);
  ok("an emerging X trend beats a fading one",
    convictionScore({ xRead: { trend_stage: "emerging" } }).score >
    convictionScore({ xRead: { trend_stage: "fading" } }).score);
  ok("a big following beats a thin one",
    convictionScore({ xRead: { dev_followers: 24_000 } }).score >
    convictionScore({ xRead: { dev_followers: 40 } }).score);
  ok("a thin following is a PENALTY, not merely zero",
    convictionScore({ xRead: { dev_followers: 40 } }).score < 0);
}

console.log("\nTHE COIN THE OWNER DESCRIBED SCORES ABOVE EVERYTHING ELSE");
{
  const ideal = convictionScore({ marketCapUsd: 250_000, whales: [whale(true), whale(true, "b"), whale(false, "c")], xRead: hot });
  const noWhales = convictionScore({ marketCapUsd: 250_000, xRead: hot });
  const wrongBand = convictionScore({ marketCapUsd: 6_000_000, whales: [whale(true), whale(true, "b"), whale(false, "c")], xRead: hot });
  const dead = convictionScore({ marketCapUsd: 250_000, whales: [],
    xRead: { trend_stage: "fading", dev_followers: 30, deleted_history: true } });
  ok("the full picture scores highest", ideal.score >= noWhales.score && ideal.score > wrongBand.score && ideal.score > dead.score,
    `ideal ${ideal.score}, no whales ${noWhales.score}, wrong band ${wrongBand.score}, dead ${dead.score}`);
  ok("...and with no roster, whales cannot separate two otherwise identical coins",
    ideal.score === noWhales.score, `${ideal.score} == ${noWhales.score}`);
  ok("a rug-shaped coin scores below zero", dead.score < 0, `${dead.score}`);
  ok("every point is explained", ideal.reasons.length >= 4, ideal.reasons.slice(0, 3).join(" | "));
  ok("whale count is still reported honestly", ideal.whaleCount === 3 && ideal.provenWhaleCount === 2);
}

console.log("\nIT NEVER PRETENDS TO KNOW WHAT IT WAS NOT TOLD");
{
  const blind = convictionScore({});
  ok("a coin with no evidence scores zero, not high", blind.score === 0, `${blind.score}`);
  ok("...and says exactly what is missing",
    blind.missing.includes("market cap") && blind.missing.includes("X read") &&
    blind.missing.some((m) => /whale/.test(m)), blind.missing.join("; "));
  ok("a coin scored without an X read admits it",
    convictionScore({ marketCapUsd: 250_000, whales: [whale(true)] }).missing.includes("X read"));
  ok("the missing roster is stated as the DESK's gap, not the coin's",
    convictionScore({ marketCapUsd: 250_000, xRead: hot }).missing.some((m) => /no whale roster on this chain yet/.test(m)) &&
    !convictionScore({ marketCapUsd: 250_000, xRead: hot }).missing.some((m) => /no verified whale seen/.test(m)));
  ok("whale credit is capped, so headcount alone cannot carry a coin",
    convictionScore({ whales: Array.from({ length: 40 }, (_, i) => whale(true, `w${i}`)) }).score
      === CONVICTION_WEIGHTS.whaleCap, `cap ${CONVICTION_WEIGHTS.whaleCap}`);
}

/* The reader is KEPT so a future roster (an on-chain proven-address source writing the
   same columns — docs/HANDOFF-agents.md) turns the term on by raising the cap. Its
   arithmetic is still checked here against rows with known answers. */
console.log("\nTHE ROSTER READER STILL WORKS, FOR THE DAY THERE IS A ROSTER");
{
  db.exec("DELETE FROM verified_callouts");
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO verified_callouts
    (mint,caller,symbol,username,multiple,wallet_sol_usd,called_at,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // A caller with a real record: four calls, three of which at least doubled.
  for (const [mint, mult] of [["m1", 5.2], ["m2", 2.1], ["m3", 3.4], ["m4", 0.7]])
    ins.run(mint, "GOOD", mint.toUpperCase(), "goodwhale", mult, 40_000, now - 3600e3, now - 3600e3, now - 60_000);
  // A caller with one lucky call: not enough to rate.
  ins.run("m1", "LUCKY", "M1", "luckywhale", 9.9, 12_000, now - 3600e3, now - 3600e3, now - 60_000);
  // A caller whose calls all died.
  for (const [mint, mult] of [["m5", 0.3], ["m6", 0.4], ["m7", 0.2]])
    ins.run(mint, "BAD", mint.toUpperCase(), "badwhale", mult, 8_000, now - 3600e3, now - 3600e3, now - 60_000);

  const roster = whaleRoster({ now });
  const good = roster.find((w) => w.caller === "GOOD");
  const lucky = roster.find((w) => w.caller === "LUCKY");
  const bad = roster.find((w) => w.caller === "BAD");
  ok("a caller with 3 hits of 4 is proven", good?.proven === true, `hitRate ${good?.hitRate?.toFixed(2)}`);
  ok("one lucky call is not a record", lucky?.proven === false && lucky?.hitRate === null,
    `${lucky?.calls} call, hitRate ${lucky?.hitRate}`);
  ok("...because a rating needs at least " + MIN_CALLS_FOR_RECORD + " calls", MIN_CALLS_FOR_RECORD >= 3);
  ok("a caller whose calls all died is rated and not proven", bad?.proven === false && bad?.hitRate === 0,
    `hitRate ${bad?.hitRate}`);
  ok("a hit is a double or better", HIT_MULTIPLE === 2 && good.hits === 3, `${good.hits} hits`);
  ok("the wallet size is carried", good?.walletUsd === 40_000);

  const on = whalesOn("m1", { now });
  ok("the coin two callers touched lists both", on.length === 2, on.map((w) => w.username).join(", "));
  ok("...with the proven one first", on[0].record?.proven === true, on[0].username);
  ok("a coin nobody called lists nobody", whalesOn("never-called", { now }).length === 0);

  const board = convictionBoard({ now, marketCaps: new Map([["m1", 250_000], ["m5", 250_000]]) });
  const m1 = board.find((b) => b.mint === "m1"), m5 = board.find((b) => b.mint === "m5");
  ok("with the cap at zero the board cannot rank the whale-backed coin above the dead one — and says so",
    m1 && m5 && m1.score === m5.score && m1.missing.includes("no whale roster on this chain yet"),
    `${m1?.mint}:${m1?.score} ${m5?.mint}:${m5?.score}`);
  ok("...while still reporting who was on it", m1.whales.length === 2 && m5.whales.length === 1);
  db.exec("DELETE FROM verified_callouts");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
