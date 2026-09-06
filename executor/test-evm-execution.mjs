/**
 * THE NONCE STATE MACHINE, EVERY TRANSITION, AGAINST A MOCKED TWO-PROVIDER CHAIN.
 *
 * test-live-execution.mjs was 2,634 lines of Solana — blockhash expiry, ALT resolution,
 * coherent account snapshots — and the record of seven adversarial review rounds. The
 * cases that survive the port are the chain-agnostic ones, restated here in EVM terms:
 * write-ahead before disclosure, the returned hash must be the journaled hash, only
 * fee-bearing attempts spend the exit budget, an observation withdraws replacement
 * authority, and exits are never frozen behind an entry. The cases that do not survive
 * (blockhash validity, rent, ATAs) have no analogue and are gone.
 *
 * Everything runs against an in-memory chain that two providers read. The chain is a
 * small simulator, not a stub: nonces are consumed by mined transactions, receipts carry
 * Transfer logs, balances have a per-block history, and a provider can be given an
 * overlay to disagree with the other (lag, a one-sided receipt, a different txCount).
 * Nothing here signs anything real: the key is a fixed test scalar and the "chain" is a
 * Map.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Wallet, Transaction, getAddress } from "ethers";
import { ExecutionJournal, CURRENT_TX_ATTEMPT_PROTOCOL, NATIVE_ASSET } from "./journal.mjs";
import { EvmExecutor, walletFromKeyFile, TRANSFER_TOPIC, CANCEL_GAS_LIMIT, EXECUTION_READINESS_ROUTE } from "./evm-executor.mjs";
import { RpcError, proveChain, pendingNonceConsensus, plainEthUnits, hex, padAddress, padUint } from "./evm-rpc.mjs";
import { floorFrom } from "./evm-swap.mjs";
import { POOL_MANAGER } from "./erc20-hazards.mjs";
import { ETH_USD_CACHE_SOURCE } from "./eth-usd-oracle.mjs";
import { lintSource } from "./lessons-lint.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  const d = String(detail ?? "").split("\n")[0].slice(0, 160);
  if (condition) { pass++; console.log(`  ok   ${name}${d ? "  — " + d : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${d ? "  — " + d : ""}`); }
};
const section = (title) => console.log(`\n${title}`);

/* ── the actors ─────────────────────────────────────────────────────────── */
const KEY = "0x" + "11".repeat(32);
const wallet = new Wallet(KEY);
const WALLET = getAddress(wallet.address);
const TOKEN = "0x" + "aa".repeat(20);
const ROUTER = "0x" + "bb".repeat(20);
const OTHER = "0x" + "cc".repeat(20);
const RATE = 1_000_000n;                 // raw token units per wei on the mock route
const ENTRY_WEI = 10n ** 15n;            // 0.001 ETH
const GAS_PRICE = 400_000_000n;          // 0.4 gwei, the order of what 4663 printed 2026-09-05
const word = (n) => "0x" + padUint(n);
const abiString = (text) => {
  const b = Buffer.from(text, "utf8");
  return "0x" + padUint(32) + padUint(b.length) + b.toString("hex").padEnd(64, "0");
};
const blockHash = (n) => "0x" + n.toString(16).padStart(64, "0");
const lower = (a) => String(a || "").toLowerCase();
/* The mock router's calldata is [selector][recipient][floor][2 × quoted]; the sim and the
   mined output read the quoted amount back out of the bytes, as the real router would.
   The quote word is doubled so it sits ABOVE the quote and outside embeddedFloor's scan
   band — real router calldata carries the floor, never the quote, and a second candidate
   in (50%, 100%] of the quote is exactly what the scan refuses. */
const quotedFromCalldata = (data) => data && data.length >= 10 + 192 ? BigInt("0x" + data.slice(10 + 128, 10 + 192)) / 2n : null;

/* ── the mock chain ─────────────────────────────────────────────────────── */
function makeChain() {
  const chain = {
    head: 1_000, gasPrice: GAS_PRICE, chainId: "0x1237",
    minedNonce: 5,
    txs: new Map(),                    // hash → { tx, status: "pending"|"mined"|"dropped", receipt }
    tokenBalances: new Map([[lower(POOL_MANAGER), 10n ** 30n], [lower(WALLET), 0n]]),
    allowance: 0n,
    balanceHistory: [{ block: 0, balance: 10n ** 18n }],
    sendPolicy: "mine",                // mine | drop | pending | throw | wronghash
    simOut: null, lastQuoteOut: null, sends: [], onSend: null,
    approvalLands: true,
  };
  chain.balanceAt = (tag) => {
    if (tag === "latest" || tag === "pending") return chain.balanceHistory.at(-1).balance;
    const n = Number(BigInt(tag));
    let out = chain.balanceHistory[0].balance;
    for (const e of chain.balanceHistory) if (e.block <= n) out = e.balance;
    return out;
  };
  chain.pendingNonce = () => {
    const pendingNonces = new Set([...chain.txs.values()].filter((t) => t.status === "pending").map((t) => t.tx.nonce));
    return chain.minedNonce + pendingNonces.size;
  };
  chain.mine = (tx, hash, { status = "0x1", out = null } = {}) => {
    chain.head += 1;
    const gasUsed = tx.data === "0x" && lower(tx.to) === lower(WALLET) ? 21_000n : 150_000n;
    const fee = gasUsed * chain.gasPrice;
    const logs = [];
    const before = chain.balanceHistory.at(-1).balance;
    let after = before - fee - BigInt(tx.value);
    if (status === "0x1" && lower(tx.to) === lower(ROUTER)) {
      if (BigInt(tx.value) > 0n) {
        const amount = out ?? chain.simOut ?? quotedFromCalldata(tx.data) ?? chain.lastQuoteOut;
        logs.push({ address: TOKEN, topics: [TRANSFER_TOPIC, "0x" + padAddress(ROUTER), "0x" + padAddress(WALLET)],
          data: "0x" + padUint(amount) });
        chain.tokenBalances.set(lower(WALLET), (chain.tokenBalances.get(lower(WALLET)) ?? 0n) + amount);
      } else {
        const amount = out ?? chain.simOut ?? quotedFromCalldata(tx.data) ?? chain.lastQuoteOut;
        after += amount;
      }
    }
    if (status === "0x1" && lower(tx.to) === lower(TOKEN) && tx.data.startsWith("0x095ea7b3") && chain.approvalLands)
      chain.allowance = BigInt("0x" + tx.data.slice(74));
    chain.balanceHistory.push({ block: chain.head, balance: after });
    /* A real sequencer will not mine nonce N+1 while N is unconsumed. The lenient
       default (any nonce mines) is what let an expired-undisclosed attempt punch a
       permanent hole past 115 green assertions; scenarios that care set strictNonce. */
    if (chain.strictNonce && tx.nonce !== chain.minedNonce) {
      chain.txs.set(hash, { tx, status: "pending", receipt: null });
      return null;
    }
    chain.minedNonce = Math.max(chain.minedNonce, tx.nonce + 1);
    const receipt = { transactionHash: hash, status, blockNumber: hex(chain.head), blockHash: blockHash(chain.head),
      gasUsed: hex(gasUsed), effectiveGasPrice: hex(chain.gasPrice), logs };
    chain.txs.set(hash, { tx, status: "mined", receipt });
    return receipt;
  };
  return chain;
}

function provider(chain, label, overlay = {}) {
  const rpc = async (method, params = []) => {
    if (overlay[method]) return overlay[method](params, chain);
    switch (method) {
      case "eth_chainId": return chain.chainId;
      case "eth_blockNumber": return hex(chain.head);
      case "eth_gasPrice": return hex(chain.gasPrice);
      case "eth_estimateGas": return hex(200_000);
      case "eth_getTransactionCount":
        return hex(params[1] === "pending" ? chain.pendingNonce() : chain.minedNonce);
      case "eth_getBalance": return hex(chain.balanceAt(params[1]));
      case "eth_getCode": {
        const a = lower(params[0]);
        if ([lower(TOKEN), lower(OTHER), lower(POOL_MANAGER), lower(ROUTER)].includes(a)) return "0x6080604052600436106100";
        return "0x";
      }
      case "eth_getStorageAt": return "0x" + "0".repeat(64);
      case "eth_getTransactionReceipt": return chain.txs.get(lower(params[0]))?.receipt ?? null;
      case "eth_getTransactionByHash": {
        const t = chain.txs.get(lower(params[0]));
        return t && t.status !== "dropped" ? { hash: params[0], nonce: hex(t.tx.nonce) } : null;
      }
      case "eth_call": {
        const { to, data } = params[0];
        const overrides = params[2];
        const sel = String(data).slice(0, 10);
        if (overrides && Object.keys(overrides).some((k) => overrides[k]?.code)) {
          // the erc20-hazards helper: [token][to][amount][next] with no selector
          const amount = BigInt("0x" + data.slice(2 + 128, 2 + 192));
          const holder = chain.tokenBalances.get(lower(to)) ?? 0n;
          return "0x" + padUint(amount) + padUint(holder);
        }
        if (lower(to) === lower(ROUTER)) return word(chain.simOut ?? quotedFromCalldata(data) ?? chain.lastQuoteOut ?? 0n);
        if (sel === "0x70a08231") return word(chain.tokenBalances.get("0x" + data.slice(-40).toLowerCase()) ?? 0n);
        if (sel === "0xdd62ed3e") return word(chain.allowance);
        if (sel === "0x313ce567") return word(18);
        if (sel === "0x06fdde03") return abiString("Mock Meme");
        throw new RpcError(`${label}: eth_call to ${to} selector ${sel} unmocked`, { method, provider: label });
      }
      case "eth_sendRawTransaction": {
        const raw = params[0];
        const tx = Transaction.from(raw);
        const hash = lower(tx.hash);
        chain.sends.push({ hash, nonce: tx.nonce, to: tx.to, value: tx.value, data: tx.data,
          maxFeePerGas: tx.maxFeePerGas, gasLimit: tx.gasLimit });
        if (chain.onSend) chain.onSend({ tx, hash });
        const policy = typeof chain.sendPolicy === "function" ? chain.sendPolicy(tx) : chain.sendPolicy;
        if (policy === "throw") throw new RpcError(`${label}: eth_sendRawTransaction transport failed`, { method, provider: label });
        if (policy === "wronghash") return "0x" + "ee".repeat(32);
        if (policy === "drop") { chain.txs.set(hash, { tx, status: "dropped" }); return tx.hash; }
        if (policy === "pending") { chain.txs.set(hash, { tx, status: "pending" }); return tx.hash; }
        if (policy === "revert") { chain.mine(tx, hash, { status: "0x0" }); return tx.hash; }
        chain.mine(tx, hash);
        return tx.hash;
      }
      default:
        throw new RpcError(`${label}: ${method} unmocked`, { method, provider: label });
    }
  };
  rpc.label = label;
  return rpc;
}

/* ── fetch, for the aggregator ──────────────────────────────────────────── */
const realFetch = globalThis.fetch;
let activeChain = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith("https://aggregator-api.kyberswap.com/robinhood/api/v1/")) return realFetch(url, init);
  const chain = activeChain;
  const respond = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.includes("/routes?")) {
    const q = new URL(u).searchParams;
    const amountIn = BigInt(q.get("amountIn"));
    const buying = lower(q.get("tokenIn")) === lower(NATIVE_ASSET);
    const amountOut = buying ? amountIn * RATE : amountIn / RATE;
    chain.lastQuoteOut = amountOut;
    return respond({ data: { routeSummary: { tokenIn: q.get("tokenIn"), tokenOut: q.get("tokenOut"),
      amountIn: String(amountIn), amountOut: String(amountOut), gas: "250000",
      route: [[{ pool: POOL_MANAGER }]] } } });
  }
  if (u.endsWith("/route/build")) {
    const body = JSON.parse(init.body);
    const quoted = BigInt(body.routeSummary.amountOut);
    const floor = floorFrom(quoted, body.slippageTolerance);
    const data = "0x12345678" + padAddress(body.recipient) + padUint(floor) + padUint(quoted * 2n);
    return respond({ data: { data, routerAddress: ROUTER, gas: "250000" } });
  }
  throw new Error(`unexpected aggregator URL ${u}`);
};

/* ── a world: chain + providers + journal + executor + clock ────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-evm-"));
let worlds = 0;
function makeWorld({ config = {}, hardStop = () => false, overlayB = {}, overlayA = {} } = {}) {
  const chain = makeChain();
  activeChain = chain;
  const clock = { t: 1_800_000_000_000 };
  const primary = provider(chain, "primary RPC", overlayA);
  const secondary = provider(chain, "secondary RPC", overlayB);
  const journal = new ExecutionJournal(path.join(tmp, `w${worlds++}.sqlite`), { wallet: WALLET, now: () => clock.t });
  const logs = [];
  const executor = new EvmExecutor({
    providers: [primary, secondary], wallet, journal, hardStop, log: (line) => logs.push(String(line)),
    now: () => clock.t, sleepFn: async (ms) => { clock.t += ms; },
    config: { slippageBps: 300, maxPriceImpactPct: 5, maxNetworkFeeWei: (2n * 10n ** 15n).toString(),
      deadlineBlocks: 300, receiptTimeoutMs: 2_000, cancelTimeoutMs: 2_000, maxAttempts: 3, maxExitAttempts: 12,
      exitRetryCooldownMs: 60_000, ...config },
  });
  return { chain, primary, secondary, journal, executor, clock, logs };
}

const entryContext = (clock) => ({
  event: { mint: TOKEN, symbol: "MOCK", call_id: 7, ts: clock.t - 1_000, stop: 0.002, target: 0.004 },
  entryReference: { marketMark: 0.002455, entryLow: 0.0022, entryHigh: 0.0027, stopRatio: 0.8, targetRatio: 1.5 },
  entryPreflight: {
    inputAmountRaw: ENTRY_WEI.toString(), forwardOutputRaw: (ENTRY_WEI * RATE).toString(),
    reverseOutputRaw: ENTRY_WEI.toString(), tokenDecimals: 18, ethUsd: 2455, observedAt: clock.t - 500,
    ethUsdSource: ETH_USD_CACHE_SOURCE, ethUsdPublishTime: Math.floor(clock.t / 1_000) - 60,
    ethUsdConfidencePct: 0.5, ethUsdProviderDivergencePct: 0,
  },
});
const entrySpec = (world, id = "entry:50:1") => ({
  id, kind: "entry", eventId: id, feedId: 1, mint: TOKEN, inputMint: NATIVE_ASSET, outputMint: TOKEN,
  amountRaw: ENTRY_WEI.toString(), context: entryContext(world.clock),
});
const position = (qty = ENTRY_WEI * RATE) => ({
  mint: TOKEN, symbol: "MOCK", qtyRaw: qty.toString(), costBasisWei: ENTRY_WEI.toString(),
  entryInputWei: ENTRY_WEI.toString(), ethUsdAtEntry: 2455, paidEth: 0.001, entryIntentId: "entry:50:1",
});
/* The exit fixture carries a sufficient allowance already, so the state-machine cases
   exercise the SWAP; the approval sections zero it themselves. */
const exitSpec = (world, id = "desk-exit:50:9", kind = "desk_exit", { allowance = null } = {}) => {
  const qty = ENTRY_WEI * RATE;
  world.chain.tokenBalances.set(lower(WALLET), qty);
  world.chain.allowance = allowance ?? qty;
  return { id, kind, eventId: kind === "desk_exit" ? id : null, feedId: 9, mint: TOKEN, inputMint: TOKEN,
    outputMint: NATIVE_ASSET, amountRaw: qty.toString(), context: { position: position(qty), why: "test" } };
};
const attemptRows = (world, id) => world.journal.attempts(id);
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* ═══════════════════════════════════════════════════════════════════════════ */
section("KEY FILE AND ADDRESS: THE ONLY SECRET, READ THE ONLY WAY");
{
  const file = path.join(tmp, "burner.key");
  fs.writeFileSync(file, KEY.slice(2) + "\n", { mode: 0o600 });
  const w = walletFromKeyFile(file, { fs });
  ok("a 0600 32-byte hex file (no 0x) loads and derives the checksummed address", getAddress(w.address) === WALLET, WALLET);
  fs.chmodSync(file, 0o644);
  const e = await caught(async () => walletFromKeyFile(file, { fs }));
  ok("a group-readable key file is refused", /0600/.test(e?.message ?? ""), e?.message);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "0x1234\n", { mode: 0o600 });
  const short = await caught(async () => walletFromKeyFile(file, { fs }));
  ok("a file that is not 32 bytes of hex is refused", /32-byte hex/.test(short?.message ?? ""));
  fs.writeFileSync(file, JSON.stringify([1, 2, 3]), { mode: 0o600 });
  const solana = await caught(async () => walletFromKeyFile(file, { fs }));
  ok("a Solana JSON keypair is refused, not misread", /32-byte hex/.test(solana?.message ?? ""));
}

section("WEI/ETH PARSING: EXACT, OR NULL");
{
  ok("0.05 ETH is exactly 5e16 wei", plainEthUnits("0.05") === 50_000_000_000_000_000n);
  ok("the smallest unit survives: 0.000000000000000001 → 1 wei", plainEthUnits("0.000000000000000001") === 1n);
  ok("nineteen fractional digits are refused, not rounded", plainEthUnits("0.0000000000000000001") === null);
  ok("exponent notation is refused", plainEthUnits("1e3") === null);
  ok("a leading dot is refused", plainEthUnits(".5") === null);
  ok("a negative is refused", plainEthUnits("-1") === null);
  ok("an operator ceiling of 0.004 parses to 4e15", plainEthUnits("0.004") === 4_000_000_000_000_000n);
}

section("BOOT GATES: BOTH PROVIDERS MUST SAY 0x1237");
{
  const chain = makeChain();
  const a = provider(chain, "A"), b = provider(chain, "B", { eth_chainId: async () => "0xa4b1" });
  const e = await caught(() => proveChain([a, b]));
  ok("a provider answering Arbitrum One's chain id is refused, naming it", /B is not Robinhood Chain .*0xa4b1/.test(e?.message ?? ""), e?.message);
  const ids = await proveChain([a, provider(chain, "B2")]);
  ok("two honest providers prove 4663", ids[0] === 4663 && ids[1] === 4663);
  const dead = provider(chain, "C", { eth_chainId: async () => { throw new RpcError("C: eth_chainId timed out", { method: "eth_chainId" }); } });
  const t = await caught(() => proveChain([a, dead]));
  ok("an unreachable provider throws a transport error the poller waits on, not a chain refusal",
    t instanceof RpcError && !/not Robinhood Chain/.test(t.message), t?.message);
  const nonce = await pendingNonceConsensus([a, provider(chain, "B3")], WALLET);
  ok("the pending nonce is read from both", nonce === 5);
  const dis = await caught(() => pendingNonceConsensus([a, provider(chain, "B4", { eth_getTransactionCount: async () => "0x9" })], WALLET));
  ok("a pending-nonce disagreement is a hold, never a choice", /disagree on the pending nonce \(5 vs 9\)/.test(dis?.message ?? ""));
}

/* ═══════════════════════════════════════════════════════════════════════════ */
section("planned → signed → submitted → confirmed  (an entry, the happy path)");
{
  const w = makeWorld();
  let stateAtSend = null;
  w.chain.onSend = () => { stateAtSend = w.journal.latestAttempt("entry:50:1")?.state; };
  const fill = await w.executor.executeIntent(entrySpec(w));
  const a = attemptRows(w, "entry:50:1");
  ok("the intent confirms", fill.state === "confirmed", fill.state);
  ok("exactly one attempt row", a.length === 1);
  ok("nonce = max(journal.next=null, chain pending=5) = 5", a[0].nonce === 5, String(a[0].nonce));
  ok("chain id 4663 on the row", a[0].chainId === 4663);
  ok("the journaled hash is the hash of the journaled raw bytes", lower(Transaction.from(a[0].rawTx).hash) === a[0].txHash);
  ok("the row carries the current EVM protocol marker", a[0].protocol === CURRENT_TX_ATTEMPT_PROTOCOL);
  ok("proven-at and deadline blocks are recorded, deadline = proven + 300", a[0].provenAtBlock === 1000 && a[0].deadlineBlock === 1300,
    `${a[0].provenAtBlock}/${a[0].deadlineBlock}`);
  ok("gas limit = estimate × 1.3", a[0].gasLimit === "260000", a[0].gasLimit);
  ok("maxFeePerGas = 2 × the live gas price read at signing", a[0].maxFeePerGas === (GAS_PRICE * 2n).toString(), a[0].maxFeePerGas);
  ok("WRITE-AHEAD: the journal said 'submitted' before eth_sendRawTransaction ran", stateAtSend === "submitted", String(stateAtSend));
  ok("meta.next_nonce advanced to 6 in the signing transaction", w.journal.nextNonce() === 6);
  ok("the sent transaction is EIP-1559 to the router with the entry's value",
    w.chain.sends.length === 1 && lower(w.chain.sends[0].to) === lower(ROUTER) && w.chain.sends[0].value === ENTRY_WEI);
  ok("output is measured from the Transfer log to this wallet, not the quote", fill.actualOutputRaw === (ENTRY_WEI * RATE).toString(), fill.actualOutputRaw);
  ok("fee = gasUsed × effectiveGasPrice from the receipt", fill.networkFeeWei === (150_000n * GAS_PRICE).toString(), fill.networkFeeWei);
  ok("the fill's tx hash is the journaled hash", fill.txHash === a[0].txHash);
  ok("nothing is left pending after confirmation except the confirmed row awaiting accounting",
    w.journal.pendingIntents().every((i) => i.state === "confirmed"));
}

section("submitted → ambiguous  (the node returned a different hash)");
{
  const w = makeWorld();
  w.chain.sendPolicy = "wronghash";
  const e = await caught(() => w.executor.executeIntent(entrySpec(w)));
  const a = attemptRows(w, "entry:50:1")[0];
  ok("the intent is quarantined", w.journal.getIntent("entry:50:1").state === "ambiguous");
  ok("...with the reason on the row", /returned hash .* for bytes journaled as/.test(a.error ?? ""), a.error);
  ok("...and the call throws naming the quarantine", /quarantined/.test(e?.message ?? ""));
  const again = await caught(() => w.executor.executeIntent(entrySpec(w)));
  ok("a replay does not sign again: AMBIGUOUS is recovery-only", /AMBIGUOUS/.test(again?.message ?? "") && attemptRows(w, "entry:50:1").length === 1);
}

section("submitted → failed  (status 0x0: gas burned, nonce consumed)");
{
  const w = makeWorld();
  w.chain.sendPolicy = "revert";
  const e = await caught(() => w.executor.executeIntent(entrySpec(w)));
  const a = attemptRows(w, "entry:50:1")[0];
  ok("the attempt is failed, fee-bearing", a.state === "failed" && /reverted on chain/.test(a.error), a.error);
  ok("the fee is booked as a risk event even though nothing was bought", w.journal.rollingRisk().deployedTodayWei === (150_000n * GAS_PRICE).toString(),
    w.journal.rollingRisk().deployedTodayWei);
  ok("the chain consumed nonce 5", w.chain.minedNonce === 6);
  ok("the error says so", /reverted on chain; fee .* accounted/.test(e?.message ?? ""));
  w.chain.sendPolicy = "mine";
  const fill = await w.executor.executeIntent(entrySpec(w));
  ok("the rebuild uses the NEXT nonce, never 5 again", attemptRows(w, "entry:50:1")[1].nonce === 6 && fill.state === "confirmed");
}

section("submitted → dropped → CANCEL → expired → rebuilt  (the transition Solana never needed)");
{
  const w = makeWorld();
  w.chain.sendPolicy = "drop";
  const first = await w.executor.executeIntent(exitSpec(w));
  ok("a dropped send leaves the intent SUBMITTED, not ambiguous — no receipt is the ordinary failure here",
    first.state === "submitted", first.state);
  ok("nothing was cancelled before the deadline block", w.chain.sends.length === 1);
  // Past the deadline. txCount==N on both, the hash unknown to both: the sequencer dropped it.
  w.chain.head = 1_400;
  w.chain.sendPolicy = "mine";
  await w.executor.recoverPending();
  const rows = attemptRows(w, "desk-exit:50:9");
  const cancel = w.chain.sends[1];
  ok("a CANCEL was sent at the same nonce", cancel && cancel.nonce === 5, String(cancel?.nonce));
  ok("...a 0-value self-transfer", lower(cancel.to) === lower(WALLET) && cancel.value === 0n && cancel.data === "0x");
  ok("...with 21,000 gas", cancel.gasLimit === CANCEL_GAS_LIMIT);
  ok("...bid ABOVE the original (≥ 1.25× its maxFeePerGas)", cancel.maxFeePerGas >= BigInt(rows[0].maxFeePerGas) * 125n / 100n,
    `${cancel.maxFeePerGas} vs ${rows[0].maxFeePerGas}`);
  ok("the original AND the cancel rows are expired once the cancel's receipt is on both providers",
    rows.length === 2 && rows[0].state === "expired" && rows[1].state === "expired", rows.map((r) => r.state).join("/"));
  ok("the cancel row is marked as a cancel of attempt 1", rows[1].order.role === "cancel" && rows[1].order.cancelOf === 1);
  ok("the intent is expired and may be rebuilt", w.journal.getIntent("desk-exit:50:9").state === "expired");
  ok("the cancel's gas is booked as a fee-bearing event", w.journal.rollingRisk().deployedTodayWei === (21_000n * GAS_PRICE).toString(),
    w.journal.rollingRisk().deployedTodayWei);
  ok("next_nonce did not move for the cancel (it already passed 5)", w.journal.nextNonce() === 6);
  const rebuilt = await w.executor.executeIntent(exitSpec(w));
  const rows2 = attemptRows(w, "desk-exit:50:9");
  ok("the rebuild is a fresh quote at the next free nonce (6), and confirms", rebuilt.state === "confirmed" && rows2[2].nonce === 6,
    `${rebuilt.state} at ${rows2[2]?.nonce}`);
  ok("native output is the balance delta across the block plus the fee", rebuilt.actualOutputRaw === (ENTRY_WEI * RATE / RATE).toString(),
    rebuilt.actualOutputRaw);
}

section("a dropped CANCEL is resent, and a bounded number of times");
{
  const w = makeWorld({ config: { maxCancelResends: 2 } });
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(exitSpec(w));
  w.chain.head = 1_400;
  await w.executor.recoverPending();            // first cancel, dropped too
  const firstCancel = w.chain.sends[1];
  await w.executor.recoverPending();            // resend of the identical bytes
  ok("the resend is the SAME bytes (same hash), so it cannot race itself", w.chain.sends[2]?.hash === firstCancel.hash);
  await w.executor.recoverPending();
  const intent = w.journal.getIntent("desk-exit:50:9");
  ok("after maxCancelResends the intent is quarantined rather than retried forever",
    intent.state === "ambiguous" && /cancels were also dropped/.test(intent.error ?? ""), intent.error);
}

section("submitted → ambiguous  (txCount > N on both, none of our hashes landed)");
{
  const w = makeWorld();
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(entrySpec(w));
  w.chain.head = 1_400;
  w.chain.minedNonce = 6;                        // something outside this journal consumed 5
  await w.executor.recoverPending();
  const intent = w.journal.getIntent("entry:50:1");
  ok("the intent is quarantined for manual reconciliation", intent.state === "ambiguous", intent.state);
  ok("...naming the foreign consumption", /consumed on both providers .* by a transaction this journal does not hold/.test(intent.error ?? ""), intent.error);
  ok("no cancel was attempted at a nonce that is already gone", w.chain.sends.length === 1);
}

section("a safety exit may consume an ambiguous BUY's nonce to clear its runway");
{
  /* THE RUNWAY IS PER-WALLET AND CANNOT BE MINT-SCOPED: nonces are sequential, so any
     unresolved attempt at a lower nonce holds everything behind it, including a stop
     on a different token. The cancel that frees such a nonce used to require the
     BLOCKER itself to be a safety exit, so a dropped, ambiguous BUY could never have
     its nonce consumed and the whole book's stops queued behind it forever.
     A cancel is a same-nonce replacement: exactly one of the two can land, so the
     ambiguity resolves either way. Holding resolves nothing and leaves real positions
     unstopped.
     Tested at the decision itself. Driving it through executeIntent needs a second
     token, and this harness models one — balanceOf ignores which contract was called —
     so that route stops at a balance check before the runway is ever reached, and a
     test written that way passed with the fix REVERTED. Mutation testing caught it. */
  /* An ambiguous buy with its cancel budget INTACT. "wronghash" quarantines the intent
     on the first attempt — the node acknowledged different bytes than we journaled — so
     no cancel has been spent and freeing the nonce is still possible. (Driving it to
     ambiguity by repeated drops instead exhausts maxCancelResends, and then nothing can
     send a cancel regardless of authorisation; that scenario cannot show this fix.) */
  const mkBlocker = async () => {
    const w = makeWorld();
    w.chain.sendPolicy = "wronghash";
    await caught(() => w.executor.executeIntent(entrySpec(w)));
    w.chain.sendPolicy = "ok";
    w.chain.head = 1_400;
    return w;
  };

  const a = await mkBlocker();
  const blocker = a.journal.getIntent("entry:50:1");
  ok("the blocking BUY is ambiguous and is not itself a safety exit",
    blocker.state === "ambiguous" && !a.executor._isSafetyExit(blocker), blocker.state);

  /* WITHOUT the runway authorisation — the old behaviour — no cancel is sent. */
  a.chain.sendPolicy = "ok";
  const sendsBefore = a.chain.sends.length;
  await a.executor._reconcile(blocker, a.journal.latestAttempt(blocker.id),
    { finalityTimeoutMs: 0, allowCancel: true, cancelAmbiguousForRunway: false });
  ok("without the runway authorisation the ambiguous buy keeps its nonce",
    a.chain.sends.length === sendsBefore, `${a.chain.sends.length - sendsBefore} sends`);

  /* WITH it — a safety exit is waiting behind this nonce — the nonce is consumed. */
  const b = await mkBlocker();
  const blockerB = b.journal.getIntent("entry:50:1");
  b.chain.sendPolicy = "ok";
  const beforeB = b.chain.sends.length;
  await b.executor._reconcile(blockerB, b.journal.latestAttempt(blockerB.id),
    { finalityTimeoutMs: 0, allowCancel: true, cancelAmbiguousForRunway: true });
  ok("with a safety exit waiting, the wedged nonce IS consumed by a cancel",
    b.chain.sends.length > beforeB, `${b.chain.sends.length - beforeB} sends`);

  /* And the authorisation is only ever handed out by the runway when the WAITING
     intent is a safety exit — never by default. */
  const src = fs.readFileSync(new URL("./evm-executor.mjs", import.meta.url), "utf8");
  ok("the option defaults to false, so no other caller gains this power",
    /cancelAmbiguousForRunway = false \} = \{\}\) \{/.test(src));
  ok("and the runway passes it only as mayCancel (a safety exit or its approval)",
    /cancelAmbiguousForRunway: mayCancel,/.test(src));
}

section("a fill priced from expired state is quarantined as unpriceable, not as missing");
{
  /* A SELL'S PROCEEDS ARE A BALANCE DELTA ACROSS THE FILL'S BLOCK, so accounting one
     needs eth_getBalance at TWO PAST blocks. On a 250ms-block L2 a non-archive node
     serves a short window, so a process down longer than that returns to a fill it can
     never price. The receipt is status 0x1 and the tokens are gone — the money is in
     the wallet. Reporting that as "no output reached the wallet" would be a lie about
     which of the two problems the operator has. */
  const prunedHistory = {
    eth_getBalance: (params, chain) => {
      if (params[1] !== "latest" && params[1] !== "pending")
        throw new Error("missing trie node — state at that block is not available");
      return hex(chain.balanceAt(params[1]));
    },
  };
  const w = makeWorld({ overlayA: prunedHistory, overlayB: prunedHistory });
  const failed = await caught(() => w.executor.executeIntent(exitSpec(w)));
  const intent = w.journal.getIntent("desk-exit:50:9");

  ok("the intent is quarantined rather than retried against a node that cannot answer",
    intent.state === "ambiguous", intent.state);
  ok("...named as UNPRICEABLE, not as a fill that never happened",
    /proceeds cannot be measured/.test(intent.error ?? "") &&
    !/no .* reached/.test(intent.error ?? ""), intent.error);
  ok("...saying plainly that the sell did land, so nobody hunts a missing transaction",
    /The sell DID land/.test(intent.error ?? ""), intent.error);
  ok("...and naming the way out rather than leaving it a dead end",
    /archive endpoint/.test(intent.error ?? ""), intent.error);
  ok("the thrown error carries the same account, so a caller is not left guessing",
    /proceeds cannot be measured/.test(failed?.message ?? ""), failed?.message?.slice(0, 120));
}

section("providers disagree → HOLD, never a guess");
{
  const w = makeWorld({ overlayB: { eth_getTransactionCount: async (p, chain) => hex(p[1] === "latest" ? chain.minedNonce + 1 : chain.pendingNonce()) } });
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(exitSpec(w));
  w.chain.head = 1_400;
  await w.executor.recoverPending();
  ok("a txCount disagreement past the deadline holds the attempt as submitted", w.journal.getIntent("desk-exit:50:9").state === "submitted");
  ok("...and says so", w.logs.some((l) => /disagree on the mined nonce \(5 vs 6\)/.test(l)));
  ok("nothing else was sent", w.chain.sends.length === 1);
}

section("one-sided receipt past the deadline → ambiguous; a safety exit may still free the nonce");
{
  let ghost = true;
  const ghostReceipt = (p, chain) => ghost ? { transactionHash: p[0], status: "0x1", blockNumber: hex(1_390), blockHash: blockHash(1_390),
    gasUsed: hex(150_000), effectiveGasPrice: hex(GAS_PRICE), logs: [] } : chain.txs.get(lower(p[0]))?.receipt ?? null;
  const w = makeWorld({ overlayB: { eth_getTransactionReceipt: ghostReceipt } });
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(exitSpec(w, "risk-exit:50:1", "risk_exit"));
  w.chain.head = 1_400;
  await w.executor.recoverPending();
  const before = w.journal.getIntent("risk-exit:50:1");
  ok("a receipt visible on ONE provider only is an observation, so replacement authority is withdrawn: ambiguous",
    before.state === "ambiguous" && /one provider only/.test(before.error ?? ""), before.error);
  ok("no cancel was sent while the observation stood", w.chain.sends.length === 1);
  ghost = false;                                 // the sighting was a lie; both providers now agree it is unknown
  w.chain.sendPolicy = "mine";
  await w.executor.recoverPending();
  await w.executor.recoverPending();
  const after = w.journal.getIntent("risk-exit:50:1");
  ok("QUARANTINE does not disarm an exit: once both providers agree the nonce is free, the exit cancels and expires",
    after.state === "expired" && w.chain.sends.length === 2 && w.chain.sends[1].nonce === 5, `${after.state}, sends ${w.chain.sends.length}`);
}

section("an ambiguous ENTRY never cancels; HARD_STOP blocks even an exit's cancel");
{
  let ghost = true;
  const w = makeWorld({ overlayB: { eth_getTransactionReceipt: (p, chain) => ghost
    ? { transactionHash: p[0], status: "0x1", blockNumber: hex(1_390), blockHash: blockHash(1_390), gasUsed: hex(1), effectiveGasPrice: hex(1), logs: [] }
    : chain.txs.get(lower(p[0]))?.receipt ?? null } });
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(entrySpec(w));
  w.chain.head = 1_400;
  await w.executor.recoverPending();
  ghost = false;
  await w.executor.recoverPending();
  await w.executor.recoverPending();
  ok("an ambiguous entry stays ambiguous — new exposure earns no cancel", w.journal.getIntent("entry:50:1").state === "ambiguous" && w.chain.sends.length === 1);

  let stop = false;
  const h = makeWorld({ hardStop: () => stop });
  h.chain.sendPolicy = "drop";
  await h.executor.executeIntent(exitSpec(h));
  h.chain.head = 1_400;
  stop = true;
  await h.executor.recoverPending();
  ok("under HARD_STOP a dropped exit is NOT cancelled and stays submitted", h.journal.getIntent("desk-exit:50:9").state === "submitted" && h.chain.sends.length === 1);
  ok("...and the log says why", h.logs.some((l) => /HARD STOP is present; no cancel sent/.test(l)));
  const fresh = makeWorld({ hardStop: () => true });
  const blocked = await caught(() => fresh.executor.executeIntent(exitSpec(fresh, "desk-exit:50:10")));
  ok("HARD_STOP blocks a new submission outright", /HARD STOP/.test(blocked?.message ?? "") && fresh.chain.sends.length === 0 &&
    attemptRows(fresh, "desk-exit:50:10").length === 0, blocked?.message);
}

section("signed but never disclosed: expires free past its deadline, holds under HARD_STOP");
{
  let stop = false;
  const w = makeWorld({ hardStop: () => stop });
  // Sign, then refuse to disclose: the hard stop appears between signing and sending.
  w.chain.onSend = () => { throw new Error("must not send"); };
  const original = w.journal.markSubmitted.bind(w.journal);
  w.journal.markSubmitted = (id, n) => { throw new Error("hard stop appeared"); };
  await caught(() => w.executor.executeIntent(exitSpec(w)));
  w.journal.markSubmitted = original;
  const signed = w.journal.latestAttempt("desk-exit:50:9");
  ok("the attempt is journaled as SIGNED with its bytes, nothing sent", signed?.state === "signed" && w.chain.sends.length === 0, signed?.state);
  stop = true;
  const held = await caught(() => w.executor.recoverPending());
  ok("recovery under HARD_STOP does not disclose signed bytes", w.journal.latestAttempt("desk-exit:50:9").state === "signed" && w.chain.sends.length === 0,
    held?.message);
  stop = false;
  w.chain.head = 1_400;
  w.chain.onSend = null;
  await w.executor.recoverPending();
  const expired = w.journal.latestAttempt("desk-exit:50:9");
  ok("past the deadline, undisclosed bytes expire for free — no cancel needed, nothing can land",
    expired.state === "expired" && /never disclosed/.test(expired.error) && w.chain.sends.length === 0, expired.error);
  /* THE NONCE COMES BACK. The chain never saw nonce N; a rebuild that signed at N+1 would
     wait forever behind a hole. On a STRICT chain (nothing above the pending nonce mines)
     the rebuilt attempt must carry N and land. Found 2026-09-05 — the lenient mock mined
     any nonce and hid it behind 115 green assertions. */
  ok("the journal handed the never-sent nonce back", w.journal.nextNonce() === expired.nonce,
    `next_nonce ${w.journal.nextNonce()} vs expired ${expired.nonce}`);
  w.chain.strictNonce = true;
  /* A real rebuild re-quotes (Kyber calldata carries a deadline) and re-reads gas, so its
     bytes — and its hash — differ from the expired attempt's. The mock is deterministic,
     so move gas to model that; the journal's tx_hash UNIQUE guard is right to refuse
     byte-identical bytes twice. */
  w.chain.gasPrice = w.chain.gasPrice * 3n / 2n;
  await w.executor.executeIntent(exitSpec(w));
  const rebuilt = w.journal.latestAttempt("desk-exit:50:9");
  ok("the rebuilt attempt reuses the freed nonce and lands on a strict chain",
    rebuilt.nonce === expired.nonce && rebuilt.state === "confirmed", `nonce ${rebuilt.nonce} state ${rebuilt.state}`);
  w.chain.strictNonce = false;
}

section("observation-only recovery reads and never sends");
{
  const w = makeWorld();
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(exitSpec(w));
  w.chain.head = 1_400;
  w.chain.sendPolicy = "throw";
  const r = await w.executor.recoverPending({ observationOnly: true, maxIntents: 1 });
  ok("the bounded observation pass returns the intent unchanged", r.length === 1 && r[0].state === "submitted");
  ok("...and sent nothing, not even a cancel", w.chain.sends.length === 1);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
section("APPROVALS ARE INTENTS: approve(N) then swap(N+1)");
{
  const w = makeWorld();
  const fill = await w.executor.executeIntent(exitSpec(w, "desk-exit:50:9", "desk_exit", { allowance: 0n }));
  const child = w.journal.getIntent("desk-exit:50:9:approve:1");
  const childRow = w.journal.latestAttempt("desk-exit:50:9:approve:1");
  const swapRow = w.journal.latestAttempt("desk-exit:50:9");
  ok("the sell confirmed", fill.state === "confirmed");
  ok("one approval intent was raised as the exit's own first leg", child?.kind === "approval" && child.context.forExit === true && child.context.parent === "desk-exit:50:9");
  ok("the approval took nonce 5 and the swap nonce 6", childRow?.nonce === 5 && swapRow?.nonce === 6, `${childRow?.nonce}/${swapRow?.nonce}`);
  ok("the approval is accounted (its gas booked), not left blocking", child.state === "accounted");
  ok("the approval is exact — the amount sold, never unbounded", BigInt("0x" + w.chain.sends[0].data.slice(74)) === ENTRY_WEI * RATE);
  ok("the swap was not even built until the allowance was READ back", w.chain.sends[0].data.startsWith("0x095ea7b3") && lower(w.chain.sends[1].to) === lower(ROUTER));
}

section("zero-first: three nonces for one sell on a token that refuses non-zero → non-zero");
{
  const w = makeWorld();
  // a stale, insufficient, non-zero grant
  const fill = await w.executor.executeIntent(exitSpec(w, "desk-exit:50:9", "desk_exit", { allowance: 7n }));
  const nonces = w.chain.sends.map((s) => s.nonce);
  const amounts = w.chain.sends.slice(0, 2).map((s) => BigInt("0x" + s.data.slice(74)));
  ok("approve(0) at 5, approve(amount) at 6, swap at 7", nonces.join(",") === "5,6,7" && fill.state === "confirmed", nonces.join(","));
  ok("the first approval is the zero", amounts[0] === 0n && amounts[1] === ENTRY_WEI * RATE);
  ok("both approval intents exist and are accounted", ["desk-exit:50:9:approve:1", "desk-exit:50:9:approve:2"]
    .every((id) => w.journal.getIntent(id)?.state === "accounted"));
}

section("a dropped approval strands nothing: the swap waits, the approval cancels, the sell rebuilds");
{
  const w = makeWorld();
  w.chain.sendPolicy = (tx) => tx.data.startsWith("0x095ea7b3") ? "drop" : "mine";
  const e = await caught(() => w.executor.executeIntent(exitSpec(w, "desk-exit:50:9", "desk_exit", { allowance: 0n })));
  ok("the sell refuses to build while its approval is unresolved", /approval .* is submitted; the sell waits for the allowance/.test(e?.message ?? ""), e?.message);
  ok("no swap bytes were signed", attemptRows(w, "desk-exit:50:9").length === 0);
  w.chain.head = 1_400;
  w.chain.sendPolicy = "mine";
  await w.executor.recoverPending();
  ok("recovery cancels the dropped approval at its nonce", w.journal.getIntent("desk-exit:50:9:approve:1").state === "expired" && w.chain.sends[1].nonce === 5);
  const fill = await w.executor.executeIntent(exitSpec(w, "desk-exit:50:9", "desk_exit", { allowance: 0n }));
  ok("the sell then goes through with a fresh approval at 6 and the swap at 7", fill.state === "confirmed" &&
    w.chain.sends.at(-2).nonce === 6 && w.chain.sends.at(-1).nonce === 7);
}

section("a MINED approval that reads back insufficient still refuses the sell");
{
  const w = makeWorld();
  w.chain.approvalLands = false;                  // the token lied: approve() succeeded, allowance() says 0
  const e = await caught(() => w.executor.executeIntent(exitSpec(w, "desk-exit:50:9", "desk_exit", { allowance: 0n })));
  ok("assertApproved refuses", /the approval did not land/.test(e?.message ?? ""), e?.message);
  ok("no swap was signed into TRANSFER_FROM_FAILED", attemptRows(w, "desk-exit:50:9").length === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════ */
section("THE FEE GATE IS READ LIVE AND REFUSES BEFORE SIGNING");
{
  const w = makeWorld();
  w.chain.gasPrice = 10n ** 10n;                  // 10 gwei: 260,000 × 20 gwei = 0.0052 ETH > the 0.002 ceiling
  const e = await caught(() => w.executor.executeIntent(entrySpec(w)));
  ok("worst-case fee above exec.maxNetworkFeeWei refuses", /worst-case network fee .* exceeds the .* ceiling/.test(e?.message ?? ""), e?.message);
  ok("nothing was journaled or sent", attemptRows(w, "entry:50:1").length === 0 && w.chain.sends.length === 0);
  const unset = await caught(async () => new EvmExecutor({ providers: [w.primary, w.secondary], wallet, journal: w.journal,
    config: { slippageBps: 300, maxNetworkFeeWei: null } }));
  ok("an executor cannot be built with the gate unset — a VOID registry entry refuses to arm", /maxNetworkFeeWei is unset/.test(unset?.message ?? ""));
  const noBps = await caught(async () => new EvmExecutor({ providers: [w.primary, w.secondary], wallet, journal: w.journal,
    config: { slippageBps: null, maxNetworkFeeWei: "1" } }));
  ok("...and neither can it without slippage", /slippageBps is unset/.test(noBps?.message ?? ""));
}

section("EXITS SPEND THE BUDGET ONLY WHEN THEY PAID GAS");
{
  const w = makeWorld({ config: { maxAttempts: 1, maxExitAttempts: 2, exitRetryCooldownMs: 0 } });
  w.chain.sendPolicy = "revert";
  await caught(() => w.executor.executeIntent(exitSpec(w)));
  ok("one fee-bearing failure", w.journal.getIntent("desk-exit:50:9").state === "failed");
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(exitSpec(w));
  w.chain.head = 1_400;
  w.chain.sendPolicy = "mine";
  await w.executor.recoverPending();
  ok("a drop+cancel is not a fee-bearing attempt", w.journal.getIntent("desk-exit:50:9").state === "expired");
  const fill = await w.executor.executeIntent(exitSpec(w));
  ok("the exit still gets its second FEE-BEARING attempt past the entry cap, and fills", fill.state === "confirmed", fill.state);
}

section("EXITS ARE NOT FROZEN BEHIND AN ENTRY");
{
  const w = makeWorld();
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent({ ...entrySpec(w, "entry:50:2"), mint: OTHER, outputMint: OTHER,
    context: { ...entryContext(w.clock), event: { ...entryContext(w.clock).event, mint: OTHER } } }).catch(() => {});
  const stuck = w.journal.getIntent("entry:50:2");
  w.chain.sendPolicy = "mine";
  // A safety exit on a DIFFERENT token while the entry is stuck at nonce 5: the machine
  // must reconcile the lower nonce first (cancel it) rather than queue behind it.
  w.chain.head = 1_400;
  const fill = await w.executor.executeIntent(exitSpec(w));
  ok("the stuck entry existed as submitted", stuck?.state === "submitted" || stuck == null);
  ok("the exit landed on the SAME tick, after the entry's nonce was freed by a cancel", fill.state === "confirmed", fill.state);
  ok("the stuck entry is expired by that cancel", w.journal.getIntent("entry:50:2").state === "expired" &&
    w.chain.sends.some((s) => s.nonce === 5 && lower(s.to) === lower(WALLET)));
  ok("the exit took the nonce after the cancel", attemptRows(w, "desk-exit:50:9").at(-1).nonce === 6);
}

section("PROTOCOL: a row from another era is observation-only");
{
  const w = makeWorld();
  w.chain.sendPolicy = "drop";
  await w.executor.executeIntent(exitSpec(w));
  w.journal.db.prepare("UPDATE tx_attempts SET protocol='jupiter-dual-rpc-coherent-snapshot-v3' WHERE intent_id=?").run("desk-exit:50:9");
  w.chain.head = 1_400;
  w.chain.sendPolicy = "mine";
  await w.executor.recoverPending();
  ok("a Solana-era protocol marker is never cancelled or resent by this machine", w.chain.sends.length === 1 &&
    w.journal.getIntent("desk-exit:50:9").state === "submitted");
  ok("...and the log names the marker", w.logs.some((l) => /carries protocol jupiter-dual-rpc-coherent-snapshot-v3/.test(l)));
}

section("READINESS: a no-sign rehearsal on the fixed WETH/USDG route");
{
  const w = makeWorld();
  w.chain.balanceHistory = [{ block: 0, balance: 10n ** 18n }];
  const r = await w.executor.probeExecutionReadiness({ amountWei: ENTRY_WEI.toString() }).catch((e) => e);
  ok("the rehearsal proves the route through both providers without signing", r?.ready === true && r.route === EXECUTION_READINESS_ROUTE && r.providers === 2 && w.chain.sends.length === 0,
    r?.message ?? JSON.stringify(r));
  w.chain.balanceHistory = [{ block: 0, balance: 10n ** 12n }];
  const poor = await w.executor.probeExecutionReadiness({ amountWei: ENTRY_WEI.toString() }).catch((e) => e);
  ok("an under-funded wallet fails the rehearsal naming the reserve", /wallet reserve is insufficient/.test(poor?.message ?? ""));
}

/* ═══════════════════════════════════════════════════════════════════════════ */
section("THE MACHINE-CHECKED LESSONS HOLD IN THE NEW CODE");
{
  for (const file of ["evm-executor.mjs", "poller.mjs", "evm-rpc.mjs"]) {
    const src = fs.readFileSync(path.join(here, file), "utf8");
    const findings = lintSource(src).filter((f) => f.rule === "gate-doubles-as-cost" && /maxNetworkFee/.test(f.message));
    ok(`${file}: the fee GATE is never multiplied as a cost model`, findings.length === 0, findings.map((f) => f.message).join("; "));
  }
  const exec = fs.readFileSync(path.join(here, "evm-executor.mjs"), "utf8");
  const resume = exec.slice(exec.indexOf("async _resume"), exec.indexOf("async _send"));
  ok("write-ahead is in the code, not only the test: markSubmitted precedes _send in _resume",
    resume.indexOf("this.journal.markSubmitted(") < resume.indexOf("await this._send("));
  ok("the returned hash is compared with the journaled hash", /lower\(returned\) !== lower\(attempt\.txHash\)/.test(exec));
  ok("nothing is disclosed on a non-current protocol", /allowCancel: false, allowSend: false/.test(exec.slice(exec.indexOf("async _resume"))));
}

/* ═══════════════════════════════════════════════════════════════════════════ */
section("BOOT (spawned): the registry gate refuses a live boot while any threshold is VOID");
{
  const dir = fs.mkdtempSync(path.join(tmp, "boot-"));
  const keyFile = path.join(dir, "burner.key");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
  const stateDb = path.join(dir, "state.sqlite");
  const base = { ...process.env, CC_SECRET: "a".repeat(64), CC_FLOOR: "50", EXECUTE: "1",
    KEY_FILE: keyFile, STATE_DB: stateDb, LOCK_FILE: `${stateDb}.lock`,
    RH_RPC: "https://primary-private-rpc.invalid", RH_RPC_SECONDARY: "https://independent-rpc.invalid",
    LIVE_TRADING_ACK: WALLET };
  const run = (extra) => spawnSync(process.execPath, [path.join(here, "poller.mjs")], { env: { ...base, ...extra }, encoding: "utf8", timeout: 20_000 });
  const init = run({ INIT_ONLY: "1", LIVE_STATE_INIT_ACK: WALLET });
  ok("INIT_ONLY binds a journal to the checksummed address without touching a provider", init.status === 0 && fs.existsSync(stateDb), init.stderr.slice(0, 300));
  const lowercase = run({ INIT_ONLY: "1", LIVE_TRADING_ACK: WALLET.toLowerCase() });
  ok("a lower-cased LIVE_TRADING_ACK is refused: the acknowledgement is the checksummed address byte for byte",
    lowercase.status !== 0 && /LIVE_TRADING_ACK must exactly equal/.test(lowercase.stderr), lowercase.stderr.slice(0, 200));
  const live = run({ SLIPPAGE_BPS: "1", MAX_PRICE_IMPACT_PCT: "99" });
  ok("a full live boot refuses at the registry, listing every VOID live threshold", live.status !== 0 && /not measured on this chain/.test(live.stderr) &&
    /exec\.slippageBps/.test(live.stderr) && /exec\.nonceReplacementHonoured/.test(live.stderr), live.stderr.slice(0, 200));
  ok("...and an env SLIPPAGE_BPS changes nothing: there is no way to supply around a VOID number", !/SLIPPAGE_BPS/.test(live.stderr + live.stdout));
  ok("...before any provider was contacted", !/RPC unreachable|eth_chainId/.test(live.stdout));
}

globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
