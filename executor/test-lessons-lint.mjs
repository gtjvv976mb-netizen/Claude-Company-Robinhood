/**
 * THE LINT MUST CATCH THE REAL BUGS, AND STAY QUIET OTHERWISE.
 *
 * Each rule below is fed the ACTUAL code that failed on the Solana desk, and then the
 * actual fix, and must call the first and clear the second. A lint validated only
 * against invented samples is a lint that catches invented bugs — and a lint that cries
 * wolf gets switched off, which is worse than not having one.
 */
import { latchesWithoutRelease, timeNamedFromRowCount, unknownReadAsPermissive,
  constantAsGateAndCost, lintSource } from "./lessons-lint.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE LATCH THAT SILENCED THE REHEARSAL (2026-09-03)");
{
  // The shape that broke: set before an async call that could never settle.
  const broken = `
let readinessProbeInFlight = false;
function maybeProbe() {
  if (readinessProbeInFlight) return;
  readinessProbeInFlight = true;
  probe().then((r) => { report(r); });
}`;
  const fixed = `
let readinessProbeInFlight = false;
function maybeProbe() {
  if (readinessProbeInFlight) return;
  readinessProbeInFlight = true;
  Promise.race([probe(), deadline]).then(report)
    .finally(() => { readinessProbeInFlight = false; });
}`;
  ok("the unreleased latch is caught", latchesWithoutRelease(broken).some((f) => f.name === "readinessProbeInFlight"));
  ok("...and the released one is not", !latchesWithoutRelease(fixed).length,
    JSON.stringify(latchesWithoutRelease(fixed)));
}

console.log("\nTHE '1m CANDLE' THAT WAS NOT A MINUTE");
{
  const broken = `const recentVol = sum(vol.slice(-5));
  const vol5mUsd = sum(vol.slice(-5));`;
  const fixed = `const recent = tape.filter((k) => k.ts > end - 5 * MIN);
  const vol5mUsd = sumVol(recent);`;
  ok("a five-minute window cut on rows is caught", timeNamedFromRowCount(broken).length > 0,
    timeNamedFromRowCount(broken)[0]?.name);
  ok("...and one cut on timestamps is not", !timeNamedFromRowCount(fixed).length);
}

console.log("\nUNKNOWN IS NOT 'NO'");
{
  ok("a catch that returns true is caught",
    unknownReadAsPermissive("try { x(); } catch { return true; }").length > 0);
  ok("a catch that returns an empty list is caught",
    unknownReadAsPermissive("try { x(); } catch (e) { return []; }").length > 0);
  ok("a safety field defaulting to pass is caught",
    unknownReadAsPermissive("const tradeable = row.tradeable ?? true;").length > 0);
  // The scope guard's real branch: a failed read REFUSES. It must stay quiet.
  const guard = `
  try { word = await readStorage(address, SLOT); }
  catch (e) { return { tradeable: false, kind: "unreadable", reason: e.message }; }`;
  ok("...and the guard that refuses on an unreadable read is not", !unknownReadAsPermissive(guard).length);
}

console.log("\nONE CONSTANT, TWO JOBS");
{
  // The real bug: the same name compared as a ceiling and multiplied as a cost.
  const broken = `
  if (networkFees > cfg.maxNetworkFeeLamports) throw new Error("over cap");
  const worstFeeRatio = 2 * cfg.maxNetworkFeeLamports / Number(amountRaw);`;
  const fixed = `
  if (networkFees > cfg.maxNetworkFeeLamports) throw new Error("over cap");
  const worstFeeRatio = 2 * cfg.expectedNetworkFeeLamports / Number(amountRaw);`;
  ok("the gate doubling as a cost model is caught",
    constantAsGateAndCost(broken).some((f) => /maxNetworkFee/.test(f.name)));
  ok("...and the split version is not",
    !constantAsGateAndCost(fixed).some((f) => /maxNetworkFee/.test(f.name)));
}

console.log("\nTHE FORK'S OWN SOURCE IS CLEAN");
{
  const fs = await import("node:fs");
  const files = ["scope-guard.mjs", "thresholds.mjs", "live-thresholds.mjs", "lessons-lint.mjs"];
  for (const f of files) {
    const findings = lintSource(fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
    ok(`${f}`, findings.length === 0, findings.map((x) => x.message).join("; ").slice(0, 96) || "no findings");
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
