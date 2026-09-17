/**
 * A QUOTE IS NOT A DEMONSTRATION THAT THE TOKENS CAN LEAVE.
 *
 * The preflight took the aggregator's reverse quote as proof of an exit. The gap between
 * "a router will route this" and "this wallet can actually sell" is every honeypot ever
 * written, and on chain 4663 that gap cannot be traded out of: priority fees are refunded
 * and ordering is first-come-first-served, so there is no paying your way out of a
 * position whose transfer has been switched off.
 *
 * So the proof executes the real sell calldata against the real router, with the position
 * and the allowance handed to the wallet for the length of one eth_call, and measures
 * what comes back.
 *
 * ── THE ASSERTIONS THAT MATTER MOST ARE THE BORING ONES ─────────────────────────────
 *
 *   · It NEVER THROWS. A check that can throw on the entry path is a bot that stops
 *     trading for a reason nobody sees — indistinguishable from a quiet market.
 *   · A TRANSPORT FAILURE IS `unreadable`, NOT `proven`. This repo has fixed
 *     fail-open-on-a-429 twice; a third time would be a choice.
 *   · A REVERT IS `refutable`, NOT `unreadable`. The revert IS the finding. Filing the
 *     honeypot under "could not measure" is how it gets bought.
 *
 * The three verdicts are three different facts and collapsing any two of them is the bug
 * this file exists to prevent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { proveExit, observationVerdict, recordExitProof, EXIT_GATE, EXIT_VERDICTS } from "./sell-proof.mjs";
import { mappingKey, soladyBalanceKey, soladyAllowanceKey, PROBE_EOA, _clearSlotCache } from "./storage-slots.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const TOKEN = "0x" + "a".repeat(40);
const ROUTER = "0x" + "b".repeat(40);
const WALLET = "0x" + "c".repeat(40);
const DATA = "0xdeadbeef";
const AMOUNT = 1_000_000_000_000_000_000n;
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

/**
 * A fake chain. `layout` decides which storage key reads the sentinel back (so the slot
 * scan can succeed), and `sell` decides what the router does once the scan is done.
 */
function fakeChain({ balSlot = 0, sell = () => ({ ok: true, data: word(900n) }), scanError = null } = {}) {
  const balKey = mappingKey(WALLET, balSlot);
  const allowKey = mappingKey(ROUTER, mappingKey(WALLET, balSlot + 1));
  let calls = 0;
  const call = async (to, data, overrides, opts) => {
    calls++;
    if (scanError && to === TOKEN) return { ok: false, error: scanError };
    if (to === TOKEN) {
      const diff = overrides?.[TOKEN]?.stateDiff ?? {};
      for (const [k, v] of Object.entries(diff)) if (k === balKey || k === allowKey) return { ok: true, data: v };
      return { ok: false, error: "execution reverted" };
    }
    return sell(to, data, overrides, opts);
  };
  return { call, balKey, allowKey, calls: () => calls };
}

console.log("\nTHE SELL IS EXECUTED, NOT QUOTED");
{
  _clearSlotCache();
  const chain = fakeChain({ sell: () => ({ ok: true, data: word(950n) }) });
  const p = await proveExit(chain.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 900n, quotedOut: 1000n });
  ok("a clean sell is PROVEN", p.verdict === "proven", p.reason);
  ok("...and reports what came back", p.simulatedOut === "950");
  ok("...and what the token kept against the quote", p.effectiveTaxBps === 500,
    `${p.effectiveTaxBps} bps of 1000 quoted vs 950 simulated`);
  ok("...and which slots it used, for the record", p.balanceSlot === "0" && p.slotKind === "sequential");
  ok("the calldata went to the ROUTER, not the token",
    (await (async () => { let seen = null;
      const c = fakeChain({ sell: (to) => { seen = to; return { ok: true, data: word(950n) }; } });
      _clearSlotCache();
      await proveExit(c.call, { token: TOKEN, amount: AMOUNT, router: ROUTER, data: DATA, wallet: WALLET, floor: 0n });
      return seen; })()) === ROUTER);
}

console.log("\nA REVERT IS THE FINDING, NOT A FAILURE TO MEASURE");
{
  _clearSlotCache();
  const chain = fakeChain({ sell: () => ({ ok: false, error: "execution reverted: TRANSFER_FROM_FAILED" }) });
  const p = await proveExit(chain.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 900n });
  ok("a reverting sell is REFUTABLE", p.verdict === "refutable", p.reason);
  ok("...never unreadable — that is how a honeypot gets bought", p.verdict !== "unreadable");
  ok("...and the revert reason is carried", /TRANSFER_FROM_FAILED/.test(p.revertReason || ""));
  ok("...and it maps to would_refuse", observationVerdict(p) === "would_refuse");
}

console.log("\nA SELL THAT EXECUTES BUT PAYS TOO LITTLE IS ALSO REFUTABLE");
{
  _clearSlotCache();
  const chain = fakeChain({ sell: () => ({ ok: true, data: word(10n) }) });
  const p = await proveExit(chain.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 900n, quotedOut: 1000n });
  ok("returning under the floor is REFUTABLE", p.verdict === "refutable", p.reason);
  ok("...and the reason names both numbers", /10/.test(p.reason) && /900/.test(p.reason));
  ok("...and the tax it implies", p.effectiveTaxBps === 9900, `${p.effectiveTaxBps} bps kept`);
}

console.log("\nA TRANSPORT FAILURE IS UNREADABLE — NOT A PASS, NOT A REFUSAL");
{
  _clearSlotCache();
  const scan = fakeChain({ scanError: "HTTP 429 Too many requests" });
  const p1 = await proveExit(scan.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 900n });
  ok("a 429 during the slot scan is UNREADABLE", p1.verdict === "unreadable", p1.reason?.slice(0, 70));
  ok("...and says it was transport", p1.transport === true);
  ok("...and never reads as proven", p1.verdict !== "proven");

  _clearSlotCache();
  const sim = fakeChain({ sell: () => ({ ok: false, error: "fetch failed" }) });
  const p2 = await proveExit(sim.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 900n });
  ok("a transport failure during the simulation is UNREADABLE", p2.verdict === "unreadable", p2.reason?.slice(0, 60));
  ok("...and is NOT filed as a revert", p2.reverted !== true);
  ok("...and maps to the unreadable observation", observationVerdict(p2) === "unreadable");

  _clearSlotCache();
  const gone = fakeChain({ balSlot: 99 });   // nothing in range reads back
  const p3 = await proveExit(gone.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 900n });
  ok("a token whose slot cannot be found is UNREADABLE, never proven", p3.verdict === "unreadable",
    p3.reason?.slice(0, 60));
}

console.log("\nIT NEVER THROWS, WHATEVER HAPPENS");
{
  const throwers = [
    ["the rpc throws", async () => { throw new Error("socket hang up"); }],
    ["the rpc returns junk", async () => ({ ok: true, data: "not-hex" })],
    ["the rpc returns nothing", async () => undefined],
  ];
  for (const [label, call] of throwers) {
    _clearSlotCache();
    let threw = false, p = null;
    try { p = await proveExit(call, { token: TOKEN, amount: AMOUNT, router: ROUTER, data: DATA, wallet: WALLET }); }
    catch { threw = true; }
    ok(`${label} → a verdict, not an exception`, !threw && p != null, p?.verdict);
    ok(`...and it is never proven`, p?.verdict !== "proven");
  }
  for (const [label, args] of [
    ["no token", { amount: AMOUNT, router: ROUTER, data: DATA }],
    ["no calldata", { token: TOKEN, amount: AMOUNT, router: ROUTER }],
    ["zero amount", { token: TOKEN, amount: 0n, router: ROUTER, data: DATA }],
  ]) {
    const p = await proveExit(async () => ({ ok: true, data: word(1n) }), args);
    ok(`${label} → unreadable, with a reason`, p.verdict === "unreadable" && p.reason.length > 10, p.reason);
  }
}

console.log("\nSOLADY'S LAYOUT IS FOUND TOO — 90 OF 800 LISTED TOKENS ARE IT");
{
  _clearSlotCache();
  const balKey = soladyBalanceKey(WALLET);
  const allowKey = soladyAllowanceKey(WALLET, ROUTER);
  const call = async (to, data, overrides) => {
    if (to === TOKEN) {
      const diff = overrides?.[TOKEN]?.stateDiff ?? {};
      for (const [k, v] of Object.entries(diff)) if (k === balKey || k === allowKey) return { ok: true, data: v };
      return { ok: false, error: "execution reverted" };
    }
    return { ok: true, data: word(1234n) };
  };
  const p = await proveExit(call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 1000n });
  ok("a Solady token proves its exit", p.verdict === "proven", p.reason);
  ok("...and the record says which layout", p.slotKind === "solady");
}

console.log("\nTHE OBSERVATION IT WRITES, AND THAT IT CANNOT REFUSE A TRADE");
{
  const rows = [];
  const journal = { recordGateObservation: (r) => { rows.push(r); return { ok: true }; } };
  _clearSlotCache();
  const chain = fakeChain({ sell: () => ({ ok: false, error: "execution reverted" }) });
  const p = await proveExit(chain.call, { token: TOKEN, amount: AMOUNT, router: ROUTER,
    data: DATA, wallet: WALLET, floor: 1n });
  recordExitProof(journal, p, { callId: 7, mint: TOKEN, symbol: "HONEY", clipWei: "1000", enforcing: false });
  ok("one row is written", rows.length === 1);
  ok("...under the gate's own name", rows[0].gate === EXIT_GATE && EXIT_GATE === "exit_route_unproven");
  ok("...as would_refuse, not as a refusal", rows[0].verdict === "would_refuse");
  ok("...marked observe-only", rows[0].enforcing === false);
  ok("...carrying the evidence", rows[0].value.reverted === true && rows[0].value.reason.length > 10);

  ok("a missing journal is not an error the caller must handle",
    recordExitProof(null, p).ok === false);
  const throwing = { recordGateObservation: () => { throw new Error("disk full"); } };
  let threw = false;
  try { recordExitProof(throwing, p); } catch { threw = true; }
  ok("a journal that throws does NOT reach the caller", threw === false,
    "a measurement may never refuse a trade");

  /* The promotion has not happened. Nothing may refuse on this yet. */
  const src = fs.readFileSync(new URL("./sell-proof.mjs", import.meta.url), "utf8");
  ok("the module never throws to refuse", !/throw new Error\(`the sell/.test(src));
  ok("...and says it ships fail-open", /FAIL-OPEN/.test(src));
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  ok("the poller does not yet refuse on it",
    !/verdict === "refutable"[\s\S]{0,200}return log\(`SKIP/.test(poller));
  ok("the three verdicts are the three facts", EXIT_VERDICTS.length === 3 &&
    EXIT_VERDICTS.join(",") === "proven,refutable,unreadable");
  assert.ok(!/privateKey|signTransaction/.test(src), "a simulation signs nothing");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
