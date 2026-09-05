/**
 * CONTRACT FACTS OVER THE PUBLIC RPC — what solana.js read from a mint account,
 * re-asked of an ERC-20 on chain 4663.
 *
 * On Solana the honeypot mechanics were fields on one account: mint authority, freeze
 * authority, the Token-2022 extensions. On an EVM chain the same questions have no
 * single home. They are answered by reading code, storage slots, a few view functions
 * and the event log, and by SIMULATING a sell against live state — which is the one
 * thing the EVM can do that Solana could not: execute the exact path and read the
 * answer, rather than infer it.
 *
 * Everything here is read-only. eth_call with a state override is a simulation input:
 * the override lives for one call and touches nothing. Nothing signs, nothing sends.
 *
 * WHAT WAS MEASURED BEFORE THIS WAS WRITTEN (2026-09-05, rpc.mainnet.chain.robinhood.com):
 *   - CASHCAT 0x020bfc65…: 5,274 bytes of its own code, empty beacon and impl slots,
 *     owner() and paused() both revert (no Ownable, no Pausable), decimals 18,
 *     totalSupply 1e27. Balance mapping at SEQUENTIAL SLOT 0, found by the override
 *     trick below and read back as 123 on the first try.
 *   - GOOGL 0x2e0847e8…: 283 bytes, beacon slot 0xe10b6f6b…, name "Alphabet Class A •
 *     Robinhood Token", paused() answers 0 (so Pausable IS present). Balance mapping at
 *     the ERC-7201 "openzeppelin.storage.ERC20" slot 0x52c63247…ce00.
 *   - A PONS V2 launch (block 0x34097a4): the token is a 3,248-byte contract, not a
 *     clone; the creator topic was a 6,538-byte CONTRACT (a bot wallet), the curve a
 *     291-byte beacon proxy on beacon 0xa125492a… that answers quoteToken() and
 *     token() and reverts on every graduation selector guessed. Supply was minted to a
 *     vault contract, not the curve proxy, and the creator's launch buy (3.09% of
 *     supply) left it in the same transaction.
 *   - eth_getLogs accepts a 10,000-block span (1,107 CASHCAT transfers in 2.0s); an
 *     eleven-call burst answers "Too Many Requests" as a JSON-RPC error under HTTP 200.
 *   - Log objects carry blockTimestamp 0x0. Timestamps come from eth_getBlockByNumber.
 */
import { readRpc, readRpcBatch } from "../lib/http.js";
import { cfg, TOKENS } from "../config.js";
import {
  keccak256, encodeCall, decodeUint, decodeAddress, decodeBool, decodeString, addressFromWord,
  topicAddress, cloneTarget, cloneVariant, codeSize, word, toHex, isAddress, lower,
  SLOT_IMPLEMENTATION, SLOT_BEACON, SLOT_ADMIN, TOPIC_TRANSFER, TOPIC_UPGRADED,
  TOPIC_BEACON_UPGRADED, ZERO_ADDRESS, DEAD_ADDRESS, fromUnits, TRANSFER_PROBE_CODE,
} from "../lib/evm.js";
import { classifyFromBeaconWord, classifyFromName, KNOWN_STOCK_TOKEN_BEACON } from "../../executor/scope-guard.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The public RPC's span ceiling for eth_getLogs, measured 2026-09-04/05. */
export const LOG_SPAN = 10_000;
/* Gap between sequential log spans. Eleven back-to-back calls tripped the limiter;
   the same eleven at 150ms did not (2026-09-05). */
const SPACING_MS = 150;
/** Uniswap V4 PoolManager — every V4 pool's tokens sit in this one contract. */
export const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/** The shared PONS V2 meme hook (docs.ponsfamily.com/docs/v2). */
export const PONS_V2_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
/* An EOA that holds nothing, used as the stand-in sender for simulations. Its balance
   is overridden for the duration of one eth_call and never exists on chain. */
export const PROBE_EOA = "0x00000000000000000000000000000000000c1a0d";
/* The transfer probe's recipient: a second empty address, so the delta it reports starts
   from a zero balance on every token. */
export const PROBE_RECIPIENT = "0x00000000000000000000000000000000000c1a0e";

/* ── transport ──────────────────────────────────────────────────────────────── */

const endpoints = () => [cfg.rhRpc, cfg.rhRpcSecondary].filter(Boolean);

/** One read, primary first, secondary on a rate limit. Always {ok, data|error}. */
export async function read(method, params, opts = {}) {
  let last;
  for (const ep of endpoints()) {
    last = await readRpc(ep, method, params, opts);
    if (last.ok) return last;
    if (!/429|Too many|rate/i.test(String(last.error))) return last;
  }
  return last ?? { ok: false, error: "no RPC endpoint configured" };
}

/** Many reads in one round trip. Positional {ok, data|error} per call. */
export const readMany = (calls, opts) => readRpcBatch(endpoints()[0], calls, opts);

/** eth_call of a view; {ok, data} with the raw hex, or {ok:false, error}. */
export async function call(to, data, { block = "latest", overrides = null, attempts = 2 } = {}) {
  const params = [{ to, data }, block];
  if (overrides) params.push(overrides);
  return read("eth_call", params, { attempts });
}

export async function blockNumber() {
  const r = await read("eth_blockNumber", []);
  return r.ok ? Number(r.data) : null;
}
export async function gasPriceWei() {
  const r = await read("eth_gasPrice", []);
  return r.ok && r.data ? BigInt(r.data) : null;
}
export async function chainId() {
  const r = await read("eth_chainId", []);
  return r.ok ? Number(r.data) : null;
}

const blockTimeCache = new Map();
/** Block timestamp in ms, cached. Logs on this RPC carry blockTimestamp 0x0. */
export async function blockTimeMs(blockNo) {
  const n = Number(blockNo);
  if (!Number.isFinite(n)) return null;
  if (blockTimeCache.has(n)) return blockTimeCache.get(n);
  const r = await read("eth_getBlockByNumber", [toHex(n), false]);
  const ts = r.ok && r.data?.timestamp ? Number(r.data.timestamp) * 1000 : null;
  if (ts) blockTimeCache.set(n, ts);
  return ts;
}

/**
 * eth_getLogs over [from, to] in spans of at most LOG_SPAN, oldest first, bounded by
 * `maxSpans`. Returns {ok, logs, complete, fromBlock, toBlock, spans} — `complete` is
 * false when the budget ran out BEFORE the range was covered, and a caller that needs
 * the whole ledger must treat that as no ledger at all.
 */
export async function getLogs({ address, topics, fromBlock, toBlock, maxSpans = 12 }) {
  const logs = [];
  let spans = 0, cursor = fromBlock, lastErr = null;
  while (cursor <= toBlock && spans < maxSpans) {
    const hi = Math.min(cursor + LOG_SPAN - 1, toBlock);
    const filter = { fromBlock: toHex(cursor), toBlock: toHex(hi), topics };
    if (address) filter.address = address;
    const r = await read("eth_getLogs", [filter], { attempts: 3 });
    if (!r.ok) { lastErr = r.error; break; }
    for (const l of r.data) logs.push(l);
    cursor = hi + 1; spans++;
    if (cursor <= toBlock) await sleep(SPACING_MS);
  }
  const complete = cursor > toBlock && !lastErr;
  return { ok: !lastErr || logs.length > 0, error: lastErr, logs, complete, fromBlock, toBlock: cursor - 1, spans };
}

/* ── the contract ───────────────────────────────────────────────────────────── */

const SEL = {
  name: encodeCall("name()"), symbol: encodeCall("symbol()"), decimals: encodeCall("decimals()"),
  totalSupply: encodeCall("totalSupply()"), owner: encodeCall("owner()"), paused: encodeCall("paused()"),
  getMinDelay: encodeCall("getMinDelay()"), getThreshold: encodeCall("getThreshold()"),
};

/** What kind of account holds an upgrade key. Pure on the code + two optional views. */
export function classifyKeyHolder({ address, code, minDelay = null, threshold = null }) {
  if (!address || address === ZERO_ADDRESS) return { address: address ?? null, kind: "none", delaySec: null };
  if (codeSize(code) === 0) return { address, kind: "eoa", delaySec: null };
  if (minDelay != null) return { address, kind: "timelock", delaySec: Number(minDelay) };
  if (threshold != null && threshold > 0n) return { address, kind: "multisig", delaySec: null, threshold: Number(threshold) };
  return { address, kind: "unknown", delaySec: null };
}

async function keyHolder(address) {
  if (!address || address === ZERO_ADDRESS) return classifyKeyHolder({ address });
  const [code, delay, thr] = await readMany([
    { method: "eth_getCode", params: [address, "latest"] },
    { method: "eth_call", params: [{ to: address, data: SEL.getMinDelay }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: SEL.getThreshold }, "latest"] },
  ]);
  return classifyKeyHolder({ address, code: code.ok ? code.data : "0x",
    minDelay: delay.ok ? decodeUint(delay.data) : null, threshold: thr.ok ? decodeUint(thr.data) : null });
}

/**
 * Everything the chain will say about one token contract, in one pass. Fails CLOSED:
 * `ok:false` when the reads that decide safety (code, the two proxy slots) did not
 * answer; softer reads (name, owner) degrade to null and are said to.
 *
 * `sinceBlock` bounds the upgrade-log scan (pool creation block when known).
 */
export async function contractFacts(address, { sinceBlock = null, head = null } = {}) {
  if (!isAddress(address)) return { ok: false, error: `not an EVM address: ${address}` };
  const a = lower(address);
  const errors = [];

  const [code, implW, beaconW, adminW, name, symbol, decimals, totalSupply, owner, paused] = await readMany([
    { method: "eth_getCode", params: [a, "latest"] },
    { method: "eth_getStorageAt", params: [a, SLOT_IMPLEMENTATION, "latest"] },
    { method: "eth_getStorageAt", params: [a, SLOT_BEACON, "latest"] },
    { method: "eth_getStorageAt", params: [a, SLOT_ADMIN, "latest"] },
    { method: "eth_call", params: [{ to: a, data: SEL.name }, "latest"] },
    { method: "eth_call", params: [{ to: a, data: SEL.symbol }, "latest"] },
    { method: "eth_call", params: [{ to: a, data: SEL.decimals }, "latest"] },
    { method: "eth_call", params: [{ to: a, data: SEL.totalSupply }, "latest"] },
    { method: "eth_call", params: [{ to: a, data: SEL.owner }, "latest"] },
    { method: "eth_call", params: [{ to: a, data: SEL.paused }, "latest"] },
  ]);

  // The reads that decide safety. Unreadable is refused, not assumed empty.
  if (!code.ok) return { ok: false, error: `eth_getCode: ${code.error}` };
  if (!implW.ok || !beaconW.ok) return { ok: false, error: `proxy slots unreadable: ${implW.error || beaconW.error}` };
  const size = codeSize(code.data);
  if (size === 0) return { ok: false, error: "no code at address — not a contract" };

  const clone = cloneTarget(code.data);
  const implementation = addressFromWord(implW.data);
  const beacon = addressFromWord(beaconW.data);
  const admin = addressFromWord(adminW.ok ? adminW.data : "0x0");
  const proxyKind = beacon ? "erc1967_beacon" : implementation ? "erc1967_implementation" : clone ? "eip1167_clone" : "none";

  /* THE EQUITY TEST, the same two signals scope-guard.mjs enforces at the executor: the
     beacon slot first, the "• Robinhood Token" marker second, and the second can only
     add a refusal. Every one of the 130 Stock Tokens measured on 2026-09-05 fires both. */
  const beaconVerdict = classifyFromBeaconWord(beaconW.data, { address: a });
  const nameStr = name.ok ? decodeString(name.data) : null;
  const nameVerdict = classifyFromName(nameStr, { address: a });
  const isEquity = beaconVerdict.kind === "stock_token" || nameVerdict.equityByName;
  const unknownBeacon = beaconVerdict.kind === "unknown_beacon";

  const ownerAddr = owner.ok ? decodeAddress(owner.data) : null;
  const hasOwnable = owner.ok && ownerAddr != null;
  const hasPausable = paused.ok && decodeBool(paused.data) != null;
  const isPaused = hasPausable ? decodeBool(paused.data) : null;
  if (!name.ok) errors.push(`name(): ${name.error}`);
  if (!totalSupply.ok) errors.push(`totalSupply(): ${totalSupply.error}`);

  // Who can swap the logic. Implementation proxies: the admin slot, else owner().
  // Beacon proxies: whoever owns the beacon.
  let proxyAdmin = { address: null, kind: "none", delaySec: null };
  if (proxyKind === "erc1967_beacon") {
    const bo = await call(beacon, SEL.owner);
    proxyAdmin = await keyHolder(bo.ok ? decodeAddress(bo.data) : null);
    if (!bo.ok) proxyAdmin = { address: null, kind: "unknown", delaySec: null, note: `beacon owner(): ${bo.error}` };
  } else if (proxyKind === "erc1967_implementation") {
    proxyAdmin = await keyHolder(admin ?? ownerAddr);
  }

  // Has the logic moved? The complete answer is one historical storage read; when the
  // RPC will not serve one, a bounded log scan says what it covered.
  const upgrades = await upgradeHistory(a, { proxyKind, sinceBlock, head, implementation, beacon });

  const flags = [];
  const roles = [];
  if (isEquity) flags.push({ flag: "equity_token", detail: beaconVerdict.reason ?? nameVerdict.reason });
  if (unknownBeacon) flags.push({ flag: "unknown_beacon", detail: beaconVerdict.reason });
  if (proxyKind !== "none" && proxyKind !== "eip1167_clone") {
    flags.push({ flag: "upgradeable", detail: `${proxyKind} — the logic can be replaced by ${proxyAdmin.address ?? "an unknown key"} (${proxyAdmin.kind})` });
    if (proxyAdmin.kind === "eoa") flags.push({ flag: "upgradeable_eoa", detail: `${proxyAdmin.address} is a plain key with no delay — one signature swaps the token's logic` });
    roles.push({ role: "upgrade", holder: proxyAdmin.address, canDo: "replace the token's logic", kind: proxyAdmin.kind, delaySec: proxyAdmin.delaySec });
  }
  if (hasPausable) {
    flags.push({ flag: isPaused ? "paused_now" : "pausable", detail: isPaused ? "paused() is TRUE — transfers are halted right now" : "paused() exists — a role can halt every transfer, sells included" });
    roles.push({ role: "pause", holder: ownerAddr ?? proxyAdmin.address ?? null, canDo: "halt all transfers" });
  }
  if (hasOwnable && ownerAddr !== ZERO_ADDRESS) {
    flags.push({ flag: "owner_live", detail: `owner() is ${ownerAddr} — not renounced` });
    roles.push({ role: "owner", holder: ownerAddr, canDo: "whatever onlyOwner guards (unverified without source)" });
  }
  if (upgrades.upgradeCount > 0) flags.push({ flag: "upgraded", detail: `${upgrades.upgradeCount} upgrade event(s) in the scanned window, last at ${upgrades.lastUpgradeAt ? new Date(upgrades.lastUpgradeAt).toISOString() : "?"}` });

  const dec = decimals.ok ? Number(decodeUint(decimals.data) ?? 18) : null;
  const supplyRaw = totalSupply.ok ? decodeUint(totalSupply.data) : null;

  return {
    ok: true,
    address: a,
    codeSize: size,
    cloneOf: clone,
    cloneVariant: cloneVariant(code.data),
    isProxy: proxyKind !== "none",
    proxyKind,
    implementation: implementation ?? clone ?? null,
    beacon,
    proxyAdmin,
    name: nameStr,
    symbol: symbol.ok ? decodeString(symbol.data) : null,
    decimals: dec,
    totalSupply: supplyRaw != null ? supplyRaw.toString() : null,
    totalSupplyUnits: supplyRaw != null && dec != null ? fromUnits(supplyRaw, dec) : null,
    owner: hasOwnable ? ownerAddr : null,
    hasOwnable,
    ownershipRenounced: hasOwnable ? ownerAddr === ZERO_ADDRESS : null,
    hasPausable,
    paused: isPaused,
    isEquity,
    equityReason: isEquity ? (beaconVerdict.reason ?? nameVerdict.reason) : null,
    unknownBeacon,
    upgradeCount: upgrades.upgradeCount,
    lastUpgradeAt: upgrades.lastUpgradeAt,
    upgradeScan: upgrades.scan,
    /* No verified-source read exists here: Blockscout answers 403 to a server UA and
       is HUMAN-facing by contract. null, never false — the seat is told to treat roles
       as UNVERIFIED either way. */
    verifiedSource: null,
    /* Buy/sell tax and fee-setters need the sell simulation (sellSim below) or verified
       source; the contract layer does not guess them. */
    transferFeeBps: null, feeSettable: null, maxFeeBps: null,
    privilegedRoles: roles,
    flags,
    errors,
  };
}

/**
 * Whether the logic behind a proxy has moved. Two strategies: a historical storage read
 * (one call, complete) when the RPC serves it; else a bounded event scan.
 */
export async function upgradeHistory(address, { proxyKind, sinceBlock, head, implementation, beacon }) {
  const none = { upgradeCount: 0, lastUpgradeAt: null, scan: { method: "not_a_proxy", complete: true } };
  if (proxyKind === "none" || proxyKind === "eip1167_clone") return none;
  const to = head ?? await blockNumber();
  if (to == null) return { upgradeCount: null, lastUpgradeAt: null, scan: { method: "none", complete: false, error: "head unreadable" } };
  const from = sinceBlock ?? Math.max(0, to - 6 * LOG_SPAN);

  if (sinceBlock != null) {
    const slot = proxyKind === "erc1967_beacon" ? SLOT_BEACON : SLOT_IMPLEMENTATION;
    const then = await read("eth_getStorageAt", [address, slot, toHex(sinceBlock)], { attempts: 1 });
    const now = proxyKind === "erc1967_beacon" ? beacon : implementation;
    if (then.ok && addressFromWord(then.data)) {
      const same = addressFromWord(then.data) === now;
      if (same) return { upgradeCount: 0, lastUpgradeAt: null, scan: { method: "historical_slot", fromBlock: sinceBlock, toBlock: to, complete: true } };
      // It moved: fall through to the log scan for when.
    }
  }
  const r = await getLogs({ address, topics: [[TOPIC_UPGRADED, TOPIC_BEACON_UPGRADED]], fromBlock: from, toBlock: to, maxSpans: 6 });
  const last = r.logs.at(-1);
  return {
    upgradeCount: r.logs.length,
    lastUpgradeAt: last ? await blockTimeMs(last.blockNumber) : null,
    scan: { method: "event_scan", fromBlock: r.fromBlock, toBlock: r.toBlock, complete: r.complete, error: r.error ?? null },
  };
}

/* ── the balance slot, found by asking the contract ─────────────────────────── */

const slotCache = new Map();

/** keccak256(pad(key) . pad(slot)) — the storage key of mapping[key] at `slot`. */
export const mappingKey = (key, slot) =>
  keccak256(Buffer.from(word(isAddress(key) ? key : toHex(key)) + word(typeof slot === "string" ? slot : toHex(slot)), "hex"));

/** The ERC-7201 base slot for a namespace, e.g. "openzeppelin.storage.ERC20". */
export function erc7201Slot(namespace) {
  const h = BigInt(keccak256(namespace)) - 1n;
  const base = BigInt(keccak256(Buffer.from(h.toString(16).padStart(64, "0"), "hex"))) & ~0xffn;
  return "0x" + base.toString(16).padStart(64, "0");
}
export const OZ_ERC20_SLOT = erc7201Slot("openzeppelin.storage.ERC20");

/**
 * Find where balanceOf lives by WRITING A NUMBER INTO A CANDIDATE SLOT FOR ONE CALL and
 * asking the contract to read it back. Slots 0..12 sequentially, then the OpenZeppelin
 * ERC-7201 namespace (Stock Tokens use it; CASHCAT and PONS launches sit at slot 0 —
 * measured 2026-09-05). A contract that reads back the sentinel from none of them is
 * reported as unknown, and every simulation built on it says UNVERIFIED.
 *
 * `offset` selects a neighbouring mapping in the same layout (allowances are typically
 * balance slot + 1 in both OZ layouts); it is verified the same way, never assumed.
 */
export async function findBalanceSlot(token, { probe = PROBE_EOA, sentinel = 123n } = {}) {
  const key = lower(token);
  if (slotCache.has(key)) return slotCache.get(key);
  const data = encodeCall("balanceOf(address)", [probe]);
  const want = "0x" + sentinel.toString(16).padStart(64, "0");
  const tryAt = async (slot, kind) => {
    const r = await call(token, data, { overrides: { [token]: { stateDiff: { [mappingKey(probe, slot)]: want } } } });
    if (r.ok && decodeUint(r.data) === sentinel) return { ok: true, slot, kind };
    return null;
  };
  let found = null;
  for (let s = 0; s <= 12 && !found; s++) { found = await tryAt(s, "sequential"); if (!found) await sleep(80); }
  if (!found) found = await tryAt(OZ_ERC20_SLOT, "erc7201");
  const out = found ?? { ok: false, error: "balanceOf did not read back from slots 0..12 or the ERC-7201 ERC20 namespace" };
  slotCache.set(key, out);
  return out;
}

/** The allowance slot, verified by the same read-back: allowance(owner, spender). */
export async function findAllowanceSlot(token, spender, { probe = PROBE_EOA, sentinel = 456n } = {}) {
  const bal = await findBalanceSlot(token, { probe });
  if (!bal.ok) return bal;
  const want = "0x" + sentinel.toString(16).padStart(64, "0");
  const data = encodeCall("allowance(address,address)", [probe, spender]);
  const candidates = typeof bal.slot === "number"
    ? [bal.slot + 1, bal.slot + 2, bal.slot - 1].filter((s) => s >= 0)
    : [toHex(BigInt(bal.slot) + 1n), toHex(BigInt(bal.slot) + 2n)];
  for (const s of candidates) {
    const inner = mappingKey(spender, mappingKey(probe, s));
    const r = await call(token, data, { overrides: { [token]: { stateDiff: { [inner]: want } } } });
    if (r.ok && decodeUint(r.data) === sentinel) return { ok: true, slot: s, kind: bal.kind, key: inner };
    await sleep(80);
  }
  return { ok: false, error: "allowance did not read back from the slots beside the balance mapping" };
}

/* ── the sell simulation ────────────────────────────────────────────────────── */

/**
 * Can `amount` of the token actually be transferred, and does it arrive whole?
 * transfer(dead, amount) from a stand-in whose balance is overridden. A revert here is
 * a transfer-level block (blacklist, pause, launch gate) that no quote can see.
 */
export async function transferSim(token, amount, { from = PROBE_EOA, recipient = PROBE_RECIPIENT } = {}) {
  const slot = await findBalanceSlot(token, { probe: from });
  if (!slot.ok) return { ok: false, unverified: true, reason: slot.error };
  const amt = BigInt(amount);
  if (amt <= 0n) return { ok: false, unverified: true, reason: "nothing to transfer" };
  /* The probe address becomes the helper contract for this one call: its balance in the
     token is overridden, TRANSFER_PROBE_CODE is placed at it, and the call returns the
     recipient's balance delta. Nothing here is a receipt or a transaction. */
  const overrides = {
    [token]: { stateDiff: { [mappingKey(from, slot.slot)]: "0x" + amt.toString(16).padStart(64, "0") } },
    [from]: { balance: toHex(10n ** 18n), code: TRANSFER_PROBE_CODE },
  };
  const data = "0x" + word(token) + word(recipient) + word(toHex(amt));
  const r = await read("eth_call", [{ to: from, data, gas: toHex(1_000_000) }, "latest", overrides], { attempts: 2 });
  if (!r.ok) return { ok: false, reverted: true, revertReason: r.error, sent: amt.toString() };
  const received = decodeUint(r.data);
  if (received == null) return { ok: false, unverified: true, reason: "probe returned no delta", sent: amt.toString() };
  // Basis points the token kept on the way through. Negative would be a rebase, reported as measured.
  const lostBps = Number((amt - received) * 10_000n / amt);
  return {
    ok: received > 0n,
    sent: amt.toString(), received: received.toString(),
    transferFeeBps: lostBps,
    revertReason: received === 0n ? "transfer succeeded but nothing arrived" : null,
    basis: "balanceOf(recipient) delta around token.transfer() from a helper placed by state override; no aggregator in the path",
  };
}

/**
 * A sell of `amount` through the aggregator's own calldata, executed with eth_call
 * against live state with the stand-in's balance and allowance overridden. The router
 * returns the amount out; against the quote that is the effective sell tax.
 *
 * `route` = kyber.quote(token → native) result carrying routeSummary; `build` = the
 * kyber.build function (injected so this file has no aggregator dependency and tests
 * can hand it a fixture). Any step that cannot be verified says so and fails closed.
 */
export async function sellSim(token, amount, { route, build, from = PROBE_EOA, slippageBps = 1000 } = {}) {
  if (!route?.ok || !route.routeSummary) return { ok: false, unverified: true, reason: `no sell route: ${route?.error ?? "none"}` };
  const built = await build(route.routeSummary, { sender: from, recipient: from, slippageBps });
  if (!built.ok) return { ok: false, unverified: true, reason: `route build: ${built.error}` };
  const router = lower(built.routerAddress);
  const bal = await findBalanceSlot(token, { probe: from });
  if (!bal.ok) return { ok: false, unverified: true, reason: bal.error };
  const allow = await findAllowanceSlot(token, router, { probe: from });
  if (!allow.ok) return { ok: false, unverified: true, reason: allow.error };
  const amt = BigInt(amount);
  const wordOf = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
  const overrides = {
    [token]: { stateDiff: { [mappingKey(from, bal.slot)]: wordOf(amt), [allow.key]: wordOf(amt) } },
    [from]: { balance: toHex(10n ** 18n) },
  };
  const r = await read("eth_call", [{ from, to: router, data: built.data, gas: toHex(3_000_000) }, "latest", overrides], { attempts: 2 });
  if (!r.ok) return { ok: false, reverted: true, revertReason: r.error, router, balanceSlot: bal.slot, allowanceSlot: allow.slot };
  const out = decodeUint(r.data);
  if (out == null) return { ok: false, unverified: true, reason: "router returned nothing measurable", router };
  const quoted = BigInt(route.outAmount);
  const taxBps = quoted > 0n ? Number((quoted - out) * 10_000n / quoted) : null;
  return {
    ok: true,
    router,
    simulatedOut: out.toString(),
    quotedOut: quoted.toString(),
    // What the chain kept relative to the quote. Slippage tolerance was set wide so a
    // small negative (chain paid MORE than quoted) is possible and reported as such.
    effectiveTaxBps: taxBps,
    balanceSlot: bal.slot, allowanceSlot: allow.slot, slotKind: bal.kind,
    revertReason: null,
  };
}

/* ── holders, from the transfer ledger ──────────────────────────────────────── */

/**
 * Balances rebuilt from every Transfer since `fromBlock`, which must be the token's
 * FIRST block (launch / pool creation): a ledger that starts later is not a ledger, and
 * the result says `complete:false` and refuses to report shares. Excludes the pool,
 * router, curve, vault, burn and zero addresses BY LABEL, so the seat can see what was
 * removed. `budgetBlocks` caps the scan (default ~120k blocks ≈ 3.3h at 100ms).
 */
export async function holdersFromLedger(token, { fromBlock, toBlock = null, supply, decimals = 18,
  exclude = [], budgetBlocks = Number(process.env.DESK_HOLDER_SCAN_BLOCKS || 120_000) } = {}) {
  if (fromBlock == null) return { ok: false, error: "no launch block — the ledger has no start" };
  const head = toBlock ?? await blockNumber();
  if (head == null) return { ok: false, error: "head unreadable" };
  if (head - fromBlock > budgetBlocks)
    return { ok: false, error: `ledger spans ${head - fromBlock} blocks, over the ${budgetBlocks}-block scan budget — holders UNVERIFIED`,
      complete: false, spanBlocks: head - fromBlock };
  const r = await getLogs({ address: token, topics: [TOPIC_TRANSFER], fromBlock, toBlock: head, maxSpans: Math.ceil(budgetBlocks / LOG_SPAN) + 1 });
  if (!r.complete) return { ok: false, error: `transfer scan incomplete (${r.error ?? "budget"}) — holders UNVERIFIED`, complete: false };
  const bal = new Map();
  let transfers = 0;
  for (const l of r.logs) {
    if (l.topics?.length < 3) continue;
    const from = topicAddress(l.topics[1]), to = topicAddress(l.topics[2]);
    const v = decodeUint(l.data) ?? 0n;
    if (from !== ZERO_ADDRESS) bal.set(from, (bal.get(from) ?? 0n) - v);
    if (to !== ZERO_ADDRESS) bal.set(to, (bal.get(to) ?? 0n) + v);
    transfers++;
  }
  /* RECONCILE OR REFUSE. A ledger replayed from a start block that is not the token's
     first Transfer has holders with negative balances and a sum below totalSupply; it
     would report a clean, wrong top-10. The sum of what the replay credits must equal
     totalSupply to a dust tolerance, else the holders are UNVERIFIED (review, 2026-09-05). */
  let credited = 0n, negative = 0;
  for (const v of bal.values()) { if (v < 0n) negative++; else credited += v; }
  const total = BigInt(supply ?? 0);
  const tolerance = total / 1_000_000n + 1n;
  const gap = credited > total ? credited - total : total - credited;
  if (negative > 0 || gap > tolerance)
    return { ok: false, complete: true, transfers, fromBlock, toBlock: head,
      error: `ledger does not reconcile to totalSupply (credited ${credited} vs supply ${total}, ${negative} negative balances) — holders UNVERIFIED` };
  return { ok: true, complete: true, transfers, fromBlock, toBlock: head, ...shapeHolders(bal, { supply, decimals, exclude }) };
}

/**
 * Pure: balances → the concentration figures the seats read. `exclude` is
 * [{address, label}]; matches are removed and reported with their share.
 */
export function shapeHolders(balances, { supply, decimals = 18, exclude = [] }) {
  const total = BigInt(supply ?? 0);
  if (total <= 0n) return { ok: false, error: "no supply" };
  const pct = (n) => Number((Number(n * 1_000_000n / total) / 10_000).toFixed(2));
  const labels = new Map(exclude.filter((e) => e?.address).map((e) => [lower(e.address), e.label ?? "excluded"]));
  labels.set(ZERO_ADDRESS, "zero"); labels.set(DEAD_ADDRESS, "burn");
  const excluded = [], holders = [];
  for (const [a, v] of balances) {
    if (v <= 0n) continue;
    if (labels.has(a)) excluded.push({ address: a, label: labels.get(a), pctOfSupply: pct(v) });
    else holders.push([a, v]);
  }
  holders.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const amounts = holders.map(([, v]) => v);
  const top10 = amounts.slice(0, 10).reduce((a, b) => a + b, 0n);

  /* THE BUNDLE FINGERPRINT — unchanged from the Solana desk. A bundler splits one buy
     across many wallets, so its balances sit in a tight band; a crowd decays. Counted
     as a run of top balances within 8% of one another. A signature, not proof. */
  let biggestCluster = 0;
  for (let i = 0; i < amounts.length; i++) {
    let run = 1;
    for (let j = i + 1; j < amounts.length; j++) {
      const diff = amounts[i] > amounts[j] ? amounts[i] - amounts[j] : amounts[j] - amounts[i];
      if (diff * 100n <= amounts[i] * 8n) run++; else break;
    }
    biggestCluster = Math.max(biggestCluster, run);
  }
  const mid = amounts.slice(2, 8).reduce((a, b) => a + b, 0n);
  const headShare = pct((amounts[0] ?? 0n) + (amounts[1] ?? 0n));
  const midShare = pct(mid);
  const poolShare = excluded.filter((e) => /pool|curve|vault|manager|router|locker/.test(e.label)).reduce((a, e) => a + e.pctOfSupply, 0);

  return {
    ok: true,
    count: holders.length,
    top1Pct: pct(amounts[0] ?? 0n),
    top10Pct: pct(top10),
    clusteredHolders: biggestCluster,
    bundleSuspect: biggestCluster >= 4,
    midHoldersPct: midShare,
    headHoldersPct: headShare,
    midToHead: headShare > 0 ? Number((midShare / headShare).toFixed(2)) : null,
    excluded,
    poolsExcluded: excluded.length,
    poolShareOfSupplyPct: Number(poolShare.toFixed(2)),
    burnedPct: excluded.filter((e) => e.label === "burn").reduce((a, e) => a + e.pctOfSupply, 0),
    accounts: holders.slice(0, 10).map(([a, v]) => ({ address: a, pctOfSupply: pct(v), units: fromUnits(v, decimals) })),
    note: "Balances rebuilt from the complete Transfer ledger. Pool, curve, vault, router and burn addresses were excluded by label; what remains may still include exchange or bot wallets — high top-10 is a question, not a verdict.",
  };
}

/** balanceOf for a list of addresses, one batch. Map address → BigInt (absent when unreadable). */
export async function balancesOf(token, addresses) {
  const list = [...new Set((addresses || []).filter(isAddress).map(lower))];
  const out = new Map();
  if (!list.length) return out;
  const rs = await readMany(list.map((a) => ({ method: "eth_call", params: [{ to: token, data: encodeCall("balanceOf(address)", [a]) }, "latest"] })));
  rs.forEach((r, i) => { const v = r.ok ? decodeUint(r.data) : null; if (v != null) out.set(list[i], v); });
  return out;
}

/** How much of the supply sits in the named pool/curve addresses, read directly.
 *  Exact and complete regardless of the token's age — the one holder fact that does
 *  not need the ledger. */
export async function poolShare(token, supply, pools) {
  const total = BigInt(supply ?? 0);
  if (total <= 0n) return { ok: false, error: "no supply" };
  const bals = await balancesOf(token, pools.map((p) => p.address));
  const rows = pools.filter((p) => bals.has(lower(p.address))).map((p) => ({
    address: lower(p.address), label: p.label, pctOfSupply: Number((Number(bals.get(lower(p.address)) * 1_000_000n / total) / 10_000).toFixed(2)),
  }));
  return { ok: rows.length === pools.length, rows, poolShareOfSupplyPct: Number(rows.reduce((a, r) => a + r.pctOfSupply, 0).toFixed(2)) };
}

/** Whether an address is a contract; null when the read fails. */
export async function isContract(address) {
  const r = await read("eth_getCode", [address, "latest"], { attempts: 2 });
  return r.ok ? codeSize(r.data) > 0 : null;
}

export { KNOWN_STOCK_TOKEN_BEACON, TOKENS };
