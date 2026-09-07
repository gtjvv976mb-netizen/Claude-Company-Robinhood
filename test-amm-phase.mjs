/**
 * "AMM" — THE PHASE THIS CHAIN NEEDED, AND THE GATE IT MUST NOT REOPEN.
 *
 * not_graduated keeps the desk off bonding curves. On pump.fun every coin has a curve and
 * a graduation, so `phase` is always knowable. On Robinhood Chain ~92% of the traded book
 * never touched a PONS curve: ordinary ERC-20s whose liquidity has always been a Uniswap
 * v3/v4 pool. For those `graduated` is not false, it is MEANINGLESS — and the fork
 * answered "unknown", which the gate refuses. Measured on the live desk 2026-09-07:
 * not_graduated fired on 24 of 24 sampled workups; the desk has never published a call.
 *
 * The danger in fixing it is the hole the 2026-09-05 review closed: DexScreener reports a
 * live PONS V2 curve as dexId "uniswap" with labels ["v4"], so any fix that reads a DEX
 * LABEL would let a coin still on its curve read as tradeable. Nothing here reads a label.
 * Two independent chain measurements are required — a VERIFIED AMM pool contract holding
 * the float, and a sell that SIMULATES — and either one missing leaves the phase refused.
 *
 *   node test-amm-phase.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { TRADEABLE_PHASES, resolveAmmPhase, evmGateFailures } from "./src/agents/risk-rails.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};
const proven = { phase: "unknown", hasLaunchLog: false, verifiedAmmPool: true, sellSimOk: true };

console.log("\nBOTH PROOFS ARE REQUIRED — EITHER ONE MISSING IS A REFUSAL");
ok("both proven resolves to amm", () => assert.equal(resolveAmmPhase(proven), "amm"));
ok("no verified AMM pool → stays unknown", () =>
  assert.equal(resolveAmmPhase({ ...proven, verifiedAmmPool: false }), "unknown"));
ok("the sell not simulating → stays unknown", () =>
  assert.equal(resolveAmmPhase({ ...proven, sellSimOk: false }), "unknown"));
ok("a honeypot that reverts on sell is refused even with a real pool", () =>
  assert.equal(resolveAmmPhase({ ...proven, sellSimOk: false, verifiedAmmPool: true }), "unknown"));
for (const bad of [null, undefined, "true", 1, {}]) {
  ok(`a non-true verifiedAmmPool (${JSON.stringify(bad)}) is not proof`, () =>
    assert.equal(resolveAmmPhase({ ...proven, verifiedAmmPool: bad }), "unknown"));
  ok(`a non-true sellSimOk (${JSON.stringify(bad)}) is not proof`, () =>
    assert.equal(resolveAmmPhase({ ...proven, sellSimOk: bad }), "unknown"));
}

console.log("\nIT CAN ONLY EVER UPGRADE 'UNKNOWN' — A CURVE STAYS A CURVE");
ok("a known curve is untouched even with both proofs", () =>
  assert.equal(resolveAmmPhase({ ...proven, phase: "curve" }), "curve"));
ok("a graduated coin is untouched", () =>
  assert.equal(resolveAmmPhase({ ...proven, phase: "graduated" }), "graduated"));
ok("a coin WITH a launch log is judged on its log, never on this", () =>
  assert.equal(resolveAmmPhase({ ...proven, hasLaunchLog: true }), "unknown"),
);

console.log("\nTHE GATE ACCEPTS amm AND STILL REFUSES EVERYTHING ELSE");
ok("graduated and amm are the only tradeable phases", () =>
  assert.deepEqual([...TRADEABLE_PHASES].sort(), ["amm", "graduated"]));
const gate = (phase) => evmGateFailures({ launch: { phase }, pairs: { pools: [] } })
  .fails.some((f) => f.code === "not_graduated");
ok("phase 'curve' still fails not_graduated", () => assert.equal(gate("curve"), true));
ok("phase 'unknown' still fails not_graduated", () => assert.equal(gate("unknown"), true));
ok("an invented phase still fails not_graduated", () => assert.equal(gate("whatever"), true));
ok("phase 'amm' passes", () => assert.equal(gate("amm"), false));
ok("phase 'graduated' passes", () => assert.equal(gate("graduated"), false));
ok("a missing phase is UNVERIFIED, not tradeable", () => {
  const r = evmGateFailures({ launch: {}, pairs: { pools: [] } });
  assert.ok(r.unverified.includes("launch.phase"));
});

console.log("\nONE DEFINITION — NO CALL SITE MAY KEEP ITS OWN COPY");
for (const f of ["src/agents/risk-rails.js", "src/penthouse.js", "src/mandate.js"]) {
  ok(`${f} uses the shared set`, () => {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/phase\s*!==\s*"graduated"/.test(src),
      "a private `!== \"graduated\"` copy silently keeps refusing what the others now allow");
    assert.match(src, /TRADEABLE_PHASES/);
  });
}

console.log("\nTHE PROOFS COME FROM CHAIN STATE, NEVER FROM A DEX LABEL");
const ev = fs.readFileSync(new URL("src/data/evidence.js", import.meta.url), "utf8");
ok("evidence.js resolves the phase through the shared function", () =>
  assert.match(ev, /phase = resolveAmmPhase\(\{/));
ok("the pool proof is the explorer's verified contract, not a dexId", () =>
  assert.match(ev, /verifiedAmmPool: holders\?\.verifiedAmmPool === true/));
ok("the exit proof is the on-chain sell simulation", () =>
  assert.match(ev, /sellSimOk: sellSim\?\.ok === true/));
ok("no dex id feeds the upgrade", () => {
  const block = ev.slice(ev.indexOf("phase = resolveAmmPhase({"), ev.indexOf("phase = resolveAmmPhase({") + 400);
  assert.ok(!/dexId|\.dex\b|launchpad/.test(block),
    "DexScreener calls a live PONS curve \"uniswap\" — a label can never be the proof");
});
const bs = fs.readFileSync(new URL("src/data/blockscout.js", import.meta.url), "utf8");
ok("verifiedAmmPool requires the contract to be VERIFIED, not merely named", () =>
  assert.match(bs, /is_contract && it\?\.address\?\.is_verified/));

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
