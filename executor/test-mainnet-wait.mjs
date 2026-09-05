/**
 * A NETWORK BLIP IS NOT A WRONG CHAIN.
 *
 * The chain-id check exists so the bot can never trade against another network, and
 * that is right. But the Solana build sent both facts to the same place: "the RPC did
 * not answer" and "the RPC answered, and it is not our chain" both hit fatal(), which
 * is process.exit(1), and launchd restarts.
 *
 * Measured over two days of the Solana live log: 63 cap-acknowledgement lines against
 * 14 boots, and four "RPC mainnet check failed: fetch failed" refusals inside 31 seconds
 * at 06:07 on 2026-09-03. The bot spent much of its life dead, and each restart hurt
 * twice — it was not polling while down, and the calls waiting for it aged past
 * MAX_CALL_AGE_MIN and were skipped as stale ("call is 143m old (max 45m)").
 *
 * What must remain absolutely true, and is asserted here against the ported proof: an
 * ANSWER that is not chain 4663 still refuses immediately and is never retried into
 * acceptance, both providers must prove 0x1237, and nothing may trade before that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const src = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("async function proveChainOrWait()"),
  src.indexOf("if (EXECUTE) await proveChainOrWait();"));

console.log("\nA WRONG CHAIN IS STILL REFUSED, AT ONCE");
{
  ok("the chain is proved by eth_chainId, expected 0x1237", /CHAIN_ID_HEX = "0x1237"/.test(src) && /eth_chainId/.test(fn));
  ok("a wrong-chain primary still calls fatal",
    /if \(chainId !== CHAIN_ID_HEX\) fatal\(/.test(fn));
  ok("a wrong-chain secondary still calls fatal",
    /if \(secondaryChainId !== CHAIN_ID_HEX\)\s*\n\s*fatal\(/.test(fn));
  /* The refusal must sit AFTER the successful read and OUTSIDE the catch, or a wrong
     endpoint would be retried instead of refused — which is the one outcome that would
     make this change dangerous rather than merely kinder. */
  const catchStart = fn.indexOf("} catch (error) {");
  const catchEnd = fn.indexOf("continue;", catchStart);
  const inCatch = fn.slice(catchStart, catchEnd);
  ok("the retry path never calls fatal", !/fatal\(/.test(inCatch));
  ok("...and the refusal path is not inside it",
    fn.indexOf("chainId !== CHAIN_ID_HEX") > catchEnd);
  ok("a wrong chain is never retried: the refusal has no continue after it",
    !/CHAIN_ID_HEX\)[\s\S]{0,200}continue;/.test(fn.slice(fn.indexOf("if (chainId !== CHAIN_ID_HEX"))));
}

console.log("\nA TRANSPORT FAILURE WAITS INSTEAD OF DYING");
{
  ok("the unreachable case backs off rather than exiting", /await new Promise\(\(r\) => setTimeout\(r, waitMs\)\)/.test(fn));
  const cap = (fn.match(/MAX_BACKOFF_MS = ([0-9_]+)/) || [])[1];
  ok("the backoff is capped, so a long outage retries steadily", cap != null, `${cap} ms`);
  ok("...and the exponent is clamped, so waitMs cannot overflow into a dead process",
    /2 \*\* Math\.min\(attempt - 1, \d+\)/.test(fn));
  ok("the wait is logged, so an operator can tell waiting from hung",
    /RPC unreachable for the chain check/.test(fn));
  ok("...but not on every attempt, so an outage cannot bury the log",
    /attempt === 1 \|\| attempt % \d+ === 0/.test(fn));
  ok("the transport itself has a deadline, so a hung socket is a failure and not a hang",
    /RPC_REQUEST_TIMEOUT_MS/.test(fs.readFileSync(new URL("./evm-rpc.mjs", import.meta.url), "utf8")));
}

console.log("\nNOTHING TRADES BEFORE BOTH PROVIDERS HAVE PROVED THE CHAIN");
{
  ok("both providers are read every attempt",
    /primary\("eth_chainId"\), secondary\("eth_chainId"\)/.test(fn));
  ok("the loop only returns after both checks pass", /return;\n\s*\}\n\}/.test(fn));
  const gate = src.indexOf("if (EXECUTE) await proveChainOrWait();");
  ok("live mode awaits the proof at startup", gate > 0);
  ok("the executor is constructed only after the proof", src.indexOf("new EvmExecutor(") > gate);
  /* Everything that can sign or send must come after the proof. The poll loop is armed
     by setInterval(tick, POLL_MS) at the end of the file; if that ever moved above this
     gate, the bot could trade during an unverified window. */
  ok("the poll loop is armed only after the proof", src.indexOf("setInterval(tick, POLL_MS)") > gate,
    `proof@${gate} poll@${src.indexOf("setInterval(tick, POLL_MS)")}`);
  const registry = src.indexOf("try { assertLiveReady(); }");
  ok("the thresholds registry is checked BEFORE the chain: an unarmed bot never asks a provider anything",
    registry > 0 && registry < gate, `registry@${registry} chain@${gate}`);
}

console.log("\nEVERY OTHER REFUSAL IS STILL A REFUSAL");
{
  /* The rest of the fatals are deterministic configuration checks — a bad cap, a
     world-readable key, a missing acknowledgement. Retrying those would be wrong,
     and this change must not have touched them. */
  const fatals = (src.match(/fatal\(/g) || []).length;
  ok("the poller still refuses on configuration errors", fatals >= 25, `${fatals} fatal() call sites`);
  ok("the key-file permission check still refuses", /live key file permissions must be 0600/.test(
    fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8")));
  ok("the caps acknowledgement still refuses", /raised live caps need a typed acknowledgement/.test(src));
  ok("no other fatal is reached from a network read",
    !/catch[^{]*\{\s*fatal\(`RPC/.test(src), "the chain-check catch was the only one");
}

console.log("\nA HUNG REHEARSAL CANNOT SILENCE THE REHEARSAL");
{
  /* readinessProbeInFlight is cleared in a .finally(), which is correct for a promise
     that settles and useless for one that does neither. Observed live on 2026-09-03 —
     no readiness line of either kind for nineteen minutes across ~80 ticks. */
  const probe = src.slice(src.indexOf("function maybeProbeExecutionReadiness()"),
    src.indexOf("function sendHeartbeat"));
  ok("the probe is raced against a deadline", /Promise\.race\(\[/.test(probe));
  ok("...and the deadline rejects rather than resolving quietly",
    /setTimeout\(\s*\(\) => reject\(/.test(probe));
  ok("the in-flight flag is cleared by the RACE, not the probe",
    /\}\)\.finally\(\(\) => \{ clearTimeout\(readinessTimer\); readinessProbeInFlight = false; \}\)/.test(probe));
  ok("the timer is cleared so a fast probe leaves nothing pending", /clearTimeout\(readinessTimer\)/.test(probe));
  ok("...and never holds the process open", /readinessTimer\.unref\?\.\(\)/.test(probe));
  const floor = (probe.match(/Math\.max\((\d+_?\d*), Number\(process\.env\.READINESS_TIMEOUT_MS\)/) || [])[1];
  ok("the deadline has a floor, so it cannot be tuned to zero", floor != null, `${floor} ms`);
  ok("the deadline is generous enough not to truncate a healthy rehearsal",
    /\|\| 90_000/.test(probe), "90s against an aggregator build plus an eth_call");
  // The rehearsal must remain advisory: it signs nothing and gates no entry.
  ok("the rehearsal still gates nothing", !/pauseEntries|entrySubmissionGate/.test(probe));
  ok("the rehearsal is on the fixed ETH→USDG route the office recognises (src/executor-dashboard.js EXECUTOR_READINESS_ROUTE)",
    /EXECUTION_READINESS_ROUTE = "eth-usdg"/.test(fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8")));
}

console.log("\nA HEALTHY REHEARSAL IS AUDIBLE");
{
  const probe = src.slice(src.indexOf("function maybeProbeExecutionReadiness()"),
    src.indexOf("const noteFeedFailure"));
  ok("a recovery still logs immediately", /const recovered = result\?\.ready === true && lastReadinessError !== null/.test(probe));
  ok("a plain success can log too, on its own clock", /dueForHeartbeat/.test(probe));
  ok("either one logs", /if \(recovered \|\| dueForHeartbeat\)/.test(probe));
  ok("the first success after boot always speaks",
    /let lastReadinessSuccessLoggedAt = 0;/.test(src), "0 means never logged");
  const quiet = (probe.match(/readinessSuccessQuietMs = ([0-9_]+)/) || [])[1];
  ok("...and then it is rate limited, so it cannot bury the log", quiet != null, `${quiet} ms`);
  ok("the failure path still collapses repeats", /if \(reason !== lastReadinessError\)/.test(probe));
  ok("the gas price and provider heads are reported with the proof, since they are what moves",
    /gasPriceWei/.test(probe) && /heads/.test(probe));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
