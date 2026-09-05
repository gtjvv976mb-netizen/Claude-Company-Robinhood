/**
 * THE SMALLEST EVM TOOLBOX THE DESK CAN GET AWAY WITH.
 *
 * Hand-rolled on purpose. The desk reads a handful of ERC-20 views, a few storage
 * slots and some logs; an ABI library would be the second-largest dependency in the
 * tree for four selectors and a string decoder. Everything here is pure, synchronous
 * and testable against vectors whose answer is already known — the keccak below is
 * asserted against keccak256("") and keccak256("BeaconUpgraded(address)") in
 * test-evm-evidence.mjs before anything trusts a selector it produced.
 *
 * Node has no keccak-256 (node:crypto ships sha3-256, which pads differently and gives a
 * different digest), so keccak-f[1600] is implemented here with BigInt lanes. It hashes
 * a few hundred bytes per token; speed is not a concern and clarity is.
 */

/* ── keccak-256 ─────────────────────────────────────────────────────────────── */

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => n === 0 ? x : (((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    // theta
    const C = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    // rho + pi
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++)
      B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
    // chi
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++)
      A[x + y] = B[x + y] ^ ((~B[(x + 1) % 5 + y] & M64) & B[(x + 2) % 5 + y]);
    // iota
    A[0] ^= RC[round];
  }
}

/** keccak-256 of a Buffer / Uint8Array / utf8 string, as a 0x-prefixed hex string. */
export function keccak256(input) {
  const msg = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const rate = 136;
  // Keccak (pre-NIST) padding: 0x01 … 0x80. SHA3 uses 0x06 and would give a different digest.
  const padLen = rate - (msg.length % rate);
  const padded = Buffer.alloc(msg.length + padLen);
  msg.copy(padded);
  padded[msg.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return "0x" + out.toString("hex");
}

/* ── selectors, topics, encoding ────────────────────────────────────────────── */

const selectorCache = new Map();
/** The 4-byte selector of a Solidity signature, e.g. selector("owner()") → 0x8da5cb5b. */
export function selector(sig) {
  let s = selectorCache.get(sig);
  if (!s) { s = keccak256(sig).slice(0, 10); selectorCache.set(sig, s); }
  return s;
}
/** The topic0 of an event signature, e.g. topic("Transfer(address,address,uint256)"). */
export const topic = (sig) => keccak256(sig);

export const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TOPIC_UPGRADED = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
export const TOPIC_BEACON_UPGRADED = "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e";
export const TOPIC_OWNERSHIP_TRANSFERRED = "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0";
export const TOPIC_PAUSED = "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258";

/** ERC-1967 slots: bytes32(uint256(keccak256("eip1967.proxy.<x>")) - 1). */
export const SLOT_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
export const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";

export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const lower = (a) => (typeof a === "string" ? a.toLowerCase() : a);

const strip = (h) => (typeof h === "string" ? h.replace(/^0x/, "") : "");

/** A 32-byte ABI word for an address. */
export const padAddress = (addr) => {
  if (!isAddress(addr)) throw new Error(`padAddress: not an address: ${addr}`);
  return "0x" + strip(addr).toLowerCase().padStart(64, "0");
};
/** A 32-byte ABI word for a uint (BigInt / number / decimal string). */
export const padUint = (v) => {
  const n = BigInt(v);
  if (n < 0n) throw new Error(`padUint: negative ${v}`);
  return "0x" + n.toString(16).padStart(64, "0");
};
/** A bare 64-hex-char word (no 0x), for topic filters and concatenation. */
export const word = (h) => strip(h).toLowerCase().padStart(64, "0");

/** Calldata for a view with zero or more address/uint arguments. */
export function encodeCall(sig, args = []) {
  let data = selector(sig);
  for (const a of args) data += strip(isAddress(a) ? padAddress(a) : padUint(a));
  return data;
}

/* ── decoding ───────────────────────────────────────────────────────────────── */

const isHex = (h) => typeof h === "string" && /^0x[0-9a-fA-F]*$/.test(h);

/** The first 32-byte word of a return as a BigInt, or null for an empty/short return. */
export function decodeUint(hex) {
  if (!isHex(hex) || hex.length < 66) return null;
  return BigInt("0x" + hex.slice(2, 66));
}
/** The first word as an address, or null. */
export function decodeAddress(hex) {
  if (!isHex(hex) || hex.length < 66) return null;
  return ("0x" + hex.slice(26, 66)).toLowerCase();
}
/** The first word as a bool. Anything non-zero is true. Null on empty. */
export function decodeBool(hex) {
  const n = decodeUint(hex);
  return n == null ? null : n !== 0n;
}
/**
 * A single ABI-encoded string. Null for anything that is not one — an empty return, a
 * short return, a bytes32-style name — rather than throwing, because "this contract has
 * no readable name" is evidence of nothing. Mirrors executor/scope-guard.mjs.
 */
export function decodeString(hex) {
  if (!isHex(hex)) return null;
  const b = hex.slice(2);
  if (b.length < 128) return null;
  const off = Number(BigInt("0x" + b.slice(0, 64)));
  if (!Number.isFinite(off) || off * 2 + 64 > b.length) return null;
  const len = Number(BigInt("0x" + b.slice(off * 2, off * 2 + 64)));
  const start = off * 2 + 64;
  if (!Number.isFinite(len) || start + len * 2 > b.length) return null;
  try { return Buffer.from(b.slice(start, start + len * 2), "hex").toString("utf8"); }
  catch { return null; }
}
/** The address held in a storage word, or null when the word is empty. */
export function addressFromWord(w) {
  if (!isHex(w)) return null;
  if (/^0x0*$/.test(w)) return null;
  return ("0x" + strip(w).padStart(64, "0").slice(-40)).toLowerCase();
}
/**
 * The address in an indexed topic. A topic is always present, so an all-zero word IS
 * the zero address — the `from` of every mint — where a zero STORAGE word means "empty"
 * (addressFromWord). Conflating the two hid every mint Transfer from launchFromReceipt
 * on 2026-09-05 and reported a launch that handed 12.7% of supply out as 0%.
 */
export const topicAddress = (t) => (isHex(t) && t.length === 66 && /^0x0+$/.test(t) ? ZERO_ADDRESS : addressFromWord(t));

/* ── the EIP-1167 minimal proxy ────────────────────────────────────────────── */

/**
 * 45 bytes of runtime code, the implementation address in the middle. Measured on chain
 * 4663 on 2026-09-05: 90 of 800 listed tokens are this exact shape and every one is a
 * PONS launch. Any deviation from the template is NOT a clone — a contract that merely
 * starts like one could do anything after the delegatecall.
 */
const CLONE_RE_1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
/* The 44-byte "0age" minimal proxy — same delegatecall, two bytes shorter. This is the
   shape scope-guard.mjs counted 90 of on 2026-09-05. Both are matched; neither is
   matched loosely. */
const CLONE_RE_0AGE = /^0x3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e602a57fd5bf3$/i;
/** The implementation a minimal proxy delegates to, or null when the code is not one. */
export function cloneTarget(code) {
  if (typeof code !== "string") return null;
  const c = code.toLowerCase();
  const m = c.match(CLONE_RE_1167) || c.match(CLONE_RE_0AGE);
  return m ? "0x" + m[1] : null;
}
/** Which template matched: "eip1167" (45 bytes), "0age" (44 bytes) or null. */
export function cloneVariant(code) {
  if (typeof code !== "string") return null;
  const c = code.toLowerCase();
  return CLONE_RE_1167.test(c) ? "eip1167" : CLONE_RE_0AGE.test(c) ? "0age" : null;
}
/** Byte length of a 0x hex code string. */
export const codeSize = (code) => (isHex(code) ? (code.length - 2) / 2 : 0);

/* ── the transfer probe: a helper contract that exists for one eth_call ──────── */

/**
 * A tiny assembler, because the probe below is the only bytecode the desk ships and
 * hand-counted jump offsets are how such things go wrong. Labels resolve to PUSH1
 * offsets; every opcode used is listed, nothing else is accepted.
 */
const OP = { STOP: 0x00, SUB: 0x03, ISZERO: 0x15, SHL: 0x1b, CALLDATALOAD: 0x35, MLOAD: 0x51, MSTORE: 0x52,
  JUMPI: 0x57, GAS: 0x5a, JUMPDEST: 0x5b, PUSH1: 0x60, PUSH4: 0x63, CALL: 0xf1, RETURN: 0xf3, STATICCALL: 0xfa, REVERT: 0xfd };
export function assemble(program) {
  const labels = new Map();
  let pc = 0;
  for (const ins of program) {
    if (typeof ins === "string" && ins.endsWith(":")) { labels.set(ins.slice(0, -1), pc); continue; }
    const [op, arg] = Array.isArray(ins) ? ins : [ins];
    if (!(op in OP)) throw new Error(`assemble: unknown op ${op}`);
    pc += 1 + (op === "PUSH1" ? 1 : op === "PUSH4" ? 4 : 0);
  }
  const out = [];
  for (const ins of program) {
    if (typeof ins === "string" && ins.endsWith(":")) continue;
    const [op, arg] = Array.isArray(ins) ? ins : [ins];
    out.push(OP[op]);
    if (op === "PUSH1") {
      const v = typeof arg === "string" ? labels.get(arg) : arg;
      if (v == null || v < 0 || v > 0xff) throw new Error(`assemble: bad PUSH1 ${arg}`);
      out.push(v);
    } else if (op === "PUSH4") {
      if (typeof arg !== "number" || arg < 0 || arg > 0xffffffff) throw new Error(`assemble: bad PUSH4 ${arg}`);
      out.push((arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff);
    }
  }
  return "0x" + Buffer.from(out).toString("hex");
}

/**
 * THE TRANSFER-TAX RULER. Called with 96 bytes of calldata — token, recipient, amount,
 * each a 32-byte word — it reads balanceOf(recipient), calls token.transfer(recipient,
 * amount), reads balanceOf(recipient) again and RETURNS THE DELTA. Placed at the probe
 * address by eth_call's state override (`code`), so it exists for exactly one call and
 * never touches the chain. A transfer that reverts reverts the probe.
 *
 * Why it exists: measuring "tax" as the gap between an aggregator's sell quote and what
 * the chain returned for its calldata reported CASHCAT — a token with no fee — at 0 bps
 * at 05:22 and 607 bps at 09:40 on 2026-09-05. A fee does not switch on and off; the
 * quote's pool model does. This ruler asks the token alone, with no aggregator in the
 * path, and is checked in test-evm-evidence.mjs against tokens whose answer is known
 * (delta must equal amount on CASHCAT, GOOGL and USDG).
 *
 * The transfer's return data is ignored on purpose (only success is checked): a token
 * that returns nothing, like USDT's shape, still moves balances, and the balance delta
 * is the fact being measured.
 */
export const TRANSFER_PROBE_CODE = assemble([
  // balanceOf(recipient) → mem[0xa0]
  ["PUSH4", 0x70a08231], ["PUSH1", 0xe0], "SHL", ["PUSH1", 0x00], "MSTORE",
  ["PUSH1", 0x20], "CALLDATALOAD", ["PUSH1", 0x04], "MSTORE",
  ["PUSH1", 0x20], ["PUSH1", 0xa0], ["PUSH1", 0x24], ["PUSH1", 0x00], ["PUSH1", 0x00], "CALLDATALOAD", "GAS", "STATICCALL",
  "ISZERO", ["PUSH1", "fail"], "JUMPI",
  // transfer(recipient, amount)
  ["PUSH4", 0xa9059cbb], ["PUSH1", 0xe0], "SHL", ["PUSH1", 0x00], "MSTORE",
  ["PUSH1", 0x20], "CALLDATALOAD", ["PUSH1", 0x04], "MSTORE",
  ["PUSH1", 0x40], "CALLDATALOAD", ["PUSH1", 0x24], "MSTORE",
  ["PUSH1", 0x00], ["PUSH1", 0x00], ["PUSH1", 0x44], ["PUSH1", 0x00], ["PUSH1", 0x00], ["PUSH1", 0x00], "CALLDATALOAD", "GAS", "CALL",
  "ISZERO", ["PUSH1", "fail"], "JUMPI",
  // balanceOf(recipient) → mem[0x80]
  ["PUSH4", 0x70a08231], ["PUSH1", 0xe0], "SHL", ["PUSH1", 0x00], "MSTORE",
  ["PUSH1", 0x20], "CALLDATALOAD", ["PUSH1", 0x04], "MSTORE",
  ["PUSH1", 0x20], ["PUSH1", 0x80], ["PUSH1", 0x24], ["PUSH1", 0x00], ["PUSH1", 0x00], "CALLDATALOAD", "GAS", "STATICCALL",
  "ISZERO", ["PUSH1", "fail"], "JUMPI",
  // return after − before
  ["PUSH1", 0xa0], "MLOAD", ["PUSH1", 0x80], "MLOAD", "SUB", ["PUSH1", 0xc0], "MSTORE",
  ["PUSH1", 0x20], ["PUSH1", 0xc0], "RETURN",
  "fail:", "JUMPDEST", ["PUSH1", 0x00], ["PUSH1", 0x00], "REVERT",
]);

/* ── units ──────────────────────────────────────────────────────────────────── */

export const hexToBigInt = (h) => (isHex(h) && h.length > 2 ? BigInt(h) : null);
export const toHex = (n) => "0x" + BigInt(n).toString(16);
/** A BigInt of base units as a JS number in whole tokens. Lossy past 2^53, by design. */
export const fromUnits = (n, decimals = 18) => {
  if (n == null) return null;
  const d = BigInt(decimals);
  const whole = BigInt(n) / 10n ** d;
  const frac = BigInt(n) % 10n ** d;
  return Number(whole) + Number(frac) / Number(10n ** d);
};
/** ETH from wei, as a number. */
export const fromWei = (n) => fromUnits(n, 18);
/** Wei from an ETH decimal (string or number), exact to 18 places. */
export function toWei(eth) {
  const s = String(eth);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`toWei: not a decimal: ${eth}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
}
