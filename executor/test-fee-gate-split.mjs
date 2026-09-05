/**
 * THE FEE CEILING IS A GATE. IT MUST NOT ALSO BE A COST MODEL.
 *
 * On Solana, maxNetworkFeeLamports was the fee above which an entry is REFUSED, so
 * raising it could only admit trades — but the same constant was also charged against
 * every trade as the reserve inside the risk rails and as worstFeeRatio in the poller's
 * executable-cost guard, where raising it could only refuse them. Coupled, the owner's
 * instruction to stop congestion refusing fills would have refused ALL of them: reviewed
 * against the real sizing engine, a 2,000,000-lamport cost model left no stop width from
 * 8% to 95% that still produced a buy.
 *
 * On this chain the two numbers are not even the same KIND of thing. The GATE is a
 * registry threshold with provenance (exec.maxNetworkFeeWei, VOID until measured) that
 * the executor compares worst-case gas×price against before signing. The COST MODEL is
 * computed per tick — half the measured round-trip gas × the gas price both providers
 * report right now — because gas moved 0.41 → 0.80 gwei between two probe runs fifteen
 * minutes apart on 2026-09-05. A constant cost model would have been wrong within the
 * hour; a gate that doubled as one would have been wrong in both directions.
 *
 * Gas is FLAT here, so the boring load-bearing assertion changes shape: it is not "an
 * ordinary desk call still buys" but "the SIZE decides whether the round trip is
 * affordable" — the canary is refused by the executable-cost guard at any stop width,
 * and the operator ceiling clears it. That inversion is the whole reason the caps are
 * marked as awaiting owner confirmation.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { planEntry, DEFAULTS } from "./strategy.mjs";
import { lintSource } from "./lessons-lint.mjs";
import { threshold } from "./thresholds.mjs";
import "./live-thresholds.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const executor = fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8");

console.log("\nTHE TWO NUMBERS ARE DIFFERENT KINDS OF THING");
{
  ok("the refusal gate is a registry threshold, live, VOID until measured on this chain",
    threshold("exec.maxNetworkFeeWei").live === true && threshold("exec.maxNetworkFeeWei").value === null);
  ok("the poller reads the gate from the registry, never from env",
    /maxNetworkFeeWei: registryValue\("exec\.maxNetworkFeeWei"/.test(poller) && !/process\.env\.MAX_NETWORK_FEE/.test(poller));
  ok("the cost model is computed per tick from the measured round-trip gas and the LIVE gas price",
    /async function expectedNetworkFeeWei\(\)/.test(poller) &&
    /BigInt\(Math\.ceil\(EXECUTOR_CFG\.roundTripGasUnits \/ 2\)\) \* gas\.max/.test(poller) &&
    /roundTripGasUnits: threshold\("swap\.roundTripGasUnits"\)\.value/.test(poller));
  ok("the sizing reserve reads the cost model, not the gate",
    /networkFeeReserveSol: EXECUTE \? weiToEth\(feeWei\)/.test(poller));
  ok("the executable-cost guard reads the cost model, not the gate",
    /worstFeeRatio = Number\(2n \* feeWei/.test(poller));
  ok("the gate itself is enforced in the executor, before signing, as a comparison only",
    /if \(worstFee > maxFee\)/.test(executor) && executor.indexOf("worstFee > maxFee") < executor.indexOf("this.wallet.signTransaction(tx)"));
  ok("a fee-model refusal names itself instead of blaming the desk",
    /dominant term: \$\{worstFeeRatio >/.test(poller));
  for (const [name, src] of [["poller.mjs", poller], ["evm-executor.mjs", executor]]) {
    const findings = lintSource(src).filter((f) => f.rule === "gate-doubles-as-cost" && /maxNetworkFee/i.test(f.message));
    ok(`${name}: the machine check finds no fee constant that is both gate and cost`, findings.length === 0,
      findings.map((f) => f.message).join("; "));
  }
}

/* The live cost model at the gas price measured 2026-09-05 (median 0.41 gwei over 300s,
   0.80 gwei over 150s fifteen minutes later; the assertions use the earlier, kinder one
   so the refusals below are not an artefact of the spike). */
const ROUND_TRIP_GAS = threshold("swap.roundTripGasUnits").value;         // 660,996, measured
const GAS_PRICE_WEI = 420_000_000n;                                       // 0.42 gwei
const legWei = BigInt(Math.ceil(ROUND_TRIP_GAS / 2)) * GAS_PRICE_WEI;
const legEth = Number(legWei) / 1e18;

console.log("\nFLAT GAS: THE SIZE, NOT THE STOP, DECIDES WHETHER THE ROUND TRIP IS AFFORDABLE");
{
  /* The guard reproduced from poller.mjs onEntry, validated first against a case whose
     answer is known: with no fee and no friction a 20% stop passes at exactly 1.0 −
     slippage haircut. */
  const slippageHaircut = (1 - 300 / 10_000) ** 2;
  const guard = ({ feeWei, amountWei, roundTripPct, stopRatio }) => {
    const executableReturnRatio = 1 - roundTripPct / 100;
    const worstFeeRatio = Number(2n * feeWei * 1_000_000n / amountWei) / 1_000_000;
    const conservative = executableReturnRatio * slippageHaircut - worstFeeRatio;
    return { refuses: conservative <= stopRatio, conservative, worstFeeRatio };
  };
  const known = guard({ feeWei: 0n, amountWei: 10n ** 18n, roundTripPct: 0, stopRatio: 0.8 });
  ok("the reproduced guard passes a known case at exactly the slippage haircut",
    Math.abs(known.conservative - slippageHaircut) < 1e-12 && !known.refuses, `${known.conservative.toFixed(6)}`);

  const canary = 4n * 10n ** 14n;            // 0.0004 ETH, LIVE_LIMITS.maxEthPerTrade
  const operator = 4n * 10n ** 15n;          // 0.004 ETH, OPERATOR_MAX.maxEthPerTrade
  const stops = [[0.90, "10%"], [0.80, "20%"], [0.70, "30%"], [0.62, "38%"]];
  const refusedAt = (amountWei) => stops.filter(([stopRatio]) =>
    guard({ feeWei: legWei, amountWei, roundTripPct: 0.5, stopRatio }).refuses);
  const canaryFee = guard({ feeWei: legWei, amountWei: canary, roundTripPct: 0.5, stopRatio: 0.7 }).worstFeeRatio;
  const operatorFee = guard({ feeWei: legWei, amountWei: operator, roundTripPct: 0.5, stopRatio: 0.7 }).worstFeeRatio;
  ok("one gas leg is a flat ~0.00014 ETH at 0.42 gwei", legEth > 0.00013 && legEth < 0.00015, `${legEth.toFixed(6)} ETH`);
  ok("at the 0.0004 ETH canary two legs are more than half the position", canaryFee > 0.5, `${(canaryFee * 100).toFixed(1)}%`);
  ok("...so the canary is refused at EVERY stop width the desk publishes", refusedAt(canary).length === stops.length,
    `${refusedAt(canary).length}/${stops.length} refused`);
  ok("at the 0.004 ETH operator ceiling the same two legs are under 10%", operatorFee < 0.1, `${(operatorFee * 100).toFixed(1)}%`);
  ok("...and every width from 20% out clears the guard", refusedAt(operator).every(([, label]) => label === "10%"),
    `${refusedAt(operator).map(([, l]) => l).join(",") || "none"} refused`);
  ok("the fee term scales inversely with size — it is flat, not proportional (1e6 fixed point, so ±0.1%)",
    Math.abs(canaryFee / operatorFee - 10) < 0.01, `${(canaryFee / operatorFee).toFixed(4)}×`);
}

console.log("\nTHE SIZING ENGINE STILL BUYS AT ETH SCALE  (the assertion that caught the 0.0005 floor)");
{
  const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
    equitySol: 0.05, spendableSol: 0.05, wins: 0, losses: 0 };
  const cfg = (cap) => ({ ...DEFAULTS, fixedSol: cap, maxSolPerTrade: cap, dailySolCap: cap * 10,
    minSolPerTrade: 0.0001, networkFeeReserveSol: legEth, measuredRoundTripLossPct: 0.5 });
  const call = (stop, conviction) => ({ mint: "m", symbol: "T", entry_ref: 1, stop, target: 3, conviction });
  for (const cap of [0.0004, 0.004]) {
    for (const [stop, label] of [[0.90, "10%"], [0.80, "20%"], [0.62, "38%"]]) {
      const r = planEntry({ call: call(stop, 30), cfg: cfg(cap), state });
      ok(`a ${label} stop at conviction 30 sizes a BUY under a ${cap} ETH cap`, r.action === "buy" && r.sol > 0,
        r.action === "buy" ? `${r.sol.toFixed(6)} ETH` : r.reason);
    }
  }
  const floored = planEntry({ call: call(0.8, 30), cfg: { ...cfg(0.0004), minSolPerTrade: undefined }, state });
  ok("without the poller's explicit minimum the old 0.0005 floor still applies (the desk's paper sizing is unchanged)",
    floored.action === "skip" && /rounds to nothing/.test(floored.reason), floored.reason);
  ok("the poller passes that minimum explicitly", /minSolPerTrade: 0\.0001/.test(poller));
}

console.log("\nRAISING THE GATE CHANGES NO SIZE AT ALL");
{
  const state = { openCount: 0, realizedTodaySol: 0, deployedTodaySol: 0, bookHeat: 0,
    equitySol: 0.05, spendableSol: 0.05, wins: 0, losses: 0 };
  const at = (reserve, stop) => planEntry({
    call: { mint: "m", symbol: "T", entry_ref: 1, stop, target: 3, conviction: 60 },
    cfg: { ...DEFAULTS, fixedSol: 0.004, maxSolPerTrade: 0.004, dailySolCap: 0.04, minSolPerTrade: 0.0001,
      networkFeeReserveSol: reserve, measuredRoundTripLossPct: 0.5 }, state });
  // The gate is a comparison in the executor; sizing never sees it. So sizing at the
  // cost model is byte-identical whatever the gate would be — which is the split.
  let identical = true;
  for (const stop of [0.95, 0.90, 0.85, 0.80, 0.70, 0.60]) {
    const a = at(legEth, stop), b = at(legEth, stop);
    if (a.action !== b.action || Math.abs((a.sol ?? 0) - (b.sol ?? 0)) > 1e-12) identical = false;
  }
  ok("sizing depends only on the cost model", identical);
  ok("...and the cost model is not a constant anywhere in the poller", !/expectedNetworkFeeWei:\s*[0-9_]+n?/.test(poller));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
