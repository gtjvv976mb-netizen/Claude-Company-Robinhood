import db from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { isEvmAddress, normalise, isZeroAddress, CHAIN_ID } from "./lib/address.js";

/**
 * THE TREASURY SCANNER FOR ROBINHOOD CHAIN — the ONLY writer of credit rows — plus the
 * handful of read-only JSON-RPC helpers the door and the ledger need (eth_call,
 * balanceOf, eth_getBalance). Hand-rolled ABI encoding on purpose: the calls this
 * building makes are four selectors wide, and a dependency that can build any call is a
 * dependency that can be talked into building one.
 *
 * What replaced what. On Solana the scanner walked getSignaturesForAddress for the
 * treasury's token account and read pre/post token balances out of each transaction. On
 * an EVM chain the same fact — "this wallet paid the treasury N base units" — is one
 * ERC-20 Transfer(from, to, value) log with `to` = the treasury, and eth_getLogs returns
 * every one of them for a block range in a single call. Two properties of the log make it
 * safer than the Solana read ever was:
 *
 *   1. A LOG ONLY EXISTS FOR A TRANSACTION THAT SUCCEEDED. The sequencer can drop a tx
 *      (no receipt) and ArbOS 61 compliance can void one (status 0x0, no logs, gas
 *      burned) — in both cases there is nothing here to credit, which is correct.
 *   2. `from` IS THE DEBITED ACCOUNT. Credit goes to the wallet whose balance went down,
 *      never to a relayer or msg.sender, which is the rule the Solana scanner had to
 *      reconstruct from balance deltas.
 *
 * Nothing a user can call performs an RPC request: RPC volume here is a function of
 * block height, not HTTP traffic. That was the Solana design's best property and it is
 * kept.
 *
 * Gas is never read here — this module sends nothing. RH_RPC is the server's own URL
 * (keyed provider in production); RH_RPC_SECONDARY, when set, is tried when the primary
 * fails. The public RPC 429s on batches, so every call below is a single request.
 */

export const RPC_URL = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
export const RPC_SECONDARY = process.env.RH_RPC_SECONDARY || "";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** balanceOf(address) */
const SEL_BALANCE_OF = "0x70a08231";

/* A block range per eth_getLogs. Public Arbitrum-style RPCs cap this (Alchemy: 2k blocks
   or 10k logs; the Robinhood public node's exact cap is UNMEASURED — 2000 is the
   conservative number every registry quotes for Nitro chains). At ~100 ms blocks that is
   ~200 s of chain per call, so a 20 s poll stays one call wide in steady state. */
const LOG_RANGE = Number(process.env.TREASURY_SCAN_RANGE || 2000);
/* Blocks behind the head the scanner reads to. Nitro finality is the sequencer's word
   until L1 posting; a one-block lag only guards against reading a block the node has
   not fully indexed logs for yet. */
const CONFIRMATIONS = Number(process.env.TREASURY_SCAN_CONFIRMATIONS || 1);

db.exec(`
CREATE TABLE IF NOT EXISTS scanner_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

const getState = (k) => db.prepare("SELECT value FROM scanner_state WHERE key=?").get(k)?.value ?? null;
const setState = (k, v) => db.prepare("INSERT INTO scanner_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* ── JSON-RPC, read-only ─────────────────────────────────────────────────── */

// Every method this process is allowed to send. A write method cannot be added by a
// caller because the list is closed here.
const ALLOWED = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getLogs",
  "eth_getBlockByNumber", "eth_getCode", "eth_getTransactionReceipt",
]);

async function post(endpoint, method, params, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    if (j.error) return { ok: false, error: j.error.message || String(j.error.code) };
    return { ok: true, data: j.result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** { ok, data } — never throws; a refused method throws because that is a bug, not weather. */
export async function evmRpc(method, params = [], { timeoutMs = 10_000, endpoint = null } = {}) {
  if (!ALLOWED.has(method)) throw new Error(`evmRpc refused non-read method: ${method}`);
  const primary = endpoint || RPC_URL;
  let r = await post(primary, method, params, timeoutMs);
  if (!r.ok && !endpoint && RPC_SECONDARY) r = await post(RPC_SECONDARY, method, params, timeoutMs);
  return r;
}

/* ── ABI helpers, exactly as wide as this file needs ──────────────────────── */

export const pad32 = (hex) => String(hex).replace(/^0x/, "").padStart(64, "0");
export const addressWord = (addr) => pad32(normalise(addr) ?? addr);
export const uintWord = (n) => pad32(BigInt(n).toString(16));
export const hexToBigInt = (hex) => (hex && hex !== "0x" ? BigInt(hex) : 0n);
/** The address packed into a 32-byte topic or return word. */
export const wordToAddress = (word) => "0x" + String(word).replace(/^0x/, "").slice(-40).toLowerCase();

export async function ethCall(to, data, { block = "latest", ...opts } = {}) {
  return evmRpc("eth_call", [{ to, data }, block], opts);
}

/** ERC-20 balanceOf(owner) as a BigInt in base units; { ok:false } on any RPC failure. */
export async function erc20BalanceOf(token, owner, opts = {}) {
  if (!isEvmAddress(token) || !isEvmAddress(owner)) return { ok: false, error: "bad address" };
  const r = await ethCall(token, SEL_BALANCE_OF + addressWord(owner), opts);
  if (!r.ok) return r;
  // An EOA or a non-token contract returns "0x": that is "not a token here", not zero.
  if (!r.data || r.data === "0x") return { ok: false, error: "no balanceOf at that address" };
  return { ok: true, value: hexToBigInt(r.data) };
}

/* ── the executor's wallet, read-only ─────────────────────────────────────── */
const walletBalanceCache = new Map();
/** Native ETH balance of an executor wallet. Shape mirrors what the dashboard reads:
 *  { ok, wei (decimal string), eth (number), observedAt }. wei is a string because a JS
 *  number holds 2^53 and an ETH balance in wei can pass it at ~9 ETH. */
export async function walletEthBalance(wallet, { maxAgeMs = 30_000 } = {}) {
  const w = normalise(wallet);
  if (!w) return { ok: false, error: "invalid wallet" };
  const now = Date.now();
  const cached = walletBalanceCache.get(w);
  if (cached && now - cached.observedAt <= Math.max(0, Number(maxAgeMs) || 0)) return cached;
  const r = await evmRpc("eth_getBalance", [w, "latest"], { timeoutMs: 5_000 });
  if (!r.ok || typeof r.data !== "string") return { ok: false, error: r?.error || "balance unavailable" };
  const wei = hexToBigInt(r.data);
  const result = { ok: true, wei: wei.toString(), eth: Number(wei) / 1e18, observedAt: now };
  walletBalanceCache.set(w, result);
  return result;
}

/** Several wallets → Map(lowercase → { wei, eth }). One request per wallet: the public
 *  RPC 429s JSON-RPC batches above ~10, so a batch buys nothing here. */
export async function walletEthBalances(wallets) {
  const out = new Map();
  for (const w of [...new Set((Array.isArray(wallets) ? wallets : []).map(normalise).filter(Boolean))]) {
    const r = await walletEthBalance(w);
    if (r.ok) out.set(w, { wei: r.wei, eth: r.eth });
  }
  return out;
}

/* ── the scanner ──────────────────────────────────────────────────────────── */

/* Read lazily so this module can be imported by leasing without a cycle at load. */
async function leasingCfg() {
  const l = await import("./leasing.js");
  return { token: l.TOKEN, treasury: l.TREASURY, launched: l.launched() };
}

const blockTimeCache = new Map();
async function blockTimestamp(blockNumberHex, rpc = evmRpc) {
  const hit = blockTimeCache.get(blockNumberHex);
  if (hit) return hit;
  const r = await rpc("eth_getBlockByNumber", [blockNumberHex, false]);
  const ts = r.ok && r.data?.timestamp ? Number(hexToBigInt(r.data.timestamp)) : null;
  if (ts) { blockTimeCache.set(blockNumberHex, ts); if (blockTimeCache.size > 512) blockTimeCache.delete(blockTimeCache.keys().next().value); }
  return ts;
}

/** Pull the credit-relevant facts out of one Transfer log. Pure, so it is testable. */
export function readTransferLog(log, { token, treasury }) {
  if (!log || log.removed) return null;
  if (normalise(log.address) !== normalise(token)) return null;
  const topics = log.topics || [];
  if (topics.length !== 3 || topics[0] !== TRANSFER_TOPIC) return null;
  if (wordToAddress(topics[2]) !== normalise(treasury)) return null;
  const value = hexToBigInt(log.data);
  if (value <= 0n) return null;                              // a zero-value transfer credits nobody
  const payer = wordToAddress(topics[1]);
  if (!isEvmAddress(payer) || isZeroAddress(payer)) return null;   // a mint to the treasury is not a payment
  return {
    payer, received: value,
    txHash: String(log.transactionHash || "").toLowerCase(),
    logIndex: Number(hexToBigInt(log.logIndex ?? "0x0")),
    blockNumber: Number(hexToBigInt(log.blockNumber ?? "0x0")),
  };
}

/**
 * One pass: from the stored cursor to (head - CONFIRMATIONS), in LOG_RANGE chunks.
 * The cursor advances only over ranges whose logs were fetched AND written, so a failed
 * getLogs mid-pass leaves the cursor at the last good range and the next poll re-reads
 * from there. A duplicate on re-read is refused by the credits unique index, not by us.
 */
export async function scanOnce({ head: headOverride = null, rpc = evmRpc } = {}) {
  const { token, treasury, launched } = await leasingCfg();
  if (!treasury) return { ok: false, error: "TREASURY_OWNER_RH not set" };
  if (!launched) return { ok: false, error: "token not launched yet (CLAUDECO_RH_TOKEN is the zero placeholder)" };

  let head = headOverride;
  if (head == null) {
    const h = await rpc("eth_blockNumber", []);
    if (!h.ok) return { ok: false, error: h.error };
    head = Number(hexToBigInt(h.data));
  }
  const to = head - CONFIRMATIONS;

  /* FIRST RUN STARTS AT THE HEAD. A brand-new deployment must not walk 54 million
     blocks of history to find nothing; TREASURY_SCAN_FROM_BLOCK exists for the day the
     treasury is set AFTER payments were already made. */
  let cursor = getState("last_block");
  if (cursor == null) {
    cursor = Number(process.env.TREASURY_SCAN_FROM_BLOCK || to);
    setState("last_block", cursor);
  }
  cursor = Number(cursor);
  if (to <= cursor) return { ok: true, scanned: 0, credited: 0, from: cursor, to };

  let credited = 0, scanned = 0;
  const treasuryTopic = "0x" + addressWord(treasury);
  /* A range that ever matches more than the node's log cap (10,000 on the public RPC)
     used to be retried unchanged every 20 s forever, and no payment landed again. On
     that error the range halves until the node answers (review, 2026-09-05). */
  const isLogCap = (err) => /more than|exceed|too many|limit|10,?000/i.test(String(err ?? ""));
  let size = LOG_RANGE;
  for (let from = cursor + 1; from <= to; from += size) {
    let upto = Math.min(to, from + size - 1);
    let r = await rpc("eth_getLogs", [{
      address: token,
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + upto.toString(16),
      topics: [TRANSFER_TOPIC, null, treasuryTopic],
    }]);
    while (!r.ok && isLogCap(r.error) && size > 16) {
      size = Math.max(16, size >> 1);
      upto = Math.min(to, from + size - 1);
      r = await rpc("eth_getLogs", [{ address: token, fromBlock: "0x" + from.toString(16), toBlock: "0x" + upto.toString(16),
        topics: [TRANSFER_TOPIC, null, treasuryTopic] }]);
    }
    if (!r.ok) return { ok: false, error: r.error, credited, scanned, partial: true, from, to };
    for (const log of r.data || []) {
      scanned++;
      const found = readTransferLog(log, { token, treasury });
      if (!found) continue;
      const blockTime = await blockTimestamp("0x" + found.blockNumber.toString(16), rpc);
      try {
        db.prepare(`INSERT INTO credits (signature,dest_account,log_index,wallet,base_units,slot,block_time,seen_at)
                    VALUES (?,?,?,?,?,?,?,?)`)
          .run(found.txHash, normalise(treasury), found.logIndex, found.payer, found.received.toString(),
               found.blockNumber, blockTime, Date.now());
        credited++;
        emit("credit", { wallet: found.payer, baseUnits: found.received.toString(), signature: found.txHash, chain: CHAIN_ID });
      } catch (e) {
        if (!/UNIQUE/i.test(String(e.message))) throw e;   // duplicate = already credited
      }
    }
    setState("last_block", upto);
  }
  return { ok: true, scanned, credited, from: cursor + 1, to };
}

let timer = null;
export function startScanner({ intervalMs = 20_000 } = {}) {
  const treasury = process.env.TREASURY_OWNER_RH || "";
  if (!treasury) { console.log("[treasury-evm] TREASURY_OWNER_RH not set — leasing is closed"); return; }
  if (timer) return;
  const tick = async () => {
    try {
      const r = await scanOnce();
      if (r.ok && r.credited) console.log(`[treasury-evm] credited ${r.credited} payment(s) in blocks ${r.from}-${r.to}`);
      if (!r.ok) console.log(`[treasury-evm] ${r.error}`);
    } catch (e) { console.log(`[treasury-evm] ${e.message}`); }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  console.log(`[treasury-evm] watching treasury ${treasury.slice(0, 8)}… on chain ${CHAIN_ID} every ${intervalMs / 1000}s`);
}
export function stopScanner() { if (timer) clearInterval(timer); timer = null; }
