/**
 * WALL-ST-E — CLAUDE COMPANY'S SELF-HOSTED POLLING EXECUTOR, ROBINHOOD CHAIN EDITION
 *
 * Default: paper decisions. EXECUTE=1 enables real swaps on chain 4663 only after
 * every local gate below passes. The central desk remains keyless: this process polls
 * a read-only feed and signs with a dedicated burner key that never leaves this
 * machine. First startup primes at the latest feed id and never replays old calls.
 *
 * What changed from the Solana build, and where each change lives:
 *   - the chain gate is eth_chainId === 0x1237 on BOTH providers (proveChainOrWait)
 *   - the key is a 0600 32-byte hex file, and LIVE_TRADING_ACK is its checksummed
 *     address (walletFromKeyFile)
 *   - caps are ETH and parsed as wei with BigInt (plainEthUnits / ethCap)
 *   - slippage, impact and the network-fee GATE come from the thresholds registry
 *     and NOT from the environment — a VOID threshold refuses to arm (assertLiveReady)
 *   - the expected network fee (the COST MODEL) is gas × gwei read live, never a
 *     constant, so the gate and the model can never be the same number again
 *   - the feed must say chain 4663; the executor is evm-executor.mjs; the USD anchor
 *     is Chainlink's ETH/USD feed read through both providers (eth-usd-oracle.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import {
  ExecutionJournal, LEGACY_CALL_IDENTITY_POLICY, NATIVE_ASSET, acquireProcessLock,
  deskExitDecisionForPosition, positionEntryBlock, requirePositiveCallId, validateRiskState,
  weiToEth,
} from "./journal.mjs";
import { EvmExecutor, EXECUTION_READINESS_ROUTE, walletFromKeyFile } from "./evm-executor.mjs";
import { createRpc, erc20Balance, gasPriceConsensus, isAddress, fromHex, plainEthUnits } from "./evm-rpc.mjs";
import "./live-thresholds.mjs";
import { assertLiveReady, threshold } from "./thresholds.mjs";
import {
  RpcBalanceUnavailableError, verifyTrackedBalanceWithFailover,
} from "./balance-verification.mjs";
import {
  advanceFrozenBatchCursor, authenticatedFeedCursorState, waitForRecoveryBudget,
} from "./feed-drain.mjs";
import {
  clearExitMarkFailureWitness, clearPriceExitWitness, confirmExitMarkFailureWitness,
  confirmPriceExitWitness, executableExitMark, priceExitTrigger,
} from "./exit-trigger.mjs";
import { executorHeartbeatHealth, executorRuntimeFingerprint } from "./heartbeat-health.mjs";
import { validateEntryPreflightContext } from "./entry-quote-guard.mjs";
import {
  inspectOwnerControlFile, requireMacEntryPower, sleepAssertionFaultPath,
} from "./sleep-assertion.mjs";
import {
  independentEthUsdPrice, ETH_USD_CACHE_SOURCE, ETH_USD_ORACLE_POLICY, usableEthUsdCache,
} from "./eth-usd-oracle.mjs";
import { DEFAULTS, planEntry, openPosition, stepPosition, freshState } from "./strategy.mjs";
import { policyConfigForPosition, resolveTakeProfitRule, validateEntryReference } from "./trade-policy.mjs";

process.umask(0o077);

const API = (process.env.CC_API || "https://claude-company-robinhood-api.onrender.com").replace(/\/$/, "");
const SECRET = process.env.CC_SECRET || "";
const FLOOR = process.env.CC_FLOOR || "";
const EXECUTE = process.env.EXECUTE === "1";
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const FEE_RESERVE = Number(process.env.FEE_RESERVE_ETH || 0.001);
const MAX_CALL_AGE_MS = Number(process.env.MAX_CALL_AGE_MIN || 45) * 60_000;
const MAX_FUTURE_SKEW_MS = Number(process.env.MAX_FUTURE_SKEW_MIN || 5) * 60_000;
const MAX_ENTRY_MARK_AGE_MS = Number(process.env.MAX_ENTRY_MARK_AGE_MIN || 15) * 60_000;
const MAX_ENTRY_DEVIATION_PCT = Number(process.env.MAX_ENTRY_DEVIATION_PCT || 10);
export const PUBLIC_RPC_HOST = "rpc.mainnet.chain.robinhood.com";
/* Every host the chain operator runs, not just the one public URL. `sequencer.mainnet.
   chain.robinhood.com` is a DIFFERENT hostname on the SAME infrastructure: a plain
   hostname-inequality test accepts it as the "independent" second provider and the
   ETH/USD cross-check then asks one operator to check itself. Measured 2026-09-05:
   rpc.mainnet.chain.robinhood.com is a CNAME to customer-origin.offchainlabs.com. */
export const CHAIN_OPERATOR_SUFFIX = "chain.robinhood.com";
/* Two subdomains of one provider are one provider (a.alchemy.com / b.alchemy.com), so
   independence is judged on the registrable domain, not the full hostname. Naive eTLD+1
   with the few two-part suffixes that would otherwise collapse to a public suffix. */
const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "co.nz", "com.br", "co.in", "com.sg"]);
export function registrableDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}
export const isChainOperatorHost = (host) =>
  host === CHAIN_OPERATOR_SUFFIX || String(host || "").endsWith("." + CHAIN_OPERATOR_SUFFIX);
const RPC = process.env.RH_RPC || `https://${PUBLIC_RPC_HOST}`;
const SECONDARY_RPC = process.env.RH_RPC_SECONDARY || "";
const KEY_FILE = path.resolve(process.env.KEY_FILE || "./burner.key");
const STATE_DB = path.resolve(process.env.STATE_DB || "./.cc-executor.sqlite");
const LOCK_FILE = path.resolve(process.env.LOCK_FILE || `${STATE_DB}.lock`);
const PAUSE_ENTRIES_FILE = path.resolve(process.env.PAUSE_ENTRIES_FILE || `${STATE_DB}.pause-entries`);
const HARD_STOP_FILE = path.resolve(process.env.HARD_STOP_FILE || `${STATE_DB}.hard-stop`);
const SLEEP_ASSERTION_FAULT_FILE = sleepAssertionFaultPath(LOCK_FILE);
// Compute once, before the loop starts. A release changed on disk without restarting
// cannot make an old in-memory process impersonate the newly published runtime.
const RUNTIME_FINGERPRINT = executorRuntimeFingerprint(path.dirname(fileURLToPath(import.meta.url)));
const CHAIN_ID_HEX = "0x1237";
export const CHAIN_ID = 4663;
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";
// newest floor verdict already logged; verdicts older than this are not repeated
let lastDecisionSeen = Date.now() - 6 * 3600e3;

/* THE LIVE CEILINGS, IN ETH.
 *
 * These are the ETH translation of the owner's SOL numbers at $2,450/ETH and ~$196/SOL
 * (0.005 SOL → 0.0004 ETH, and so on) — the same translation that produced the house
 * seed of 0.05 / 0.016 ETH in the feed contract — and they are MARKED AS AWAITING OWNER
 * CONFIRMATION: nobody has decided what a canary is worth on this chain, only what the
 * old one was worth in dollars. Two things are known to be different here and both
 * argue the canary is too small, not too large: gas is FLAT (a $0.54 round trip is 54%
 * of a 0.0004 ETH clip and 0.4% of a 0.05 ETH one, live-thresholds.mjs), and the
 * deep-pool round trip is two orders of magnitude cheaper than Solana's. Raising them
 * is the caps ceremony below, exactly as before. */
const LIVE_LIMITS = Object.freeze({
  maxEthPerTrade: 0.0004,
  dailyEthCap: 0.0008,
  dailyLossLimitEth: 0.0008,
  maxOpenPositions: 4,
  maxExitPriceImpactPct: 50,
  maxEntryRoundTripLossPct: 12,
  maxEntryQuoteDriftPct: 5,
  maxEntryPreflightAgeMs: 60_000,
  maxExitTriggerAgeMs: 60_000,
  /* The oracle cache window equals the feed's own staleness policy. The Solana build
     kept 30 minutes because Pyth pushed every minute and a day-old SOL rate could be
     20% wrong; Chainlink's ETH/USD here updates on 0.5% deviation OR 24h, so any
     answer inside the policy window is within 0.5% of the truth by construction and a
     tighter cache window would only disarm stops during an RPC outage. */
  ethUsdCacheMaxAgeMs: ETH_USD_ORACLE_POLICY.maxAgeMs,
  maxAttempts: 3,
  maxExitAttempts: 12,
  /* Blocks after the proving block by which a submitted transaction must have a
     receipt, or it is treated as dropped and cancelled. ~30s at 100ms blocks. A guess
     until exec.inclusionLatencyMs is measured (live-thresholds.mjs); bounded so an
     operator cannot stretch it into "wait forever". */
  deadlineBlocks: 300,
  receiptTimeoutMs: 30_000,
});
const log = (...args) => console.log(new Date().toISOString(), "WALL-ST-E", ...args);
const fatal = (message) => { console.error(new Date().toISOString(), "WALL-ST-E REFUSES:", message); process.exit(1); };

// One durable journal has exactly one lock identity. Allowing LOCK_FILE to point
// elsewhere lets two differently configured pollers mutate the same SQLite state.
if (LOCK_FILE !== `${STATE_DB}.lock`)
  fatal("LOCK_FILE must be the canonical STATE_DB lock (STATE_DB plus .lock)");

const number = (name, value, { min = 0, max = Infinity } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fatal(`${name} must be between ${min} and ${max}`);
  return n;
};
/* ETH caps are parsed as WEI, exactly. A double cannot hold 18 decimals and a cap that
   rounds onto a permitted boundary is a cap that was never checked. */
const ethCap = (name, value, { min, max }) => {
  const raw = String(value);
  const units = plainEthUnits(raw);
  if (units === null)
    fatal(`${name} must be a plain decimal with at most 18 fractional digits`);
  const minUnits = plainEthUnits(min);
  const maxUnits = plainEthUnits(max);
  if (units < minUnits || units > maxUnits)
    fatal(`${name} must be between ${min} and ${max}`);
  return Object.freeze({ raw, units, value: Number(units) / 1e18 });
};
const ethToWei = (eth) => {
  // Six decimals of ETH is a micro-ETH: enough for a cap, exact in BigInt.
  const micro = BigInt(Math.floor(Number(eth) * 1e6 + 1e-9));   // floor: never round UP past a cap
  if (micro <= 0n) throw new Error("amount rounds to zero");
  return micro * 10n ** 12n;
};
const openPositions = (value) => {
  const raw = String(value);
  if (!/^[1-4]$/.test(raw))
    fatal("MAX_OPEN_POSITIONS must be an integer between 1 and 4");
  return Number(raw);
};

if (!SECRET || !/^\d+$/.test(FLOOR) || Number(FLOOR) <= 0) fatal("CC_SECRET and a positive CC_FLOOR are required");
/* HTTPS always — with one carve-out that cannot weaken live. A loopback API lets a
 * full dry-run rehearsal run against a local office process (the only way to test the
 * feed contract end-to-end without touching production). Loopback traffic never
 * crosses a network, so there is nothing for TLS to protect; any OTHER plain-HTTP
 * host still refuses, and EXECUTE=1 refuses plain HTTP unconditionally — a live
 * canary has no business on a rehearsal feed. */
{
  let apiHost = "";
  try { apiHost = new URL(API).hostname; } catch { fatal("CC_API is not a valid URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiHost);
  if (!API.startsWith("https://") && !(loopback && !EXECUTE))
    fatal(EXECUTE ? "live execution requires an HTTPS CC_API — no loopback carve-out"
                  : "CC_API must use HTTPS (plain HTTP is allowed only for loopback dry-run rehearsals)");
}
if (!fs.existsSync(KEY_FILE)) fatal(`no key file at ${KEY_FILE}`);

function loadWallet() {
  try {
    return walletFromKeyFile(KEY_FILE, { fs, requirePrivate: EXECUTE,
      uid: EXECUTE && typeof process.getuid === "function" ? process.getuid() : null });
  } catch (error) { fatal(error.message); }
}

const wallet = loadWallet();
/* The checksummed address is the wallet's one public name; LIVE_TRADING_ACK must equal
   it byte for byte, so a lower-cased paste is refused on purpose. */
const WALLET = getAddress(wallet.address);
const controlActive = (file, label) => inspectOwnerControlFile(file, { label }).present;
const pauseEntries = () => controlActive(PAUSE_ENTRIES_FILE, "entry-pause sentinel") ||
  controlActive(SLEEP_ASSERTION_FAULT_FILE, "sleep assertion fault latch");
const hardStop = () => controlActive(HARD_STOP_FILE, "hard-stop sentinel");
const assertEntriesUnpaused = () => {
  const pause = inspectOwnerControlFile(PAUSE_ENTRIES_FILE, { label: "entry-pause sentinel" });
  if (pause.present) throw new Error(pause.valid
    ? "PAUSE ENTRIES file appeared before submission"
    : `PAUSE ENTRIES control is unsafe (${pause.reason})`);
  const fault = inspectOwnerControlFile(SLEEP_ASSERTION_FAULT_FILE, {
    label: "sleep assertion fault latch",
  });
  if (fault.present) throw new Error(fault.valid
    ? "sleep assertion fault is latched; explicit operator repair and review are required"
    : `sleep assertion fault latch is unsafe (${fault.reason})`);
};

const rpcHost = (url, label) => {
  let parsed;
  try { parsed = new URL(url); } catch { fatal(`${label} must be a valid HTTPS URL`); }
  if (parsed.protocol !== "https:") fatal(`${label} must use HTTPS`);
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
};

if (EXECUTE) {
  if (process.env.LIVE_TRADING_ACK !== WALLET)
    fatal(`LIVE_TRADING_ACK must exactly equal this burner's checksummed address: ${WALLET}`);
  if (!process.env.RH_RPC || !RPC.startsWith("https://")) fatal("live execution requires an explicit private HTTPS RH_RPC");
  if (!process.env.RH_RPC_SECONDARY)
    fatal("live execution requires an explicit independent RH_RPC_SECONDARY");
  const primaryHost = rpcHost(RPC, "RH_RPC");
  const secondaryHost = rpcHost(SECONDARY_RPC, "RH_RPC_SECONDARY");
  /* The public endpoint 429s on batches larger than ~10 and is shared with every bot
     on the chain; an absence proof built on it is an absence proof built on a coin
     toss. Two private providers on different hostnames, or no live mode. */
  if (isChainOperatorHost(primaryHost) || isChainOperatorHost(secondaryHost))
    fatal("the rate-limited public Robinhood Chain RPC is not accepted for either live endpoint");
  if (primaryHost === secondaryHost || registrableDomain(primaryHost) === registrableDomain(secondaryHost))
    fatal("RH_RPC_SECONDARY must use an independent provider hostname");
  const legacy = path.resolve(process.env.STATE_FILE || "./.cc-state.json");
  if (fs.existsSync(legacy)) {
    let old;
    try { old = JSON.parse(fs.readFileSync(legacy, "utf8")); }
    catch { fatal(`legacy state is unreadable: ${legacy}`); }
    if (Object.keys(old?.positions || {}).length)
      fatal(`legacy JSON contains unproven positions; reconcile them manually before live mode (${legacy})`);
  }
  if (!fs.existsSync(STATE_DB) && process.env.LIVE_STATE_INIT_ACK !== WALLET)
    fatal(`live journal is missing; initialize it once with LIVE_STATE_INIT_ACK=${WALLET} and INIT_ONLY=1`);
} else if (SECONDARY_RPC) {
  rpcHost(SECONDARY_RPC, "RH_RPC_SECONDARY");
}

/* ── OPERATOR-RAISED LIVE CAPS ────────────────────────────────────────────────
 * The canary ceilings stay the default and env can still only LOWER them; raising is
 * possible and deliberately awkward. All three money caps must be set explicitly, and
 * LIVE_CAPS_ACK must be the current versioned sentence naming THIS wallet and THESE
 * numbers; change one and it stops matching. The v3 wording (ETH, checksummed
 * address) revokes every SOL-era acknowledgement: a retained Solana environment
 * cannot regain authority over an ETH wallet. maxOpenPositions stays frozen because
 * it multiplies every other cap. */
const OPERATOR_MAX = Object.freeze({ maxEthPerTrade: 0.004, dailyEthCap: 0.04, dailyLossLimitEth: 0.012 });
const capsAckSentence = (wallet, trade, daily, loss) =>
  `I acknowledge WALL-ST-E caps v3 for ${wallet}: ${trade} ETH per trade, ${daily} ETH per day, ${loss} ETH rolling realized-loss entry brake`;

let LIVE_CEILINGS = LIVE_LIMITS;
if (EXECUTE) {
  const req = {
    trade: process.env.MAX_ETH_PER_TRADE,
    daily: process.env.DAILY_ETH_CAP,
    loss: process.env.DAILY_LOSS_LIMIT_ETH,
  };
  const requested = {
    trade: req.trade == null ? null : ethCap("MAX_ETH_PER_TRADE", req.trade,
      { min: 0.000001, max: OPERATOR_MAX.maxEthPerTrade }),
    daily: req.daily == null ? null : ethCap("DAILY_ETH_CAP", req.daily,
      { min: 0.000001, max: OPERATOR_MAX.dailyEthCap }),
    loss: req.loss == null ? null : ethCap("DAILY_LOSS_LIMIT_ETH", req.loss,
      { min: 0.000001, max: OPERATOR_MAX.dailyLossLimitEth }),
  };
  const wantsRaise =
    (requested.trade && requested.trade.units > plainEthUnits(LIVE_LIMITS.maxEthPerTrade)) ||
    (requested.daily && requested.daily.units > plainEthUnits(LIVE_LIMITS.dailyEthCap)) ||
    (requested.loss && requested.loss.units > plainEthUnits(LIVE_LIMITS.dailyLossLimitEth));
  if (wantsRaise) {
    if (!requested.trade || !requested.daily || !requested.loss)
      fatal("raising any live cap requires ALL THREE set explicitly: MAX_ETH_PER_TRADE, " +
        "DAILY_ETH_CAP, DAILY_LOSS_LIMIT_ETH — a partial raise hides the numbers the " +
        "acknowledgement exists to make you look at");
    if (requested.daily.units < requested.trade.units)
      fatal(`DAILY_ETH_CAP (${requested.daily.value}) is below MAX_ETH_PER_TRADE (${requested.trade.value}) — the day would refuse the first trade`);
    const expected = capsAckSentence(WALLET, requested.trade.raw,
      requested.daily.raw, requested.loss.raw);
    if ((process.env.LIVE_CAPS_ACK || "") !== expected)
      fatal("raised live caps need a typed acknowledgement. Set LIVE_CAPS_ACK to exactly:\n\n    " + expected + "\n");
    LIVE_CEILINGS = Object.freeze({ ...LIVE_LIMITS,
      maxEthPerTrade: requested.trade.value,
      dailyEthCap: requested.daily.value,
      dailyLossLimitEth: requested.loss.value });
    log(`OPERATOR-RAISED CAPS acknowledged: ${requested.trade.value} ETH/trade, ${requested.daily.value} ETH/day deploy, ${requested.loss.value} ETH rolling realized-loss entry brake ` +
      `(hard maxima ${OPERATOR_MAX.maxEthPerTrade}/${OPERATOR_MAX.dailyEthCap}/${OPERATOR_MAX.dailyLossLimitEth} are a code change, by design)`);
  }
}

/* Paper defaults are the Solana strategy engine's numbers scaled to ETH; they size
   PAPER decisions only and never reach a signature. */
const PAPER_DEFAULTS = Object.freeze({ maxEthPerTrade: 0.004, dailyEthCap: 0.04, dailyLossLimitEth: 0.012, fixedEth: 0.0016 });
const configuredTradeCap = ethCap("MAX_ETH_PER_TRADE",
  process.env.MAX_ETH_PER_TRADE ?? (EXECUTE ? LIVE_CEILINGS.maxEthPerTrade : PAPER_DEFAULTS.maxEthPerTrade),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.maxEthPerTrade : 100 });
const configuredDailyCap = ethCap("DAILY_ETH_CAP",
  process.env.DAILY_ETH_CAP ?? (EXECUTE ? LIVE_CEILINGS.dailyEthCap : PAPER_DEFAULTS.dailyEthCap),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailyEthCap : 1000 });
const configuredLossCap = ethCap("DAILY_LOSS_LIMIT_ETH",
  process.env.DAILY_LOSS_LIMIT_ETH ?? (EXECUTE ? LIVE_CEILINGS.dailyLossLimitEth : PAPER_DEFAULTS.dailyLossLimitEth),
  { min: 0.000001, max: EXECUTE ? LIVE_CEILINGS.dailyLossLimitEth : 1000 });
/* STRATEGY VOCABULARY. strategy.mjs is shared with the desk and its knobs are still
   spelled *Sol; on this chain they carry ETH. See the note at the top of journal.mjs. */
const CFG = {
  ...DEFAULTS,
  maxSolPerTrade: configuredTradeCap.value,
  dailySolCap: configuredDailyCap.value,
  dailyLossLimitSol: configuredLossCap.value,
  fixedSol: PAPER_DEFAULTS.fixedEth,
  minSolPerTrade: 0.0001,
  maxOpenPositions: openPositions(process.env.MAX_OPEN_POSITIONS ?? DEFAULTS.maxOpenPositions),
  trailPct: number("TRAIL_PCT", process.env.TRAIL_PCT || DEFAULTS.trailPct, { min: 0.01, max: 0.95 }),
  fDefault: number("F_DEFAULT", process.env.F_DEFAULT || DEFAULTS.fDefault, { min: 0.00001, max: 1 }),
  fNameMax: number("F_NAME_MAX", process.env.F_NAME_MAX || DEFAULTS.fNameMax, { min: 0.00001, max: 1 }),
  bookHeatMax: number("BOOK_HEAT_MAX", process.env.BOOK_HEAT_MAX || DEFAULTS.bookHeatMax, { min: 0.00001, max: 1 }),
  maxAgeHours: number("MAX_AGE_HOURS", process.env.MAX_AGE_HOURS || DEFAULTS.maxAgeHours, { min: 0.01, max: 720 }),
  scaleOutPct: 0,
};
if (EXECUTE && configuredDailyCap.units < configuredTradeCap.units)
  fatal(`DAILY_ETH_CAP (${CFG.dailySolCap}) is below MAX_ETH_PER_TRADE (${CFG.maxSolPerTrade}) — the day would refuse the first trade`);

/* THE NUMBERS THE EXECUTOR TRADES ON COME FROM THE REGISTRY, NOT FROM THE ENVIRONMENT.
 *
 * The Solana build read SLIPPAGE_BPS and MAX_PRICE_IMPACT_PCT from env with a live
 * ceiling; the fork built a thresholds registry with provenance so a Solana number
 * could not arm an EVM bot — and then nothing read the registry. Now the poller does,
 * and there is no env override to supply around it: in live mode a VOID threshold
 * (assertLiveReady, below, after INIT_ONLY) refuses the boot, and in paper mode a
 * VOID threshold falls back to a labelled paper-only stand-in that never signs. */
const registryValue = (name, paperFallback) => {
  const t = threshold(name);
  if (EXECUTE) return t.value;            // assertLiveReady has already proved non-null
  return t.value ?? paperFallback;
};
const EXECUTOR_CFG = {
  slippageBps: registryValue("exec.slippageBps", 300),
  maxPriceImpactPct: registryValue("exec.maxPriceImpactPct", 5),
  maxNetworkFeeWei: registryValue("exec.maxNetworkFeeWei", 10n ** 15n)?.toString?.() ?? null,
  /* The cost model is computed per tick from swap.roundTripGasUnits and the live gas
     price; see expectedNetworkFeeWei(). Deliberately NOT a config constant. */
  roundTripGasUnits: threshold("swap.roundTripGasUnits").value,
  maxExitPriceImpactPct: number("MAX_EXIT_PRICE_IMPACT_PCT",
    process.env.MAX_EXIT_PRICE_IMPACT_PCT || LIVE_LIMITS.maxExitPriceImpactPct,
    { min: 0.01, max: EXECUTE ? LIVE_LIMITS.maxExitPriceImpactPct : 100 }),
  maxEntryRoundTripLossPct: number("MAX_ENTRY_ROUND_TRIP_LOSS_PCT",
    process.env.MAX_ENTRY_ROUND_TRIP_LOSS_PCT || LIVE_LIMITS.maxEntryRoundTripLossPct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxEntryRoundTripLossPct : 50 }),
  maxEntryQuoteDriftPct: number("MAX_ENTRY_QUOTE_DRIFT_PCT",
    process.env.MAX_ENTRY_QUOTE_DRIFT_PCT || LIVE_LIMITS.maxEntryQuoteDriftPct,
    { min: 0.1, max: EXECUTE ? LIVE_LIMITS.maxEntryQuoteDriftPct : 50 }),
  maxEntryPreflightAgeMs: number("MAX_ENTRY_PREFLIGHT_AGE_MS",
    process.env.MAX_ENTRY_PREFLIGHT_AGE_MS || LIVE_LIMITS.maxEntryPreflightAgeMs,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxEntryPreflightAgeMs : 600_000 }),
  maxExitTriggerAgeMs: number("MAX_EXIT_TRIGGER_AGE_MS",
    process.env.MAX_EXIT_TRIGGER_AGE_MS || LIVE_LIMITS.maxExitTriggerAgeMs,
    { min: 5_000, max: EXECUTE ? LIVE_LIMITS.maxExitTriggerAgeMs : 600_000 }),
  maxAttempts: number("MAX_TX_ATTEMPTS", process.env.MAX_TX_ATTEMPTS || LIVE_LIMITS.maxAttempts,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxAttempts : 10 }),
  // Exit retries beyond maxAttempts: only when every prior attempt is terminally
  // resolved, and never past this. Each on-chain failure burns real gas.
  maxExitAttempts: number("MAX_EXIT_TX_ATTEMPTS",
    process.env.MAX_EXIT_TX_ATTEMPTS || LIVE_LIMITS.maxExitAttempts,
    { min: 1, max: EXECUTE ? LIVE_LIMITS.maxExitAttempts : 50 }),
  deadlineBlocks: number("DEADLINE_BLOCKS", process.env.DEADLINE_BLOCKS || LIVE_LIMITS.deadlineBlocks,
    { min: 50, max: EXECUTE ? LIVE_LIMITS.deadlineBlocks : 10_000 }),
  receiptTimeoutMs: number("RECEIPT_TIMEOUT_MS", process.env.RECEIPT_TIMEOUT_MS || LIVE_LIMITS.receiptTimeoutMs,
    { min: 1_000, max: 120_000 }),
};

// Parse this once at startup. Live operators may shorten the outage bridge, but
// cannot extend the feed-policy ceiling through a mutable env value.
const ETH_USD_CACHE_MAX_AGE_MS = number("ETH_USD_CACHE_MAX_AGE_MS",
  process.env.ETH_USD_CACHE_MAX_AGE_MS || LIVE_LIMITS.ethUsdCacheMaxAgeMs,
  { min: 1_000, max: EXECUTE ? LIVE_LIMITS.ethUsdCacheMaxAgeMs : 7 * 24 * 60 * 60_000 });

number("POLL_MS", POLL_MS, { min: 1_000, max: 3_600_000 });
number("FEE_RESERVE_ETH", FEE_RESERVE, { min: 0, max: 100 });
number("MAX_CALL_AGE_MIN", MAX_CALL_AGE_MS / 60_000, { min: 1, max: 10_080 });
number("MAX_FUTURE_SKEW_MIN", MAX_FUTURE_SKEW_MS / 60_000, { min: 0.1, max: 60 });
number("MAX_ENTRY_MARK_AGE_MIN", MAX_ENTRY_MARK_AGE_MS / 60_000, { min: 1, max: 60 });
number("MAX_ENTRY_DEVIATION_PCT", MAX_ENTRY_DEVIATION_PCT, { min: 0.1, max: 50 });

const releaseLock = (() => {
  try { return acquireProcessLock(LOCK_FILE); }
  catch (error) { fatal(error.message); }
})();
let journal;
try {
  journal = new ExecutionJournal(STATE_DB, {
    wallet: WALLET,
    create: !EXECUTE || fs.existsSync(STATE_DB) || process.env.LIVE_STATE_INIT_ACK === WALLET,
  });
} catch (error) {
  releaseLock();
  fatal(error.message);
}

let S = journal.snapshot();
S.state = { ...freshState(Date.now()), ...(S.state || {}) };
Object.assign(S.state, journal.rollingRisk(Date.now()));
S.positions ||= {};
let feedRollback = (() => {
  const value = journal.getMeta("feed_rollback");
  if (value == null) return null;
  if (value?.active === true && Number.isSafeInteger(Number(value.cursor)) &&
      Number.isSafeInteger(Number(value.latestId))) return value;
  // A corrupt durable alarm is itself reason to keep entries frozen until a valid
  // authenticated feed proves it has caught back up to the durable cursor.
  return { active: true, cursor: S.cursor, latestId: -1, observedAt: Date.now() };
})();
const feedRollbackActive = () => feedRollback?.active === true;
const persistFeedRollback = (latestId) => {
  feedRollback = {
    active: true, cursor: S.cursor, latestId: Number(latestId), observedAt: Date.now(),
  };
  journal.setMeta("feed_rollback", feedRollback);
};
const clearFeedRollback = () => {
  if (!feedRollbackActive()) return;
  feedRollback = null;
  journal.setMeta("feed_rollback", null);
};
const save = () => journal.saveRuntime(S);
save();
if (process.env.INIT_ONLY === "1") {
  log(`initialized journal for ${WALLET} (chain ${CHAIN_ID}) at ${STATE_DB}; no network request or trade was made`);
  journal.close();
  releaseLock();
  process.exit(0);
}

/* THE REGISTRY GATE. Every number on the live path must be measured on THIS chain.
   Placed after INIT_ONLY so the installer can still create and bind a journal while
   the measurement campaign is outstanding; placed before any provider is contacted so
   an unarmed bot never even asks the chain. */
if (EXECUTE) {
  try { assertLiveReady(); }
  catch (error) { releaseLock(); try { journal.close(); } catch {} fatal(error.message); }
}

let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping on ${signal}`);
  try { journal.close(); } catch {}
  releaseLock();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", releaseLock);

// Both providers use an actually aborting transport (evm-rpc.mjs): no abandoned
// socket can survive the fixed ceiling or accumulate across recovery passes. Labels,
// never URLs, reach the log — provider URLs carry credentials.
const primary = createRpc(RPC, { label: "primary RPC" });
const secondary = SECONDARY_RPC ? createRpc(SECONDARY_RPC, { label: "secondary RPC" }) : null;
const providers = secondary ? [primary, secondary] : null;

/* A NETWORK BLIP IS NOT A WRONG CHAIN, AND IT WAS COSTING THE BOT ITS LIFE.
 *
 * Measured over two days of the Solana live log: 63 cap-acknowledgement lines against
 * 14 boots, four "mainnet check failed: fetch failed" refusals inside 31 seconds. The
 * bot spent much of its life restarting, and every restart hurt twice — not polling
 * while down, and the calls waiting for it aged past MAX_CALL_AGE_MIN. So the two
 * facts are separated. An ANSWER that is not chain 4663 is a configuration error:
 * refuse at once, because no amount of retrying turns another chain into this one.
 * A FAILURE TO REACH the provider is weather: wait and ask again. Nothing trades
 * until BOTH providers have answered 0x1237. */
async function proveChainOrWait() {
  const MAX_BACKOFF_MS = 30_000;
  for (let attempt = 1; ; attempt++) {
    let ids;
    try {
      ids = await Promise.all([primary("eth_chainId"), secondary("eth_chainId")]);
    } catch (error) {
      const waitMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt - 1, 5));
      // Once plainly, then every tenth attempt: a short outage still leaves a trace and
      // a long one does not bury the log.
      if (attempt === 1 || attempt % 10 === 0)
        log(`RPC unreachable for the chain check (attempt ${attempt}: ${error.message}) —` +
          ` waiting ${Math.round(waitMs / 1_000)}s and asking again.` +
          ` NOTHING is traded until both providers have proved chain ${CHAIN_ID}.`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const [chainId, secondaryChainId] = ids;
    if (chainId !== CHAIN_ID_HEX) fatal(`RPC is not Robinhood Chain (eth_chainId ${chainId}, expected ${CHAIN_ID_HEX})`);
    if (secondaryChainId !== CHAIN_ID_HEX)
      fatal(`secondary RPC is not Robinhood Chain (eth_chainId ${secondaryChainId}, expected ${CHAIN_ID_HEX})`);
    if (attempt > 1) log(`both RPC providers proved chain ${CHAIN_ID} after ${attempt} attempts`);
    return;
  }
}

if (EXECUTE) await proveChainOrWait();

const executor = EXECUTE ? new EvmExecutor({
  providers,
  wallet,
  journal,
  hardStop,
  submissionGate: (intent) => entrySubmissionGate(intent),
  log,
  config: EXECUTOR_CFG,
}) : null;

const openList = () => Object.values(S.positions);

/* THE COST MODEL, READ LIVE. One swap leg's gas (half the measured round trip) at the
   gas price both providers report right now. This is what sizing charges against a
   trade; the fee GATE is exec.maxNetworkFeeWei from the registry and is compared, never
   multiplied. lessons-lint's gate-doubles-as-cost rule watches the two stay apart. */
async function expectedNetworkFeeWei() {
  const gas = await gasPriceConsensus(providers);
  return BigInt(Math.ceil(EXECUTOR_CFG.roundTripGasUnits / 2)) * gas.max;
}

async function heldRaw(mint, rpc) {
  try { return await erc20Balance(rpc, mint, WALLET); }
  catch (error) { throw new RpcBalanceUnavailableError(error); }
}
/* ONE READ, NO RETRY, NO FAILOVER — ON THE PATH THAT DECIDES WHETHER WE CAN AFFORD
 * THE TRADE was how the Solana bot dropped calls on ordinary hiccups. Retry the
 * primary once, then ask the independent secondary. Still throws when nothing
 * answers, because an unknown balance must never be treated as a sufficient one. */
async function ethBalance() {
  const read = async (rpc, label) => {
    const wei = fromHex(await rpc("eth_getBalance", [WALLET, "latest"]), `${label} balance`);
    return weiToEth(wei);
  };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return await read(primary, "primary RPC"); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (secondary) {
    try {
      const balance = await read(secondary, "secondary RPC");
      log("wallet balance: the primary RPC did not answer twice; the independent secondary did" +
        ` (${lastError?.message || lastError})`);
      return balance;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function inspectTrackedBalance(pos) {
  const balance = await verifyTrackedBalanceWithFailover({
    trackedRaw: String(pos.qtyRaw || "0"),
    readPrimary: () => heldRaw(pos.mint, primary),
    readSecondary: secondary ? () => heldRaw(pos.mint, secondary) : null,
  });
  if (balance.verified && balance.source === "secondary") {
    log(`${pos.symbol}: primary balanceOf read failed; custody verified by the independent secondary RPC`);
  }
  return balance;
}

function persistBalanceBlock(pos, balance) {
  pos.balanceReconciliationRequired = true;
  pos.balanceReconciliationReason = balance.reason;
  pos.balanceObservedAt = Date.now();
  pos.balanceObservedPrimaryRaw = balance.primaryRaw ?? null;
  pos.balanceObservedSecondaryRaw = balance.secondaryRaw ?? null;
  save();
}

function clearBalanceBlock(pos) {
  delete pos.balanceReconciliationRequired;
  delete pos.balanceReconciliationReason;
  delete pos.balanceObservedAt;
  delete pos.balanceObservedPrimaryRaw;
  delete pos.balanceObservedSecondaryRaw;
}

function latchExit(pos, why, intentId, trigger = null) {
  if (!EXECUTE) return;
  pos.exitExecutionRequired = true;
  pos.exitExecutionReason ||= String(why || "risk exit");
  pos.exitExecutionIntentId ||= intentId;
  pos.exitExecutionObservedAt ||= Date.now();
  if (trigger && !pos.exitExecutionTrigger) pos.exitExecutionTrigger = structuredClone(trigger);
  save();
}

function clearExitLatch(pos) {
  for (const key of ["exitExecutionRequired", "exitExecutionReason", "exitExecutionIntentId",
    "exitExecutionObservedAt", "exitExecutionTrigger", "exitExecutionLastError",
    "exitExecutionLastAttemptAt"]) delete pos[key];
}

function validEntryEvent(ev) {
  if (!isAddress(ev?.mint)) throw new Error("invalid ERC-20 address in feed event");
  requirePositiveCallId(ev.call_id, "entry event call_id");
  if (!Number.isFinite(Number(ev.ts)) || Number(ev.ts) <= 0) throw new Error("entry event has no valid timestamp");
  if (Number(ev.ts) > Date.now() + MAX_FUTURE_SKEW_MS) throw new Error("entry event timestamp is too far in the future");
}

function entryEventSubmissionGate(intent) {
  if (intent?.kind !== "entry") return;
  assertEntriesUnpaused();
  const event = intent.context?.event;
  validEntryEvent(event);
  if (Date.now() - Number(event.ts) > MAX_CALL_AGE_MS)
    throw new Error("entry call became stale before submission");
  validateEntryReference(event, {
    nowMs: Date.now(), maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS,
    maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
  });
}

function entrySubmissionGate(intent) {
  entryEventSubmissionGate(intent);
  if (intent?.kind === "entry" && EXECUTE && process.env["WALLSTE_SUPERVISOR"] === "launchd") {
    requireMacEntryPower({ ownerPid: process.pid, lockFile: LOCK_FILE,
      pauseEntriesFile: PAUSE_ENTRIES_FILE });
    // The synchronous pmset/ps proof takes time. A concurrent power watcher or
    // operator pause that appeared during those reads must still close this gate.
    assertEntriesUnpaused();
  }
  validateEntryPreflightContext(intent, {
    nowMs: Date.now(), maxEntryPreflightAgeMs: EXECUTOR_CFG.maxEntryPreflightAgeMs,
    requireFresh: true,
  });
}

function confirmedAmounts(intent, label) {
  if (!intent || intent.state !== "confirmed")
    throw new Error(`${label} intent is not confirmed`);
  const input = String(intent.actualInputRaw ?? "");
  const output = String(intent.actualOutputRaw ?? "");
  const exactIn = String(intent.amountRaw ?? "");
  if (!/^\d+$/.test(input) || !/^\d+$/.test(output) || BigInt(input) <= 0n || BigInt(output) <= 0n)
    throw new Error(`${label} confirmed without positive actual fill totals`);
  if (!/^\d+$/.test(exactIn) || BigInt(input) !== BigInt(exactIn))
    throw new Error(`${label} actual input does not match its durable exact-in amount`);
  const networkFee = String(intent.networkFeeWei ?? "");
  if (!/^\d+$/.test(networkFee)) throw new Error(`${label} confirmed without an exact network fee in wei`);
  return { input, output, networkFee };
}

function recoveryRuntime(context) {
  const next = structuredClone(S);
  const liveState = structuredClone(next.state);
  if (context?.riskStateBefore && typeof context.riskStateBefore === "object") {
    const recovered = structuredClone(context.riskStateBefore);
    // A malformed pre-sign snapshot must not prevent custody accounting. Exact
    // financial rails are rebuilt from risk_events inside markAccounted anyway.
    try {
      validateRiskState(recovered, { now: Date.now() });
      next.state = recovered;
    } catch {}
  }
  // Unrelated exits may reconcile independently and carry equally old pre-sign
  // snapshots. Lifetime result counters are monotonic: restoring one snapshot may
  // never erase a result already accounted by another intent.
  for (const key of ["wins", "losses"]) {
    const live = Number(liveState?.[key]);
    const recovered = Number(next.state?.[key]);
    if (Number.isSafeInteger(live) && live >= 0 &&
        Number.isSafeInteger(recovered) && recovered >= 0)
      next.state[key] = Math.max(live, recovered);
  }
  return next;
}

/**
 * Finish the local half of a confirmed buy. This deliberately reads the event,
 * sizing decision and immutable take-profit rule from the intent journal rather
 * than from a replayed feed row or today's environment. markAccounted commits the
 * intent transition and the full runtime snapshot in one SQLite transaction; S is
 * replaced only after that commit succeeds, so a disk error cannot double-count.
 */
function applyConfirmedEntry(intent) {
  if (intent?.state === "accounted") return false;
  if (intent?.kind !== "entry") throw new Error(`intent ${intent?.id || "?"} is not an entry`);
  const { input, output, networkFee } = confirmedAmounts(intent, "entry");
  const context = intent.context || {};
  const authoredEvent = context.event;
  const plan = context.plan;
  if (context.wallet && context.wallet !== WALLET)
    throw new Error(`entry intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint.toLowerCase() !== NATIVE_ASSET.toLowerCase() || intent.outputMint !== intent.mint)
    throw new Error(`entry intent ${intent.id} has an invalid durable token route`);

  /* A finalized fill is custody reality, even if it was created by the older
   * runtime. Never let missing pre-upgrade oracle/call metadata make that holding
   * disappear from the book or throw at the top of every future tick. New entries
   * prove the complete durable context; older/malformed contexts are represented as
   * an explicit exit-only quarantine with conservative placeholders. */
  let verified = null;
  const metadataIssues = [];
  try {
    verified = validateEntryPreflightContext(intent, {
      nowMs: Number(context.entryPreflight?.observedAt) || Date.now(),
      maxEntryPreflightAgeMs: EXECUTOR_CFG.maxEntryPreflightAgeMs,
      requireFresh: false,
    });
  } catch (error) {
    metadataIssues.push(`no provable independent ETH/USD entry basis: ${error.message}`);
  }
  const matchingEvent = authoredEvent &&
    String(authoredEvent.mint || "").toLowerCase() === String(intent.mint).toLowerCase() ? authoredEvent : null;
  const candidateCallId = Number(matchingEvent?.call_id);
  const hasExactCallId = Number.isSafeInteger(candidateCallId) && candidateCallId > 0;
  if (!hasExactCallId) metadataIssues.push("no exact durable call identity");
  if (!plan || plan.action !== "buy" || !Number.isFinite(Number(plan.sol)) || Number(plan.sol) <= 0 ||
      !Number.isFinite(Number(plan.f)) || Number(plan.f) < 0)
    metadataIssues.push("no complete durable sizing context");

  const rule = context.takeProfitRule || {};
  const durableTakeProfitX = Number(rule.takeProfitX);
  if (!Number.isFinite(durableTakeProfitX) || durableTakeProfitX <= 0 ||
      typeof rule.honorDeskTarget !== "boolean")
    metadataIssues.push("no durable take-profit rule");
  const entryReference = context.entryReference;
  if (!entryReference || !(Number(entryReference.stopRatio) > 0) ||
      Number(entryReference.stopRatio) >= 1 ||
      (entryReference.targetRatio != null && !(Number(entryReference.targetRatio) > 0)))
    metadataIssues.push("no valid durable market reference");
  const oracleVerified = Boolean(verified);
  const independentlyVerified = oracleVerified && metadataIssues.length === 0;

  const costBasisWei = BigInt(input) + BigInt(networkFee);
  const paidEth = weiToEth(costBasisWei);
  const existing = S.positions[intent.mint];
  if (existing) {
    if (existing.entryIntentId !== intent.id || String(existing.qtyRaw) !== output ||
        String(existing.costBasisWei) !== costBasisWei.toString() ||
        (hasExactCallId && Number(existing.callId) !== candidateCallId) ||
        (independentlyVerified && existing.ethUsdSource !== ETH_USD_CACHE_SOURCE) ||
        (!independentlyVerified && existing.accountingIncomplete !== true) ||
        Math.abs(Number(existing.paidEth) - paidEth) > 1e-9)
      throw new Error(`entry intent ${intent.id} conflicts with the recorded position`);
    const next = structuredClone(S);
    journal.markAccounted(intent.id, next);
    S = next;
    return true;
  }

  const takeProfitX = Number.isFinite(durableTakeProfitX) && durableTakeProfitX > 0
    ? durableTakeProfitX : Math.max(1, Number(CFG.takeProfitX) || 2);
  const honorDeskTarget = typeof rule.honorDeskTarget === "boolean" ? rule.honorDeskTarget : false;
  const stopBufferPct = Number(context.positionConfig?.stopBufferPct);
  const stopRatio = Number(entryReference?.stopRatio) > 0 && Number(entryReference.stopRatio) < 1
    ? Number(entryReference.stopRatio) : 0.01;
  const targetRatio = Number(entryReference?.targetRatio) > 0
    ? Number(entryReference.targetRatio) : null;
  const event = matchingEvent || {
    mint: intent.mint,
    symbol: String(authoredEvent?.symbol || intent.mint.slice(0, 8)),
    ts: Number(context.openedAtMs || intent.confirmedAt || intent.createdAt || Date.now()),
  };
  const pos = openPosition({
    call: {
      ...event,
      mint: intent.mint,
      stop: stopRatio,
      target: targetRatio,
    },
    sol: paidEth,
    fillPrice: 1,
    cfg: { stopBufferPct: Number.isFinite(stopBufferPct) ? stopBufferPct : CFG.stopBufferPct },
  });
  pos.qtyRaw = output;
  pos.paidEth = paidEth;
  delete pos.paidSol;
  pos.costBasisWei = costBasisWei.toString();
  pos.entryInputWei = input;
  pos.riskF = Number.isFinite(Number(plan?.f)) && Number(plan.f) >= 0 ? Number(plan.f) : 0;
  const durableOpenedAt = Number(context.openedAtMs ?? intent.createdAt);
  pos.openedAtMs = Number.isFinite(durableOpenedAt) && durableOpenedAt > 0
    ? durableOpenedAt : Date.now();
  pos.entryIntentId = intent.id;
  if (hasExactCallId) pos.callId = candidateCallId;
  else {
    pos.callIdentityIncomplete = true;
    pos.callIdentityIncompleteReason =
      "landed legacy entry has no provable originating call_id; new entries remain blocked until it closes";
    pos.callIdentityPolicy = LEGACY_CALL_IDENTITY_POLICY;
  }
  pos.takeProfitX = takeProfitX;
  pos.honorDeskTarget = honorDeskTarget;
  if (Number(entryReference?.marketMark) > 0)
    pos.marketMarkAtEntry = Number(entryReference.marketMark);
  if (Number(entryReference?.marketMarkAt) > 0)
    pos.marketMarkObservedAt = Number(entryReference.marketMarkAt);
  const ethUsdAtEntry = Number(context.entryPreflight?.ethUsd);
  pos.ethUsdAtEntry = Number.isFinite(ethUsdAtEntry) && ethUsdAtEntry > 0 ? ethUsdAtEntry : 1;
  // Preserve truthful oracle provenance even when some other strategy metadata is
  // incomplete. accountingIncomplete, not a false source label, is what disarms all
  // automatic price policy for the exit-only quarantine.
  pos.ethUsdSource = oracleVerified ? ETH_USD_CACHE_SOURCE : "legacy-unverified";
  if (!independentlyVerified) {
    pos.accountingIncomplete = true;
    pos.accountingIncompleteReason =
      `landed entry has incomplete durable non-custody metadata: ` +
      `${metadataIssues.join("; ") || "durable provenance unavailable"}; ` +
      "automatic price exits are quarantined";
  }

  // An exit can arrive while this exact buy is signed/submitted/ambiguous but not
  // yet a position. The feed cursor is allowed to drain past that exit only because
  // the journal kept it. Attach the latch in the SAME transaction that accounts the
  // buy, so a crash cannot create a position that forgot the desk had already left.
  const deferredExit = journal.deferredDeskExitForEntry(intent.id);
  if (deferredExit) {
    if (deferredExit.mint !== intent.mint ||
        (hasExactCallId && Number(deferredExit.callId) !== candidateCallId))
      throw new Error(`deferred desk exit for ${intent.id} does not match the confirmed entry`);
    pos.exitExecutionRequired = true;
    pos.exitExecutionReason = deferredExit.reason;
    pos.exitExecutionIntentId = `desk-exit:${deferredExit.eventId}`;
    pos.exitExecutionObservedAt = deferredExit.observedAt;
  }

  const next = recoveryRuntime(independentlyVerified ? context : null);
  next.positions[intent.mint] = pos;
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next, { consumeDeferredDeskExit: Boolean(deferredExit) });
  S = next;
  log(`${independentlyVerified ? "BOUGHT" : "RECOVERED + QUARANTINED"} ` +
    `${event.symbol || intent.mint.slice(0, 8)} — ${paidEth.toFixed(6)} ETH → ${output} raw — ` +
    `${EXPLORER}${intent.txHash}`);
  return true;
}

/** Apply a confirmed sell from its pre-submit position snapshot, never a balance read. */
function applyConfirmedExit(intent) {
  if (intent?.state === "accounted") return false;
  if (!intent || !["desk_exit", "risk_exit"].includes(intent.kind))
    throw new Error(`intent ${intent?.id || "?"} is not an exit`);
  const { input, output, networkFee } = confirmedAmounts(intent, "exit");
  if (intent.context?.wallet && intent.context.wallet !== WALLET)
    throw new Error(`exit intent ${intent.id} belongs to a different wallet context`);
  if (intent.inputMint !== intent.mint || intent.outputMint.toLowerCase() !== NATIVE_ASSET.toLowerCase())
    throw new Error(`exit intent ${intent.id} has an invalid durable token route`);
  const before = intent.context?.position;
  if (!before || String(before.mint || "") !== String(intent.mint))
    throw new Error(`exit intent ${intent.id} has no matching durable position context`);
  const beforeRaw = BigInt(String(before.qtyRaw || "0"));
  const soldRaw = BigInt(input);
  if (beforeRaw <= 0n || soldRaw > beforeRaw)
    throw new Error(`exit intent ${intent.id} fill exceeds its durable position`);
  const current = S.positions[intent.mint];
  if (current && (String(current.qtyRaw) !== String(before.qtyRaw) ||
      (before.entryIntentId && current.entryIntentId !== before.entryIntentId)))
    throw new Error(`exit intent ${intent.id} conflicts with the recorded position`);

  const basisBeforeWei = BigInt(String(before.costBasisWei || "0"));
  if (basisBeforeWei <= 0n) throw new Error(`exit intent ${intent.id} has invalid durable cost basis`);
  const paidPortionWei = soldRaw >= beforeRaw ? basisBeforeWei : basisBeforeWei * soldRaw / beforeRaw;
  const netProceedsWei = BigInt(output) - BigInt(networkFee);
  const netWei = netProceedsWei - paidPortionWei;
  const outEth = weiToEth(netProceedsWei);
  const net = weiToEth(netWei);
  const fraction = Number(intent.context?.fraction ?? 1);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new Error(`exit intent ${intent.id} has invalid durable sell fraction`);
  const fullExit = fraction >= 1 || soldRaw >= beforeRaw;
  const next = recoveryRuntime(intent.context);
  if (fullExit) {
    delete next.positions[intent.mint];
    if (netWei >= 0n) next.state.wins = (Number(next.state.wins) || 0) + 1;
    else next.state.losses = (Number(next.state.losses) || 0) + 1;
  } else {
    const remainingBasis = basisBeforeWei - paidPortionWei;
    next.positions[intent.mint] = {
      ...structuredClone(before),
      qtyRaw: String(beforeRaw - soldRaw),
      costBasisWei: remainingBasis.toString(),
      paidEth: weiToEth(remainingBasis),
      entryInputWei: String(BigInt(before.entryInputWei) -
        (soldRaw >= beforeRaw ? BigInt(before.entryInputWei) :
          BigInt(before.entryInputWei) * soldRaw / beforeRaw)),
    };
  }
  next.state.openCount = Object.keys(next.positions).length;
  next.state.bookHeat = Object.values(next.positions)
    .reduce((sum, position) => sum + (Number(position.riskF) || 0), 0);
  journal.markAccounted(intent.id, next);
  S = next;
  const symbol = before.symbol || intent.mint.slice(0, 8);
  log(`${fullExit ? "SOLD" : "SCALED"} ${symbol} for ${outEth.toFixed(6)} ETH` +
    `${fullExit ? ` (${net >= 0 ? "+" : ""}${net.toFixed(6)})` : ""} — ${EXPLORER}${intent.txHash}`);
  return true;
}

function accountConfirmedIntents() {
  let count = 0;
  for (const intent of journal.pendingIntents()) {
    if (intent.state !== "confirmed") continue;
    try {
      if (intent.kind === "entry") applyConfirmedEntry(intent);
      else if (["desk_exit", "risk_exit"].includes(intent.kind)) applyConfirmedExit(intent);
      else if (intent.kind === "approval") journal.markApprovalSettled(intent.id);
      else throw new Error(`confirmed intent ${intent.id} has unsupported kind ${intent.kind}`);
      count++;
    } catch (error) {
      // One damaged accounting row must remain visible and block new exposure, but
      // it may never starve stop/desk-exit handling for every unrelated holding.
      // The confirmed state is deliberately retained for monitor/operator repair.
      log(`ACCOUNTING QUARANTINE ${intent.id}: ${error.message} — ` +
        "intent remains confirmed; unrelated position protection continues");
    }
  }
  return count;
}

async function onEntry(ev) {
  const intentId = `entry:${ev.event_id || `${FLOOR}:${ev.id}`}`;
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedEntry(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`ENTRY ${ev.symbol} already accounted`);
  validEntryEvent(ev);
  if (S.positions[ev.mint]) return log(`SKIP ${ev.symbol}: already holding`);
  const unresolvedPosition = openList().find((position) => positionEntryBlock(position));
  if (unresolvedPosition)
    return log(`SKIP ${ev.symbol}: ${unresolvedPosition.symbol} blocks new exposure — ${positionEntryBlock(unresolvedPosition)}`);
  const age = Date.now() - Number(ev.ts);
  if (age > MAX_CALL_AGE_MS)
    return log(`SKIP ${ev.symbol}: call is ${Math.round(age / 60_000)}m old (max ${MAX_CALL_AGE_MS / 60_000}m)`);
  if (feedRollbackActive())
    return log(`SKIP ${ev.symbol}: authenticated feed latest_id rolled behind durable cursor — entries frozen`);
  if (pauseEntries()) return log(`SKIP ${ev.symbol}: PAUSE ENTRIES file is present`);
  if (hardStop()) return log(`SKIP ${ev.symbol}: HARD STOP file is present`);
  const history = journal.riskHistoryStatus(Date.now());
  if (!history.complete)
    return log(`SKIP ${ev.symbol}: rolling risk history is quarantined until ${new Date(history.incompleteUntil).toISOString()}`);

  Object.assign(S.state, journal.rollingRisk(Date.now()));
  S.state.openCount = openList().length;
  /* ONE READ, NOT TWO: spendable and equity derive from the same balance. */
  const walletEth = EXECUTE ? await ethBalance() : null;
  S.state.spendableSol = EXECUTE ? Math.max(0, walletEth - FEE_RESERVE) : null;
  S.state.equitySol = EXECUTE ? walletEth : (S.state.equitySol ?? CFG.dailySolCap);
  S.state.bookHeat = openList().reduce((sum, pos) => sum + (pos.riskF || 0), 0);

  const entryReference = validateEntryReference(ev, {
    nowMs: Date.now(), maxMarkAgeMs: MAX_ENTRY_MARK_AGE_MS,
    maxDeviationPct: MAX_ENTRY_DEVIATION_PCT,
  });

  const takeProfitRule = resolveTakeProfitRule(ev.take_profit_x, CFG.takeProfitX);
  // Tenant sizes arrive as ETH decimal strings (fixed_eth); the operator cap wins.
  const fixed = Number(ev.fixed_eth) > 0 ? Math.min(Number(ev.fixed_eth), CFG.maxSolPerTrade) : CFG.fixedSol;
  const feeWei = EXECUTE ? await expectedNetworkFeeWei() : 0n;
  const perCall = { ...CFG, ...takeProfitRule, fixedSol: fixed,
    networkFeeReserveSol: EXECUTE ? weiToEth(feeWei) : 0 };
  const normalizedCall = { ...ev, entry_ref: 1, stop: entryReference.stopRatio,
    target: entryReference.targetRatio, size_sol: ev.size_eth ?? ev.size_sol };
  let plan = planEntry({ call: normalizedCall, cfg: perCall, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol}: ${plan.reason}`);

  if (!EXECUTE) {
    log(`ENTRY ${ev.symbol} — ${plan.sol} ETH | stop ${ev.stop} target ${ev.target}`);
    return log("PAPER — no transaction signed");
  }
  if (!executor) throw new Error("the EVM executor is unavailable");

  const preliminaryAmountWei = ethToWei(plan.sol);
  const [preflight, tokenDecimals, ethUsdOracle] = await Promise.all([
    executor.preflightEntry(ev.mint, preliminaryAmountWei.toString()),
    executor.tokenDecimals(ev.mint),
    independentEthUsdPrice(providers),
  ]);
  entryEventSubmissionGate({ kind: "entry", context: { event: ev } });
  const executableReturnRatio = Number(BigInt(preflight.reverse.outAmount) * 1_000_000n /
    preliminaryAmountWei) / 1_000_000;
  /* The fee term is the COST MODEL (gas × live gwei, both legs), never the gate. On
     this chain it is what punishes small clips: at 0.0004 ETH two legs of ~330k gas
     at 0.3 gwei are ~0.0002 ETH, half the position. The message names the dominant
     term so a refusal is actionable. */
  const worstFeeRatio = Number(2n * feeWei * 1_000_000n / preliminaryAmountWei) / 1_000_000;
  const slippageHaircut = (1 - EXECUTOR_CFG.slippageBps / 10_000) ** 2;
  const conservativeReturnRatio = executableReturnRatio * slippageHaircut - worstFeeRatio;
  if (conservativeReturnRatio <= entryReference.stopRatio)
    throw new Error(`entry round trip plus worst-case fees is already at/below the authored stop ` +
      `[dominant term: ${worstFeeRatio > (1 - executableReturnRatio * slippageHaircut) ? "the fee model" : "the measured round trip"}] ` +
      `(measured round trip ${Number(preflight.lossPct ?? 0).toFixed(2)}% → executable ${(executableReturnRatio * 100).toFixed(2)}%; ` +
      `slippage haircut ${((1 - slippageHaircut) * 100).toFixed(2)}%, worst-case fees ${(worstFeeRatio * 100).toFixed(2)}%; ` +
      `conservative return ${(conservativeReturnRatio * 100).toFixed(2)}% vs stop at ${(entryReference.stopRatio * 100).toFixed(2)}% of entry)`);
  const conservativeLossPct = Math.max(preflight.lossPct, (1 - conservativeReturnRatio) * 100);
  if (conservativeLossPct > EXECUTOR_CFG.maxEntryRoundTripLossPct)
    throw new Error(`entry round trip ${conservativeLossPct.toFixed(2)}% exceeds the ${EXECUTOR_CFG.maxEntryRoundTripLossPct}% ceiling`);
  plan = planEntry({ call: normalizedCall,
    cfg: { ...perCall, measuredRoundTripLossPct: conservativeLossPct }, state: S.state });
  if (plan.action !== "buy") return log(`SKIP ${ev.symbol} after executable-cost check: ${plan.reason}`);
  const amountWei = ethToWei(plan.sol);
  log(`ENTRY ${ev.symbol} — ${plan.sol} ETH | stop ${ev.stop} target ${ev.target}`);
  const openedAtMs = Date.now();
  const intentContext = {
    event: ev, plan, takeProfitRule, openedAtMs, entryReference,
    entryPreflight: {
      inputAmountRaw: preliminaryAmountWei.toString(),
      forwardOutputRaw: String(preflight.forward.outAmount),
      reverseOutputRaw: String(preflight.reverse.outAmount),
      roundTripLossPct: preflight.lossPct,
      // Never let the swap counterparty author its own USD fairness anchor.
      // Chainlink's ETH/USD is read through both independent RPC providers and its
      // aggregator, decimals, freshness and consensus are checked.
      ethUsd: ethUsdOracle.price,
      ethUsdSource: ethUsdOracle.source,
      ethUsdPublishTime: ethUsdOracle.publishTime,
      ethUsdConfidencePct: ethUsdOracle.confidencePct,
      ethUsdProviderDivergencePct: ethUsdOracle.divergencePct,
      tokenDecimals,
      hazards: preflight.prepared?.hazards ?? null,
      priceImpactPct: preflight.prepared?.priceImpactPct ?? null,
      observedAt: ethUsdOracle.observedAt,
    },
    positionConfig: { stopBufferPct: perCall.stopBufferPct },
    riskStateBefore: structuredClone(S.state),
  };
  // Apply the exact same complete gate used by restart recovery before an intent is
  // even journaled. The executor checks it again after final simulation and before
  // signing, and once more before any recovered signed bytes could be disclosed.
  entrySubmissionGate({ kind: "entry", amountRaw: amountWei.toString(), context: intentContext });
  const fill = await executor.executeIntent({
    id: intentId,
    kind: "entry",
    eventId: ev.event_id || null,
    feedId: ev.id,
    mint: ev.mint,
    inputMint: NATIVE_ASSET,
    outputMint: ev.mint,
    amountRaw: amountWei.toString(),
    context: intentContext,
  });
  applyConfirmedEntry(fill);
}

async function sellAll(pos, why, fraction = 1, suppliedIntentId = null, trigger = null) {
  const intentId = suppliedIntentId || `risk-exit:${pos.entryIntentId || `${pos.mint}:${pos.openedAtMs || pos.openedAt}`}`;
  latchExit(pos, why, intentId, trigger);
  const existingIntent = journal.getIntent(intentId);
  if (existingIntent?.state === "confirmed") {
    applyConfirmedExit(existingIntent);
    return;
  }
  if (existingIntent?.state === "accounted") return log(`EXIT ${pos.symbol} already accounted`);
  if (["signed", "submitted", "ambiguous"].includes(existingIntent?.state))
    return log(`EXIT ${pos.symbol} remains durably latched — ${existingIntent.state} attempt is ` +
      "handled by bounded recovery without blocking other position checks");
  if (!EXECUTE) return log(`PAPER EXIT ${pos.symbol} — ${why} — position retained; no transaction sent`);
  /* The message used to end at "manage the wallet manually", which sounds like a
     wallet is the only way out and is misleading: removing this sentinel re-arms the
     bot's own exits, and that is almost always what the operator wants. Naming the
     other sentinel matters too — an operator reaching for a kill switch reads "hard
     stop" as the stronger, safer one and thereby disarms every stop-loss they have. */
  if (hardStop()) throw new Error(
    `HARD STOP is present at ${HARD_STOP_FILE} — it blocks EXITS as well as entries, so this ` +
    "position has no stop-loss while it is there. Remove it to let the bot close the position " +
    "(rm the file), or sell from the burner wallet yourself. To stop only NEW entries and keep " +
    `stops armed, use the entry-pause sentinel at ${PAUSE_ENTRIES_FILE} instead.`);

  const tracked = BigInt(pos.qtyRaw || 0);
  const balance = await inspectTrackedBalance(pos);
  if (!balance.verified) {
    persistBalanceBlock(pos, balance);
    return log(`AMBIGUOUS ${pos.symbol}: ${balance.reason} — durable position retained; manual reconciliation required`);
  }
  clearBalanceBlock(pos);
  const amount = fraction >= 1 ? tracked :
    (tracked * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
  if (amount <= 0n) throw new Error(`${pos.symbol} durable exit amount rounded to zero`);
  log(`EXIT ${pos.symbol} — ${why}`);
  const fill = await executor.executeIntent({
    id: intentId,
    kind: suppliedIntentId?.startsWith("desk-exit:") ? "desk_exit" : "risk_exit",
    eventId: suppliedIntentId?.startsWith("desk-exit:") ? suppliedIntentId.slice(10) : null,
    mint: pos.mint,
    inputMint: pos.mint,
    outputMint: NATIVE_ASSET,
    amountRaw: amount.toString(),
    context: {
      position: structuredClone(pos), why, fraction,
      trigger: trigger ? structuredClone(trigger) : null,
      riskStateBefore: structuredClone(S.state),
    },
  });
  applyConfirmedExit(fill);
}

/** Execute an exit for a held position, or durably defer it for the exact buy that
 * is already beyond the no-return signing boundary but has not accounted yet. */
async function handleDeskExitEvent(ev) {
  if (!isAddress(ev?.mint)) throw new Error("invalid ERC-20 address in desk exit event");
  requirePositiveCallId(ev?.call_id, "desk exit call_id");
  const eventId = ev.event_id || `${FLOOR}:${ev.id}`;
  const reason = `desk exit (${ev.code || "exit"})`;
  const pos = S.positions[ev.mint];
  if (pos) {
    const decision = deskExitDecisionForPosition(pos, ev);
    if (decision.action === "ignore") {
      log(`EXIT ${ev.symbol || ev.mint}: call ${decision.callId} does not match held call ${decision.positionCallId}`);
      return "different-call";
    }
    if (decision.reason === "legacy-risk-reduction")
      log(`EXIT ${ev.symbol || ev.mint}: legacy call identity is unprovable — taking the risk-reducing same-token exit`);
    await sellAll(pos, reason, 1, `desk-exit:${eventId}`);
    return "position";
  }
  const entry = journal.blockingEntryForDeskExit({ mint: ev.mint, callId: ev.call_id });
  if (!entry) return "not-held";
  journal.deferDeskExitForEntry({
    entryIntentId: entry.id, eventId, feedId: ev.id, callId: ev.call_id,
    mint: ev.mint, reason, observedAt: Date.now(),
  });
  log(`EXIT ${ev.symbol || ev.mint}: durably deferred until unresolved entry ${entry.id} is accounted`);
  return "deferred";
}

async function manageOpen() {
  let currentEthUsd = null;
  let ethUsdObservation = null;
  let ethUsdError = null;
  if (EXECUTE && openList().length) {
    try {
      ethUsdObservation = await independentEthUsdPrice(providers);
      currentEthUsd = ethUsdObservation.price;
    }
    catch (error) { ethUsdError = error; }
  }

  /* ONE DENOMINATOR OUTAGE MUST NOT DISARM EVERY STOP. When the oracle read fails the
   * cached rate is used for up to ETH_USD_CACHE_MAX_AGE_MS — the feed's own staleness
   * window, because its 0.5% deviation trigger bounds the value error whatever the
   * age. The cache is durable meta because restarts CORRELATE with the outages it
   * exists for; a failed write must never fail a tick. */
  if (currentEthUsd > 0) {
    S.ethUsdCache = {
      v: currentEthUsd,
      ts: ethUsdObservation.observedAt,
      publishTime: ethUsdObservation.publishTime,
      source: ETH_USD_CACHE_SOURCE,
    };
    try { journal.setMeta("eth_usd_cache", JSON.stringify(S.ethUsdCache)); } catch {}
  } else if (ethUsdError || !(currentEthUsd > 0)) {
    if (!S.ethUsdCache) {
      try { const m = journal.getMeta("eth_usd_cache"); if (m) S.ethUsdCache = JSON.parse(m); } catch {}
    }
    const cache = S.ethUsdCache;
    const usableCache = usableEthUsdCache(cache, {
      nowMs: Date.now(), maxAgeMs: ETH_USD_CACHE_MAX_AGE_MS,
    });
    if (usableCache) {
      currentEthUsd = usableCache.price;
      ethUsdError = null;
      log(`independent ETH/USD oracle failed — using the cached Chainlink rate $${usableCache.price} ` +
        `published ${Math.round(usableCache.publishAgeMs / 60_000)}m ago so stops stay armed`);
    }
  }

  /* Iterate by KEY and re-resolve each position from the live state: any exit inside
   * the loop swaps S for a structuredClone (applyConfirmedExit), and a detached `pos`
   * silently loses every write. */
  for (const posKey of openList().map((p) => p.mint)) {
    const pos = openList().find((p) => p.mint === posKey);
    if (!pos) continue;                            // exited earlier in this same pass
    try {
      if (EXECUTE) {
        const wasBlocked = pos.balanceReconciliationRequired;
        const balance = await inspectTrackedBalance(pos);
        if (!balance.verified) {
          persistBalanceBlock(pos, balance);
          log(`AMBIGUOUS ${pos.symbol}: ${balance.reason} — position management remains disarmed`);
          continue;
        }
        clearBalanceBlock(pos);
        save();
        if (wasBlocked) log(`${pos.symbol}: full balanceOf verified again — custody gate re-armed`);
      }
      // A previously latched stop/rug/desk exit outranks fresh market-data work.
      if (pos.exitExecutionRequired) {
        await sellAll(pos, pos.exitExecutionReason || "required risk exit", 1,
          pos.exitExecutionIntentId || null, pos.exitExecutionTrigger || null);
        continue;
      }
      if (pos.accountingIncomplete) {
        log(`${pos.symbol}: legacy accounting/ETH-USD basis is incomplete — ` +
          "automatic price exits remain disarmed; explicit same-token desk exits remain enabled");
        continue;
      }
      let mark = null;
      if (executor && pos.qtyRaw && BigInt(pos.qtyRaw) > 0n) {
        try {
          if (ethUsdError || !(currentEthUsd > 0))
            /* An oracle gap is a fact about Chainlink, not about this pool — classified
               so it cannot latch a market liquidation on two ticks. */
            throw Object.assign(new Error(
              `independent ETH/USD mark unavailable: ${ethUsdError?.message || "no usable Chainlink cache"}`),
              { failureClass: "oracle" });
          const observation = await executor.preflightExitMark({
            mint: pos.mint, amountRaw: pos.qtyRaw, position: pos,
          });
          mark = executableExitMark(pos, observation.actualOutputRaw, currentEthUsd);
          clearExitMarkFailureWitness(pos);
          delete pos.riskDataUnavailable;
          delete pos.riskDataUnavailableReason;
          delete pos.riskDataUnavailableAt;
          save();
        }
        catch (error) {
          pos.riskDataUnavailable = true;
          pos.riskDataUnavailableReason = `independent executable exit mark unavailable: ${error.message}`;
          pos.riskDataUnavailableAt = Date.now();
          /* WHAT THE FAILURE IS EVIDENCE OF decides how much of it is needed before a
             latched, price-blind liquidation of the whole position. evm-swap tags an
             aggregator answer with no route as "no-route" (two ticks, unchanged) and an
             HTTP/DNS/timeout failure as "transport" (six observations over ten minutes).
             An unclassified error falls through to the stricter routing fuse. */
          const witness = confirmExitMarkFailureWitness(pos, {
            observedAt: pos.riskDataUnavailableAt, reason: pos.riskDataUnavailableReason,
            failureClass: error?.failureClass,
          }, { maxGapMs: Math.max(60_000, POLL_MS * 4) });
          save();
          if (!witness.confirmed) {
            log(`mark ${pos.symbol}: ${error.message} — new entries blocked; ` +
              "waiting for one independent next-tick failure witness before risk reduction");
          } else {
            log(`mark ${pos.symbol}: executable mark unavailable — ${witness.trigger.witnesses} ` +
              `${witness.trigger.failureClass} observations over ` +
              `${Math.round((witness.trigger.observedAt - witness.trigger.firstObservedAt) / 1000)}s — ` +
              "latching a risk-reducing exit so the aggregator cannot suppress a stop");
            await sellAll(pos, "independent executable exit mark unavailable on two consecutive ticks",
              1, null, witness.trigger);
            continue;
          }
        }
      }
      const decision = stepPosition({ pos, mark, deskExit: null, cfg: policyConfigForPosition(pos, CFG) });
      if (decision.action === "sell") {
        const trigger = priceExitTrigger(pos, decision, mark, currentEthUsd, Date.now());
        const witness = confirmPriceExitWitness(pos, trigger, { maxGapMs: Math.max(60_000, POLL_MS * 4) });
        if (!witness.confirmed) {
          save();
          log(`${pos.symbol}: ${decision.reason} observed once — waiting for an independent next-tick witness`);
          continue;
        }
        await sellAll(pos, decision.reason, 1, null, witness.trigger);
      }
      else if (decision.action === "sell_part") await sellAll(pos, decision.reason, decision.fraction);
      else { clearPriceExitWitness(pos); save(); }
    } catch (error) {
      // A sellAll above may have swapped S for a clone; write the failure onto the
      // LIVE object or the flags evaporate with the detached one.
      const live = openList().find((p) => p.mint === posKey);
      const pos = live ?? { symbol: posKey };
      if (!live) { log(`manage ${pos.symbol}: ${error.message} — position left the book mid-pass`); continue; }
      if (pos.exitExecutionRequired) {
        if (error?.code === "EXIT_TRIGGER_NOT_MET") {
          clearExitLatch(pos);
          clearPriceExitWitness(pos);
          save();
          log(`EXIT CANCELLED ${pos.symbol}: ${error.message} — price trigger must earn two fresh witnesses again`);
          continue;
        }
        pos.exitExecutionLastError = error.message;
        pos.exitExecutionLastAttemptAt = Date.now();
        if (/price impact .* exceeds cap/i.test(error.message)) {
          pos.manualExitRequired = true;
          pos.manualExitReason = error.message;
          pos.manualExitObservedAt = Date.now();
        }
        save();
        log(`EXIT BLOCKED ${pos.symbol}: ${error.message} — fired exit remains latched; new entries blocked`);
      } else {
        pos.riskDataUnavailable = true;
        pos.riskDataUnavailableReason = `position management failed: ${error.message}`;
        pos.riskDataUnavailableAt = Date.now();
        save();
        log(`manage ${pos.symbol}: ${error.message} — new entries blocked`);
      }
    }
  }
}

let ticking = false;
/* Self-reported liveness for the floor's bot card. Outbound-only, same read-only
 * secret as the feed, fire-and-forget: a dead site must never delay a stop check.
 * Throttled to once a minute. */
let lastHeartbeatAt = 0;
const capWei = () => ethToWei(CFG.maxSolPerTrade);
const runtimeHealth = {
  lastTickStartedAt: 0, lastTickCompletedAt: 0, lastFeedSuccessAt: 0,
  consecutiveFeedFailures: 0, consecutiveTickFailures: 0,
  executionReadiness: EXECUTE ? {
    ready: false, lastSuccessAt: 0, observedAt: 0, route: EXECUTION_READINESS_ROUTE, providers: 0,
    amountWei: capWei().toString(),
  } : null,
};
let readinessProbeInFlight = false;
let lastReadinessProbeAt = 0;
let lastReadinessError = null;
/* 0 means "never logged one", so the first success after boot always speaks. */
let lastReadinessSuccessLoggedAt = 0;
function maybeProbeExecutionReadiness() {
  if (!EXECUTE || !executor || readinessProbeInFlight ||
      Date.now() - lastReadinessProbeAt < 2 * 60_000) return;
  lastReadinessProbeAt = Date.now();
  readinessProbeInFlight = true;
  /* A PROBE THAT NEVER SETTLES TAKES THE REHEARSAL WITH IT, PERMANENTLY — so it is
   * raced against a deadline and the .finally() hangs off the race. It gates nothing:
   * the rehearsal signs nothing and is not consulted before an entry. */
  const readinessDeadlineMs = Math.max(30_000, Number(process.env.READINESS_TIMEOUT_MS) || 90_000);
  let readinessTimer = null;
  const readinessDeadline = new Promise((_, reject) => {
    readinessTimer = setTimeout(
      () => reject(new Error(`readiness rehearsal exceeded ${Math.round(readinessDeadlineMs / 1000)}s and was abandoned`)),
      readinessDeadlineMs);
    readinessTimer.unref?.();
  });
  Promise.race([
    executor.probeExecutionReadiness({ amountWei: capWei().toString() }),
    readinessDeadline,
  ]).then((result) => {
    const succeededAt = Date.now();
    /* A REHEARSAL THAT SUCCEEDS SILENTLY IS INDISTINGUISHABLE FROM ONE THAT NEVER RAN:
     * the first success after boot always speaks, then at most one an hour; a recovery
     * still logs immediately. */
    const readinessSuccessQuietMs = 3_600_000;
    const recovered = result?.ready === true && lastReadinessError !== null;
    const dueForHeartbeat = result?.ready === true &&
      succeededAt - lastReadinessSuccessLoggedAt >= readinessSuccessQuietMs;
    if (recovered || dueForHeartbeat) {
      lastReadinessError = null;
      lastReadinessSuccessLoggedAt = succeededAt;
      log(`READINESS proved: ${result.route} at ${CFG.maxSolPerTrade} ETH on ${result.providers} providers, nothing signed` +
        ` — gas ${(Number(result.gasPriceWei) / 1e9).toFixed(3)} gwei, heads ${result.heads?.join("/") ?? "?"}`);
    }
    runtimeHealth.executionReadiness = {
      ready: result?.ready === true,
      lastSuccessAt: result?.ready === true ? succeededAt : 0,
      observedAt: Number(result?.observedAt) || succeededAt,
      route: result?.route === EXECUTION_READINESS_ROUTE ? EXECUTION_READINESS_ROUTE : null,
      providers: Number(result?.providers) === 2 ? 2 : 0,
      amountWei: String(result?.amountWei || "0"),
    };
  }).catch((error) => {
    /* SAY WHY IT IS NOT READY, once per distinct cause. */
    const reason = String(error?.message || error).slice(0, 300);
    if (reason !== lastReadinessError) {
      lastReadinessError = reason;
      const need = capWei() + BigInt(EXECUTOR_CFG.maxNetworkFeeWei) + 10n ** 15n;
      log(`READINESS not proved (${EXECUTION_READINESS_ROUTE} at ${CFG.maxSolPerTrade} ETH): ${reason}` +
        ` — this no-sign rehearsal needs about ${weiToEth(need).toFixed(6)} ETH in the wallet ` +
        "(the trade size, the network-fee ceiling and a 0.001 ETH reserve)");
    }
    runtimeHealth.executionReadiness = {
      ready: false,
      lastSuccessAt: Number(runtimeHealth.executionReadiness?.lastSuccessAt) || 0,
      observedAt: Date.now(), route: EXECUTION_READINESS_ROUTE, providers: 0,
      amountWei: capWei().toString(),
      lastError: reason,
    };
  }).finally(() => { clearTimeout(readinessTimer); readinessProbeInFlight = false; });
}
const noteFeedFailure = () => { runtimeHealth.consecutiveFeedFailures++; };
const noteFeedSuccess = () => {
  runtimeHealth.lastFeedSuccessAt = Date.now();
  runtimeHealth.consecutiveFeedFailures = 0;
};
function sendHeartbeat() {
  if (Date.now() - lastHeartbeatAt < 60_000) return;
  lastHeartbeatAt = Date.now();
  const caps = {
    maxEthPerTrade: CFG.maxSolPerTrade,
    dailyEthCap: CFG.dailySolCap,
    dailyLossLimitEth: CFG.dailyLossLimitSol,
    maxOpenPositions: CFG.maxOpenPositions,
  };
  let health;
  try {
    health = executorHeartbeatHealth({
      entriesPaused: pauseEntries(), hardStop: hardStop(),
      blockingIntent: Boolean(journal.hasBlockingIntent()), positions: openList(),
      lastTickCompletedAt: runtimeHealth.lastTickCompletedAt,
      lastFeedSuccessAt: runtimeHealth.lastFeedSuccessAt,
      consecutiveFeedFailures: runtimeHealth.consecutiveFeedFailures,
      consecutiveTickFailures: runtimeHealth.consecutiveTickFailures,
      feedRollback: feedRollbackActive(),
      executionReadiness: runtimeHealth.executionReadiness,
      caps,
      runtimeCommit: process.env.EXECUTOR_SOURCE_COMMIT || null,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    });
  } catch {
    // Telemetry can lose detail; it can never stop the trading/reconciliation loop.
    health = executorHeartbeatHealth({
      entriesPaused: pauseEntries(), hardStop: hardStop(), blockingIntent: true,
      lastTickCompletedAt: runtimeHealth.lastTickCompletedAt,
      lastFeedSuccessAt: runtimeHealth.lastFeedSuccessAt,
      consecutiveFeedFailures: runtimeHealth.consecutiveFeedFailures,
      consecutiveTickFailures: runtimeHealth.consecutiveTickFailures + 1,
      feedRollback: feedRollbackActive(),
      executionReadiness: runtimeHealth.executionReadiness,
      caps,
      runtimeCommit: process.env.EXECUTOR_SOURCE_COMMIT || null,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
    });
  }
  fetch(`${API}/api/floor/${FLOOR}/executor/heartbeat`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      mode: EXECUTE ? "live" : "paper",
      chain: CHAIN_ID,
      wallet: WALLET,
      cursor: S.cursor,
      open: openList().length,
      // WHICH coins, not just how many. Token and size only: no prices, no PnL.
      held: openList().slice(0, 20).map((p) => ({
        mint: p.mint,
        eth: Number(weiToEth(p.entryInputWei || 0).toFixed(6)),
        openedAt: Number(p.openedAtMs) || 0,
      })),
      health,
      ts: Date.now(),
    }),
  }).catch(() => {});
}

/* Recovery is never allowed to sit unbounded in front of fresh position safety.
 * At most one exit-first intent is probed before manageOpen, and the tick waits no
 * more than one second for that observation-only pass. A full retry (resend, or a
 * cancel of a dropped nonce) is scheduled only after the tick's risk, feed and
 * heartbeat work has completed, and never overlaps another recovery pass. */
let recoveryPassInFlight = null;
const startRecoveryPass = (options) => {
  if (!EXECUTE || !executor || recoveryPassInFlight) return recoveryPassInFlight;
  const pass = Promise.resolve(executor.recoverPending(options))
    .catch((error) => log(`bounded recovery pass: ${error.message}`))
    .finally(() => { if (recoveryPassInFlight === pass) recoveryPassInFlight = null; });
  recoveryPassInFlight = pass;
  return pass;
};
async function boundedRecoveryBeforeRisk() {
  if (!EXECUTE) return;
  const pass = recoveryPassInFlight || startRecoveryPass({ observationOnly: true, maxIntents: 1 });
  if (!pass) return;
  await waitForRecoveryBudget(pass,
    Math.min(1_000, Math.max(100, Math.floor(POLL_MS / 4))));
}
const scheduleBackgroundRecovery = () => {
  if (!EXECUTE || recoveryPassInFlight) return;
  startRecoveryPass({ maxIntents: 1 });
};

async function tick() {
  if (ticking || shuttingDown) return;
  ticking = true;
  runtimeHealth.lastTickStartedAt = Date.now();
  let tickFailed = false;
  try {
    await boundedRecoveryBeforeRisk();
    accountConfirmedIntents();
    // Existing risk outranks new opportunity. A stop, age exit, balance ambiguity, or
    // emergency-impact block must update the durable book before an entry from this
    // feed tick can pass sizing and loss gates.
    await manageOpen();
    try {
      const response = await fetch(`${API}/api/floor/${FLOOR}/executor/feed?after=${S.cursor}`, {
        headers: { authorization: `Bearer ${SECRET}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        noteFeedFailure();
        log("feed authentication rejected — check CC_SECRET / CC_FLOOR");
      } else if (!response.ok) {
        noteFeedFailure();
        log(`feed HTTP ${response.status}`);
      }
      else {
        const payload = await response.json();
        /* THE FEED CONTRACT PINS THE CHAIN ON BOTH ENDS. This is the first place an
           accidental cross-wiring — this poller against the Solana desk's API, or the
           reverse — is caught, so it stays strict: a number, and exactly this one. */
        if (payload.chain !== CHAIN_ID) throw new Error(`feed chain is not ${CHAIN_ID}`);
        if (!Array.isArray(payload.events)) throw new Error("feed omitted its events array");
        const events = payload.events;
        /* Say why a call was NOT offered. Pure observability. */
        if (Array.isArray(payload.decisions)) {
          for (const d of [...payload.decisions].reverse()) {
            const at = Number(d?.delivered_at) || 0;
            if (at <= lastDecisionSeen || d?.verdict === "offered") continue;
            log(`NOT OFFERED ${d?.symbol || d?.call_id}: ${d?.reason || d?.verdict}`);
          }
          lastDecisionSeen = Math.max(lastDecisionSeen,
            ...payload.decisions.map((d) => Number(d?.delivered_at) || 0));
        }
        const feedCursor = authenticatedFeedCursorState(S.cursor, payload.latest_id);
        const latestId = feedCursor.latestId;
        if (feedCursor.rollback) {
          persistFeedRollback(latestId);
          noteFeedFailure();
          log(`CRITICAL FEED ROLLBACK: authenticated latest_id ${latestId} is behind durable cursor ` +
            `${S.cursor} — entries remain frozen; local position/risk exits continue`);
          return;
        }
        const returnedIds = events.map((event) => Number(event?.id));
        let previousId = S.cursor;
        for (const id of returnedIds) {
          if (!Number.isSafeInteger(id) || id <= previousId || id > latestId)
            throw new Error("feed event ids are not strictly increasing above the cursor or exceed latest_id");
          previousId = id;
        }
        clearFeedRollback();
        noteFeedSuccess();
        if (!S.primed) {
          S.primed = true;
          S.cursor = Math.max(S.cursor, latestId);
          save();
          log(`primed at cursor ${S.cursor} — ${events.length} historic event(s) skipped; trading forward only`);
        } else {
          // Exit safety is not held hostage by an earlier bad entry. Pre-latch/process
          // every exit in the validated batch before the sequential cursor pass.
          let unsafeExitPrepass = false;
          for (const ev of events.filter((event) => event.type === "exit")) {
            try {
              await handleDeskExitEvent(ev);
            } catch (error) {
              const positionLatched = S.positions[ev.mint]?.exitExecutionRequired === true;
              let deferred = false;
              try {
                const entry = journal.blockingEntryForDeskExit({ mint: ev.mint, callId: ev.call_id });
                deferred = Boolean(entry && journal.deferredDeskExitForEntry(entry.id));
              } catch {}
              if (!positionLatched && !deferred) unsafeExitPrepass = true;
              log(`EXIT PREPASS ${ev.symbol || ev.id}: ${error.message} — ` +
                `${positionLatched || deferred ? "durable exit remains latched" : "exit was not durably recorded"}`);
            }
          }
          const blockingIntent = journal.hasBlockingIntent();
          if (blockingIntent) {
            /* The server returns at most 50 rows. Cross the batch now: entries are
             * conservatively abandoned while exposure is frozen, and the next window
             * (and its exits) becomes visible on the next poll. Never jump straight to
             * latest_id — exits beyond this batch have not been seen yet. */
            if (unsafeExitPrepass) {
              log(`journal intent ${blockingIntent} is unresolved and an exit could not be recorded — ` +
                "cursor stays pinned; manual action required");
              return;
            }
            const nextCursor = advanceFrozenBatchCursor(S.cursor, events);
            if (nextCursor > S.cursor) {
              S.cursor = nextCursor;
              save();
              log(`journal intent ${blockingIntent} is unresolved — exits were preprocessed; ` +
                `new exposure stayed frozen and cursor advanced to ${S.cursor} to expose the next batch`);
            } else {
              log(`journal intent ${blockingIntent} is unresolved — exits stay latched and new exposure is frozen`);
            }
            return;
          }
          for (const ev of events) {
            try {
              if (ev.type === "entry") await onEntry(ev);
              else if (ev.type === "exit") {
                const disposition = await handleDeskExitEvent(ev);
                if (disposition === "not-held") log(`EXIT ${ev.symbol} — not held`);
              } else throw new Error(`unknown event type ${ev.type}`);
              S.cursor = Math.max(S.cursor, Number(ev.id));
              save();
            } catch (error) {
              const intent = ev.type === "entry"
                ? journal.getIntent(`entry:${ev.event_id || `${FLOOR}:${ev.id}`}`) : null;
              if (ev.type === "entry" && (!intent || ["planned", "failed", "expired"].includes(intent.state))) {
                // New exposure is optional; a permanently unsafe or pre-sign failed
                // entry must not become a head-of-line denial of every later exit.
                log(`SKIP ${ev.symbol || ev.id}: ${error.message} — entry acknowledged without a trade`);
                S.cursor = Number(ev.id);
                save();
                continue;
              }
              log(`ERROR on ${ev.symbol || ev.id}: ${error.message} — event remains pending`);
              break;
            }
          }
        }
      }
    } catch (error) { noteFeedFailure(); log(`poll error: ${error.message}`); }
  } catch (error) {
    tickFailed = true;
    log(`tick safety stop: ${error.message}`);
  } finally {
    runtimeHealth.lastTickCompletedAt = Date.now();
    runtimeHealth.consecutiveTickFailures = tickFailed
      ? runtimeHealth.consecutiveTickFailures + 1 : 0;
    maybeProbeExecutionReadiness();
    sendHeartbeat();
    ticking = false;
    scheduleBackgroundRecovery();
  }
}

log(`up — floor ${FLOOR} — wallet ${WALLET} — chain ${CHAIN_ID} — ${EXECUTE ? "LIVE" : "PAPER"}`);
log(`caps: ${CFG.maxSolPerTrade} ETH/trade, ${CFG.dailySolCap} ETH/rolling 24h deploy, ${CFG.dailyLossLimitSol} ETH/rolling realized-loss entry brake, ${CFG.maxOpenPositions} open`);
log(`registry: slippage ${EXECUTOR_CFG.slippageBps} bps, impact cap ${EXECUTOR_CFG.maxPriceImpactPct}%, ` +
  `fee gate ${EXECUTOR_CFG.maxNetworkFeeWei} wei, round-trip gas ${EXECUTOR_CFG.roundTripGasUnits}${EXECUTE ? "" : " (paper stand-ins where the registry is VOID)"}`);
log(`journal: ${STATE_DB}; entries pause: ${PAUSE_ENTRIES_FILE}; ` +
  `sleep fault: ${SLEEP_ASSERTION_FAULT_FILE}; hard stop: ${HARD_STOP_FILE}`);
log(`resuming ${openList().length} position(s) from cursor ${S.cursor}`);
await tick();
setInterval(tick, POLL_MS);
