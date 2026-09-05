/**
 * THE ONLY WAY THIS EXECUTOR TALKS TO ROBINHOOD CHAIN.
 *
 * JSON-RPC over fetch, with the one property the Solana transport was built for and
 * that web3.js could not give us: every request owns an AbortController and the
 * promise does not settle until the underlying socket has. Promise.race on top of a
 * transport that keeps its socket alive is how the Solana bot accumulated abandoned
 * requests across recovery passes (sol-usd-oracle.mjs, 2026-09-01). Here the deadline
 * IS the transport.
 *
 * Two providers, deliberately asymmetric in nothing. Every liveness or absence claim
 * the executor makes (a receipt exists, a nonce has been consumed, a transaction is not
 * known to the network) is only a claim when BOTH providers agree; one provider is an
 * opinion. That rule is the backbone of the recovery path and it is enforced by the
 * helpers below, not by callers remembering to ask twice.
 *
 * Nothing in this file signs, holds a key, or sends anything but read requests — with
 * one exception, `eth_sendRawTransaction`, which is a plain method call like any other
 * and is only ever reached through evm-executor.mjs after the journal has recorded the
 * bytes. Batches are avoided on purpose: the public RPC returns 429 on batches larger
 * than ~10 (measured 2026-09-04), and a batch that half-fails is harder to reason about
 * than two requests.
 */

/** Per-request ceiling. Blocks are ~100ms; a provider that takes longer than this to
 *  answer a read is not a provider the executor should be reasoning from. */
export const RPC_REQUEST_TIMEOUT_MS = 8_000;

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";

const isHexQuantity = (value) => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);

export const hex = (n) => "0x" + BigInt(n).toString(16);
export const fromHex = (value, label = "quantity") => {
  if (!isHexQuantity(value)) throw new Error(`${label} is not a hex quantity: ${String(value).slice(0, 40)}`);
  return BigInt(value);
};
export const fromHexNumber = (value, label = "quantity") => {
  const big = fromHex(value, label);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe integer range`);
  return Number(big);
};

/** ABI word helpers — enough for the handful of selectors this desk uses. */
export const padAddress = (a) => String(a).toLowerCase().replace(/^0x/, "").padStart(64, "0");
export const padUint = (n) => BigInt(n).toString(16).padStart(64, "0");
export const wordAt = (ret, index) => {
  if (typeof ret !== "string" || ret.length < 2 + 64 * (index + 1))
    throw new Error(`return data has no word ${index}`);
  return BigInt("0x" + ret.slice(2 + 64 * index, 2 + 64 * (index + 1)));
};
export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** ETH written as a plain decimal → wei, exactly, or null. A double cannot hold 18
 *  decimals, and a cap that rounds onto a permitted boundary is a cap that was never
 *  checked — so the poller parses every ETH amount through this, never Number(). */
export const WEI_PER_ETH = 10n ** 18n;
export const plainEthUnits = (value) => {
  const raw = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/.exec(raw);
  if (!match) return null;
  return BigInt(match[1]) * WEI_PER_ETH + BigInt((match[2] || "").padEnd(18, "0") || "0");
};

export class RpcError extends Error {
  constructor(message, { method, code = null, data = null, provider = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    this.data = data;
    this.provider = provider;
  }
}

/**
 * Make one provider. Returns `rpc(method, params)`; the label is used in errors and is
 * never the URL — provider URLs carry credentials in their path and must not reach a
 * log or a journal row.
 */
export function createRpc(url, {
  label = "rpc", fetchFn = globalThis.fetch, timeoutMs = RPC_REQUEST_TIMEOUT_MS, now = Date.now,
} = {}) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`${label}: RPC URL is invalid`);
  if (typeof fetchFn !== "function") throw new Error(`${label}: fetch is unavailable`);
  let nextId = 1;
  const rpc = async (method, params = []) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}: ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    const startedAt = now();
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: controller.signal,
        redirect: "error",
      });
      // Buffer the body while the controller is still armed; a peer can send headers
      // and leave the body hanging forever otherwise.
      const text = await response.text();
      if (!response.ok)
        throw new RpcError(`${label}: ${method} HTTP ${response.status}`, { method, code: response.status, provider: label });
      let body;
      try { body = JSON.parse(text); }
      catch { throw new RpcError(`${label}: ${method} returned non-JSON`, { method, provider: label }); }
      if (body?.error)
        throw new RpcError(`${label}: ${method}: ${String(body.error.message || "error").slice(0, 200)}`,
          { method, code: body.error.code ?? null, data: body.error.data ?? null, provider: label });
      if (!("result" in (body ?? {})))
        throw new RpcError(`${label}: ${method} returned no result`, { method, provider: label });
      rpc.lastLatencyMs = now() - startedAt;
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) throw new RpcError(`${label}: ${method} timed out after ${timeoutMs}ms`, { method, provider: label });
      if (error instanceof RpcError) throw error;
      throw new RpcError(`${label}: ${method} transport failed: ${String(error?.message || error).slice(0, 120)}`,
        { method, provider: label });
    } finally {
      clearTimeout(timer);
    }
  };
  rpc.label = label;
  rpc.lastLatencyMs = null;
  return rpc;
}

/** A revert from eth_call is an answer, not a transport failure. */
export const isRevert = (error) => error instanceof RpcError &&
  (error.code === 3 || error.code === -32000 || /revert|execution reverted/i.test(error.message));

/**
 * Ask both providers the same question. Resolves to `[primary, secondary]` only when
 * both answered; a single failure rejects, because the callers of this helper are the
 * ones that need two independent views to make a claim.
 */
export async function both(providers, method, params = []) {
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1])
    throw new Error("two distinct RPC providers are required");
  const results = await Promise.allSettled(providers.map((rpc) => rpc(method, params)));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}

/** Both providers must claim the same chain id, and it must be this chain. */
export async function proveChain(providers, { chainIdHex = CHAIN_ID_HEX } = {}) {
  const ids = await both(providers, "eth_chainId");
  return ids.map((id, index) => {
    const label = providers[index].label || `provider ${index + 1}`;
    if (!isHexQuantity(id) || BigInt(id) !== BigInt(chainIdHex))
      throw new Error(`${label} is not Robinhood Chain (eth_chainId ${String(id).slice(0, 20)}, expected ${chainIdHex})`);
    return Number(BigInt(id));
  });
}

/** The pending nonce on both providers. Disagreement is a hold, never a guess. */
export async function pendingNonceConsensus(providers, address) {
  const [a, b] = await both(providers, "eth_getTransactionCount", [address, "pending"]);
  const na = fromHexNumber(a, "primary pending nonce");
  const nb = fromHexNumber(b, "secondary pending nonce");
  if (na !== nb)
    throw new Error(`providers disagree on the pending nonce (${na} vs ${nb}) — holding rather than choosing one`);
  return na;
}

/** The mined ("latest") nonce on both providers, reported separately. */
export async function latestNonces(providers, address) {
  const [a, b] = await both(providers, "eth_getTransactionCount", [address, "latest"]);
  return [fromHexNumber(a, "primary latest nonce"), fromHexNumber(b, "secondary latest nonce")];
}

/**
 * Receipt on both providers. Returns `{ agreed, receipts }` where `agreed` is the
 * receipt only when both providers return one with the same block hash and status.
 * One-sided sightings are reported, never promoted to a fact.
 */
export async function receiptConsensus(providers, txHash) {
  const receipts = await both(providers, "eth_getTransactionReceipt", [txHash]);
  const [a, b] = receipts;
  if (a && b) {
    if (a.blockHash !== b.blockHash || a.status !== b.status)
      return { agreed: null, receipts, disagreement: `block ${a.blockHash} vs ${b.blockHash}, status ${a.status} vs ${b.status}` };
    return { agreed: a, receipts, disagreement: null };
  }
  return { agreed: null, receipts, disagreement: null };
}

/** True only when NEITHER provider knows the transaction (mempool or block). */
export async function unknownOnBoth(providers, txHash) {
  const [a, b] = await both(providers, "eth_getTransactionByHash", [txHash]);
  return { unknown: a == null && b == null, seen: [a != null, b != null] };
}

/** Current head on both providers; the executor reasons from the LOWER of the two so
 *  a lagging provider cannot make a deadline look passed before it is. */
export async function headConsensus(providers) {
  const [a, b] = await both(providers, "eth_blockNumber");
  const heads = [fromHexNumber(a, "primary head"), fromHexNumber(b, "secondary head")];
  return { heads, low: Math.min(...heads), high: Math.max(...heads) };
}

/** Gas price, read live from both providers, never cached. The executor bids the
 *  HIGHER one: 0.02 → 0.7 gwei in two weeks and spikes above 5 gwei were observed
 *  (market brief, 2026-09), and an underbid is a silent sequencer drop. */
export async function gasPriceConsensus(providers) {
  const [a, b] = await both(providers, "eth_gasPrice");
  const prices = [fromHex(a, "primary gas price"), fromHex(b, "secondary gas price")];
  return { prices, max: prices[0] > prices[1] ? prices[0] : prices[1] };
}

/** Native balance on both providers. */
export async function balanceOnBoth(providers, address, block = "latest") {
  const [a, b] = await both(providers, "eth_getBalance", [address, block]);
  return [fromHex(a, "primary balance"), fromHex(b, "secondary balance")];
}

export const SELECTOR = Object.freeze({
  transfer: "0xa9059cbb",
  balanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
  decimals: "0x313ce567",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
});

/** ERC-20 balanceOf through one provider. Unreadable is an error, never zero. */
export async function erc20Balance(rpc, token, owner, block = "latest") {
  const ret = await rpc("eth_call", [{ to: token, data: SELECTOR.balanceOf + padAddress(owner) }, block]);
  if (typeof ret !== "string" || ret.length < 66)
    throw new Error(`balanceOf(${owner}) on ${token} returned ${String(ret).slice(0, 20)} — refusing to read an unreadable balance as zero`);
  return wordAt(ret, 0);
}

/** ERC-20 decimals through both providers; they must agree. */
export async function erc20DecimalsConsensus(providers, token) {
  const [a, b] = await both(providers, "eth_call", [{ to: token, data: SELECTOR.decimals }, "latest"]);
  const da = Number(wordAt(a, 0)), db = Number(wordAt(b, 0));
  if (da !== db) throw new Error(`providers disagree on decimals() for ${token}: ${da} vs ${db}`);
  if (!Number.isInteger(da) || da < 0 || da > 36) throw new Error(`decimals() for ${token} is ${da} — outside any sane range`);
  return da;
}
