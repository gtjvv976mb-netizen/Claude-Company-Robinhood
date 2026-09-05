/**
 * WHAT A TOKEN CAN DO TO A TRANSFER, MEASURED BEFORE MONEY TOUCHES IT.
 *
 * token2022.mjs did this job on Solana by parsing Token-2022 TLV extensions: a mint
 * that could tax, freeze or block a transfer was refused before the desk bought it.
 * EVM has no extension table to read. A memecoin here is arbitrary code, and the three
 * things arbitrary code does to a holder are: keep part of every transfer (fee-on-
 * transfer), stop transfers altogether (pausable), and stop THIS holder's transfers
 * (blocklist). The 203 Robinhood Stock Tokens are pausable and carry a blocklist by
 * design; scope-guard refuses those as positions. This module is for everything
 * scope-guard lets through.
 *
 * THE FEE IS MEASURED, NOT DECLARED. A token's tax is whatever its transfer() does, and
 * source is not always verified (Blockscout sits behind a challenge page). So the tax is
 * observed the only way that cannot lie: execute a transfer with eth_call and read the
 * recipient's balance afterwards. eth_call state overrides let us put a small helper
 * program at the address of an EXISTING HOLDER — the Uniswap V4 PoolManager for every
 * graduated PONS launch — so the helper transfers out of that holder's real balance,
 * then a second helper at the recipient sends it straight back. One call, both legs, no
 * key, no gas, no storage-slot guessing.
 *
 * VALIDATED 2026-09-05 against CASHCAT through the public RPC at block 54,571,318: the
 * PoolManager held 12,776,877.25 CASHCAT; a 1.0-token single hop returned exactly
 * 1,000,000,000,000,000,000 (delta 0 bps) and the chained round trip left the holder's
 * balance byte-identical (sell received == amount). The helper is 142 bytes of hand-
 * assembled EVM, listed opcode by opcode below so the next reader does not have to
 * trust a hex string.
 *
 * FAIL CLOSED, BOTH WAYS. "Could not measure" is refused; a measured tax above the
 * ceiling is refused; a pausable or blocklist selector in the code is refused. The
 * selector scan is deliberately a short list of the exact 4-byte signatures the
 * common templates emit, because a lint that cries wolf gets switched off; unknown
 * code shapes are caught by the measured transfer, not by the scan.
 */
import { SELECTOR, padAddress, padUint, wordAt, isAddress, hex, isRevert, erc20Balance } from "./evm-rpc.mjs";

/** Uniswap V4 PoolManager on 4663 — the holder of every graduated PONS V2 position. */
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

/** A recipient that holds nothing, so its post-transfer balance IS the delta. */
export const SCRATCH_RECIPIENT = "0x000000000000000000000000000000000000BEEF";

/** bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1) */
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1) */
export const ERC1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/** The selectors that mean "someone can stop this token moving". keccak-derived,
 *  listed with their signatures so a reviewer can recompute them. */
export const HAZARD_SELECTORS = Object.freeze({
  pausable: Object.freeze({
    "0x5c975abb": "paused()",
    "0x8456cb59": "pause()",
    "0x3f4ba83a": "unpause()",
  }),
  blocklist: Object.freeze({
    "0xf9f92be4": "blacklist(address)",
    "0xfe575a87": "isBlacklisted(address)",
    "0xdbac26e9": "blacklisted(address)",
    "0x1cdd3be3": "_isBlacklisted(address)",
    "0xe47d6060": "isBlackListed(address)",
    "0x153b0d1e": "setBlacklist(address,bool)",
  }),
});

/* THE HELPER, assembled at load. calldata = [token][to][amount][next?] (no selector).
 * It transfers `amount` of `token` from address(this) to `to`, reads balanceOf(to), and
 * when a fourth word is present, calls `to` (which must carry this same code) with
 * [token][next][balanceOf(to)] so the tokens make the return leg. Returns two words:
 * [balanceOf(to) after the first hop][balanceOf(next) after the return hop, or 0]. */
function assemble(ops) {
  const labels = {};
  let pc = 0;
  for (const op of ops) {
    if (typeof op === "object" && op.label) { labels[op.label] = pc; continue; }
    pc += typeof op === "object" && op.ref ? 3 : op.length / 2;
  }
  let out = "";
  for (const op of ops) {
    if (typeof op === "object" && op.label) continue;
    if (typeof op === "object" && op.ref) out += "61" + labels[op.ref].toString(16).padStart(4, "0");
    else out += op;
  }
  return "0x" + out;
}
export const TRANSFER_DELTA_HELPER = assemble([
  "63a9059cbb", "60e0", "1b", "6000", "52",           // mem[0]   = transfer selector << 224
  "6020", "35", "6004", "52",                         // mem[4]   = to
  "6040", "35", "6024", "52",                         // mem[36]  = amount
  "6000", "6000", "6044", "6000", "6000", "6000", "35", "5a", "f1", // CALL token.transfer(to, amount)
  "15", { ref: "REV" }, "57",                         // revert if the call failed
  "6370a08231", "60e0", "1b", "6000", "52",           // mem[0]   = balanceOf selector << 224
  "6020", "35", "6004", "52",                         // mem[4]   = to
  "6020", "6080", "6024", "6000", "6000", "35", "5a", "fa", // STATICCALL balanceOf(to) -> mem[0x80]
  "15", { ref: "REV" }, "57",
  "6000", "60a0", "52",                               // mem[0xa0] = 0
  "6080", "36", "10", { ref: "RET" }, "57",           // if calldatasize < 0x80 goto RET
  "6000", "35", "60c0", "52",                         // mem[0xc0] = token
  "6060", "35", "60e0", "52",                         // mem[0xe0] = next
  "6080", "51", "610100", "52",                       // mem[0x100] = balanceOf(to)
  "6040", "60a0", "6060", "60c0", "6000", "6020", "35", "5a", "f1", // CALL to(token, next, received) -> mem[0xa0..0xe0]
  "15", { ref: "REV" }, "57",
  { label: "RET" }, "5b", "6040", "6080", "f3",       // return mem[0x80..0xc0]
  { label: "REV" }, "5b", "6000", "6000", "fd",
]);

const CALLER = "0x000000000000000000000000000000000000dEaD";

/**
 * Measure what a transfer keeps, in basis points, on both legs. `holder` must really
 * hold at least `amount` of the token at `block`; PoolManager is tried first because
 * every graduated launch's liquidity sits there, then any pool the aggregator routed
 * through. Throws when nothing can be measured — never returns "0, probably".
 */
export async function measureTransferTax(rpc, { token, amount, holders = [], block = null }) {
  if (!isAddress(token)) throw new Error(`transfer-tax probe needs a token address, got ${String(token)}`);
  const amountWei = BigInt(amount);
  if (amountWei <= 0n) throw new Error("transfer-tax probe amount must be positive");
  const tag = block ?? await rpc("eth_blockNumber", []);
  const candidates = [POOL_MANAGER, ...holders.filter((h) => isAddress(h) && h.toLowerCase() !== POOL_MANAGER)];
  let holder = null;
  let holderBalance = 0n;
  for (const candidate of candidates) {
    let balance;
    try { balance = await erc20Balance(rpc, token, candidate, tag); }
    catch { continue; }
    if (balance >= amountWei) { holder = candidate; holderBalance = balance; break; }
  }
  if (!holder)
    throw new Error(`no known holder of ${token} carries ${amountWei} at block ${tag} — the transfer tax cannot be measured, so the token is refused rather than assumed clean`);
  const data = "0x" + padAddress(token) + padAddress(SCRATCH_RECIPIENT) + padUint(amountWei) + padAddress(holder);
  const overrides = { [holder]: { code: TRANSFER_DELTA_HELPER }, [SCRATCH_RECIPIENT]: { code: TRANSFER_DELTA_HELPER } };
  let ret;
  try {
    ret = await rpc("eth_call", [{ from: CALLER, to: holder, data, gas: hex(3_000_000) }, tag, overrides]);
  } catch (error) {
    if (isRevert(error))
      throw new Error(`a plain transfer of ${token} REVERTED in simulation (${error.message.slice(0, 120)}) — a token that cannot move cannot be sold`);
    throw error;
  }
  if (typeof ret !== "string" || ret.length < 2 + 128)
    throw new Error(`transfer-tax probe returned ${String(ret).slice(0, 20)} — cannot read the delta`);
  const received = wordAt(ret, 0);
  const holderAfter = wordAt(ret, 1);
  const returned = holderAfter + amountWei - holderBalance;
  const bps = (sent, got) => sent > 0n ? Number((sent - got) * 10_000n / sent) : Infinity;
  return Object.freeze({
    holder, block: tag, amount: amountWei,
    received, returned,
    buyTaxBps: bps(amountWei, received),
    sellTaxBps: received > 0n ? bps(received, returned) : Infinity,
  });
}

/** EIP-1167 minimal proxy: 363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3 */
export function eip1167Target(code) {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(String(code || ""));
  return m ? ("0x" + m[1]).toLowerCase() : null;
}

/** Which hazard selectors the code carries. Pure; scans the runtime bytecode for the
 *  PUSH4 patterns Solidity's dispatcher emits (`63` + selector). */
export function scanSelectors(code) {
  const body = String(code || "").toLowerCase().replace(/^0x/, "");
  const hits = { pausable: [], blocklist: [] };
  for (const [group, table] of Object.entries(HAZARD_SELECTORS)) {
    for (const [selector, signature] of Object.entries(table)) {
      if (body.includes("63" + selector.slice(2))) hits[group].push(signature);
    }
  }
  return hits;
}

/**
 * The whole verdict. `rpc` is one provider (reads, no consensus needed: a refusal from
 * one honest view is enough, and the transfer measurement is deterministic at a block).
 * Returns `{ tradeable: true, ... }` or `{ tradeable: false, reason }`; throws only on
 * transport failure, which callers must treat as "not checked", never as clean.
 */
export async function classifyErc20Hazards(rpc, { token, amount, holders = [], maxTaxBps = 0, block = null }) {
  if (!isAddress(token)) throw new Error(`hazard check needs a token address, got ${String(token)}`);
  const tag = block ?? await rpc("eth_blockNumber", []);
  const code = await rpc("eth_getCode", [token, tag]);
  if (typeof code !== "string" || code === "0x")
    return { tradeable: false, kind: "no_code", reason: `${token} has no code at block ${tag}` };
  const clone = eip1167Target(code);
  const implSlot = await rpc("eth_getStorageAt", [token, ERC1967_IMPLEMENTATION_SLOT, tag]);
  const implementation = /^0x0*$/.test(implSlot) ? null : ("0x" + implSlot.slice(-40)).toLowerCase();
  const logic = clone ?? implementation;
  const logicCode = logic ? await rpc("eth_getCode", [logic, tag]) : code;
  if (logic && (typeof logicCode !== "string" || logicCode === "0x"))
    return { tradeable: false, kind: "dangling_delegate", reason: `${token} delegates to ${logic}, which has no code` };
  const selectors = scanSelectors(logicCode);
  if (selectors.pausable.length)
    return { tradeable: false, kind: "pausable", selectors, reason:
      `${token} carries ${selectors.pausable.join(", ")} — whoever holds that role can freeze every exit` };
  if (selectors.blocklist.length)
    return { tradeable: false, kind: "blocklist", selectors, reason:
      `${token} carries ${selectors.blocklist.join(", ")} — whoever holds that role can freeze THIS wallet's exit` };

  /* An upgradeable token behind a single key is a token whose transfer() can become
     anything tomorrow. Flagged and refused when the admin is an EOA; a contract admin
     (timelock, multisig) is reported but not refused, because the desk cannot tell a
     timelock from a one-of-one multisig here and the seat's forensics carry that. */
  let proxyAdmin = null;
  if (implementation) {
    const adminSlot = await rpc("eth_getStorageAt", [token, ERC1967_ADMIN_SLOT, tag]);
    const admin = /^0x0*$/.test(adminSlot) ? null : ("0x" + adminSlot.slice(-40)).toLowerCase();
    if (admin) {
      const adminCode = await rpc("eth_getCode", [admin, tag]);
      const adminIsEoa = adminCode === "0x";
      proxyAdmin = { address: admin, kind: adminIsEoa ? "eoa" : "contract" };
      if (adminIsEoa)
        return { tradeable: false, kind: "upgradeable_by_eoa", proxyAdmin, reason:
          `${token} is an ERC-1967 proxy whose admin ${admin} is a single key — its transfer() can be swapped under the position` };
    }
  }

  const tax = await measureTransferTax(rpc, { token, amount, holders, block: tag });
  const worst = Math.max(tax.buyTaxBps, tax.sellTaxBps);
  if (!(worst <= Number(maxTaxBps)))
    return { tradeable: false, kind: "fee_on_transfer", tax, proxyAdmin, reason:
      `${token} keeps ${tax.buyTaxBps} bps on the way in and ${tax.sellTaxBps} bps on the way out (ceiling ${maxTaxBps}) — measured by executing a real transfer at block ${tag}` };
  return { tradeable: true, kind: clone ? "eip1167_clone" : implementation ? "erc1967_proxy" : "plain",
    logic, proxyAdmin, tax, selectors };
}
