/**
 * A DROP AND A VOID ARE NOT THE SAME FAILURE, AND MODELLING THEM AS ONE UNDERSTATES RISK.
 *
 * Chain 4663's sequencer can drop a transaction with no receipt, and its compliance
 * filter can void one (status 0x0, no logs, gas burned). The executor treats them
 * differently on purpose, and a cost model that blurs them is wrong in the flattering
 * direction:
 *
 *   A DROP IS A TIME COST. The intent is reconciled by nonce and rebuilt next tick
 *   (evm-executor.mjs), so the position is not lost — it is entered LATER, at whatever
 *   the price has done meanwhile. The gas is a 21,000-unit cancel: 0.058% of a 0.0112
 *   clip, which is rounding. Charging a drop as gas and stopping there models the cheap
 *   half of it.
 *
 *   A VOID IS A MONEY COST, AND THE SELL LEG IS THE EXPENSIVE ONE. A voided send is a
 *   finalized failure and is NEVER retried. Voiding an ENTRY burns a leg and leaves no
 *   position. Voiding an EXIT burns a leg AND STRANDS THE POSITION with nothing left to
 *   close it — position-scale, not gas-scale. A model that voids only entries is exactly
 *   the flattering half, so the two legs are separable here and the sell leg is pinned.
 *
 * NEITHER RATE IS MEASURED, and that is the point of the last section. exec.dropRatePct
 * is registered null with CANARY provenance so nobody can read it as measured, and
 * SEND_DROP_PAUSE_PCT is a REFUSAL GATE — feeding a refusal gate a simulated cost is
 * this repo's own gate-doubles-as-cost lint. Nothing this model prints may flow back
 * into either, and the grep below is what keeps that true.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runOne, simConfig, rng, legGasEth, cancelGasEth, FAILURE_MODEL_HELP } from "./simulate.mjs";
import { ROUND_TRIP_GAS, GAS_PRICE_GWEI, DROP_RATE_PCT } from "./live-thresholds.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const here = new URL("./simulate.mjs", import.meta.url).pathname;
const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [here, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};

console.log("\nTHE FAILURE MODEL TAKES NO DEFAULT");
{
  const only = run(["--trials", "2", "--calls", "3", "--droprate", "2"]);
  ok("one flag alone is refused", only.code !== 0, `exit ${only.code}`);
  ok("...and the refusal names BOTH flags",
    /--droprate/.test(only.out) && /--voidrate/.test(only.out));
  ok("...and says why there is no default", /no defaults|CANARY|null/.test(only.out));
  const neither = run(["--trials", "2", "--calls", "3"]);
  ok("neither flag runs cleanly, with no failure model", neither.code === 0 &&
    /no sequencer failure model/.test(neither.out));
  const both = run(["--trials", "2", "--calls", "3", "--droprate", "2", "--voidrate", "1"]);
  ok("both flags run", both.code === 0);
  ok("...and print a SWEEP, not a point estimate",
    (both.out.match(/── drop /g) || []).length >= 3,
    `${(both.out.match(/── drop /g) || []).length} rows`);
  ok("...each row marked UNMEASURED while the registry value is null",
    DROP_RATE_PCT == null ? /UNMEASURED — modelled/.test(both.out) : true);
  ok("...and the run states nothing may be written back",
    /NOTHING HERE MAY BE WRITTEN BACK/.test(both.out));
  ok("the help text is exported so the message has one home",
    typeof FAILURE_MODEL_HELP === "string" && FAILURE_MODEL_HELP.includes("--voidrate"));
}

console.log("\nA DROP IS A DELAY, AND THE DELAY IS THE COST");
{
  const cfg = simConfig();
  const opts = { managed: true, calls: 40, deskLag: 6, cfg, dropDelaySteps: 6 };
  const clean = runOne({ ...opts, rand: rng(11) });
  const dropped = runOne({ ...opts, rand: rng(11), dropRate: 100 });
  ok("every entry dropped when the rate is 100%", dropped.drops === dropped.taken && dropped.drops > 0,
    `${dropped.drops} drops / ${dropped.taken} taken`);
  ok("no entry dropped when the rate is 0%", clean.drops === 0);
  const delta = Math.abs(dropped.realized - clean.realized);
  const gasCharged = dropped.drops * cancelGasEth();
  ok("a drop changes the outcome at all", delta > 0);
  ok("...and the DELAY dominates, not the 21,000-gas cancel", delta > gasCharged * 2,
    `delta ${delta.toFixed(6)} ETH vs gas ${gasCharged.toFixed(6)} ETH`);
  ok("...the cancel really is rounding against a clip",
    cancelGasEth() / cfg.fixedSol < 0.002,
    `${((cancelGasEth() / cfg.fixedSol) * 100).toFixed(3)}% of a ${cfg.fixedSol} ETH clip`);
}

console.log("\nA VOIDED SELL STRANDS THE POSITION — THE EXPENSIVE HALF");
{
  const cfg = simConfig();
  const opts = { managed: true, calls: 30, deskLag: 6, cfg };
  const clean = runOne({ ...opts, rand: rng(23) });
  const exitVoids = runOne({ ...opts, rand: rng(23), voidEntryRate: 0, voidExitRate: 100 });
  ok("every exit voids when only the sell leg is set", exitVoids.voidedExits > 0 && exitVoids.voidedEntries === 0,
    `${exitVoids.voidedExits} voided sells, ${exitVoids.voidedEntries} voided entries`);
  ok("...and each one strands its position", exitVoids.strandedPositions === exitVoids.voidedExits);
  ok("...which the clean run never does", clean.strandedPositions === 0 && clean.voidedExits === 0);
  ok("a stranded position costs more than the gas leg it burned",
    Math.abs(exitVoids.realized - clean.realized) > exitVoids.strandedPositions * legGasEth(),
    `delta ${Math.abs(exitVoids.realized - clean.realized).toFixed(6)} ETH`);

  const entryVoids = runOne({ ...opts, rand: rng(23), voidEntryRate: 100, voidExitRate: 0 });
  ok("a voided ENTRY opens no position at all", entryVoids.taken === 0 && entryVoids.voidedEntries > 0);
  ok("...and costs exactly one leg of gas each",
    Math.abs(entryVoids.realized + entryVoids.voidedEntries * legGasEth()) < 1e-12);
  ok("a leg is half the measured round-trip gas",
    Math.abs(legGasEth() - (ROUND_TRIP_GAS / 2) * GAS_PRICE_GWEI * 1e-9) < 1e-18);
  ok("voiding only entries would understate the risk",
    Math.abs(exitVoids.realized - clean.realized) > Math.abs(entryVoids.realized - clean.realized) * 0.5,
    "the sell leg is the one that matters");
}

console.log("\nNOTHING SIMULATED MAY REACH A THRESHOLD OR A REFUSAL GATE");
{
  const root = path.dirname(new URL(import.meta.url).pathname);
  const sim = fs.readFileSync(path.join(root, "simulate.mjs"), "utf8");
  ok("the simulator never writes a threshold",
    !/defineThreshold|registerMeasurement|thresholds\.(set|register)/.test(sim));
  ok("...and never mentions the drop pause gate as an output",
    !/SEND_DROP_PAUSE_PCT\s*=/.test(sim));
  ok("...and says so in the file, where the next person will read it",
    /gate-doubles-as-cost|refusal gate/.test(sim));
  ok("exec.dropRatePct is still registered unmeasured", DROP_RATE_PCT == null,
    "a measurement would change this test, correctly");
  /* The registry's own guard: a simulated number has no provenance state to live in. */
  const provenance = fs.readFileSync(path.join(root, "thresholds.mjs"), "utf8");
  ok("PROVENANCE has no 'simulated' state, and must not grow one",
    !/simulated/i.test(provenance));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
