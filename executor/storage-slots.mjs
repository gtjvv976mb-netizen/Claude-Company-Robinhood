/**
 * WHERE A TOKEN KEEPS ITS BALANCES, FOUND BY WRITING A NUMBER AND ASKING FOR IT BACK.
 *
 * To simulate a sell before buying, you have to be able to give a wallet a balance and an
 * allowance it does not have — which means knowing which storage slot the token reads
 * them from. There is no standard answer: a Solidity mapping puts them at
 * keccak(pad(holder) ‖ pad(slot)) for some slot nobody declares, an upgradeable token
 * puts them under an ERC-7201 namespace, and Solady hand-rolls a layout that is not a
 * mapping at all.
 *
 * So the slot is never assumed. Each candidate is tried by overriding it with a sentinel
 * for ONE eth_call and asking balanceOf whether it reads the sentinel back. A contract
 * that answers from none of them is reported UNKNOWN, and every simulation built on it
 * says unverified rather than guessing.
 *
 * ── MIRRORED, NOT IMPORTED, AND THAT IS THE HOUSE RULE ──────────────────────────────
 *
 * src/data/evm.js already does this, correctly, and has the measurements to prove it.
 * But executor/ is a standalone installed package whose only dependency is ethers — it
 * does not import ../src, the same way erc20-hazards.mjs mirrors rather than imports.
 * test-storage-slots.mjs reads the desk's source AS TEXT and holds the two in step, so
 * the copy cannot silently rot.
 *
 * ── THE DETAILS THAT WERE PAID FOR, CARRIED OVER DELIBERATELY ───────────────────────
 *
 *   1. A TRANSPORT FAILURE IS NOT "NOT THIS SLOT". Thirteen 429s in a row once read as
 *      "balanceOf did not read back from slots 0..12" and the coin died as unverified.
 *      A revert or a different number is the contract's ANSWER; anything else is NO
 *      answer, is reported as `transport`, and is never cached.
 *   2. THE ORDER IS BY MEASURED FREQUENCY, because every miss is a round trip. Slot 0 is
 *      every 3,248-byte PONS V2 token; Solady is the ~90 clone launches; the OpenZeppelin
 *      namespace is every Stock Token. A token once spent 167 seconds in the first
 *      ordering of this scan and answers on the second try now.
 *   3. SOLADY IS NOT A MAPPING. 90 of 800 listed tokens are Solady's ERC20, whose balance
 *      key is keccak(owner ‖ 8 zero bytes ‖ 0x87a211a2). That is why a candidate carries a
 *      `keyFor(holder)` FUNCTION rather than a slot number — no caller may assume the
 *      Solidity shape.
 *   4. A NEGATIVE RESULT IS CACHED ONLY WITH THE BLOCK IT WAS TAKEN AT. A proxy upgrade
 *      changes the layout, so "this token has no findable slot" is true of a block, not
 *      of a token, and an unbounded negative cache would outlive the fact.
 */
import { keccak256, getBytes } from "ethers";

export const PROBE_EOA = "0x000000000000000000000000000000000000dEaD";

const lower = (a) => String(a).toLowerCase();
export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const toHex = (n) => "0x" + BigInt(n).toString(16);
const word = (v) => String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const keccakHex = (hex) => keccak256(getBytes("0x" + String(hex).replace(/^0x/, "")));

/** keccak(pad(key) ‖ pad(slot)) — the Solidity mapping location. */
export const mappingKey = (key, slot) =>
  keccakHex(word(isAddress(key) ? key : toHex(key)) + word(typeof slot === "string" ? slot : toHex(slot)));

/** The ERC-7201 base slot for a namespace, e.g. "openzeppelin.storage.ERC20". */
export function erc7201Slot(namespace) {
  const h = BigInt(keccak256(Buffer.from(namespace, "utf8"))) - 1n;
  const base = BigInt(keccakHex(h.toString(16).padStart(64, "0"))) & ~0xffn;
  return "0x" + base.toString(16).padStart(64, "0");
}

/* Solady's ERC20 hand-rolls its layout; these two seeds are it. */
export const SOLADY_BALANCE_SEED = "87a211a2";
export const SOLADY_ALLOWANCE_SEED = "7f5e9f20";
const addr20 = (a) => { if (!isAddress(a)) throw new Error(`not an address: ${a}`); return a.slice(2).toLowerCase(); };
export const soladyBalanceKey = (owner) =>
  keccakHex(addr20(owner) + "0000000000000000" + SOLADY_BALANCE_SEED);
export const soladyAllowanceKey = (owner, spender) =>
  keccakHex(addr20(owner) + "0000000000000000" + SOLADY_ALLOWANCE_SEED + addr20(spender));

/* Beyond the OpenZeppelin namespace, the ERC-7201 names launchers on this chain have used
   or are likely to. Cheap to try; each is one eth_call. */
export const ERC7201_NAMESPACES = Object.freeze(["openzeppelin.storage.ERC20",
  "openzeppelin.storage.ERC20Upgradeable", "pons.storage.Token", "pons.storage.ERC20",
  "hood.storage.ERC20", "storage.ERC20"]);
/** 0 is every 3,248-byte PONS V2 token; the bound covers a dozen mixins with __gap arrays. */
export const SEQUENTIAL_SLOTS = 64;

/** A transport failure is NOT the contract's answer. Revert-shaped errors are. */
export const isTransportError = (err) =>
  !/revert|execution reverted|invalid opcode|out of gas|VM Exception|invalid jump/i.test(String(err ?? "")) &&
  /429|Too many|rate limit|timeout|timed out|abort|fetch failed|ECONN|socket|HTTP 5\d\d|network|missing from batch|batch failed|no RPC/i.test(String(err ?? ""));

const SELECTOR_BALANCE_OF = "0x70a08231";
const SELECTOR_ALLOWANCE = "0xdd62ed3e";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A POSITIVE result is stable for the life of a layout; a NEGATIVE one is only true of
   the block it was taken at, because a proxy upgrade rewrites the layout. So the negative
   cache carries its block and expires; the positive one does not need to. */
const slotCache = new Map();
export const _clearSlotCache = () => slotCache.clear();
const NEGATIVE_CACHE_BLOCKS = 5_000;

/**
 * Find the balance slot. `call(to, data, overrides)` must resolve to
 * `{ ok, data }` or `{ ok: false, error }` — injected so this is runnable offline.
 */
export async function findBalanceSlot(call, token, { probe = PROBE_EOA, sentinel = 123n, blockNumber = null } = {}) {
  const key = lower(token);
  const cached = slotCache.get(key);
  if (cached?.ok) return cached;
  if (cached && !cached.ok && blockNumber != null && cached.atBlock != null &&
      Number(blockNumber) - Number(cached.atBlock) < NEGATIVE_CACHE_BLOCKS) return cached;

  const data = SELECTOR_BALANCE_OF + word(probe);
  const want = "0x" + sentinel.toString(16).padStart(64, "0");
  let transport = null;
  const tryKey = async (storageKey, meta) => {
    const r = await call(token, data, { [token]: { stateDiff: { [storageKey]: want } } });
    if (r?.ok && BigInt(r.data || "0x0") === sentinel) return { ok: true, ...meta };
    if (r && !r.ok && isTransportError(r.error)) transport = r.error;
    return null;
  };

  const seq = (n) => ({ slot: n, kind: "sequential", keyFor: (h) => mappingKey(h, n), key: mappingKey(probe, n) });
  const ns7201 = (ns) => { const base = erc7201Slot(ns); return { slot: base, kind: "erc7201", namespace: ns, keyFor: (h) => mappingKey(h, base), key: mappingKey(probe, base) }; };
  const candidates = [
    seq(0),
    { slot: "solady", kind: "solady", keyFor: (h) => soladyBalanceKey(h), key: soladyBalanceKey(probe) },
    ns7201(ERC7201_NAMESPACES[0]),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(seq),
    ...ERC7201_NAMESPACES.slice(1).map(ns7201),
    ...Array.from({ length: SEQUENTIAL_SLOTS - 12 }, (_, i) => seq(i + 13)),
  ];

  for (const c of candidates) {
    const { key: storageKey, ...meta } = c;
    const found = await tryKey(storageKey, meta);
    if (found) { slotCache.set(key, found); return found; }
    await sleep(10);
  }
  if (transport)
    return { ok: false, transport: true,
      error: `the balance slot scan got no answer from the node (${transport}) — unreadable, not absent` };
  const out = { ok: false, atBlock: blockNumber,
    error: `balanceOf did not read back from slots 0..${SEQUENTIAL_SLOTS}, the ERC-7201 namespaces or Solady's layout` };
  slotCache.set(key, out);
  return out;
}

/** The allowance slot, verified by the same read-back: allowance(owner, spender). */
export async function findAllowanceSlot(call, token, spender, { probe = PROBE_EOA, sentinel = 456n, blockNumber = null } = {}) {
  const bal = await findBalanceSlot(call, token, { probe, blockNumber });
  if (!bal.ok) return bal;
  const want = "0x" + sentinel.toString(16).padStart(64, "0");
  const data = SELECTOR_ALLOWANCE + word(probe) + word(spender);
  const candidates = bal.kind === "solady"
    ? [{ slot: "solady", key: soladyAllowanceKey(probe, spender), keyFor: (o, sp) => soladyAllowanceKey(o, sp) }]
    : (typeof bal.slot === "number"
      ? [bal.slot + 1, bal.slot + 2, bal.slot - 1].filter((s) => s >= 0)
      : [toHex(BigInt(bal.slot) + 1n), toHex(BigInt(bal.slot) + 2n)])
      .map((s) => ({ slot: s, key: mappingKey(spender, mappingKey(probe, s)), keyFor: (o, sp) => mappingKey(sp, mappingKey(o, s)) }));
  let transport = null;
  for (const c of candidates) {
    const r = await call(token, data, { [token]: { stateDiff: { [c.key]: want } } });
    if (r?.ok && BigInt(r.data || "0x0") === sentinel)
      return { ok: true, slot: c.slot, kind: bal.kind, key: c.key, keyFor: c.keyFor };
    if (r && !r.ok && isTransportError(r.error)) transport = r.error;
    await sleep(10);
  }
  if (transport)
    return { ok: false, transport: true,
      error: `the allowance slot scan got no answer from the node (${transport}) — unreadable, not absent` };
  return { ok: false, error: `allowance did not read back beside the balance slot (${bal.kind} ${bal.slot})` };
}
