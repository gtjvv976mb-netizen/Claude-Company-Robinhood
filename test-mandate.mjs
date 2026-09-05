/**
 * THE MANDATE'S TESTS.
 *
 * The mandate deliberately lowers the desk's CONVICTION bar so that every cycle ends
 * in a trade. That is only defensible if the SAFETY bar is provably untouched — so
 * most of what follows is an attempt to smuggle an unsafe token past it.
 *
 * Runs against a throwaway database. It never touches the live journal.
 *   CLAUDE_CO_DB=/tmp/x.db node test-mandate.mjs
 */
import { eligibility, contenderScore, pickOne, bookState, MAX_LIVE_CALLS } from "./src/mandate.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

/** A workup record that is clean in every respect — the control. */
const good = (over = {}) => ({
  mint: "So11111111111111111111111111111111111111112",
  symbol: "CTRL",
  outcome: "decided",
  weighted: 68,
  finalDecision: "APPROVED",
  pm: { decision: "PROPOSE", conviction: 70, thesis: "t", invalidation: "deployer sells" },
  redteam: { verdict: "survives", headline: "h" },
  compliance: { pass: true, violations: [] },
  risk: { position_size_usd: 50, stop_price: 0.8, max_loss_usd: 10 },
  ceo: { ruling: "APPROVE", order_size_usd: 50 },
  order: { size: 50 },
  ticket: { stop_price: 0.8, take_profit: [{ price: 1.9 }] },
  ev: { pair: { priceUsd: 1.0, priceChange: { m5: 2 } } },
  ...over,
});

console.log("\nCONTROL — a clean approval must be eligible");
{
  const e = eligibility(good());
  ok("clean record is eligible", e.eligible === true, e.reason);
  ok("clean approval is tier 4", e.tier === 4, `tier=${e.tier}`);
}

console.log("\nSAFETY — none of these may EVER be published, mandate or not");
const unsafe = [
  ["no data",                  { outcome: "no_data" }],
  ["workup errored",           { outcome: "error", error: "boom" }],
  ["failed the screen",        { outcome: "screened_out", fails: [{ code: "cannot_exit" }] }],
  ["thin analyst coverage",    { outcome: "insufficient_coverage" }],
  ["analyst hard kill",        { outcome: "killed", killedBy: "forensics", reason: "mint authority live" }],
  ["compliance veto",          { compliance: { pass: false, violations: [{ code: "size" }] } }],
  ["VETOED final",             { finalDecision: "VETOED" }],
  ["red team refuted (PM did not answer)", { redteam: { verdict: "refuted", headline: "wash" }, pm: { ...good().pm, decision: "WATCH" } }],
  ["no invalidation",          { pm: { decision: "PROPOSE", conviction: 70, invalidation: "" } }],
  ["stop of zero",             { ticket: { stop_price: 0 } }],
  ["stop missing",             { ticket: {} }],
  ["negative stop",            { ticket: { stop_price: -1 } }],
  ["no readable price",        { ev: { pair: { priceUsd: 0 } } }],
  ["stop at or above entry",   { ticket: { stop_price: 1.0 }, ev: { pair: { priceUsd: 1.0, priceChange: { m5: 0 } } } }],
  ["zero-sized authorization", { risk: { position_size_usd: 0 }, ceo: { ruling: "HOLD", order_size_usd: 0 }, order: { size: 0 } }],
  ["spike-shaped entry",       { ev: { pair: { priceUsd: 1, priceChange: { m5: 44 } } } }],
];
for (const [name, over] of unsafe) {
  const e = eligibility(good(over));
  ok(name + " → refused", e.eligible === false, e.reason);
  if (e.eligible === false) ok(name + " → flagged as safety", e.safety === true, `safety=${e.safety}`);
}

console.log("\nTHE TEAM'S EXPLICIT NO — refused, but as judgement rather than safety");
{
  const p = eligibility(good({ pm: { ...good().pm, decision: "PASS" }, finalDecision: "PASS" }));
  ok("PM PASS is refused", p.eligible === false, p.reason);
  ok("PM PASS is not a safety refusal", p.safety === false);
  const d = eligibility(good({ finalDecision: "DECLINED" }));
  ok("CEO DECLINE is refused", d.eligible === false, d.reason);
}

console.log("\nTHE UNLOCK — what the mandate is actually FOR");
{
  const held = eligibility(good({ finalDecision: "HELD" }));
  ok("a CEO HOLD is now tradeable", held.eligible === true, held.reason);
  ok("a CEO HOLD ranks tier 3", held.tier === 3, `tier=${held.tier}`);

  const watch = eligibility(good({
    finalDecision: "WATCH",
    pm: { decision: "WATCH", conviction: 55, invalidation: "liq halves" },
  }));
  ok("a WATCH with a real ticket is tradeable", watch.eligible === true, watch.reason);
  ok("a WATCH ranks last, tier 1", watch.tier === 1, `tier=${watch.tier}`);

  // The charter's own exception: a PM may answer a refutation and still propose.
  const answered = eligibility(good({
    redteam: { verdict: "refuted", headline: "volume looks washed" },
    pm: { ...good().pm, decision: "PROPOSE" },
    finalDecision: "APPROVED",
  }));
  ok("refuted BUT the PM proposed anyway is allowed", answered.eligible === true, answered.reason);
}

console.log("\nRANKING — a stronger verdict must never lose to a weaker one");
{
  const approvedLowConviction = good({ finalDecision: "APPROVED", pm: { ...good().pm, conviction: 1 }, weighted: 0 });
  const watchMaxConviction = good({ finalDecision: "WATCH", weighted: 100,
    pm: { decision: "WATCH", conviction: 100, invalidation: "x" } });
  ok("approval at conviction 1 outranks a WATCH at 100",
    contenderScore(approvedLowConviction) > contenderScore(watchMaxConviction),
    `${contenderScore(approvedLowConviction)} > ${contenderScore(watchMaxConviction)}`);

  const heldHigh = good({ finalDecision: "HELD", pm: { ...good().pm, conviction: 90 } });
  const heldLow = good({ finalDecision: "HELD", pm: { ...good().pm, conviction: 20 } });
  ok("inside a tier, conviction decides", contenderScore(heldHigh) > contenderScore(heldLow));
  ok("an ineligible record scores -Infinity",
    contenderScore(good({ outcome: "killed" })) === -Infinity);
}

console.log("\nTHE PICK — one cycle, exactly one call");
{
  const cohort = [
    { rec: good({ mint: "a", symbol: "KILLED", outcome: "killed", killedBy: "flow", reason: "rug" }) },
    { rec: good({ mint: "b", symbol: "PASSED", pm: { ...good().pm, decision: "PASS" } }) },
    { rec: good({ mint: "c", symbol: "WATCHED", finalDecision: "WATCH",
      pm: { decision: "WATCH", conviction: 88, invalidation: "x" } }) },
    { rec: good({ mint: "d", symbol: "HELD", finalDecision: "HELD", pm: { ...good().pm, conviction: 41 } }) },
  ];
  const { winner, eligible, judged } = pickOne(cohort);
  ok("all four were judged", judged.length === 4);
  ok("exactly two were eligible", eligible.length === 2, eligible.map((e) => e.rec.symbol).join(", "));
  ok("the HELD wins over the higher-conviction WATCH",
    winner?.rec?.symbol === "HELD", `winner=${winner?.rec?.symbol}`);

  // The case that matters most: a cohort of nothing but poison must produce NO call.
  const poison = [
    { rec: good({ outcome: "screened_out", fails: [{ code: "freezable" }] }) },
    { rec: good({ outcome: "killed", killedBy: "forensics", reason: "honeypot" }) },
    { rec: good({ compliance: { pass: false, violations: [{ code: "x" }] } }) },
  ];
  const p = pickOne(poison);
  ok("a cohort of poison yields NO winner — the mandate does not force", p.winner === null);
  ok("and every refusal is on safety grounds",
    p.judged.every((j) => j.eligibility.safety === true));
}

console.log("\nSEQUENCING — the book gate");
{
  const { openCall, closeCall } = await import("./src/calls.js");
  ok("an empty book is not full", bookState().full === false, `live=${bookState().live}`);

  /* The book holds MAX_LIVE_CALLS at once — three now, so the desk keeps hunting
   * rather than idling behind one trade. What is under test is the GATE, not the
   * number, so fill whatever the configured book is and assert it closes. */
  const opened = [];
  for (let i = 0; i < MAX_LIVE_CALLS; i++) {
    ok(`with ${i} open the desk is still hunting`, bookState().full === false,
      `live=${bookState().live}/${MAX_LIVE_CALLS}`);
    const c = openCall({ mint: `SeqTest${i}11111111111111111111111111111111`, symbol: `SEQ${i}`,
      entryRef: 1, stop: 0.7, target: 2, thesis: "t", invalidation: "i" });
    ok(`call ${i + 1} opened`, !!c);
    opened.push(c);
  }
  const b = bookState();
  ok(`${MAX_LIVE_CALLS} live calls fill the book`, b.full === true, `live=${b.live} max=${MAX_LIVE_CALLS}`);
  ok("the gate names what it is holding", !!b.holding?.symbol, b.holding?.symbol);

  // And the whole point: while it is full, nothing may publish.
  const e = eligibility(good());
  ok("the winner is still eligible on merit", e.eligible === true);
  ok("but the book says full, so the cycle must not open another",
    bookState().full === true);

  closeCall(opened[0].id, "test", 1.2);
  ok("closing ONE call reopens the book", bookState().full === false, `live=${bookState().live}`);
  for (const c of opened.slice(1)) closeCall(c.id, "test", 1.2);
}


console.log("\nCOMPLIANCE — a WATCH ticket must be audited exactly like a PROPOSE ticket");
{
  const { complianceCheck } = await import("./src/agents/compliance.js");
  // A ticket whose first target is 4% away while the measured round trip costs 3%:
  // the "machine for paying the market" the edge_below_cost rule exists to stop.
  const badEdge = {
    entry_zone_low: 0.9, entry_zone_high: 1.1, stop_price: 0.8,
    take_profit: [{ price: 1.04, pct_to_sell: 100 }], max_slippage_bps: 500,
  };
  const ev = { pair: { priceUsd: 1.0 }, exitProbe: { roundTripLossPct: 3 } };
  const risk = { position_size_usd: 50, stop_price: 0.8, max_loss_usd: 11.5 };

  const asPropose = complianceCheck({ pm: { decision: "PROPOSE" }, risk, redteam: {}, ticket: badEdge, ev });
  ok("a bad-edge PROPOSE ticket is vetoed (unchanged)", asPropose.pass === false,
    asPropose.violations.map((v) => v.code).join(","));

  const asWatch = complianceCheck({ pm: { decision: "WATCH" }, risk, redteam: {}, ticket: badEdge, ev });
  ok("a bad-edge WATCH ticket is ALSO vetoed (the hole)", asWatch.pass === false,
    asWatch.violations.map((v) => v.code).join(","));

  // A stop that is not below the entry zone must be caught on a WATCH too.
  const badStop = { ...badEdge, stop_price: 1.2, take_profit: [{ price: 2.0, pct_to_sell: 100 }] };
  const stopWatch = complianceCheck({ pm: { decision: "WATCH" }, risk: { ...risk, stop_price: 1.2 },
    redteam: {}, ticket: badStop, ev });
  ok("a stop above the entry zone is caught on a WATCH", stopWatch.pass === false,
    stopWatch.violations.map((v) => v.code).join(","));

  // And a clean WATCH ticket must still pass — the fix must not veto everything.
  const goodTicket = { entry_zone_low: 0.95, entry_zone_high: 1.05, stop_price: 0.8,
    take_profit: [{ price: 1.6, pct_to_sell: 100 }], max_slippage_bps: 500 };
  const cleanWatch = complianceCheck({ pm: { decision: "WATCH" }, risk, redteam: {}, ticket: goodTicket, ev });
  ok("a clean WATCH ticket still passes", cleanWatch.pass === true,
    cleanWatch.violations.map((v) => v.code).join(",") || "clear");

  // No ticket at all (alwaysTicket off) must behave exactly as before.
  const noTicket = complianceCheck({ pm: { decision: "WATCH" }, risk, redteam: {}, ticket: null, ev });
  ok("a WATCH with no ticket is unaffected", noTicket.pass === true);
  ok("...but the bundle's missing chain facts are on the tape as a warning",
    noTicket.warnings.some((w) => w.code === "evm_gates_unverified" && /launch\.phase/.test(w.detail)),
    noTicket.warnings.map((w) => w.code).join(","));
}

/* THE CHAIN'S GATES AT THE DOOR. The same facts that zero Risk's size veto here, from
 * the evidence contract's fields only, so a PM that talked itself past a curve token or an
 * equity-quoted pool is stopped by code. A clean graduate passes with no warning. */
console.log("\nCOMPLIANCE — the chain's deterministic gates are a veto, from the bundle's own fields");
{
  const { complianceCheck } = await import("./src/agents/compliance.js");
  const now = 1_800_000_000_000;
  const risk = { position_size_usd: 50, stop_price: 0.8, max_loss_usd: 11.5 };
  const ticket = { entry_zone_low: 0.95, entry_zone_high: 1.05, stop_price: 0.8,
    take_profit: [{ price: 1.6, pct_to_sell: 100 }], max_slippage_bps: 500,
    execution_warnings: ["a send with no receipt was dropped by the sequencer: reconcile by nonce and re-send"] };
  const graduate = {
    pair: { priceUsd: 1.0 }, exitProbe: { roundTripLossPct: 3 },
    launch: { phase: "graduated", graduatedAt: now - 3 * 3600e3, exemptShareOfSupplyPct: 4 },
    pairs: { pools: [{ pairToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", pairTokenClass: "weth" }] },
    contract: { cloneOf: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", verifiedSource: false, flags: [] },
    sellSim: { ok: true },
  };
  const check = (over) => complianceCheck({ pm: { decision: "PROPOSE", how_red_team_was_answered: "x" }, risk,
    redteam: { verdict: "survives" }, ticket, ev: { ...graduate, ...over }, now });
  const clean = check({});
  ok("a clean graduate passes", clean.pass === true, clean.violations.map((v) => v.code).join(",") || "clear");
  ok("...with no unverified-gate warning", !clean.warnings.some((w) => w.code === "evm_gates_unverified"),
    clean.warnings.map((w) => w.code).join(",") || "none");
  for (const [name, over, code] of [
    ["a token still on the curve", { launch: { ...graduate.launch, phase: "curve", graduatedAt: null } }, "not_graduated"],
    ["a pool graduated 30 seconds ago", { launch: { ...graduate.launch, graduatedAt: now - 30e3 } }, "graduated_too_recently"],
    ["a pool quoted in an unlisted equity", { pairs: { pools: [{ pairToken: "0x4a0e", pairTokenClass: "equity_unlisted" }] } }, "pair_token_gate"],
    ["an exempt list holding 60% of supply", { launch: { ...graduate.launch, exemptShareOfSupplyPct: 60 } }, "insider_float"],
    ["bespoke unverified code whose sell reverts", { contract: { cloneOf: null, verifiedSource: false, flags: [] }, sellSim: { ok: false, revertReason: "y" } }, "unverified_code"],
    ["a live blacklist role", { contract: { ...graduate.contract, flags: [{ flag: "blacklist" }] } }, "live_authority"],
  ]) {
    const r = check(over);
    ok(`${name} is vetoed as ${code}`, r.pass === false && r.violations.some((v) => v.code === code),
      r.violations.map((v) => v.code).join(",") || "passed");
  }
  // An allowlisted equity is a pair asset and passes; the seats price the leg.
  const nvda = check({ pairs: { pools: [{ pairToken: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", pairTokenClass: "allowed_equity" }] } });
  ok("an allowlisted equity as the pair asset passes", nvda.pass === true, nvda.violations.map((v) => v.code).join(","));
  // The one execution fact unique to this chain must be on every ticket.
  const silent = complianceCheck({ pm: { decision: "PROPOSE", how_red_team_was_answered: "x" }, risk,
    redteam: { verdict: "survives" }, ticket: { ...ticket, execution_warnings: ["thin book"] }, ev: graduate, now });
  ok("a ticket without the no-receipt warning is warned", silent.warnings.some((w) => w.code === "no_receipt_warning_missing"));
  // EVM signing vocabulary is execution language too.
  const signing = complianceCheck({ pm: { decision: "PROPOSE", how_red_team_was_answered: "x", thesis: "call eth_sendRawTransaction from the desk" }, risk,
    redteam: { verdict: "survives" }, ticket, ev: graduate, now });
  ok("eth_sendRawTransaction in a seat's output is a veto", signing.violations.some((v) => v.code === "execution_language"));
  // Gas is inside the loss arithmetic and the edge floor.
  const gassed = complianceCheck({ pm: { decision: "PROPOSE", how_red_team_was_answered: "x" },
    risk: { ...risk, max_loss_usd: 12.04 }, redteam: { verdict: "survives" }, ticket,
    ev: { ...graduate, exitProbe: { roundTripLossPct: 3, gasUsdRoundTrip: 0.54 } }, now });
  ok("the recomputed loss carries the $0.54 of gas", !gassed.violations.some((v) => v.code === "risk_arithmetic_mismatch"),
    gassed.violations.map((v) => `${v.code}: ${v.detail}`).join(" | ") || "matches");
  const thinEdge = complianceCheck({ pm: { decision: "PROPOSE", how_red_team_was_answered: "x" },
    risk: { ...risk, position_size_usd: 5, max_loss_usd: 1.69 }, redteam: { verdict: "survives" },
    ticket: { ...ticket, take_profit: [{ price: 1.2, pct_to_sell: 100 }] },
    ev: { ...graduate, exitProbe: { roundTripLossPct: 3, gasUsdRoundTrip: 0.54 } }, now });
  ok("on a $5 clip the gas makes a 20% target fall under 5x cost",
    thinEdge.violations.some((v) => v.code === "edge_below_cost" && /gas/.test(v.detail)),
    thinEdge.violations.filter((v) => v.code === "edge_below_cost").map((v) => v.detail).join("") || "no edge_below_cost");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
