/**
 * WALL-ST-E DASHBOARD CONTRACT
 *
 * This module turns the local executor's outbound heartbeat and one read-only
 * public-chain balance lookup into a small UI payload. It deliberately contains no
 * command, signing, secret, RPC proxy, or cap-changing field: the website can observe
 * the tenant's machine, but it cannot operate it.
 *
 * ROBINHOOD EDITION. Addresses are EVM (0x, lowercase in storage); the balance is native
 * ETH on chain 4663, carried as `wei` (decimal string) + `eth` (number). The heartbeat's
 * wire names are the executor lane's (executor/poller.mjs sendHeartbeat, read 2026-09-05):
 * caps.{maxEthPerTrade, dailyEthCap, dailyLossLimitEth, maxOpenPositions},
 * executionReadiness.{route: "eth-usdg", amountWei: <decimal string>}, held[].eth.
 * This reader and office.js sanitizeExecutorHealth changed together with them. A heartbeat
 * still under the Solana names (maxSolPerTrade, amountLamports, "wsol-usdc") reads as
 * "caps not reported" and "not rehearsed" — the honest state for a bot that has not been
 * rebuilt for 4663, and the reason the old names are not accepted as aliases.
 */
import { isEvmAddress, normalise } from "./lib/address.js";

export const EXECUTOR_HEARTBEAT_STALE_MS = 150_000;
export const EXECUTOR_READINESS_STALE_MS = 5 * 60_000;
/* The executor's LIVE_LIMITS and OPERATOR_MAX (executor/poller.mjs): the ETH translation
   of the owner's SOL canary at $2,450/ETH, MARKED THERE AS AWAITING OWNER CONFIRMATION.
   test-executor-dashboard.mjs pins both sets to the poller source so they cannot drift
   apart silently. */
export const EXECUTOR_CANARY_DEFAULTS = Object.freeze({
  maxEthPerTrade: 0.0004,
  rolling24hDeployEth: 0.0008,
  rolling24hRealizedLossBrakeEth: 0.0008,
  maxOpenPositions: 4,
});
export const EXECUTOR_GAS_HEADROOM_ETH_PLACEHOLDER = 0.001;
export const EXECUTOR_OPERATOR_MAXIMA = Object.freeze({
  maxEthPerTrade: 0.004,
  rolling24hDeployEth: 0.04,
  rolling24hRealizedLossBrakeEth: 0.012,
  maxOpenPositions: 4,
});
/** The 4663 rehearsal pair (executor/evm-executor.mjs EXECUTION_READINESS_ROUTE). */
export const EXECUTOR_READINESS_ROUTE = "eth-usdg";

/** The poller's own rounding (executor/poller.mjs ethToWei): a cap is rounded to six
 *  decimals of ETH — a micro-ETH — and then scaled, exact in BigInt. Reproduced here
 *  rather than multiplying by 1e18 because the readiness-covers-cap identity below
 *  compares the rehearsal's wei to the cap's wei: a cap of 0.0004567 ETH rehearses at
 *  457000000000000 wei, and cap * 1e18 is 456700000000000 — an honest bot would fail the
 *  check. (For the shipped defaults both forms agree; measured 2026-09-05.) */
export const ethToWei = (eth) => {
  const n = Number(eth);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.floor(n * 1e6 + 1e-9)) * 10n ** 12n;   // floor, as the poller does: never UP past a cap
};
/** The largest rehearsal the operator ceiling allows, in wei. */
export const READINESS_MAX_WEI = ethToWei(EXECUTOR_OPERATOR_MAXIMA.maxEthPerTrade);
/** A rehearsal amount as a bounded decimal string of wei, or "0" for anything else. A
 *  STRING by contract — the executor sends String(); a number would be exact below 2^53
 *  wei (~9 ETH) but a typed field is one fewer thing for a reader to guess about. */
export const weiString = (value) => {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,30}$/.test(value)) return "0";
  const v = BigInt(value);
  return v >= 1n && v <= READINESS_MAX_WEI ? v.toString() : "0";
};

const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const count = (value) => Math.min(1_000_000, Math.max(0, Math.floor(finite(value, 0))));

const timestamp = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const publicReadiness = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ready: value.ready === true,
    lastSuccessAt: timestamp(value.lastSuccessAt),
    observedAt: timestamp(value.observedAt),
    route: value.route === EXECUTOR_READINESS_ROUTE ? EXECUTOR_READINESS_ROUTE : null,
    providers: Number(value.providers) === 2 ? 2 : 0,
    amountWei: weiString(value.amountWei),
    // Why the rehearsal did not pass, as the bot reported it. "0/2" alone sent an
    // operator to the source to find out whether the probe even existed.
    lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 300) : null,
  };
};

const publicCaps = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const caps = {
    maxEthPerTrade: finite(value.maxEthPerTrade),
    rolling24hDeployEth: finite(value.dailyEthCap),
    rolling24hRealizedLossBrakeEth: finite(value.dailyLossLimitEth),
    maxOpenPositions: Number(value.maxOpenPositions),
  };
  if (!(caps.maxEthPerTrade >= 0.000001 &&
      caps.maxEthPerTrade <= EXECUTOR_OPERATOR_MAXIMA.maxEthPerTrade &&
      caps.rolling24hDeployEth >= 0.000001 &&
      caps.rolling24hDeployEth >= caps.maxEthPerTrade &&
      caps.rolling24hDeployEth <= EXECUTOR_OPERATOR_MAXIMA.rolling24hDeployEth &&
      caps.rolling24hRealizedLossBrakeEth >= 0.000001 &&
      caps.rolling24hRealizedLossBrakeEth <= EXECUTOR_OPERATOR_MAXIMA.rolling24hRealizedLossBrakeEth &&
      Number.isInteger(caps.maxOpenPositions) && caps.maxOpenPositions >= 1 &&
      caps.maxOpenPositions <= EXECUTOR_OPERATOR_MAXIMA.maxOpenPositions)) return null;
  return caps;
};

const publicHealth = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = ["healthy", "entries-paused", "degraded", "manual-action", "exits-blocked"]
    .includes(value.state) ? value.state : "degraded";
  return {
    state,
    entriesPaused: value.entriesPaused === true,
    hardStop: value.hardStop === true,
    blockingIntent: value.blockingIntent === true,
    blockedPositions: count(value.blockedPositions),
    manualAction: value.manualAction === true,
    exitBlocked: value.exitBlocked === true,
    feedRollback: value.feedRollback === true,
    lastTickCompletedAt: timestamp(value.lastTickCompletedAt),
    lastFeedSuccessAt: timestamp(value.lastFeedSuccessAt),
    consecutiveFeedFailures: count(value.consecutiveFeedFailures),
    consecutiveTickFailures: count(value.consecutiveTickFailures),
    executionReadiness: publicReadiness(value.executionReadiness),
    caps: publicCaps(value.caps),
    runtimeCommit: /^[0-9a-f]{7,40}$/i.test(String(value.runtimeCommit || ""))
      ? String(value.runtimeCommit).slice(0, 40).toLowerCase() : null,
    runtimeFingerprint: /^[0-9a-f]{32}$/i.test(String(value.runtimeFingerprint || ""))
      ? String(value.runtimeFingerprint).toLowerCase() : null,
  };
};

const publicHeartbeat = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wallet = isEvmAddress(value.wallet) ? normalise(value.wallet) : null;
  const mode = value.mode === "live" || value.mode === "paper" ? value.mode : "unknown";
  const health = publicHealth(value.health);
  return {
    mode,
    wallet,
    cursor: count(value.cursor),
    open: count(value.open),
    held: Array.isArray(value.held) ? value.held.slice(0, 20).map((holding) => ({
      mint: isEvmAddress(holding?.mint) ? normalise(holding.mint) : null,
      eth: Math.max(0, finite(holding?.eth, 0)),
      openedAt: timestamp(holding?.openedAt),
    })).filter((holding) => holding.mint) : [],
    health,
    ts: timestamp(value.ts),
    seenAt: timestamp(value.seenAt),
  };
};

const publicSettings = (settings = {}) => ({
  appetite: ["conservative", "balanced", "aggressive"].includes(settings.appetite)
    ? settings.appetite : "balanced",
  bankrollSol: Math.max(0, finite(settings.bankrollSol, 0)),
  instantDelivery: settings.instantDelivery === true,
  categories: Array.isArray(settings.categories)
    ? settings.categories.filter((value) => typeof value === "string").slice(0, 24) : [],
  launchpads: Array.isArray(settings.launchpads)
    ? settings.launchpads.filter((value) => typeof value === "string").slice(0, 24) : [],
  minLiquidityUsd: Math.max(0, finite(settings.minLiquidityUsd, 0)),
  takeProfitX: Math.max(0, finite(settings.takeProfitX, 0)),
  fixedSol: Math.max(0, finite(settings.fixedSol, 0)),
  marketCapTier: typeof settings.marketCapTier === "string"
    ? settings.marketCapTier.slice(0, 32) : "any",
  updatedAt: timestamp(settings.updatedAt),
});

export const BALANCE_SOURCE = "robinhood-4663-latest-read";

/* wei arrives as a decimal STRING (a JS number loses wei precision above ~9 ETH). */
const weiOf = (value) => {
  try { const v = BigInt(String(value)); return v >= 0n ? v : null; } catch { return null; }
};

const publicBalance = (wallet, result, requiredForReadinessEth = null) => {
  if (!wallet) return {
    address: null, balanceEth: null, balanceWei: null,
    state: "not-reported", source: null, observedAt: null,
    requiredForReadinessEth: null,
  };
  const wei = weiOf(result?.wei);
  const eth = Number(result?.eth);
  const ok = result?.ok === true && wei != null && Number.isFinite(eth) && eth >= 0;
  if (!ok) return {
    address: wallet, balanceEth: null, balanceWei: null,
    state: "unavailable", source: BALANCE_SOURCE, observedAt: null,
    requiredForReadinessEth,
  };
  const threshold = Number(requiredForReadinessEth);
  const state = wei === 0n ? "empty" : !(Number.isFinite(threshold) && threshold > 0)
    ? "active-caps-unavailable" : eth < threshold
      ? "below-readiness-reserve" : "ready-balance";
  return {
    address: wallet, balanceEth: eth, balanceWei: wei.toString(),
    state, source: BALANCE_SOURCE, observedAt: timestamp(result.observedAt) || null,
    requiredForReadinessEth: Number.isFinite(threshold) && threshold > 0 ? threshold : null,
  };
};

export function buildExecutorDashboard({
  heartbeatLog = [],
  floorNo,
  settings = {},
  heartbeat = null,
  balanceResult = null,
  nowMs = Date.now(),
} = {}) {
  const now = timestamp(nowMs) || Date.now();
  const pulse = publicHeartbeat(heartbeat);
  const ageMs = pulse?.seenAt ? Math.max(0, now - pulse.seenAt) : null;
  const connected = ageMs != null && ageMs <= EXECUTOR_HEARTBEAT_STALE_MS;
  const filters = publicSettings(settings);
  const activeCaps = pulse?.health?.caps ?? null;
  /* A display threshold only: the active trade plus gas headroom. There is no rent on
     an EVM chain; the gas figure is a PLACEHOLDER, not a measurement — eth_gasPrice on
     4663 moved 0.02 → 0.7 gwei in two weeks and spikes >5 gwei, and the executor lane
     owns the live number (executor/live-thresholds.mjs). 0.001 ETH covers ~200k gas at
     5 gwei; it will be replaced by the executor's own reserve once the heartbeat
     carries it. */
  const requiredForReadinessEth = activeCaps
    ? activeCaps.maxEthPerTrade + EXECUTOR_GAS_HEADROOM_ETH_PLACEHOLDER : null;
  const wallet = publicBalance(pulse?.wallet ?? null, balanceResult, requiredForReadinessEth);
  const readiness = pulse?.health?.executionReadiness;
  const readinessLastSuccessAt = timestamp(readiness?.lastSuccessAt);
  const readinessObservedAt = timestamp(readiness?.observedAt);
  const readinessFresh = readinessLastSuccessAt > 0 && readinessObservedAt > 0 &&
    readinessLastSuccessAt <= now + 60_000 && readinessObservedAt <= now + 60_000 &&
    now - readinessLastSuccessAt <= EXECUTOR_READINESS_STALE_MS &&
    now - readinessObservedAt <= EXECUTOR_READINESS_STALE_MS;
  // The rehearsal must be the SAME size as the active cap, in the poller's own wei
  // rounding: a raised executor cannot inherit readiness from the smaller default probe.
  const readinessCoversActiveCap = Boolean(activeCaps && readiness &&
    readiness.amountWei !== "0" && BigInt(readiness.amountWei) === ethToWei(activeCaps.maxEthPerTrade));
  const executionReadinessReady = Boolean(readinessFresh && readiness?.ready === true &&
    readiness.route === EXECUTOR_READINESS_ROUTE && readiness.providers === 2 && readinessCoversActiveCap);
  // The monitor treats every missing, stale, incomplete, or wrong-size live rehearsal
  // as critical. Preserve the poller's higher-severity states, but do not let the
  // human-facing status contradict that same evidence by displaying healthy/paused.
  const displayedPulse = pulse?.mode === "live" && pulse.health && !executionReadinessReady &&
    (pulse.health.state === "healthy" || pulse.health.state === "entries-paused")
    ? { ...pulse, health: { ...pulse.health, state: "degraded" } } : pulse;

  return {
    floorNo: Number(floorNo),
    telemetry: {
      source: "self-reported-by-tenant-machine",
      connected,
      // Oldest first, bounded: the WALL-ST-E tab had no history at all before this.
      history: Array.isArray(heartbeatLog) ? heartbeatLog.slice(-48).map((h) => ({
        seenAt: timestamp(h?.seenAt), mode: String(h?.mode ?? "").slice(0, 16),
        open: count(h?.open), state: h?.state == null ? null : String(h.state).slice(0, 32),
      })).filter((h) => h.seenAt) : [],
      ageMs,
      staleAfterMs: EXECUTOR_HEARTBEAT_STALE_MS,
      heartbeat: displayedPulse,
    },
    wallet,
    filters,
    activation: {
      feedCredentialReady: settings.feedCredentialReady === true,
      heartbeatSeen: Boolean(pulse),
      // A stale heartbeat is historical evidence, not present-tense readiness. Keep
      // its last-reported values visible for diagnosis, but never let them complete
      // an activation step or imply that the current process still owns this wallet.
      currentPaperMode: connected && pulse?.mode === "paper",
      currentLiveMode: connected && pulse?.mode === "live",
      executionReadinessReady: connected && executionReadinessReady,
      walletReported: connected && Boolean(wallet.address),
      walletFunded: connected && Boolean(activeCaps) && wallet.state === "ready-balance",
    },
    boundary: {
      custody: "tenant-machine-only",
      remoteControl: false,
      browserSigning: false,
      balanceReadOnly: true,
    },
    capPolicy: {
      active: activeCaps,
      activeFresh: connected && Boolean(activeCaps),
      canaryDefaults: EXECUTOR_CANARY_DEFAULTS,
      operatorMaxima: EXECUTOR_OPERATOR_MAXIMA,
      raisedCapsRequire: "local-versioned-wallet-and-values-acknowledgement",
      lossControl: "rolling-realized-loss-entry-brake-not-loss-guarantee",
    },
  };
}
