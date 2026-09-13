/**
 * ONE REAL ROUND TRIP, ON PURPOSE — and the only way three of this desk's numbers can
 * ever be measured.
 *
 * exec.inclusionLatencyMs, exec.dropRatePct and exec.nonceReplacementHonoured are facts
 * about what the sequencer does with a transaction from THIS wallet. No read-only probe
 * can produce them (probe-measure-4663.mjs says so in its own header), and while they
 * were registered as live-path thresholds the executor refused to arm until they were
 * measured — a gate that needs a send in order to open, guarding sends. They are now
 * `canary` in the registry, and this script is how they get answered: a funded burner
 * sends a 0-value self-transfer, then buys and sells one token, through the SAME
 * EvmExecutor the poller uses, into a SEPARATE journal.
 *
 * The Solana desk did exactly this before its first call ("30 mainnet transactions say
 * the bytes are right") and its live-roundtrip-test.mjs is this file's parent, including
 * the two things it got wrong first and wrote down: the separate journal (so a supervised
 * poller is never handed a position it did not decide to take) and importing the
 * production ceilings rather than inventing kinder ones here.
 *
 * WHAT IT DOES, IN ORDER
 *   1. Proves chain 4663 on both providers and reads the wallet's balance.
 *   2. Sends N 0-value self-transfers (default 5), timing submit → receipt on both
 *      providers. This is the latency and drop sample and it costs 21,000 gas each —
 *      about $0.00001 at the measured gas price.
 *   3. Optionally (TEST_TOKEN set) buys TEST_ETH of one token and sells all of it back,
 *      through the real gates: scope guard, ERC-20 hazards, price impact, the calldata
 *      floor, the eth_call simulation, the two-provider receipt.
 *   4. Prints the round trip's real cost and pasteable M(date, method) lines with the
 *      transaction hashes as the method, for live-thresholds.mjs.
 *
 * WHAT IT REFUSES. No key file, no two independent providers, a wallet that cannot cover
 * the trade plus the fee ceiling, or a TEST_TOKEN the scope guard rejects: it stops
 * before signing anything. It never touches the poller's journal and never reads the
 * desk's feed.
 *
 *   KEY_FILE=./burner.key RH_RPC=... RH_RPC_SECONDARY=... \
 *   LIVE_ROUNDTRIP_ACK=<checksummed burner address> \
 *   TEST_TOKEN=0x… TEST_ETH=0.0112 node live-roundtrip-4663.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import { ExecutionJournal, NATIVE_ASSET, acquireProcessLock, weiToEth } from "./journal.mjs";
import { EvmExecutor, walletFromKeyFile, summariseSendStats } from "./evm-executor.mjs";
import { createRpc, proveChain, balanceOnBoth, gasPriceConsensus, headConsensus,
  receiptConsensus, latestNonces, isAddress, hex } from "./evm-rpc.mjs";
import { threshold } from "./thresholds.mjs";
import "./live-thresholds.mjs";
import { classifyToken, SELECTOR_NAME, assertNotAccessToken } from "./scope-guard.mjs";

const CHAIN_ID = 4663;
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";
const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString(), "ROUNDTRIP", ...a);
const die = (m) => { console.error(new Date().toISOString(), "ROUNDTRIP REFUSES:", m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY_FILE = path.resolve(process.env.KEY_FILE || "./burner.key");
/* A JOURNAL OF ITS OWN. The poller's journal is the record of positions it decided to
   take; a probe's fill in it is a position nobody decided on, which the Solana desk
   learned by having to write close-out.mjs afterwards. */
const STATE_DB = path.resolve(process.env.ROUNDTRIP_DB || "./.roundtrip-4663.sqlite");
const SELF_SENDS = Math.max(0, Math.min(20, Number(process.env.SELF_SENDS ?? 5)));
const TEST_TOKEN = process.env.TEST_TOKEN || "";
const TEST_ETH = process.env.TEST_ETH || String(threshold("size.cheapestClipEth").value);

if (!fs.existsSync(KEY_FILE)) die(`no key file at ${KEY_FILE}`);
if (!process.env.RH_RPC || !process.env.RH_RPC_SECONDARY)
  die("two independent HTTPS providers are required: RH_RPC and RH_RPC_SECONDARY");
const wallet = walletFromKeyFile(KEY_FILE, { fs, requirePrivate: true,
  uid: typeof process.getuid === "function" ? process.getuid() : null });
const WALLET = getAddress(wallet.address);
/* The same shape of acknowledgement the poller demands, for the same reason: this script
   spends real money, and retyping the address is the moment a person confirms WHICH
   wallet is about to spend it. */
if (process.env.LIVE_ROUNDTRIP_ACK !== WALLET)
  die(`LIVE_ROUNDTRIP_ACK must exactly equal this burner's checksummed address: ${WALLET}`);
if (TEST_TOKEN && !isAddress(TEST_TOKEN)) die("TEST_TOKEN is not an address");

const primary = createRpc(process.env.RH_RPC, { label: "primary RPC" });
const secondary = createRpc(process.env.RH_RPC_SECONDARY, { label: "secondary RPC" });
const providers = [primary, secondary];

await proveChain(providers);
log(`chain ${CHAIN_ID} proved on both providers; wallet ${WALLET}`);

if (TEST_TOKEN) {
  assertNotAccessToken(TEST_TOKEN);
  const verdict = await classifyToken(TEST_TOKEN,
    (a, slot) => primary("eth_getStorageAt", [a, slot, "latest"]),
    (a) => primary("eth_call", [{ to: a, data: SELECTOR_NAME }, "latest"]));
  if (!verdict.tradeable) die(`scope guard: ${verdict.reason}`);
}

const releaseLock = acquireProcessLock(`${STATE_DB}.lock`);
const journal = new ExecutionJournal(STATE_DB, { wallet: WALLET, create: true });
process.on("exit", releaseLock);

const feeCeiling = BigInt(threshold("exec.maxNetworkFeeWei").value);
const executor = new EvmExecutor({
  providers, wallet, journal, log,
  config: {
    slippageBps: threshold("exec.slippageBps").value,
    maxPriceImpactPct: threshold("exec.maxPriceImpactPct").value,
    maxExitPriceImpactPct: 50,
    maxNetworkFeeWei: feeCeiling.toString(),
  },
});

const balances = await balanceOnBoth(providers, WALLET);
const gas = await gasPriceConsensus(providers);
log(`balance ${weiToEth(balances[0]).toFixed(6)} ETH on both providers; gas ${(Number(gas.max) / 1e9).toFixed(4)} gwei`);

/* ── 1. THE SELF-TRANSFERS: latency, and whether anything is dropped ─────────── */
const samples = [];
for (let i = 1; i <= SELF_SENDS; i++) {
  const [nonceA, nonceB] = await latestNonces(providers, WALLET);
  if (nonceA !== nonceB) { log(`providers disagree on the nonce (${nonceA} vs ${nonceB}); waiting`); await sleep(2_000); continue; }
  const head = await headConsensus(providers);
  const maxFeePerGas = gas.max * 2n;
  const worstFee = 21_000n * maxFeePerGas;
  if (worstFee > feeCeiling) die(`a 21,000-gas self-transfer would cost up to ${worstFee} wei, above the ${feeCeiling} wei ceiling`);
  const tx = await wallet.signTransaction({
    type: 2, chainId: CHAIN_ID, nonce: nonceA, to: WALLET, value: 0n, data: "0x",
    gasLimit: 21_000n, maxFeePerGas, maxPriorityFeePerGas: 0n,
  });
  const sentAt = Date.now();
  let hash;
  try { hash = await primary("eth_sendRawTransaction", [tx]); }
  catch (error) { log(`send ${i}: refused by the node (${error.message})`); samples.push({ i, outcome: "refused" }); continue; }
  /* Poll BOTH providers, as the executor does: one provider's receipt is an observation,
     never a fact. Past the deadline with no receipt on either, this is a real drop. */
  const deadline = sentAt + 60_000;
  let receipt = null;
  while (Date.now() < deadline) {
    const seen = await receiptConsensus(providers, hash);
    if (seen.agreed) { receipt = seen.agreed; break; }
    await sleep(250);
  }
  if (receipt) {
    const latencyMs = Date.now() - sentAt;
    samples.push({ i, outcome: receipt.status === "0x1" ? "confirmed" : "reverted", latencyMs, hash,
      block: Number(receipt.blockNumber), sentAtBlock: head.low });
    log(`send ${i}: ${receipt.status === "0x1" ? "confirmed" : "REVERTED"} in ${latencyMs}ms — ${EXPLORER}${hash}`);
  } else {
    samples.push({ i, outcome: "dropped", latencyMs: null, hash });
    log(`send ${i}: NO RECEIPT on either provider after 60s — the sequencer dropped it; ${EXPLORER}${hash}`);
  }
  await sleep(500);
}

const done = samples.filter((s) => s.outcome !== "refused");
const latencies = done.map((s) => s.latencyMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
const q = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.round((latencies.length - 1) * p))] : null;
const dropped = done.filter((s) => s.outcome === "dropped").length;

/* ── 2. THE ROUND TRIP, through the real executor and the real gates ─────────── */
let entry = null, exit = null;
if (TEST_TOKEN) {
  const amountWei = BigInt(Math.round(Number(TEST_ETH) * 1e6)) * 10n ** 12n;
  if (amountWei <= 0n) die("TEST_ETH must be positive");
  const need = amountWei + feeCeiling * 4n;
  if (balances.some((b) => b < need))
    die(`the wallet holds ${weiToEth(balances[0]).toFixed(6)} ETH; this needs ${weiToEth(need).toFixed(6)} (the clip plus four fee ceilings)`);
  log(`buying ${TEST_ETH} ETH of ${TEST_TOKEN} through the production gates`);
  entry = await executor.executeIntent({
    id: `roundtrip:buy:${Date.now()}`, kind: "entry", eventId: null, feedId: null,
    mint: TEST_TOKEN, inputMint: NATIVE_ASSET, outputMint: TEST_TOKEN,
    amountRaw: amountWei.toString(),
    context: { probe: "live-roundtrip-4663", openedAtMs: Date.now() },
  });
  log(`BOUGHT ${entry.actualOutputRaw} raw for ${entry.actualInputRaw} wei — ${EXPLORER}${entry.txHash}`);
  await sleep(2_000);
  log("selling all of it straight back");
  exit = await executor.executeIntent({
    id: `roundtrip:sell:${Date.now()}`, kind: "risk_exit", eventId: null, feedId: null,
    mint: TEST_TOKEN, inputMint: TEST_TOKEN, outputMint: NATIVE_ASSET,
    amountRaw: String(entry.actualOutputRaw),
    context: { probe: "live-roundtrip-4663", fraction: 1,
      position: { mint: TEST_TOKEN, qtyRaw: String(entry.actualOutputRaw),
        costBasisWei: (BigInt(entry.actualInputRaw) + BigInt(entry.networkFeeWei)).toString(),
        entryInputWei: String(entry.actualInputRaw) } },
  });
  const spent = BigInt(entry.actualInputRaw) + BigInt(entry.networkFeeWei);
  const back = BigInt(exit.actualOutputRaw) - BigInt(exit.networkFeeWei);
  const lossPct = Number((spent - back) * 1_000_000n / spent) / 10_000;
  log(`SOLD for ${exit.actualOutputRaw} wei — ${EXPLORER}${exit.txHash}`);
  log(`ROUND TRIP: ${weiToEth(spent).toFixed(6)} ETH out, ${weiToEth(back).toFixed(6)} ETH back — ${lossPct.toFixed(3)}% all in, ` +
    `gas ${weiToEth(BigInt(entry.networkFeeWei) + BigInt(exit.networkFeeWei)).toFixed(6)} ETH across both legs`);
}

/* ── 3. THE PASTEABLE LINES ──────────────────────────────────────────────────── */
const stats = summariseSendStats(journal.getMeta("send_stats"));
const hashes = done.filter((s) => s.hash).map((s) => s.hash.slice(0, 12)).join(", ");
console.log(`\n${"─".repeat(78)}\nMEASURED. Paste into live-thresholds.mjs, replacing the CANARY entry of the same name.\n`);
if (latencies.length) {
  console.log(`export const INCLUSION_LATENCY_MS = defineThreshold("exec.inclusionLatencyMs", ${q(0.5)},
  { ...M("${today}", "${done.length} real sends from the burner, submit → receipt agreed on both providers: " +
    "median ${q(0.5)}ms, p90 ${q(0.9)}ms, max ${latencies.at(-1)}ms (${hashes})"),
    unit: "ms", live: false });\n`);
  console.log(`export const DROP_RATE_PCT = defineThreshold("exec.dropRatePct", ${(dropped / done.length * 100).toFixed(2)},
  { ...M("${today}", "${dropped} of ${done.length} real sends never received a receipt on either provider inside 60s"),
    unit: "%", live: false });\n`);
} else {
  console.log("  (no send completed, so no latency or drop rate is claimed)\n");
}
console.log(stats.nonceReplacementHonoured === null
  ? "  exec.nonceReplacementHonoured: nothing was dropped, so no same-nonce replacement was ever needed — UNMEASURED, and that is the honest answer.\n"
  : `export const NONCE_REPLACEMENT_HONOURED = defineThreshold("exec.nonceReplacementHonoured", ${stats.nonceReplacementHonoured},
  { ...M("${today}", "a dropped nonce was replaced by a same-nonce cancel and ${stats.nonceReplacementHonoured ? "the cancel landed" : "the cancel was also dropped"}"),
    live: false });\n`);
console.log(`  journal send_stats: ${JSON.stringify(stats)}`);
console.log(`  the journal is at ${STATE_DB} — it is NOT the poller's, and any position it holds is this probe's\n`);

journal.close();
releaseLock();
