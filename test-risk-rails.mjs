import { enforceCeoRails, enforceRiskRails, retainedBookRiskUsd, evmGateFailures,
  stopFloorForCoin, stopFloorDetail, EVM_GATES } from "./src/agents/risk-rails.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};
const near = (actual, expected, epsilon = 0.011) => Math.abs(actual - expected) <= epsilon;

const config = {
  equityUsd: 10_000,
  maxRiskPct: 1,
  maxBookRiskPct: 4,
  targetSizeUsd: 10_000,
  maxRoundTripSlippagePct: 8,
};
const ev = {
  pair: { priceUsd: 1 },
  exitProbe: { roundTripLossPct: 2 },
  mintAccount: { mintAuthority: null, freezeAuthority: null, flags: [] },
};
const model = {
  risk_tier: "full",
  stop_price: 0.60,
  stop_rationale: "the launch breaks",
  size_rationale: "complete evidence",
  liquidity_adjusted: false,
  portfolio_notes: "",
  confidence: 1,
  // Deliberate lies: production must overwrite all three.
  position_size_usd: 10_000,
  max_loss_usd: 1,
  pct_of_equity_at_risk: 0.01,
};
const now = 1_800_000_000_000;
const run = (redteam = "survives", over = {}) => enforceRiskRails({
  risk: { ...model, ...(over.risk || {}) },
  ev: { ...ev, ...(over.ev || {}) },
  redteam: { verdict: redteam },
  openRiskUsd: over.openRiskUsd ?? 0,
  config: { ...config, ...(over.config || {}) },
  now,
});

console.log("\nLOSS-AT-STOP IS RECOMPUTED, NOT TRUSTED");
const full = run();
// 40% stop distance + 2% measured round trip = 42%; $100 / 42% = $238.10.
ok("position derives from the $100 budget and 42% loss fraction",
  near(full.position_size_usd, 238.10), `size=$${full.position_size_usd}`);
ok("max loss is recomputed to the configured ceiling", near(full.max_loss_usd, 100),
  `loss=$${full.max_loss_usd}`);
ok("risk percentage is recomputed", near(full.pct_of_equity_at_risk, 1, 0.0001),
  `${full.pct_of_equity_at_risk}%`);

console.log("\nGAS IS A FIXED TOLL INSIDE THE LOSS BUDGET");
{
  // $0.54 measured round trip (executor/live-thresholds.mjs): size = ($100 - $0.54) / 0.42.
  const gassed = run("survives", { ev: { exitProbe: { roundTripLossPct: 2, gasUsdRoundTrip: 0.54 } } });
  ok("the gas comes out of the position, not out of the budget's honesty",
    near(gassed.position_size_usd, 236.81) && near(gassed.max_loss_usd, 100),
    `size=$${gassed.position_size_usd} loss=$${gassed.max_loss_usd}`);
  ok("the rail says so", gassed.rail_notes.some((n) => /0\.54 of fixed round-trip gas/.test(n)), gassed.rail_notes.join("; "));
  // A budget the gas alone exhausts cannot open: maxRiskPct 0.001% of $10k is $0.10.
  const starved = run("survives", { config: { maxRiskPct: 0.001 }, ev: { exitProbe: { roundTripLossPct: 2, gasUsdRoundTrip: 0.54 } } });
  ok("a $0.10 budget against $0.54 of gas is a mechanical zero", starved.position_size_usd === 0 && starved.max_loss_usd === 0,
    starved.rail_notes.join("; "));
}

console.log("\nRED TEAM AND BOOK HEAT CAN ONLY REDUCE RISK");
const retainedHeat = retainedBookRiskUsd([
  { desk_risk_usd: 25 }, { desk_risk_usd: null }, { desk_risk_usd: -10 },
], config);
ok("legacy live calls reserve one full idea budget", retainedHeat === 125,
  `$${retainedHeat} retained risk`);
const wounded = run("wounded");
const refuted = run("refuted");
ok("wounded is smaller than survives", wounded.max_loss_usd < full.max_loss_usd,
  `${wounded.max_loss_usd} < ${full.max_loss_usd}`);
ok("refuted is smaller than wounded", refuted.max_loss_usd < wounded.max_loss_usd,
  `${refuted.max_loss_usd} < ${wounded.max_loss_usd}`);
const almostFull = run("survives", { openRiskUsd: 390 });
ok("remaining book budget caps loss at $10", near(almostFull.max_loss_usd, 10),
  `loss=$${almostFull.max_loss_usd}`);
const fullBook = run("survives", { openRiskUsd: 400 });
ok("an exhausted book produces no authorization", fullBook.position_size_usd === 0,
  fullBook.rail_notes.join("; "));

console.log("\nTHE EXIT-PROBED NOTIONAL IS AN ABSOLUTE CEILING");
const probed = run("survives", { config: { targetSizeUsd: 75 } });
ok("size cannot exceed the measured $75 notional", probed.position_size_usd === 75,
  `size=$${probed.position_size_usd}`);
ok("the cap is audited", probed.liquidity_adjusted === true &&
  probed.rail_notes.some((n) => /exit-probe notional/.test(n)), probed.rail_notes.join("; "));

/* THE CHAIN'S GATES ZERO THE SIZE — from the evidence contract's fields only.
 * On an EVM bundle mintAccount is absent, so before 2026-09-05 the mechanical zero for a
 * live authority could never fire. Each case below is one fact the chain punishes. */
console.log("\nTHE CHAIN'S GATES ZERO THE SIZE");
const graduated = {
  launch: { phase: "graduated", graduatedAt: now - 2 * 3600e3, exemptShareOfSupplyPct: 5 },
  pairs: { pools: [{ pairToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", pairTokenClass: "weth" }] },
  contract: { cloneOf: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", verifiedSource: false, flags: [] },
  sellSim: { ok: true },
};
const cleanEvm = run("survives", { ev: { mintAccount: undefined, ...graduated } });
ok("a graduated, WETH-quoted, clone-coded, exempt-light coin is sized", cleanEvm.position_size_usd > 0,
  `size=$${cleanEvm.position_size_usd}`);
ok("...and none of the gates is reported unverified",
  !cleanEvm.rail_notes.some((n) => /EVM gates unverified/.test(n)), cleanEvm.rail_notes.join("; "));
for (const [name, over, code] of [
  ["still on the curve", { launch: { ...graduated.launch, phase: "curve", graduatedAt: null } }, "not_graduated"],
  ["graduated 60 seconds ago", { launch: { ...graduated.launch, graduatedAt: now - 60e3 } }, "graduated_too_recently"],
  ["quoted in an unlisted equity", { pairs: { pools: [{ pairToken: "0x4a0e", pairTokenClass: "equity_unlisted" }] } }, "pair_token_gate"],
  ["quoted in an obscure ERC-20", { pairs: { pools: [{ pairToken: "0xdead", pairTokenClass: "other" }] } }, "pair_token_gate"],
  ["exempt wallets hold 55% of supply", { launch: { ...graduated.launch, exemptShareOfSupplyPct: 55 } }, "insider_float"],
  ["bespoke unverified code whose sell reverts", { contract: { cloneOf: null, verifiedSource: false, flags: [] }, sellSim: { ok: false, revertReason: "x" } }, "unverified_code"],
  ["a pausable role", { contract: { ...graduated.contract, flags: [{ flag: "pausable" }] } }, "live_authority"],
  ["an EOA upgrade key flagged by the screen", { contract: { ...graduated.contract, flags: ["upgradeable_eoa"] } }, "live_authority"],
]) {
  const r = run("survives", { ev: { mintAccount: undefined, ...graduated, ...over } });
  ok(`${name} -> zero`, r.position_size_usd === 0 && r.max_loss_usd === 0, r.rail_notes.join("; "));
  ok(`${name} names ${code}`, r.rail_notes.some((n) => n.includes(code)));
}
{
  // Bespoke code whose sell DOES simulate is allowed through this gate (forensics prices it).
  const bespokeOk = run("survives", { ev: { mintAccount: undefined, ...graduated,
    contract: { cloneOf: null, verifiedSource: false, flags: [] }, sellSim: { ok: true } } });
  ok("bespoke code with a simulating sell is not zeroed by the code gate", bespokeOk.position_size_usd > 0,
    bespokeOk.rail_notes.join("; "));
  // A bundle that never produced the fields is reported, not silently passed or failed.
  const legacy = run();
  const g = evmGateFailures(ev, { now });
  ok("absent fields are listed as unverified, not failed", g.fails.length === 0 && g.unverified.length >= 4, g.unverified.join(", "));
  ok("...and the rail note carries them", legacy.rail_notes.some((n) => /EVM gates unverified/.test(n)));
  ok("the gate thresholds are the shared ones",
    EVM_GATES.minGraduationAgeSec > 0 && EVM_GATES.maxInsiderFloatPct > 0 && EVM_GATES.allowedPairTokenClasses.includes("allowed_equity"),
    `age>=${EVM_GATES.minGraduationAgeSec}s insiders<=${EVM_GATES.maxInsiderFloatPct}% pairs ${EVM_GATES.allowedPairTokenClasses.join("/")}`);
}

/* THE STOP FLOOR CARRIES THE GAS. Ported from MAIN's stopFloorForCoin and given the fixed
 * term: at the $75 probe $0.54 is 0.72%; at a $5 clip it is 10.8%, and the floor moves
 * from ~12% to ~28%. Printed, because that inversion is the whole point of the port. */
console.log("\nTHE STOP FLOOR IS GAS-INCLUSIVE AND SIZE-AWARE");
{
  const cfg = { minStopDistancePct: 12, targetSizeUsd: 75 };
  const noGas = stopFloorForCoin({ exitProbe: { roundTripLossPct: 2 } }, cfg);
  const probe = stopFloorForCoin({ exitProbe: { roundTripLossPct: 2, gasUsdRoundTrip: 0.54 } }, cfg);
  const clip = stopFloorForCoin({ exitProbe: { roundTripLossPct: 2, gasUsdRoundTrip: 0.54 } }, cfg, { positionUsd: 5 });
  ok("MAIN's arithmetic is reproduced without gas", near(noGas, 11.06, 0.01), `${noGas.toFixed(2)}%`);
  ok("gas at the probe size raises the floor", probe > noGas && near(probe, 12.19, 0.02), `${probe.toFixed(2)}%`);
  ok("gas at a $5 clip raises it far more", clip > probe && clip > 25, `${clip.toFixed(2)}%`);
  const unmeasured = stopFloorDetail({ exitProbe: {} }, cfg);
  ok("an unmeasured coin falls back to the flat floor", unmeasured.floorPct === 12 && unmeasured.measured === false);
}

console.log("\nCEO MAY CUT, NEVER ENLARGE OR REVIVE");
const authorized = { position_size_usd: 75 };
const enlarged = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 500, size_change_reason: "" }, risk: authorized,
});
ok("oversized CEO order is capped to Risk", enlarged.order_size_usd === 75,
  `$${enlarged.order_size_usd}`);
const cut = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 20, size_change_reason: "" }, risk: authorized,
});
ok("a genuine CEO cut is preserved", cut.order_size_usd === 20);
const empty = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: 0, size_change_reason: "" }, risk: authorized,
});
ok("zero-sized APPROVE becomes HOLD", empty.ruling === "HOLD" && empty.order_size_usd === 0,
  `${empty.ruling} $${empty.order_size_usd}`);
const decline = enforceCeoRails({
  ceo: { ruling: "DECLINE", order_size_usd: 50, size_change_reason: "" }, risk: authorized,
});
ok("DECLINE is always zero", decline.order_size_usd === 0);
const malformed = enforceCeoRails({
  ceo: { ruling: "APPROVE", order_size_usd: Infinity, size_change_reason: "" }, risk: authorized,
});
ok("non-finite approval fails to HOLD at zero",
  malformed.ruling === "HOLD" && malformed.order_size_usd === 0,
  `${malformed.ruling} $${malformed.order_size_usd}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
