/**
 * WHAT A TENANT OWNS, AND WHAT THE TEAM OWNS.
 *
 * The tenant owns two numbers: the money in their bot, and the SOL that goes into each
 * trade. The trading team owns everything else, including which coins are worth trading
 * at all (owner, 2026-09-03).
 *
 * There used to be a wall of per-floor filters — launchpad, category, liquidity floor,
 * market-cap sleeve, conviction bar — and every one of them was a way to receive
 * nothing. The house floor's own bot sat armed for twelve hours on 2026-09-02 while
 * each call it was sent died on one. A customer assembling a filter policy before their
 * bot works has been handed the desk's job.
 *
 *   bankroll_sol    the money the bot is allowed to trade
 *   fixed_sol       0 = auto (bankroll x category x conviction), else the same size
 *   take_profit_x   0 = auto (the desk's authored target), else a hard multiple
 */
import db from "./src/lib/store.js";
import { settingsFor, saveSettings, decide, MCAP_TIERS } from "./src/copy.js";
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const F = 7;
/* A tenant floor seeds 'balanced', whose own note reads "Everything but pure
 * memecoins" — so on a memecoin desk a new floor refuses the house's entire output
 * until its owner changes appetite. Worth knowing, and worth setting here explicitly:
 * without it every assertion below passes or fails on the CATEGORY gate rather than
 * on the dial under test, which is how a green suite ends up proving nothing. */
saveSettings(F, { appetite: "aggressive" });
const call = (over = {}) => ({ mint: "m", symbol: "T", category: "memecoin", launchpad: "pump.fun",
  conviction: 70, liq_at_call: 60_000, mcap_at_call: 900_000, ...over });

console.log("\nDEFAULTS — a tenant who sets nothing gets AUTO on all three");
settingsFor(F);
let s = settingsFor(F);
ok("take profit is auto", Number(s.take_profit_x) === 0, `take_profit_x=${s.take_profit_x}`);
ok("size is auto", Number(s.fixed_sol) === 0, `fixed_sol=${s.fixed_sol}`);
ok("no sleeve filter stands between the team and the bot", decide(F, call({ mcap_at_call: 9_000 })).verdict === "offered");
const autoOffer = decide(F, call());
ok("auto sizing scales with conviction", autoOffer.verdict === "offered" && !/fixed/.test(autoOffer.reason),
  autoOffer.reason);

console.log("\nDIAL 1 — TAKE PROFIT, chosen by the tenant");
saveSettings(F, { takeProfitX: 10 });
ok("10x is stored", Number(settingsFor(F).take_profit_x) === 10);
saveSettings(F, { takeProfitX: 0.5 });
ok("a take profit BELOW entry is clamped, never stored", Number(settingsFor(F).take_profit_x) >= 1.05,
  `${settingsFor(F).take_profit_x}x — 0.5x would be an instruction to sell at a 50% loss`);
saveSettings(F, { takeProfitX: "auto" });
ok("auto is expressible", Number(settingsFor(F).take_profit_x) === 0);

console.log("\n...and it reaches the bot, per position");
const c2 = { mint: "m", symbol: "T", entry_ref: 1, stop: 0.6, target: 2, size_sol: 5 };
const st = { ...freshState(0), equitySol: 5 };
for (const [x, mark, want] of [[2, 2.0, "sell"], [10, 2.0, "hold"], [10, 10.0, "sell"]]) {
  // A tenant-selected target owns the exit; the authored target remains the AUTO
  // fallback. Setting this false mirrors the executor's saved tenant preference.
  const cfg = { ...DEFAULTS, takeProfitX: x, honorDeskTarget: false, fixedSol: 0, scaleOutPct: 0 };
  const p = openPosition({ call: c2, sol: 0.05, fillPrice: 1, cfg });
  const d = stepPosition({ pos: p, mark, cfg });
  ok(`at ${x}x rule, a ${mark}x mark => ${want}`, d.action === want, d.reason);
}

console.log("\nDIAL 2 — FIXED FUND, chosen by the tenant");
saveSettings(F, { fixedSol: 0.05 });
const fixedOffer = decide(F, call());
ok("every trade is the same size", fixedOffer.sizeSol === 0.05, `${fixedOffer.sizeSol} SOL — ${fixedOffer.reason}`);
const fixedOffer2 = decide(F, call({ conviction: 42 }));
ok("...regardless of conviction", fixedOffer2.sizeSol === 0.05, `conviction 42 -> ${fixedOffer2.sizeSol} SOL`);
saveSettings(F, { fixedSol: 900 });
ok("a fixed fund larger than the bankroll is clamped", Number(settingsFor(F).fixed_sol) <= Number(settingsFor(F).bankroll_sol),
  `${settingsFor(F).fixed_sol} SOL vs a ${settingsFor(F).bankroll_sol} SOL bankroll`);
saveSettings(F, { fixedSol: "auto" });
ok("auto is expressible", Number(settingsFor(F).fixed_sol) === 0);
// The dial governs how MUCH, never WHETHER.
const pf = planEntry({ call: c2, cfg: { ...DEFAULTS, fixedSol: 0.02 }, state: { ...st, wins: 3, losses: 29 } });
ok("a fixed fund does NOT override a refusal", pf.action === "skip", pf.reason);

console.log("\nTHE TEAM DECIDES WHAT IS TRADED — no tenant filter can block a call");
/* Each of these was, until 2026-09-03, a per-floor gate that could silently refuse a
 * call the trading team had already researched, sized and published. They are stored
 * settings still (tenants may have set them, and the columns are read elsewhere), but
 * they no longer decide delivery. The assertion is deliberately blunt: with every one
 * of them set to its most exclusive value, the call still arrives. */
saveSettings(F, { mcapTier: "micro", categories: ["established"], launchpads: ["bags.fm"], minLiqUsd: 5_000_000 });
for (const [what, over] of [
  ["a cap far outside the stored sleeve", { mcap_at_call: 900_000 }],
  ["a nano-cap coin",                     { mcap_at_call: 9_000 }],
  ["a category the floor did not list",   { category: "memecoin" }],
  ["a launchpad the floor did not list",  { launchpad: "pump.fun" }],
  ["liquidity under the stored floor",    { liq_at_call: 12_000 }],
  ["conviction under the old bar",        { conviction: 12 }],
  ["an unreadable market cap",            { mcap_at_call: null }],
]) ok(what + " is still delivered", decide(F, call(over)).verdict === "offered", decide(F, call(over)).reason);
saveSettings(F, { mcapTier: "any", categories: null, launchpads: null, minLiqUsd: 0 });
// The brakes that remain are the ones that are not preferences: money, and fees.
ok("a bogus tier name still falls back to a real one",
  (saveSettings(F, { mcapTier: "moon" }), !!MCAP_TIERS[settingsFor(F).mcap_tier]), settingsFor(F).mcap_tier);
saveSettings(F, { mcapTier: "any" });


/* ── THE SLEEVES MUST TILE WHAT THE DESK ACTUALLY PRODUCES ───────────────────
 * They were hardcoded while the desk's ceiling moved to $3m underneath them, which
 * left `mid` covering $3m-$30m — a band no call could ever land in. A tenant who
 * chose it would have waited forever for an arithmetically impossible delivery, with
 * nothing anywhere explaining why. A filter that cannot match anything is worse than
 * a missing filter, because it looks like it is working. */
{
  const { cfg } = await import("./src/config.js");
  const ceiling = cfg.screen.maxMarketCapUsd;
  console.log(`\nSLEEVES vs THE DESK CEILING ($${ceiling.toLocaleString()})`);
  const dead = Object.entries(MCAP_TIERS).filter(([k, v]) => k !== "any" && v.lo >= ceiling);
  ok("no sleeve sits entirely above the ceiling", dead.length === 0,
    dead.length ? dead.map(([k]) => k).join(", ") + " can never receive a call" : "every sleeve is reachable");
  const bands = ["nano", "micro", "low", "medium", "high", "very_high"];
  ok("the sleeves tile the board with no gap",
    bands.slice(0, -1).every((b, i) => MCAP_TIERS[b].hi === MCAP_TIERS[bands[i + 1]].lo),
    bands.join(" -> "));
  ok("the top sleeve ends exactly at the desk's ceiling", MCAP_TIERS.very_high.hi === ceiling,
    `very_high tops out at $${Math.round(MCAP_TIERS.very_high.hi).toLocaleString()}`);
  // A call anywhere on the board must fall in exactly one sleeve.
  for (const mcap of [10_000, 50_000, 250_000, 750_000, 5_000_000]) {
    const hits = Object.entries(MCAP_TIERS)
      .filter(([k, v]) => k !== "any" && mcap >= v.lo && mcap < v.hi).map(([k]) => k);
    ok(`a $${mcap.toLocaleString()} call lands in exactly one sleeve`, hits.length === 1, hits.join(",") || "NONE");
  }
}


/* THE HOLD WINDOWS. A call carries its band's window to the executor, so an edit here
 * changes how long real money sits in a position. The CAP boundaries are the owner's;
 * the CLOCKS on this tower are measured on Robinhood Chain and re-derived from cost
 * (src/bands.js) — the Solana tower keeps the owner's pump.fun clocks. */
{
  const { CAP_BANDS, holdWindowFor } = await import("./src/categories.js");
  const MIN = 60_000, HOUR = 60 * MIN;
  console.log("\nHOLD WINDOWS");
  /* THIS USED TO BE A SECOND COPY OF THE BAND TABLE — the exact minutes, restated as a
     literal. A test that duplicates the value it protects does not protect it; it just
     fails the day that value is legitimately re-measured, which is what happened when the
     clocks were re-derived for Robinhood Chain (src/bands.js). What follows asserts the
     PROPERTIES that must hold on this chain instead. */
  const MEASURED_BREAKEVEN_H = 120;   // src/bands.js: the shortest hold that is not measurably loss-making
  for (const [band, b] of Object.entries(CAP_BANDS)) {
    ok(`${band} has a hold window at all`,
      b.holdMaxMs > 0 && b.holdMinMs > 0 && b.holdMaxMs > b.holdMinMs,
      `${b.holdMinMs / MIN}-${b.holdMaxMs / MIN} min`);
    /* THE INVARIANT THAT MATTERS HERE. A round trip on this chain costs 7.35% at the
       cheapest clip and 9.16% at the operator's cap, and the median trade cannot clear
       that until roughly the five-day mark — measured two independent ways, and traded
       over 41 days (1h -14.71%, 24h -7.36%, 72h -2.31%, 120h +2.19%). A band that closes
       sooner is a forced sale into a cost the move has not had time to cover. */
    ok(`${band} is not held for less than the measured break-even horizon`,
      b.holdMaxMs >= MEASURED_BREAKEVEN_H * HOUR,
      `${(b.holdMaxMs / HOUR).toFixed(0)}h vs the ${MEASURED_BREAKEVEN_H}h floor`);
  }
  ok("a $9k cap resolves to the nano window",
    holdWindowFor(9_000)?.holdMaxMs === CAP_BANDS.nano.holdMaxMs);
  ok("a $5m cap resolves to the very-high window",
    holdWindowFor(5_000_000)?.holdMaxMs === CAP_BANDS.very_high.holdMaxMs);
  ok("an unreadable cap has no window", holdWindowFor(null) === null && holdWindowFor(0) === null);
  ok("a cap off the board has no window", holdWindowFor(50_000_000) === null);
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
