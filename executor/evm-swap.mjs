/**
 * THE SWAP LAYER: QUOTE, BUILD, AND PROVE IT BEFORE ANYTHING IS SIGNED.
 *
 * The Solana executor spends 2,474 lines proving a transaction matches its quote by
 * decoding Anchor discriminators and asserting account positions. EVM offers something
 * strictly stronger and Solana could not: the router RETURNS the amount out, so the
 * exact bytes you are about to sign can be EXECUTED against live state with eth_call and
 * the answer measured rather than inferred. This module is built on that.
 *
 * WHY IT IS NOT OPTIONAL. The floor a swap will actually enforce lives in the CALLDATA,
 * and nowhere else. The build response carries an `amountOut` field that looks like a
 * floor and is not one: measured on chain 4663 on 2026-09-04 it came back byte-identical
 * at 100, 300 and 1000 bps of requested tolerance, always the quoted amount minus
 * rounding. Reading it as the minimum says every transaction is a guaranteed revert,
 * which is false — I made exactly that mistake building this file and it refused 100% of
 * swaps before the calldata was checked.
 *
 * The bytes tell the truth. Decoded from the same builds: 100 bps embeds a floor 1.00%
 * below the quote and 1000 bps embeds 10.00%, exactly as asked. So the Solana desk's
 * rule ports intact and literally — take minOut from the SIGNED BYTES, never from a
 * field beside them — and it has to be read from the calldata to mean anything.
 *
 * What holds here:
 *
 *   1. OUR floor is computed from OUR tolerance, never read from the aggregator.
 *   2. The floor EMBEDDED IN THE CALLDATA must match it, or the bytes do not implement
 *      the trade we asked for and are refused.
 *   3. The exact bytes are then executed with eth_call, and the measured output must
 *      clear that floor — because a route that cannot fill reverts, and a revert costs
 *      gas and buys nothing.
 *
 * Everything here is read-only. Nothing in this file signs, holds a key, or sends.
 */

import { classifyToken, classifyPairAssetOnChain, SELECTOR_NAME } from "./scope-guard.mjs";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const AGG = "https://aggregator-api.kyberswap.com/robinhood/api/v1";
const CLIENT = "claude-co-robinhood";
const BPS = 10_000n;

export const NATIVE_SENTINEL = NATIVE;

/* THE msg.value TRAP, paid for once. Quoting the WRAPPED token as tokenIn builds a
   transaction the router funds by transferFrom, so attaching msg.value as well reverts
   with "Invalid msg.value". Native in means the sentinel, and it means value. */
export const isNative = (t) => String(t).toLowerCase() === NATIVE.toLowerCase();

const jsonFetch = async (url, init, timeoutMs = 20_000) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs),
    headers: { "x-client-id": CLIENT, ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${url.split("?")[0]} ${r.status}: ${body?.message ?? "no body"}`);
  return body;
};

/** A route, or a thrown reason. Never a null that a caller might read as "no cost". */
export async function quote({ tokenIn, tokenOut, amountIn, to }) {
  const qs = new URLSearchParams({ tokenIn, tokenOut, amountIn: String(amountIn),
    to, gasInclude: "true" });
  const body = await jsonFetch(`${AGG}/routes?${qs}`);
  const route = body?.data?.routeSummary;
  if (!route?.amountOut) throw new Error(`no route for ${tokenIn} -> ${tokenOut} at ${amountIn}`);
  return route;
}

/** Executable calldata for a route. The floor it embeds is NOT trusted; see prepareSwap. */
export async function build(route, { sender, recipient, slippageBps }) {
  const body = await jsonFetch(`${AGG}/route/build`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ routeSummary: route, sender, recipient,
      slippageTolerance: Number(slippageBps) }),
  });
  const d = body?.data;
  if (!d?.data || !d?.routerAddress) throw new Error("build returned no calldata");
  return d;
}

/**
 * Our own floor. Deliberately computed here from the quote and our tolerance rather
 * than read from the build response, because the build response is the thing that was
 * measured to be wrong.
 */
export function floorFrom(quotedOut, slippageBps) {
  const q = BigInt(quotedOut), s = BigInt(slippageBps);
  if (s < 0n || s >= BPS) throw new Error(`slippageBps must be within [0, ${BPS}), got ${slippageBps}`);
  return q * (BPS - s) / BPS;
}

/**
 * Execute the exact bytes against live state and read what comes back.
 * `rpc` is injected so this is testable without a network.
 */
export async function simulateExact(rpc, { from, to, data, value = 0n, gas = 3_000_000 }) {
  const call = { from, to, data, gas: "0x" + gas.toString(16) };
  if (value > 0n) call.value = "0x" + value.toString(16);
  // The sender is a stand-in and holds nothing, so fund it for the simulation only.
  const overrides = { [from]: { balance: "0x" + ((value > 0n ? value : 10n ** 18n) * 100n).toString(16) } };
  const ret = await rpc("eth_call", [call, "latest", overrides]);
  if (typeof ret !== "string" || ret.length < 66)
    throw new Error(`router returned ${ret === "0x" ? "nothing" : String(ret).slice(0, 24)} — cannot measure the output`);
  return { amountOut: BigInt("0x" + ret.slice(2, 66)), raw: ret };
}

/**
 * The floor the transaction will actually enforce, read out of the bytes that would be
 * signed. The build response's `amountOut` is NOT this — it is informational and does
 * not move with the requested tolerance (measured identical at 100/300/1000 bps).
 *
 * Found by scanning the 32-byte words of the calldata for the one that sits below the
 * quote but not absurdly below it. Deliberately not a router-ABI decode: the aggregator
 * may route through any of several encodings, and a scan that FAILS CLOSED when it finds
 * none, or more than one candidate, is safer than a decoder that silently misreads a
 * shape it was not written for.
 */
export function embeddedFloor(calldata, quotedOut, { floorBand = 5000n } = {}) {
  if (typeof calldata !== "string" || calldata.length < 74) return null;
  const q = BigInt(quotedOut);
  const lo = q * (BPS - floorBand) / BPS;          // ignore anything below 50% of quote
  const hex = calldata.slice(10);                   // strip the 4-byte selector
  const found = new Set();
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    const w = BigInt("0x" + hex.slice(i, i + 64));
    if (w > lo && w <= q) found.add(w);
  }
  // More than one candidate means the scan cannot say which is the floor. Refuse.
  return found.size === 1 ? [...found][0] : null;
}

/**
 * The whole path, proven. Returns something safe to sign, or throws saying why not.
 * Signing is the caller's job and happens nowhere in this file.
 */
export async function prepareSwap(rpc, {
  tokenIn, tokenOut, amountIn, sender, recipient = sender, slippageBps,
  scopeCheck = true, direction = "buy",
}) {
  if (!(BigInt(amountIn) > 0n)) throw new Error("amountIn must be positive");

  /* MEMECOINS ONLY, CHECKED HERE TOO. The desk screens upstream, but the executor is
     the last thing between a decision and money moving, and it does not get to assume
     the caller screened. An unreadable slot refuses. */
  if (scopeCheck) {
    /* TWO DIFFERENT QUESTIONS, NOT ONE FLAG. A swap has a thing being speculated on and a
       thing being spent, and this desk treats them differently: an equity may be the
       medium of exchange for a memecoin trade, and may never be the position. Which side
       is which depends on direction — buying, the target is tokenOut and we spend
       tokenIn; selling, the reverse. */
    const read = (addr, slot) => rpc("eth_getStorageAt", [addr, slot, "latest"]);
    /* The second signal: name(). See scope-guard.mjs — it can only add a refusal. */
    const readName = (addr) => rpc("eth_call", [{ to: addr, data: SELECTOR_NAME }, "latest"]);
    const selling = !isNative(tokenIn) && isNative(tokenOut) === false && direction === "sell";
    const target = selling ? tokenIn : tokenOut;
    const paidWith = selling ? tokenOut : tokenIn;

    if (!isNative(target)) {
      const v = await classifyToken(target, read, readName);
      if (!v.tradeable) throw new Error(`scope guard: ${v.reason}`);
    }
    if (!isNative(paidWith)) {
      const v = await classifyPairAssetOnChain(paidWith, read, readName);
      if (!v.allowedAsPair) throw new Error(`scope guard, pair asset: ${v.reason}`);
    }
  }

  const route = await quote({ tokenIn, tokenOut, amountIn, to: recipient });
  const built = await build(route, { sender, recipient, slippageBps });

  const quotedOut = BigInt(route.amountOut);
  const ourFloor = floorFrom(quotedOut, slippageBps);
  const embedded = embeddedFloor(built.data, quotedOut);
  const value = isNative(tokenIn) ? BigInt(amountIn) : 0n;

  const sim = await simulateExact(rpc, { from: sender, to: built.routerAddress, data: built.data, value });

  /* THE THREE REFUSALS, in the order that makes the reason legible. */
  if (sim.amountOut < ourFloor)
    throw new Error(`simulated output ${sim.amountOut} is below our floor ${ourFloor} ` +
      `(quoted ${quotedOut}, tolerance ${slippageBps}bps) — the route cannot fill at the price we asked`);

  if (embedded === null)
    throw new Error(`no floor could be found in the calldata between ${ourFloor} and ${quotedOut} — ` +
      `refusing to sign bytes whose slippage protection cannot be read`);

  /* The bytes must implement the tolerance we asked for. A floor TIGHTER than ours would
     revert on a move we were willing to accept; a LOOSER one would let us be filled worse
     than we agreed. One rounding wei of play, no more. */
  const drift = embedded > ourFloor ? embedded - ourFloor : ourFloor - embedded;
  if (drift > quotedOut / 100_000n + 1n)
    throw new Error(`the calldata embeds a floor of ${embedded} but our ${slippageBps}bps tolerance ` +
      `means ${ourFloor} — the bytes do not implement the trade we asked for`);

  if (embedded > sim.amountOut)
    throw new Error(`the calldata embeds a floor of ${embedded} but executing those exact bytes ` +
      `returns ${sim.amountOut} — it would revert on chain and burn gas for nothing`);

  /* THE COUNTERPARTY MAY NOT AUTHOR THE NUMBER THAT CHECKS THE COUNTERPARTY.
   *
   * Every check above this line is anchored, one way or another, on the aggregator's own
   * quote: our floor is a percentage off it, and the embedded floor is checked against
   * our floor. A quote that is uniformly low-balled satisfies all of them — the floor
   * moves down with it and nothing notices.
   *
   * That is not a theoretical shape. The Solana desk lost the argument to it once: impact,
   * minOut and the round-trip preflight were all authored by the same API response they
   * were checking, so a self-consistent quote at a fraction of fair value passed cleanly,
   * and the wallet signed an on-chain floor far below fair value. The trade still FILLS
   * correctly — the pool pays what the pool pays — but the gap between the floor you
   * signed and the value the trade is really worth is exactly what anyone watching the
   * transaction in flight can take.
   *
   * The anchor has to come from somewhere the counterparty cannot write, and it already
   * does: sim.amountOut is what the CHAIN returns when those exact bytes execute against
   * live pool state. So the floor is measured against that, not against the quote. The
   * distance between what we would accept and what the trade is actually worth is capped
   * at the tolerance we chose, whatever the quote claimed. */
  const extractable = sim.amountOut - embedded;
  const allowed = sim.amountOut * BigInt(slippageBps) / BPS;
  if (extractable > allowed)
    throw new Error(`the floor in the calldata is ${embedded} but the chain says these bytes yield ` +
      `${sim.amountOut} — a gap of ${extractable}, which is ${Number(extractable * BPS / sim.amountOut)}bps ` +
      `and above the ${slippageBps}bps we agreed to risk. That gap is not a discount, it is the amount ` +
      `anyone watching the transaction can take. The quote may be low-balled: our floor is derived from ` +
      `it, so only the simulated output is independent of the party being checked.`);

  const gotRecipient = String(built.data).toLowerCase().includes(String(recipient).toLowerCase().slice(2));
  if (!gotRecipient)
    throw new Error(`the calldata does not mention the recipient ${recipient} — refusing to sign a ` +
      `transaction whose destination cannot be seen in its own bytes`);

  return Object.freeze({
    to: built.routerAddress, data: built.data, value,
    quotedOut, ourFloor, embeddedFloor: embedded, simulatedOut: sim.amountOut,
    extractableGap: extractable,
    slippageBps, gas: Number(built.gas ?? route.gas ?? 0),
    driftFromQuoteBps: Number((sim.amountOut - quotedOut) * BPS / quotedOut),
  });
}
