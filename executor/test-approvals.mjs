/**
 * AN APPROVAL OUTLIVES THE TRADE, WHICH IS WHY IT CANNOT BE UNBOUNDED.
 *
 * The Solana executor never had to think about this: a swap there moves tokens because
 * the transaction is signed, and nothing is left behind. Here, selling means granting a
 * router permission to move your tokens with transferFrom, and that permission persists.
 * Measured on chain 4663 on 2026-09-04: a KyberSwap sell carries no Permit2 and pulls
 * directly, so simulating it against a zero allowance reverts with
 * "TransferHelper: TRANSFER_FROM_FAILED".
 *
 * The convenient habit is to approve 2^256-1 once and forget it. That is the most common
 * way funds leave an EVM wallet, and the router here is upgradeable-shaped code the desk
 * does not control. So this module is built so an unbounded approval cannot be expressed,
 * and these assertions are what keep it that way.
 */
import { assertBounded, buildApproval, allowanceOf, planApproval, assertApproved,
  residualAllowance, MAX_UINT256 } from "./approvals.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const threw = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
};
const TOKEN = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const OWNER = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const rpcWith = (allowance) => async () => word(allowance);

console.log("\nUNBOUNDED CANNOT BE EXPRESSED");
{
  ok("2^256-1 is refused", await threw(() => assertBounded(MAX_UINT256), /unbounded/));
  ok("...and the refusal says what it actually risks", await threw(() => assertBounded(MAX_UINT256),
    /take the whole balance/));
  ok("buildApproval cannot smuggle it through either",
    await threw(() => buildApproval({ token: TOKEN, spender: ROUTER, amount: MAX_UINT256 })));
  /* "Effectively infinite" is the same risk wearing a smaller number, so an approval
     larger than the balance being sold is refused too. */
  ok("more than the balance is refused", await threw(
    () => assertBounded(1000n, { balance: 999n }), /exceeds the balance/));
  ok("exactly the balance is fine", assertBounded(999n, { balance: 999n }) === 999n);
  ok("zero is not a trade", await threw(() => assertBounded(0n)));
  ok("negative is not a trade", await threw(() => assertBounded(-1n)));
}

console.log("\nTHE CALLDATA IS APPROVE(SPENDER, EXACT)");
{
  const a = buildApproval({ token: TOKEN, spender: ROUTER, amount: 12345n });
  ok("it targets the token, not the router", a.to === TOKEN);
  ok("the selector is approve(address,uint256)", a.data.startsWith("0x095ea7b3"));
  ok("the spender is the router", a.data.toLowerCase().includes(ROUTER.toLowerCase().slice(2)));
  ok("the amount is exact", a.data.endsWith(BigInt(12345).toString(16).padStart(64, "0")));
  ok("it carries no value", a.value === 0n);
  /* Zero is the revoke, and must remain constructible or nothing could ever be cleared. */
  ok("a revoke to zero is allowed", buildApproval({ token: TOKEN, spender: ROUTER, amount: 0n }).amount === 0n);
}

console.log("\nAN UNREADABLE ALLOWANCE IS NOT ZERO");
{
  /* Reading a failed call as 0 looks exactly like "needs approval" and would mask a
     broken token behind a redundant transaction. */
  ok("an empty return is refused", await threw(
    () => allowanceOf(async () => "0x", { token: TOKEN, owner: OWNER, spender: ROUTER }),
    /refusing to treat an unreadable allowance as zero/));
  ok("a truncated return is refused", await threw(
    () => allowanceOf(async () => "0x12", { token: TOKEN, owner: OWNER, spender: ROUTER })));
  ok("a bad address is a programming error", await threw(
    () => allowanceOf(rpcWith(0n), { token: "nope", owner: OWNER, spender: ROUTER }), /token address/));
  ok("a real value is read whole",
    await allowanceOf(rpcWith(93_318_205_751_965_188_096n), { token: TOKEN, owner: OWNER, spender: ROUTER })
      === 93_318_205_751_965_188_096n);
}

console.log("\nTHE PLAN IS THE SMALLEST THING THAT WORKS");
{
  const enough = await planApproval(rpcWith(500n), { token: TOKEN, owner: OWNER, spender: ROUTER, amount: 400n });
  ok("a sufficient allowance costs no transaction", enough.steps.length === 0, enough.reason);

  const fresh = await planApproval(rpcWith(0n), { token: TOKEN, owner: OWNER, spender: ROUTER, amount: 400n });
  ok("no allowance means exactly one approval", fresh.steps.length === 1, fresh.reason);
  ok("...for the exact amount", fresh.steps[0].amount === 400n);

  /* Some ERC-20s refuse to move a NON-ZERO allowance to another non-zero value. Approving
     over the top silently fails on those, and the sell then reverts looking like a routing
     fault rather than an allowance one. */
  const raise = await planApproval(rpcWith(100n), { token: TOKEN, owner: OWNER, spender: ROUTER, amount: 400n });
  ok("raising a non-zero allowance zeroes it first", raise.steps.length === 2, raise.reason);
  ok("...zero, then the amount", raise.steps[0].amount === 0n && raise.steps[1].amount === 400n);
  ok("the plan reports what it saw and what it needs", raise.have === 100n && raise.need === 400n);
}

console.log("\nA SUBMITTED APPROVAL IS NOT AN APPROVAL");
{
  /* It can be dropped, replaced, or silently excluded by the sequencer — and this chain
     excludes rather than reverts, which leaves no receipt to notice. */
  ok("selling is refused when the grant did not land", await threw(
    () => assertApproved(rpcWith(399n), { token: TOKEN, owner: OWNER, spender: ROUTER, amount: 400n }),
    /did not land/));
  ok("...and the message names the revert it would otherwise cause", await threw(
    () => assertApproved(rpcWith(0n), { token: TOKEN, owner: OWNER, spender: ROUTER, amount: 400n }),
    /TRANSFER_FROM_FAILED/));
  ok("an exact grant passes",
    await assertApproved(rpcWith(400n), { token: TOKEN, owner: OWNER, spender: ROUTER, amount: 400n }) === 400n);
}

console.log("\nRESIDUE IS A DEFECT, NOT A CONVENIENCE");
{
  const clean = await residualAllowance(rpcWith(0n), { token: TOKEN, owner: OWNER, spender: ROUTER });
  ok("nothing left standing after an exact approval", clean.clean === true && clean.revoke === null);
  const dirty = await residualAllowance(rpcWith(7n), { token: TOKEN, owner: OWNER, spender: ROUTER });
  ok("leftovers are surfaced", dirty.clean === false && dirty.residual === 7n);
  ok("...with the revoke already built, so clearing it is one step",
    dirty.revoke?.amount === 0n && dirty.revoke.to === TOKEN);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
