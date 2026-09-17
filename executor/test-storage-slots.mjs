/**
 * A MIRROR THAT DRIFTS IS WORSE THAN NO MIRROR.
 *
 * storage-slots.mjs is a deliberate copy of src/data/evm.js's slot finder, because
 * executor/ is a standalone installed package whose only dependency is ethers and it does
 * not import ../src — the rule erc20-hazards.mjs already follows. A copy is the right
 * call there, and it is also how two versions of one fact start disagreeing.
 *
 * So this file pins the copy to the original in the only way that survives: it recomputes
 * the DERIVATIONS on both sides and compares the VALUES, and it reads the desk's source as
 * TEXT to catch a namespace or a seed being added there and not here. Comparing values,
 * never source literals, is this repo's own rule for exactly this situation.
 *
 * ── WHAT THE COPY HAD TO CARRY, AND WHY EACH ONE COST SOMETHING ─────────────────────
 *
 *   · A TRANSPORT FAILURE IS NOT "NOT THIS SLOT". Thirteen 429s once read as "balanceOf
 *     did not read back from slots 0..12" and a coin died unverified on a busy minute.
 *   · SOLADY IS NOT A MAPPING, and it is ~90 of 800 listed tokens. Its balance key is
 *     keccak(owner ‖ 8 zero bytes ‖ 0x87a211a2), which is why a candidate carries a
 *     keyFor() FUNCTION and no caller may assume the Solidity shape.
 *   · THE ORDER IS BY MEASURED FREQUENCY, because every miss is a round trip.
 *
 * A negative cache is the one deliberate DIVERGENCE: the desk caches "no slot found"
 * forever, which is fine for a workup that runs once. The executor may hold a position
 * across a proxy upgrade that rewrites the layout, so here a negative is bounded by
 * block and expires.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  mappingKey, erc7201Slot, soladyBalanceKey, soladyAllowanceKey,
  findBalanceSlot, findAllowanceSlot, isTransportError, _clearSlotCache,
  ERC7201_NAMESPACES, SEQUENTIAL_SLOTS, SOLADY_BALANCE_SEED, SOLADY_ALLOWANCE_SEED,
  PROBE_EOA,
} from "./storage-slots.mjs";
const desk = await import("../src/data/evm.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const here = path.dirname(new URL(import.meta.url).pathname);
const deskSrc = fs.readFileSync(path.join(here, "..", "src", "data", "evm.js"), "utf8");
const OWNER = "0x" + "1".repeat(40);
const SPENDER = "0x" + "2".repeat(40);
const TOKEN = "0x" + "a".repeat(40);
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

console.log("\nEVERY DERIVATION COMPUTES THE SAME VALUE AS THE DESK'S");
{
  ok("the OpenZeppelin ERC-7201 slot", erc7201Slot("openzeppelin.storage.ERC20") === desk.OZ_ERC20_SLOT,
    desk.OZ_ERC20_SLOT.slice(0, 18) + "…");
  for (const ns of ERC7201_NAMESPACES)
    ok(`the ${ns} namespace`, erc7201Slot(ns) === desk.erc7201Slot(ns));
  ok("the Solady balance key", soladyBalanceKey(OWNER) === desk.soladyBalanceKey(OWNER));
  ok("the Solady allowance key", soladyAllowanceKey(OWNER, SPENDER) === desk.soladyAllowanceKey(OWNER, SPENDER));
  for (const slot of [0, 1, 7, 12, 63])
    ok(`the mapping key at slot ${slot}`, mappingKey(OWNER, slot) === desk.mappingKey(OWNER, slot));
  ok("a nested mapping key (allowance)",
    mappingKey(SPENDER, mappingKey(OWNER, 3)) === desk.mappingKey(SPENDER, desk.mappingKey(OWNER, 3)));
  ok("the Solady seeds are the measured ones",
    SOLADY_BALANCE_SEED === "87a211a2" && SOLADY_ALLOWANCE_SEED === "7f5e9f20");
  ok("...and are the same seeds the desk uses",
    SOLADY_BALANCE_SEED === desk.SOLADY_BALANCE_SEED && SOLADY_ALLOWANCE_SEED === desk.SOLADY_ALLOWANCE_SEED);
}

console.log("\nTHE DESK'S SOURCE HAS NOT GROWN A CANDIDATE THIS COPY LACKS");
{
  const nsLine = deskSrc.match(/const ERC7201_NAMESPACES = \[([\s\S]*?)\]/);
  assert.ok(nsLine, "ERC7201_NAMESPACES moved in the desk — repoint this test, do not delete it");
  const deskNamespaces = nsLine[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const missing = deskNamespaces.filter((ns) => !ERC7201_NAMESPACES.includes(ns));
  ok("the executor tries every namespace the desk tries", missing.length === 0,
    missing.length ? `MISSING: ${missing.join(", ")}` : `${deskNamespaces.length} namespaces`);

  const seqLine = deskSrc.match(/const SEQUENTIAL_SLOTS = (\d+)/);
  ok("...and scans at least as many sequential slots",
    seqLine && SEQUENTIAL_SLOTS >= Number(seqLine[1]),
    `executor ${SEQUENTIAL_SLOTS}, desk ${seqLine?.[1]}`);
  ok("...and this test reads the desk as text rather than trusting a number typed twice",
    /readFileSync\(path\.join\(here, "\.\.", "src"/.test(fs.readFileSync(new URL(import.meta.url), "utf8")));
}

console.log("\nA TRANSPORT FAILURE IS NOT THE CONTRACT'S ANSWER");
{
  for (const e of ["HTTP 429 Too many requests", "fetch failed", "socket hang up",
                   "timeout of 8000ms exceeded", "HTTP 503", "ECONNRESET"])
    ok(`"${e.slice(0, 28)}" is transport`, isTransportError(e));
  for (const e of ["execution reverted", "execution reverted: TRANSFER_FAILED",
                   "invalid opcode", "out of gas"])
    ok(`"${e.slice(0, 28)}" is the contract answering`, !isTransportError(e));
  ok("...and the desk agrees, clause for clause",
    ["HTTP 429", "fetch failed", "execution reverted", "out of gas"]
      .every((e) => isTransportError(e) === desk.isTransportError(e)));
}

console.log("\nTHE SCAN FINDS EACH LAYOUT, AND SAYS SO");
{
  /** A fake chain where exactly one storage key reads the sentinel back. */
  const chainWhere = (keyFn) => async (to, data, ov) => {
    const diff = ov?.[to]?.stateDiff ?? {};
    for (const [k, v] of Object.entries(diff)) if (k === keyFn()) return { ok: true, data: v };
    return { ok: false, error: "execution reverted" };
  };

  _clearSlotCache();
  const s0 = await findBalanceSlot(chainWhere(() => mappingKey(PROBE_EOA, 0)), TOKEN);
  ok("slot 0 — every 3,248-byte PONS V2 token", s0.ok && s0.slot === 0 && s0.kind === "sequential");

  _clearSlotCache();
  const sol = await findBalanceSlot(chainWhere(() => soladyBalanceKey(PROBE_EOA)), TOKEN);
  ok("Solady's hand-rolled layout", sol.ok && sol.kind === "solady");
  ok("...and it hands back a keyFor FUNCTION, not a slot to assume",
    typeof sol.keyFor === "function" && sol.keyFor(OWNER) === soladyBalanceKey(OWNER));

  _clearSlotCache();
  const oz = await findBalanceSlot(chainWhere(() => mappingKey(PROBE_EOA, desk.OZ_ERC20_SLOT)), TOKEN);
  ok("the OpenZeppelin namespace — every Stock Token", oz.ok && oz.kind === "erc7201");

  _clearSlotCache();
  const deep = await findBalanceSlot(chainWhere(() => mappingKey(PROBE_EOA, 40)), TOKEN);
  ok("a deep sequential slot behind a mixin chain", deep.ok && deep.slot === 40);

  _clearSlotCache();
  const none = await findBalanceSlot(chainWhere(() => "0xdead"), TOKEN);
  ok("a token that answers from nowhere is reported unknown, never guessed",
    !none.ok && /did not read back/.test(none.error));
}

console.log("\nAN UNREADABLE SCAN IS UNREADABLE, AND IS NOT CACHED AS ABSENT");
{
  _clearSlotCache();
  const flaky = await findBalanceSlot(async () => ({ ok: false, error: "HTTP 429" }), TOKEN);
  ok("a scan that got no answer says so", !flaky.ok && flaky.transport === true,
    flaky.error?.slice(0, 60));
  ok("...and calls it unreadable, not absent", /unreadable, not absent/.test(flaky.error));

  /* The next attempt must ask again rather than reading a cached "no". */
  const after = await findBalanceSlot(async (to, data, ov) => {
    const diff = ov?.[to]?.stateDiff ?? {};
    for (const [k, v] of Object.entries(diff)) if (k === mappingKey(PROBE_EOA, 0)) return { ok: true, data: v };
    return { ok: false, error: "execution reverted" };
  }, TOKEN);
  ok("...and a transport failure did NOT poison the cache", after.ok && after.slot === 0);
}

console.log("\nTHE ALLOWANCE SLOT IS VERIFIED, NOT ASSUMED TO SIT BESIDE THE BALANCE");
{
  _clearSlotCache();
  const balKey = mappingKey(PROBE_EOA, 5);
  const allowKey = mappingKey(SPENDER, mappingKey(PROBE_EOA, 6));
  const call = async (to, data, ov) => {
    const diff = ov?.[to]?.stateDiff ?? {};
    for (const [k, v] of Object.entries(diff)) if (k === balKey || k === allowKey) return { ok: true, data: v };
    return { ok: false, error: "execution reverted" };
  };
  const a = await findAllowanceSlot(call, TOKEN, SPENDER);
  ok("it finds the allowance one slot past the balance", a.ok && a.slot === 6, `slot ${a.slot}`);

  _clearSlotCache();
  const onlyBal = async (to, data, ov) => {
    const diff = ov?.[to]?.stateDiff ?? {};
    for (const [k, v] of Object.entries(diff)) if (k === balKey) return { ok: true, data: v };
    return { ok: false, error: "execution reverted" };
  };
  const b = await findAllowanceSlot(onlyBal, TOKEN, SPENDER);
  ok("a token whose allowance is nowhere near is refused, not guessed",
    !b.ok && /did not read back beside/.test(b.error));

  _clearSlotCache();
  const solCall = async (to, data, ov) => {
    const diff = ov?.[to]?.stateDiff ?? {};
    for (const [k, v] of Object.entries(diff))
      if (k === soladyBalanceKey(PROBE_EOA) || k === soladyAllowanceKey(PROBE_EOA, SPENDER))
        return { ok: true, data: v };
    return { ok: false, error: "execution reverted" };
  };
  const c = await findAllowanceSlot(solCall, TOKEN, SPENDER);
  ok("Solady's allowance is found by its own seed", c.ok && c.kind === "solady");
}

console.log("\nTHE DIVERGENCE THAT IS DELIBERATE");
{
  const src = fs.readFileSync(path.join(here, "storage-slots.mjs"), "utf8");
  ok("the executor bounds its NEGATIVE cache by block",
    /NEGATIVE_CACHE_BLOCKS/.test(src) && /atBlock/.test(src));
  ok("...and says why: a proxy upgrade rewrites the layout",
    /proxy upgrade/i.test(src));
  ok("the module imports nothing from ../src", !/from "\.\.\/src/.test(src));
  /* Match the WHOLE import line: a lookahead-anchored pattern stops at the opening quote
     and never sees the module name, so it passes on anything. */
  const imports = src.match(/^import .*$/gm) || [];
  ok("...and every import is ethers or a sibling file", imports.length > 0 &&
    imports.every((l) => /from "ethers"/.test(l) || /from "\.\//.test(l)),
    imports.join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
