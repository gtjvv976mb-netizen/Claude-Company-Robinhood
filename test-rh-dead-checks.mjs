/**
 * FOUR CHECKS THAT COULD NOT DO THEIR JOB ON THIS CHAIN.
 *
 * Each was ported intact from the Solana desk, reads a field that does not exist here,
 * and therefore always returned the same answer. Two failed OPEN (a real risk downgraded
 * to unconfirmed), one failed CLOSED (unverifiable data read as damning), and one turned
 * a deliberate alarm into silent data corruption.
 *
 *   node test-rh-dead-checks.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

console.log("\n1. A NATIVE BUY'S ETH IS READABLE — OR THE FILL IS NOT A TRADE");
const treasury = fs.readFileSync(new URL("./src/treasury-evm.js", import.meta.url), "utf8");
const perf = fs.readFileSync(new URL("./src/perf.js", import.meta.url), "utf8");
ok("eth_getTransactionByHash is on the read allowlist", () =>
  assert.match(treasury, /"eth_getTransactionByHash",/,
    "perf.js reads it for every native buy; unlisted, every one of those reads threw"));
ok("the allowlist is still closed to writes", () => {
  const set = treasury.slice(treasury.indexOf("const ALLOWED = new Set(["), treasury.indexOf("]);"));
  assert.ok(!/eth_sendRawTransaction|eth_sendTransaction|eth_sign|personal_/.test(set),
    "a write method must never be reachable from this process");
  for (const m of set.match(/"eth_[a-zA-Z]+"/g) ?? [])
    assert.match(m, /"eth_(chainId|blockNumber|call|getBalance|getLogs|getBlockByNumber|getCode|getTransactionReceipt|getTransactionByHash)"/,
      `${m} is not a known read method`);
});
ok("a REFUSED method is re-thrown, not swallowed into a zero", () =>
  assert.match(perf, /if \(\/refused non-read method\/\.test\(String\(e\?\.message\)\)\) throw e;/,
    "evmRpc throws on a refusal deliberately — catching it into 0n rewrites the track record"));
ok("...while genuine network weather still degrades to 0", () =>
  assert.match(perf, /throw e;\s*\n\s*nativeWei = 0n;/,
    "a missing value costs one fill's precision; a bug must not be treated the same way"));

console.log("\n2. THE DECISION FINGERPRINT COVERS WHAT DECIDES");
const manifest = fs.readFileSync(new URL("./src/manifest.js", import.meta.url), "utf8");
ok("blockscout.js is in the manifest", () => assert.match(manifest, /"src\/data\/blockscout\.js",/),
);
ok("...because it now decides holder concentration and the launch phase", () => {
  const ev = fs.readFileSync(new URL("./src/data/evidence.js", import.meta.url), "utf8");
  assert.match(ev, /blockscout\.holdersFromExplorer/);
  assert.match(ev, /verifiedAmmPool: holders\?\.verifiedAmmPool === true/);
});
ok("eth-usd.js is in the manifest", () => assert.match(manifest, /"src\/data\/eth-usd\.js",/));

console.log("\n3. unlock_risk CAN FIRE ON AN EVM CONTRACT (it failed OPEN)");
const { RED_TEAM_FACT_CODES } = await import("./src/agents/schemas.js");
const rt = fs.readFileSync(new URL("./src/agents/redteam-policy.js", import.meta.url), "utf8");
const unlock = rt.slice(rt.indexOf('case "unlock_risk":'), rt.indexOf('case "upgrade_key_live"'));
ok("it tests the EVM flag vocabulary, not only Token-2022 names", () =>
  assert.match(unlock, /cflags\.some\(\(f\) => \/fee_over_ceiling\|mint_role_live\|pausable\|upgradeable_eoa\/i\.test\(f\)\)/));
ok("the Solana terms are kept, not replaced — the desk may still see a Token-2022 bundle", () =>
  assert.match(unlock, /permanentDelegate\|transferHook/));
ok("contract.feeSettable alone was never enough — it is hardcoded null", () => {
  const evm = fs.readFileSync(new URL("./src/data/evm.js", import.meta.url), "utf8");
  assert.match(evm, /feeSettable: null/, "if this ever gets populated, the fallback is belt and braces");
});

console.log("\n4. deployer_misconduct NO LONGER CONFIRMS ON MISSING DATA (it failed CLOSED)");
const dep = rt.slice(rt.indexOf('case "deployer_misconduct"'), rt.indexOf('case "liquidity_collapse"'));
ok("an unreadable graduation count cannot satisfy the farm test", () =>
  assert.match(dep, /Number\.isFinite\(grads\) && grads === 0/,
    "Number(null) is 0, so the absence of the field was reading as 'never graduated'"));
ok("the old always-true form is gone", () =>
  assert.ok(!/Number\(evidence\?\.deployer\?\.graduated\) === 0/.test(dep)));
ok("a real serial rugger still confirms on its own", () =>
  assert.match(dep, /evidence\?\.xRead\?\.serial_rugger === true/));
ok("unlock_risk and deployer_misconduct are both still real fact codes", () => {
  assert.ok(RED_TEAM_FACT_CODES.includes("unlock_risk"));
  assert.ok(RED_TEAM_FACT_CODES.includes("deployer_misconduct"));
});

console.log("\n5. THE LIQUIDITY HAIRCUT MUST DISCRIMINATE, NOT HAIRCUT EVERYTHING");
/* rtCost is measured at cfg.targetSizeUsd ($75 = 0.0167 ETH). Interpolating the 18
   KyberSwap-quoted PONS round trips of 2026-09-07 to that clip: MEDIAN 6.25%, WORST
   8.09%. Under the old Solana thresholds (>4 -> 0.5, >2 -> 0.75) BOTH scored 0.5, so a
   rule named for liquidity was a flat 50% haircut that could not tell a typical coin from
   the worst one. A check whose output does not vary is not measuring anything. */
const rails = fs.readFileSync(new URL("./src/agents/risk-rails.js", import.meta.url), "utf8");
const mult = rails.match(/const liquidityMultiplier = ([^;]+);/);
ok("the multiplier is still a three-step function of the measured round trip", () =>
  assert.ok(mult, "could not read liquidityMultiplier"));
const f = new Function("rtCost", `return ${mult[1]};`);
const PONS_MEDIAN = 6.25, PONS_WORST = 8.09;
ok("the MEDIAN PONS coin is not haircut", () =>
  assert.equal(f(PONS_MEDIAN), 1, `a typical coin scoring ${f(PONS_MEDIAN)} means every coin is penalised`));
ok("the WORST measured PONS coin IS haircut", () =>
  assert.equal(f(PONS_WORST), 0.5, "the rule must still bite on genuinely expensive exits"));
ok("...so median and worst get DIFFERENT answers — the rule discriminates", () =>
  assert.notEqual(f(PONS_MEDIAN), f(PONS_WORST)));
ok("a cheap deep-pool round trip is untouched", () => assert.equal(f(0.5), 1));
ok("something worse than anything measured is still capped at 0.5", () =>
  assert.equal(f(25), 0.5, "the 0.5 floor is the mechanism's own; only the boundaries moved"));
ok("the direction is unchanged — more cost never means MORE size", () => {
  let prev = Infinity;
  for (const rt of [0, 2, 4, 6, 6.3, 8, 9, 20]) { const v = f(rt); assert.ok(v <= prev, `rose at ${rt}%`); prev = v; }
});

console.log("\n6. ONE FACT, ONE POOL, ONE ANSWER");
/* The rails gated pair_token_gate on pools[0] and called it "the deepest pool". That is
   true of pools[0] by liquidity, but ev.pair is ds.shapePair(cons.deepest) — the deepest
   among pools that survived the PRICE-CONSENSUS filter — and a pool excluded from that
   vote can still be the deepest overall. So the rails and the free screen
   (pair_token_unallowed, which matches ev.pair.pairAddress) could read different pools
   and return different verdicts about one fact. */
const { evmGateFailures } = await import("./src/agents/risk-rails.js");
const gateOn = (pools, tradedAddr) => evmGateFailures({
  launch: { phase: "amm" }, pair: { pairAddress: tradedAddr }, pairs: { pools },
}).fails.some((f) => f.code === "pair_token_gate");
const NATIVE = { address: "0xA", pairTokenClass: "native", pairToken: "ETH" };
const EQUITY = { address: "0xB", pairTokenClass: "equity", pairToken: "TSLA" };
ok("the deepest pool being an equity does not condemn a native pool the desk trades", () =>
  assert.equal(gateOn([EQUITY, NATIVE], "0xA"), false));
ok("the desk trading an EQUITY pool is caught even when the deepest pool is native", () =>
  assert.equal(gateOn([NATIVE, EQUITY], "0xB"), true,
    "this is the dangerous case pools[0] cleared — an equity pair passing the rails"));
ok("an unknown traded pool falls back to pools[0] rather than passing blind", () =>
  assert.equal(gateOn([EQUITY, NATIVE], "0xZZ"), true));
ok("the rails and the screen key on the same field", () => {
  const ev = fs.readFileSync(new URL("./src/data/evidence.js", import.meta.url), "utf8");
  assert.match(rails, /q\.address === ev\?\.pair\?\.pairAddress/);
  assert.match(ev, /q\.address === ev\.pair\.pairAddress/);
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
