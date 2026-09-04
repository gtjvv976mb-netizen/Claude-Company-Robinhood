/**
 * ALLOWANCES: A STANDING GRANT, NOT A STEP IN A TRADE.
 *
 * The Solana executor never had to think about this. There, a swap moves tokens because
 * the transaction itself is signed; nothing is left behind. Here, selling requires
 * granting a router permission to move your tokens with transferFrom, and THAT
 * PERMISSION OUTLIVES THE TRADE. Measured on chain 4663 on 2026-09-04: a sell built by
 * KyberSwap carries no Permit2 and pulls directly, so simulating it against a zero
 * allowance reverts with "TransferHelper: TRANSFER_FROM_FAILED".
 *
 * The industry habit is to approve 2^256-1 once and never think about it again. That is
 * the single most common way funds are drained on EVM: every unbounded approval is a
 * standing promise that whoever controls that spender, now or after an upgrade, may take
 * the entire balance at any future moment. The router here is itself upgradeable-shaped
 * code the desk does not control.
 *
 * So this module cannot express an unbounded approval. `MAX_UINT256` is refused by
 * assertion, exact amounts are the only thing it will build, and residue left after a
 * trade is treated as a defect to be cleared rather than a convenience to be reused.
 *
 * Nothing here signs or sends. It builds calldata and reads state.
 */

export const MAX_UINT256 = (1n << 256n) - 1n;
const SEL_APPROVE = "0x095ea7b3";
const SEL_ALLOWANCE = "0xdd62ed3e";
const pad = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padN = (n) => BigInt(n).toString(16).padStart(64, "0");

const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * An unbounded approval is refused here rather than discouraged in a comment, because a
 * comment is not a mechanism. The ceiling is deliberately far below MAX_UINT256: any
 * approval large enough to look like "infinite in practice" is the same risk wearing a
 * smaller number.
 */
export function assertBounded(amount, { balance = null } = {}) {
  const a = BigInt(amount);
  if (a <= 0n) throw new Error(`an approval of ${a} is not a trade — refusing`);
  if (a === MAX_UINT256)
    throw new Error("unbounded approval refused: 2^256-1 is a standing promise that whoever " +
      "controls this spender may take the whole balance at any future moment");
  if (balance !== null && a > BigInt(balance))
    throw new Error(`approval of ${a} exceeds the balance of ${balance} — approve what is being ` +
      `sold, not more, so nothing is left standing after the trade`);
  return a;
}

/** allowance(owner, spender), read from the token itself. */
export async function allowanceOf(rpc, { token, owner, spender }) {
  for (const [k, v] of Object.entries({ token, owner, spender }))
    if (!isAddress(v)) throw new Error(`allowanceOf needs a ${k} address, got ${String(v)}`);
  const ret = await rpc("eth_call", [{ to: token, data: SEL_ALLOWANCE + pad(owner) + pad(spender) }, "latest"]);
  if (typeof ret !== "string" || ret.length < 66)
    throw new Error(`allowance read returned ${String(ret).slice(0, 20)} — refusing to treat an ` +
      `unreadable allowance as zero, which would look like "needs approval" and mask a broken token`);
  return BigInt(ret.slice(0, 66));
}

/** approve(spender, amount) calldata. Never unbounded; see assertBounded. */
export function buildApproval({ token, spender, amount, balance = null }) {
  if (!isAddress(token) || !isAddress(spender)) throw new Error("buildApproval needs token and spender addresses");
  const a = amount === 0n ? 0n : assertBounded(amount, { balance });
  return Object.freeze({ to: token, data: SEL_APPROVE + pad(spender) + padN(a), value: 0n, amount: a });
}

/**
 * What has to happen before this sell can go through.
 *
 * Returns a list of transactions, which is usually empty or one. The two-step case is
 * the ERC-20 quirk where a token refuses to move a NON-ZERO allowance to another
 * non-zero value, so it must be zeroed first — approving over the top silently fails on
 * those tokens, and a sell that then reverts looks like a routing problem rather than an
 * allowance one.
 */
export async function planApproval(rpc, { token, owner, spender, amount, balance = null,
  resetFirst = true }) {
  const need = assertBounded(amount, { balance });
  const have = await allowanceOf(rpc, { token, owner, spender });
  if (have >= need) return Object.freeze({ steps: [], have, need, reason: "already sufficient" });
  const steps = [];
  if (have > 0n && resetFirst) steps.push(buildApproval({ token, spender, amount: 0n }));
  steps.push(buildApproval({ token, spender, amount: need, balance }));
  return Object.freeze({ steps, have, need,
    reason: have > 0n ? "raising a non-zero allowance, zeroed first" : "no allowance yet" });
}

/**
 * Confirm the grant actually landed. A submitted approval is not an approval — the
 * transaction can be dropped, replaced or silently excluded by the sequencer, and the
 * sell that follows would revert with TRANSFER_FROM_FAILED and read as a bad route.
 */
export async function assertApproved(rpc, { token, owner, spender, amount }) {
  const have = await allowanceOf(rpc, { token, owner, spender });
  if (have < BigInt(amount))
    throw new Error(`allowance is ${have} but ${amount} is needed — the approval did not land. ` +
      `Do not sell into this: it reverts with TRANSFER_FROM_FAILED and reads as a routing fault.`);
  return have;
}

/**
 * What is still granted after a trade. Exact approvals should leave nothing; anything
 * left is a standing grant nobody decided to make, so it is surfaced rather than kept
 * around as a convenience for the next trade.
 */
export async function residualAllowance(rpc, { token, owner, spender }) {
  const have = await allowanceOf(rpc, { token, owner, spender });
  return Object.freeze({
    residual: have,
    clean: have === 0n,
    revoke: have > 0n ? buildApproval({ token, spender, amount: 0n }) : null,
  });
}
