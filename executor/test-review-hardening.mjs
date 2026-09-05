/**
 * THE 2026-09-01 ADVERSARIAL-REVIEW HARDENING — the findings that survive the port.
 *
 * The Solana review's eight findings shared one shape: the only number a guard
 * consulted was one the counterparty authored, or a state write landed on an object the
 * state had already abandoned. Findings about Jupiter's transaction shape (F1, F2, F3,
 * F5, the P3/P4/P5 blockhash-expiry passes) have no EVM analogue and are covered where
 * their INTENT survives, in test-evm-swap.mjs (the chain-measured floor) and
 * test-evm-execution.mjs (write-ahead, the resume/expiry fence, fee-bearing attempts).
 * What is pinned here is the rest: the policy ratchet, the poller's state handling, the
 * cache, and the desk-side witness rules the seats still depend on.
 */
import fs from "node:fs";
import { pricePolicy, POLICY_VERSION } from "./trade-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
};

/* ── F8: the high-water mark needs two witnesses ─────────────────────────────── */
console.log("\nTHE RATCHET NEEDS TWO WITNESSES");
{
  const cfg = { breakevenArmX: 1.35, trailArmX: 1.5, trailPct: 0.25, takeProfitX: 0, maxAgeHours: 0, honorDeskTarget: false };
  let p = { entry: 1, stop: 0.8, high: 1.0, openedAtMs: 0 };
  const t1 = pricePolicy({ position: p, mark: 1.9, config: cfg, nowMs: 1 });
  ok("a lone 1.9x spike does not ratchet the stop", t1.position.stop === 0.8,
    `stop stays ${t1.position.stop} (used to jump to 1.425 and force-sell next tick)`);
  const t2 = pricePolicy({ position: t1.position, mark: 1.1, config: cfg, nowMs: 2 });
  ok("...and the next honest tick HOLDS instead of force-selling", t2.action === "hold",
    `${t2.action} (${t2.reason})`);
  ok("...the spike value itself can never commit", t2.position.high <= 1.1 && t2.position.high !== 1.9,
    `high=${t2.position.high}`);
  const t3 = pricePolicy({ position: t2.position, mark: 0.95, config: cfg, nowMs: 3 });
  ok("...and a down-tick clears the stage entirely", (Number(t3.position.pendingHigh) || 0) === 0);

  let q = { entry: 1, stop: 0.8, high: 1.0, openedAtMs: 0 };
  const r1 = pricePolicy({ position: q, mark: 1.6, config: cfg, nowMs: 1 });
  const r2 = pricePolicy({ position: r1.position, mark: 1.7, config: cfg, nowMs: 2 });
  ok("a real run commits on the second witness", r2.position.high === 1.6,
    `high=${r2.position.high}, the LOWER of the two consecutive samples`);
  ok("...and arms the trail off the confirmed high", r2.position.stop === 1.6 * 0.75, `stop=${r2.position.stop}`);
  const r3 = pricePolicy({ position: r2.position, mark: 1.15, config: cfg, nowMs: 3 });
  ok("...and the ratcheted stop still fires on a genuine giveback", r3.action === "sell", r3.reason);
  ok("the policy version says so", POLICY_VERSION === "snipe-v3");
}

/* ── the executor carries the review's signing-path contracts in EVM form ───── */
console.log("\nSIGNING-PATH CONTRACTS (EVM form; exercised end-to-end in test-evm-execution.mjs)");
{
  const src = fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8");
  const swap = fs.readFileSync(new URL("./evm-swap.mjs", import.meta.url), "utf8");
  const exec = src.slice(src.indexOf("async executeIntent"), src.indexOf("async _prepareUnsigned"));
  const sign = src.slice(src.indexOf("async _signAndJournal"), src.indexOf("async _resume"));
  ok("F3: the bytes are proven with eth_call BEFORE they are signed — prepareSwap precedes signTransaction",
    src.indexOf("prepareSwap(this.primary") < src.indexOf("this.wallet.signTransaction(tx)"),
    "a signature authorizes, it does not change execution; nothing broadcastable exists until the chain agreed");
  ok("F5: a refused build journals NOTHING — recordSigned is reached only after the proof",
    exec.indexOf("_prepareUnsigned") < exec.indexOf("_signAndJournal") && /recordSigned\(/.test(sign) && !/recordSigned/.test(exec));
  ok("F1: the floor is measured against the CHAIN's output, never only against the quote",
    /extractable = sim\.amountOut - embedded/.test(swap) && /allowed = sim\.amountOut \* BigInt\(slippageBps\)/.test(swap),
    "a uniformly low-balled quote moves our floor with it; only the simulated output is independent of the party being checked");
  ok("F6: exits may retry past the entry cap", /maxExitAttempts/.test(exec) && /cooling down/.test(exec));
  ok("F6: entries keep the hard cap of maxAttempts", /if \(!isExit && count >= this\.cfg\.maxAttempts\)/.test(exec));
  ok("P4-4: only FEE-BEARING attempts spend the exit budget", /feeAttempts/.test(exec) && /state === "failed"/.test(exec),
    "a dropped-and-cancelled attempt costs a cancel's gas and proves nothing about the market");
  ok("P5-4: the cooldown keys on FEE-BEARING attempts, same counter as the cap",
    /feeAttempts >= this\.cfg\.maxAttempts/.test(exec));
  ok("P3-1/P5-1: a 'signed' attempt is checked against the chain head before disclosure, and expires undisclosed past its deadline",
    /attempt\.state === "signed"/.test(src) && src.indexOf("head.low > attempt.deadlineBlock") < src.indexOf("this.journal.markSubmitted("));
  ok("the write-ahead: markSubmitted precedes the send", src.indexOf("this.journal.markSubmitted(") < src.indexOf("await this._send("));
}

/* ── F4/F7 shape checks in the poller ────────────────────────────────────────── */
console.log("\nSTATE-HANDLING CONTRACTS IN THE POLLER");
{
  const src = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  const manage = src.slice(src.indexOf("async function manageOpen"), src.indexOf("let ticking = false"));
  ok("F4: positions are re-resolved from live state each iteration, not held from a snapshot",
    /for \(const posKey of openList\(\)\.map\(\(p\) => p\.mint\)\)/.test(manage) &&
    /openList\(\)\.find\(\(p\) => p\.mint === posKey\)/.test(manage));
  const afterLastCatch = manage.split("catch (error)").at(-1) ?? "";
  ok("F4: the outer catch writes to the live object too",
    afterLastCatch.includes("openList().find((p) => p.mint === posKey)"));
  ok("F7: an ETH/USD outage falls back to the cached rate instead of disarming stops",
    /ethUsdCache/.test(manage) && /stops stay armed/.test(manage));
  ok("F7: the fallback is bounded by age", /ETH_USD_CACHE_MAX_AGE_MS/.test(manage));
  ok("P3-5: the ETH/USD cache is durable, not process-memory",
    /setMeta\("eth_usd_cache"/.test(src) && /getMeta\("eth_usd_cache"/.test(src));
  ok("P4-3: the persisted cache age is bounded below as well as above",
    /usableEthUsdCache/.test(src) &&
      /observedAgeMs < 0 \|\| publishAgeMs < 0/.test(fs.readFileSync(new URL("./eth-usd-oracle.mjs", import.meta.url), "utf8")));
  ok("exit policy consumes the executable mark, never a display quote",
    /preflightExitMark/.test(manage) && /observation\.actualOutputRaw/.test(manage));
  ok("two consecutive unusable executable marks latch a risk-reducing exit",
    /confirmExitMarkFailureWitness/.test(manage) &&
      /independent executable exit mark unavailable on two consecutive ticks/.test(manage));
  const limits = src.slice(src.indexOf("const LIVE_LIMITS"), src.indexOf("const log ="));
  ok("the bounds are FROZEN live ceilings like every other cap",
    /deadlineBlocks: 300/.test(limits) && /maxExitAttempts: 12/.test(limits) && /Object\.freeze/.test(limits));
  ok("the counterparty never authors the USD anchor: the entry stores Chainlink's read, with its round provenance",
    /ethUsdSource: ethUsdOracle\.source/.test(src) && /independentEthUsdPrice\(providers\)/.test(src));
}

/* ── the desk-side witness rules the seats still depend on ─────────────────── */
console.log("\nDESK-SIDE WITNESS CONTRACTS");
{
  const pent = fs.readFileSync(new URL("../src/penthouse.js", import.meta.url), "utf8");
  const idx = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const callsSrc = fs.readFileSync(new URL("../src/calls.js", import.meta.url), "utf8");
  ok("P3-3: provenance rows carry no mark — one observation can no longer confirm itself",
    !/noteEvent\(call\.id, "evidence", [^)]*entry_ref\)/.test(pent) &&
    !/noteEvent\(call\.id, "mandate", [^)]*entry_ref\)/.test(pent));
  ok("P3-2: sub-tick marks give the pair rule honest neighbours inside a monitor pass",
    /export async function subTickMarks/.test(pent) && /PENTHOUSE_SUBMARK_SECS/.test(idx));
  ok("P3-4: a close print is provisional until one confirming read agrees",
    /close_restated/.test(pent) && /close_confirmed/.test(callsSrc));
  ok("P4-5: sub-tick marks arm once per process with a busy guard and minimum spacing",
    /_subTickArmed/.test(pent) && /_subTickBusy/.test(pent) && /minSpacingMs/.test(pent) &&
    /startSubTickMarks\(/.test(idx) && !/setInterval\(\(\) => \{ subTickMarks/.test(idx));
  const sub = pent.slice(pent.indexOf("export async function subTickMarks"), pent.indexOf("export async function monitorCalls"));
  ok("P4-6: a close print is judged against the mark BEFORE it, not the price after", /preMark/.test(sub) && /postAgreesWithPre/.test(sub));
  ok("P4-8: both confirm/restate UPDATEs refuse to touch an already-confirmed close",
    (sub.match(/close_confirmed IS NULL/g) || []).length >= 3);
  ok("P4-6b: with no pre-close witness the print stands", /one witness cannot convict another/.test(sub));
  ok("P5-5: every witness mark enters by one spacing-guarded door",
    /export function writeWitnessMark/.test(pent) && /if \(!writeWitnessMark\(call\.id, now\.mark\)\)/.test(pent));
  ok("P5-6: a restatement may never flatter the outcome", /flatters/.test(sub) && /never in the book's favour/.test(sub));
  ok("P5-7: closes stay eligible until confirmed; the post-close witness is history",
    /24 \* 3600e3/.test(sub) && /postMark/.test(sub));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
