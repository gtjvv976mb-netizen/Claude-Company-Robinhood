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

console.log("\nPOSITIVE EVIDENCE OF A CURVE VETOES THE UPGRADE");
ok("a curve contract among the top holders blocks it even WITH both proofs", () =>
  assert.equal(resolveAmmPhase({ ...proven, curveHolder: true }), "unknown"));
ok("a LOCKER is not a curve — a graduated PONS coin holds one and must still pass", () =>
  assert.equal(resolveAmmPhase({ ...proven, curveHolder: false }), "amm"));
ok("the veto defaults to off, so a bundle without the field is not silently refused", () =>
  assert.equal(resolveAmmPhase({ phase: "unknown", hasLaunchLog: false, verifiedAmmPool: true, sellSimOk: true }), "amm"));

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
/* STRIP COMMENTS BEFORE LOOKING FOR CODE. The first tightened version of this regex
   matched the PROSE in the very comments that explain the rule — every file documenting
   `!== "graduated"` failed its own guard. A source-text assertion that cannot tell code
   from a comment is the exact failure mode this suite is meant to catch elsewhere. */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
for (const f of ["src/agents/risk-rails.js", "src/penthouse.js", "src/mandate.js"]) {
  ok(`${f} uses the shared set`, () => {
    const src = codeOnly(fs.readFileSync(new URL(f, import.meta.url), "utf8"));
    /* ANY comparison against the literal, however the left side is spelled. The old
       regex required the token `phase` immediately before !==, so it could not see
       `launchPhaseOf(c) !== "graduated"` — which is exactly the fifth caller it existed
       to forbid, and it passed while that caller was live. */
    assert.ok(!/!==\s*"graduated"/.test(src),
      "a private `!== \"graduated\"` copy silently keeps refusing what the others now allow");
    assert.ok(!/===\s*"graduated"\s*\?/.test(src),
      "a ternary on the literal is the same copy wearing a different shape");
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
ok("the V4 PoolManager singleton is NOT accepted as proof of a graduated pool", () => {
  /* It briefly was, matched by address. But every V4 pool on the chain keeps its tokens
     in that one contract, so its presence proves the token has SOME V4 position — not
     that the position is a graduated pool rather than a live PONS curve. DEX_VENUES
     would settle it, except its own comment calls that split "an inference from the ids,
     not a documented contract". A safety gate cannot rest on that. */
  assert.ok(!/addr === lower\(V4_POOL_MANAGER\)/.test(codeOnly(bs)),
    "a singleton that holds every V4 pool cannot distinguish a graduate from a curve");
});
ok("...so proof requires a VERIFIED contract named as a specific AMM pool", () =>
  assert.match(codeOnly(bs), /is_contract && it\?\.address\?\.is_verified/));
ok("the curve veto does not fire on a LOCKER", () =>
  assert.match(bs, /!\/locker\/i\.test/),
);
ok("the explorer retries transient failures rather than losing the coin", () =>
  assert.match(bs, /TRANSIENT_HTTP/));

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
