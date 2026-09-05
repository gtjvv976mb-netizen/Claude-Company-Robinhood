/**
 * THE NONCE STATE MACHINE. HOW A TRADE GETS ONTO ROBINHOOD CHAIN WITHOUT WEDGING.
 *
 * jupiter.mjs spent 2,474 lines and seven review rounds proving one thing: never
 * disclose bytes that can still land twice, and never freeze an exit behind a stuck
 * entry. Its whole design rested on a Solana fact — signed bytes become PROVABLY
 * un-landable after ~150 blocks, and that proof is what let `expired` grant a fresh
 * signature safely. EVM has no expiry. A signed transaction at nonce N is valid until
 * nonce N is consumed by ANY transaction from this account, you cannot send N+1 until
 * N lands, and on 4663 the sequencer silently excludes transactions with no receipt at
 * all, so "no receipt" is the ORDINARY failure, not evidence of anything. A naive port
 * that mapped "no receipt" to `ambiguous` would reproduce the permanent-latch failure
 * the Solana build documented (LESSONS: "an exit delayed one tick beats an exit
 * disarmed forever") — with no expiry to ever release it.
 *
 * So the machine here is different in one load-bearing place: a dropped transaction is
 * not waited out, it is CANCELLED. A 0-value self-transfer at the same nonce, bid above
 * the original, consumes N; once ITS receipt is on both providers the dropped bytes are
 * provably dead and the intent may be rebuilt. Whether the sequencer honours same-nonce
 * replacement at all on an FCFS chain with no fee auction is UNMEASURED (registered as
 * exec.nonceReplacementHonoured, VOID, in live-thresholds.mjs) — which is exactly why
 * the cancel path never depends on it: if the cancel is also dropped it is resent, and
 * if the original lands first that is a receipt like any other.
 *
 * The transitions, each of which is a test in test-evm-execution.mjs:
 *
 *   planned  → signed     bytes proven with eth_call at block B; nonce N =
 *                         max(journal.next_nonce, eth_getTransactionCount pending on
 *                         BOTH providers), refused when the providers disagree; signed
 *                         locally; journaled (write-ahead, next_nonce advances in the
 *                         same transaction) BEFORE any disclosure.
 *   signed   → submitted  markSubmitted FIRST, then eth_sendRawTransaction. The hash
 *                         the node returns must equal the journaled hash or the row is
 *                         quarantined: bytes that hash to something else are not ours.
 *   submitted→ confirmed  receipt on BOTH providers, same block, status 0x1. Output
 *                         from the Transfer log to this wallet (ERC-20 out) or the
 *                         balance delta across the block (native out); fee = gasUsed ×
 *                         effectiveGasPrice.
 *   submitted→ failed     receipt on both, status 0x0. Fee-bearing; the nonce is
 *                         consumed; the next attempt uses a fresh nonce.
 *   submitted→ expired    no receipt past deadline_block AND txCount == N on both AND
 *                         eth_getTransactionByHash null on both: the sequencer dropped
 *                         it. CANCEL at N → wait for the cancel's receipt on both →
 *                         markCancelled (original + cancel rows expired, cancel fee
 *                         booked) → rebuild next tick at the next free nonce.
 *   submitted→ ambiguous  txCount > N on both with no receipt for any hash this journal
 *                         holds at N (something else consumed N); or a receipt seen on
 *                         one provider only past the deadline; or the providers
 *                         disagree on txCount. Manual reconciliation. QUARANTINE does
 *                         not disarm the cancel path for a safety exit: an exit may
 *                         still free a nonce; HARD_STOP blocks everything.
 *
 * Approvals are their own intents (kind "approval"): a sell is approve(N) then
 * swap(N+1), or approve(0) N, approve(x) N+1, swap N+2 for tokens that refuse a
 * non-zero → non-zero change. A dropped approve strands the swap, so every approval
 * goes through this same machine and the swap is not even BUILT until the allowance
 * has been READ back from the chain (approvals.mjs assertApproved).
 *
 * The invariants carried over verbatim from the Solana build: simulate UNSIGNED before
 * signing and the first disclosure is the send; write-ahead markSubmitted; exits retry
 * past the entry cap but only FEE-BEARING attempts spend the budget; any observation
 * anywhere permanently withdraws replacement authority; the counterparty may not
 * author the number that checks the counterparty (evm-swap.mjs).
 */
import { Wallet, Transaction } from "ethers";
import { prepareSwap, quote, build, NATIVE_SENTINEL, isNative } from "./evm-swap.mjs";
import { planApproval, assertApproved, residualAllowance } from "./approvals.mjs";
import { validateExecutableEntryOrder } from "./entry-quote-guard.mjs";
import { validateExecutableExitOrder } from "./exit-trigger.mjs";
import { CURRENT_TX_ATTEMPT_PROTOCOL, isExitAsset } from "./journal.mjs";
import {
  CHAIN_ID, both, proveChain, pendingNonceConsensus, latestNonces, receiptConsensus,
  unknownOnBoth, headConsensus, gasPriceConsensus, balanceOnBoth, erc20Balance,
  erc20DecimalsConsensus, hex, fromHex, fromHexNumber, isAddress, RpcError,
} from "./evm-rpc.mjs";

/* The office's heartbeat sanitizer (src/executor-dashboard.js EXECUTOR_READINESS_ROUTE,
   read by src/office.js) accepts exactly this string for the 4663 rehearsal pair — native
   ETH into USDG through Kyber. Any other spelling sanitises to route: null and the office
   records the executor as degraded forever. Verified against both readers 2026-09-05. */
export const EXECUTION_READINESS_ROUTE = "eth-usdg";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** What the readiness rehearsal insists stays untouched in the wallet, beyond the
 *  trade and the fee ceiling: 0.001 ETH, so a rehearsal never rehearses the last wei. */
export const EXECUTION_READINESS_RESERVE_WEI = 10n ** 15n;
export const CANCEL_GAS_LIMIT = 21_000n;

const DEFAULT_CONFIG = Object.freeze({
  slippageBps: null,             // from the thresholds registry; null refuses to arm
  maxPriceImpactPct: null,       // ditto
  maxNetworkFeeWei: null,        // the GATE: gasLimit × maxFeePerGas above this refuses
  expectedNetworkFeeWei: null,   // the COST MODEL, used by sizing; never the gate
  maxTransferTaxBps: 0,
  deadlineBlocks: 300,           // ~30s at 100ms blocks: past this, no receipt = dropped
  receiptTimeoutMs: 30_000,      // how long one reconcile pass waits for a receipt
  cancelTimeoutMs: 45_000,
  maxAttempts: 3,
  maxExitAttempts: 12,
  exitRetryCooldownMs: 60_000,
  gasLimitMultiplier: 1.3,
  maxGasLimit: 3_000_000n,
  maxEntryQuoteDriftPct: 5,
  maxEntryPreflightAgeMs: 60_000,
  maxExitTriggerAgeMs: 60_000,
  maxCancelResends: 3,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isWei = (v) => /^\d+$/.test(String(v ?? ""));
const positiveWei = (value, label) => {
  if (!isWei(value) || BigInt(value) <= 0n) throw new Error(`${label} must be a positive integer`);
  return BigInt(value);
};
const lower = (a) => String(a || "").toLowerCase();

/** Read a 0600, owner-only, 32-byte hex key file into an ethers Wallet. Never logs
 *  the key; the only thing that ever leaves this function is the address. */
export function walletFromKeyFile(file, { fs, requirePrivate = true, uid = null }) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("KEY_FILE must be a regular, non-symlink file");
  if (requirePrivate) {
    if ((st.mode & 0o077) !== 0) throw new Error(`live key file permissions must be 0600 (chmod 600 ${file})`);
    if (uid != null && st.uid !== uid) throw new Error("live key file must be owned by the service user");
  }
  const text = fs.readFileSync(file, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(text))
    throw new Error("KEY_FILE does not contain a 32-byte hex private key");
  return new Wallet(text.startsWith("0x") ? text : "0x" + text);
}

export class EvmExecutor {
  constructor({ providers, wallet, journal, hardStop, submissionGate, log, now = Date.now,
    config = {}, sleepFn = sleep }) {
    if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1])
      throw new Error("EvmExecutor needs two distinct RPC providers");
    if (!wallet || typeof wallet.signTransaction !== "function" || !isAddress(wallet.address))
      throw new Error("EvmExecutor needs an ethers Wallet");
    if (!journal) throw new Error("EvmExecutor needs the journal");
    this.providers = providers;
    this.primary = providers[0];
    this.secondary = providers[1];
    this.wallet = wallet;
    this.address = wallet.address;
    this.journal = journal;
    this.hardStop = typeof hardStop === "function" ? hardStop : () => false;
    this.submissionGate = typeof submissionGate === "function" ? submissionGate : () => {};
    this.log = typeof log === "function" ? log : () => {};
    this.now = now;
    this.sleep = sleepFn;
    this.cfg = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this.inFlightIntents = new Map();
    this.lastBoundedRecoveryIntentId = null;
    for (const key of ["slippageBps", "maxNetworkFeeWei"]) {
      if (this.cfg[key] == null) throw new Error(`EvmExecutor config.${key} is unset — the thresholds registry has not supplied it`);
    }
  }

  /* ── intent scope ──────────────────────────────────────────────────────── */

  _isSafetyExit(intent) {
    return (intent.kind === "risk_exit" || intent.kind === "desk_exit") &&
      lower(intent.inputMint) === lower(intent.mint) && isExitAsset(intent.outputMint) &&
      lower(intent.context?.position?.mint) === lower(intent.mint);
  }

  _inFlightConflict(intent, exceptId = null) {
    for (const [id, other] of this.inFlightIntents) {
      if (id === intent.id || id === exceptId) continue;
      // A child approval runs inside its parent's scope and is not a conflict with it.
      if (intent.context?.parent === id || other.context?.parent === intent.id) continue;
      if (lower(other.mint) === lower(intent.mint)) return id;
      if (!this._isSafetyExit(intent) && !(intent.kind === "approval" && intent.context?.forExit)) return id;
    }
    return null;
  }

  async _withIntentScope(intent, fn) {
    const conflict = this._inFlightConflict(intent);
    if (conflict) throw new Error(`in-flight intent ${conflict} conflicts with ${intent.id}; submission serialized`);
    this.inFlightIntents.set(intent.id, intent);
    try { return await fn(); }
    finally { this.inFlightIntents.delete(intent.id); }
  }

  _validateIntentSpec(spec) {
    if (!spec || typeof spec !== "object") throw new Error("intent spec is invalid");
    if (!["entry", "risk_exit", "desk_exit", "approval"].includes(spec.kind)) throw new Error(`intent kind ${spec.kind} is unsupported`);
    for (const key of ["mint", "inputMint", "outputMint"])
      if (!isAddress(spec[key])) throw new Error(`intent ${key} is not an address`);
    if (spec.kind === "approval") { if (!isWei(spec.amountRaw)) throw new Error("approval amountRaw is invalid"); }
    else positiveWei(spec.amountRaw, "intent amountRaw");
    if (spec.kind === "entry" && !(isNative(spec.inputMint) && lower(spec.outputMint) === lower(spec.mint)))
      throw new Error("an entry must spend native ETH into the named token");
    if ((spec.kind === "risk_exit" || spec.kind === "desk_exit") &&
        !(lower(spec.inputMint) === lower(spec.mint) && isExitAsset(spec.outputMint)))
      throw new Error("an exit must sell the named token into ETH");
    if (spec.context?.wallet && lower(spec.context.wallet) !== lower(this.address))
      throw new Error(`intent ${spec.id} belongs to a different wallet`);
  }

  /* ── the entry point the poller calls ──────────────────────────────────── */

  async executeIntent(spec) {
    this._validateIntentSpec(spec);
    let intent = this.journal.ensureIntent({ ...spec, context: { ...(spec.context || {}), wallet: this.address } });
    return this._withIntentScope(intent, async () => {
      intent = this.journal.getIntent(intent.id);
      this._validateIntentSpec(intent);
      if (intent.state === "accounted" || intent.state === "confirmed") return intent;
      if (intent.state === "ambiguous") {
        // Quarantine is observation-first; an exit may free its nonce via cancel.
        const resolved = await this._reconcile(intent, this.journal.latestAttempt(intent.id), { finalityTimeoutMs: 0 });
        if (["confirmed", "accounted"].includes(resolved.state)) return resolved;
        throw new Error(`intent ${intent.id} is AMBIGUOUS; existing transaction is recovery-only (${resolved.error || "no new evidence"})`);
      }
      const blocking = this.journal.hasConflictingIntent(intent);
      if (blocking) throw new Error(`unresolved intent ${blocking} conflicts with ${intent.kind} ${intent.id}`);

      let attempt = this.journal.latestAttempt(intent.id);
      if (attempt && ["signed", "submitted"].includes(attempt.state)) return this._resume(intent, attempt);
      const attempts = this.journal.attempts(intent.id);
      const count = attempts.length;
      const isExit = intent.kind !== "entry";
      const exitCap = this.cfg.maxExitAttempts;
      // Only FEE-BEARING attempts spend the exit budget: a cancelled/expired attempt cost
      // a cancel's 21,000 gas at most and proved nothing about the market.
      const feeAttempts = attempts.filter((a) => a.state === "failed").length;
      if (isExit && feeAttempts >= exitCap)
        throw new Error(`exit intent ${intent.id} exhausted ${exitCap} fee-bearing attempts — manual intervention required`);
      if (!isExit && count >= this.cfg.maxAttempts)
        throw new Error(`intent ${intent.id} exhausted ${this.cfg.maxAttempts} attempts`);
      if (isExit && feeAttempts >= this.cfg.maxAttempts) {
        const lastFee = attempts.filter((a) => a.state === "failed").at(-1);
        const last = lastFee?.updatedAt ?? lastFee?.createdAt ?? 0;
        if (this.now() - Number(last) < this.cfg.exitRetryCooldownMs)
          throw new Error(`exit intent ${intent.id} is cooling down after ${feeAttempts} fee-bearing attempts`);
        this.log(`exit ${intent.id}: retrying past the entry cap — fee-bearing attempt ${feeAttempts + 1} of ${exitCap}`);
      }
      if (this.hardStop()) throw new Error("HARD STOP is present — no new submission");
      if (intent.kind === "entry") this.submissionGate(intent);

      const prepared = await this._prepareUnsigned(intent);
      // A safety exit may start while an unrelated entry is in its pre-sign build.
      // Re-check at the durable boundary; the unjournaled bytes never left memory.
      const concurrent = this._inFlightConflict(intent, intent.id);
      const newlyBlocking = this.journal.hasConflictingIntent(intent);
      if (concurrent || newlyBlocking)
        throw new Error(`submission scope changed during build; unresolved intent ${concurrent || newlyBlocking} now conflicts with ${intent.id}`);
      if (this.hardStop()) throw new Error("HARD STOP appeared during build — nothing signed");
      attempt = await this._signAndJournal(intent, prepared, count + 1);
      intent = this.journal.getIntent(intent.id);
      return this._resume(intent, attempt);
    });
  }

  /* ── build ─────────────────────────────────────────────────────────────── */

  async _prepareUnsigned(intent) {
    if (intent.kind === "approval") {
      const { token, spender, calldata } = intent.context || {};
      if (!isAddress(token) || !isAddress(spender) || typeof calldata !== "string" || !calldata.startsWith("0x095ea7b3"))
        throw new Error(`approval ${intent.id} carries no approve() calldata`);
      return { to: token, data: calldata, value: 0n, quotedOut: 0n, minOut: 0n,
        order: { role: "approval", token, spender, amount: intent.amountRaw } };
    }
    if (intent.kind === "entry") {
      const prepared = await prepareSwap(this.primary, {
        tokenIn: NATIVE_SENTINEL, tokenOut: intent.mint, amountIn: BigInt(intent.amountRaw),
        sender: this.address, slippageBps: this.cfg.slippageBps, direction: "buy",
        hazards: { maxTaxBps: this.cfg.maxTransferTaxBps },
        maxPriceImpactPct: this.cfg.maxPriceImpactPct,
      });
      // The entry guard binds the FINAL executable order to the independently
      // monitored mark; the floor it sees is the one read out of the calldata.
      validateExecutableEntryOrder(intent, {
        inAmount: intent.amountRaw, outAmount: prepared.quotedOut.toString(),
        otherAmountThreshold: prepared.embeddedFloor.toString(),
      }, { nowMs: this.now(), maxEntryQuoteDriftPct: this.cfg.maxEntryQuoteDriftPct,
        maxEntryPreflightAgeMs: this.cfg.maxEntryPreflightAgeMs });
      return { to: prepared.to, data: prepared.data, value: prepared.value,
        quotedOut: prepared.quotedOut, minOut: prepared.embeddedFloor,
        order: { role: "swap", direction: "buy", router: prepared.to, quotedOut: prepared.quotedOut.toString(),
          embeddedFloor: prepared.embeddedFloor.toString(), simulatedOut: prepared.simulatedOut.toString(),
          extractableGap: prepared.extractableGap.toString(), driftFromQuoteBps: prepared.driftFromQuoteBps,
          slippageBps: prepared.slippageBps, gas: prepared.gas, priceImpactPct: prepared.priceImpactPct ?? null,
          hazards: prepared.hazards ?? null } };
    }
    // An exit: the allowance comes first, as its own intents, and the swap is only
    // built once the allowance has been read back from the chain.
    const spender = await this._ensureApprovals(intent);
    /* NO SCREEN ON THE WAY OUT. The scope guard and the hazard reads judge what the desk
       may BUY; the asset here is already held, and a token-controlled fact — a name that
       starts carrying "Robinhood Token", a beacon slot that reads unreadable for one
       tick — must never strand its own exit. The output is asserted native/WETH below,
       so there is nothing left to scope. (Review, 2026-09-05.) */
    const prepared = await prepareSwap(this.primary, {
      tokenIn: intent.mint, tokenOut: NATIVE_SENTINEL, amountIn: BigInt(intent.amountRaw),
      sender: this.address, slippageBps: this.cfg.slippageBps, direction: "sell", scopeCheck: false,
    });
    if (lower(prepared.to) !== lower(spender))
      throw new Error(`the sell routed through ${prepared.to} but the allowance was granted to ${spender}; refusing to sign a swap the allowance does not cover`);
    validateExecutableExitOrder(intent, {
      outAmount: prepared.quotedOut.toString(), otherAmountThreshold: prepared.embeddedFloor.toString(),
    }, { nowMs: this.now(), maxExitTriggerAgeMs: this.cfg.maxExitTriggerAgeMs });
    return { to: prepared.to, data: prepared.data, value: 0n,
      quotedOut: prepared.quotedOut, minOut: prepared.embeddedFloor,
      order: { role: "swap", direction: "sell", router: prepared.to, quotedOut: prepared.quotedOut.toString(),
        embeddedFloor: prepared.embeddedFloor.toString(), simulatedOut: prepared.simulatedOut.toString(),
        extractableGap: prepared.extractableGap.toString(), driftFromQuoteBps: prepared.driftFromQuoteBps,
        slippageBps: prepared.slippageBps, gas: prepared.gas, spender } };
  }

  /** Discover the router, plan the allowance, run each step as its own intent through
   *  this machine, then READ the allowance back. Returns the spender. */
  async _ensureApprovals(intent) {
    const amount = BigInt(intent.amountRaw);
    const route = await quote({ tokenIn: intent.mint, tokenOut: NATIVE_SENTINEL, amountIn: amount, to: this.address });
    const built = await build(route, { sender: this.address, recipient: this.address, slippageBps: this.cfg.slippageBps });
    const spender = built.routerAddress;
    if (!isAddress(spender)) throw new Error("the aggregator named no router to approve");
    const balance = await erc20Balance(this.primary, intent.mint, this.address);
    if (balance < amount)
      throw new Error(`wallet holds ${balance} of ${intent.mint} but the exit sells ${amount} — custody must be reconciled before selling`);
    const plan = await planApproval(this.primary, { token: intent.mint, owner: this.address, spender, amount, balance });
    for (const [index, step] of plan.steps.entries()) {
      const childId = `${intent.id}:approve:${index + 1}`;
      const child = await this.executeIntent({
        id: childId, kind: "approval", eventId: null, feedId: null,
        mint: intent.mint, inputMint: intent.mint, outputMint: spender, amountRaw: step.amount.toString(),
        context: { forExit: true, parent: intent.id, token: intent.mint, spender, calldata: step.data,
          position: intent.context?.position ?? null, step: index + 1, of: plan.steps.length, reason: plan.reason },
      });
      if (child.state !== "accounted")
        throw new Error(`approval ${childId} is ${child.state}; the sell waits for the allowance to land`);
    }
    await assertApproved(this.primary, { token: intent.mint, owner: this.address, spender, amount });
    return spender;
  }

  /* ── the durable signing boundary ──────────────────────────────────────── */

  async _nonceWithRunway(intent) {
    const chainNonce = await pendingNonceConsensus(this.providers, this.address);
    const journalNext = this.journal.nextNonce();
    const nonce = Math.max(chainNonce, journalNext ?? 0);
    if (journalNext != null && chainNonce > journalNext)
      this.log(`nonce: chain pending ${chainNonce} is ahead of the journal's ${journalNext} — something outside this journal sent from ${this.address}; following the chain`);
    // Strictly sequential: any unresolved attempt at a LOWER nonce must resolve first,
    // or this transaction would queue behind it forever. Reconcile it now (which may
    // cancel it); if it is still unresolved, HOLD rather than sign into a wedge.
    const mayCancel = this._isSafetyExit(intent) || (intent.kind === "approval" && intent.context?.forExit === true);
    for (const pending of this.journal.pendingIntents()) {
      if (pending.id === intent.id) continue;
      const latest = this.journal.latestAttempt(pending.id);
      if (!latest || latest.nonce == null || latest.nonce >= nonce) continue;
      if (!["signed", "submitted", "ambiguous"].includes(latest.state)) continue;
      // A safety exit waits for the cancel's receipt here rather than one tick: an exit
      // delayed a tick beats one disarmed, and an exit not delayed at all beats both.
      // "cancelled — may be rebuilt" is thrown by design so no caller mistakes a cancel
      // for a fill; for THIS caller it is the outcome it was waiting for.
      try {
        await this._reconcile(pending, latest, { finalityTimeoutMs: mayCancel ? this.cfg.cancelTimeoutMs : 0, allowCancel: mayCancel });
      } catch (error) {
        this.log(`nonce runway ${intent.id}: ${pending.id}: ${String(error.message).slice(0, 160)}`);
      }
      const stillOpen = this.journal.latestAttempt(pending.id);
      if (["signed", "submitted", "ambiguous"].includes(stillOpen?.state))
        throw new Error(`nonce ${latest.nonce} is still occupied by ${pending.id} (${stillOpen.state}); holding ${intent.id} rather than queueing behind it`);
    }
    return nonce;
  }

  async _signAndJournal(intent, prepared, attemptNo) {
    const value = BigInt(prepared.value ?? 0n);
    const call = { from: this.address, to: prepared.to, data: prepared.data };
    if (value > 0n) call.value = hex(value);
    // Gas is estimated on the FUNDED wallet against live state; the sim in prepareSwap
    // already proved the bytes, so an estimate that fails here means state moved.
    let estimated;
    try { estimated = fromHex(await this.primary("eth_estimateGas", [call]), "gas estimate"); }
    catch (error) { throw new Error(`gas estimate refused the proven bytes (${error.message.slice(0, 120)}) — state moved since simulation; rebuild`); }
    let gasLimit = estimated * BigInt(Math.round(this.cfg.gasLimitMultiplier * 100)) / 100n;
    if (gasLimit > this.cfg.maxGasLimit) gasLimit = this.cfg.maxGasLimit;
    if (gasLimit < estimated) throw new Error(`gas estimate ${estimated} exceeds the ${this.cfg.maxGasLimit} ceiling`);
    // Read per ticket, never cached: it moved 0.02 → 0.7 gwei in two weeks.
    const gas = await gasPriceConsensus(this.providers);
    const maxFeePerGas = gas.max * 2n;
    const worstFee = gasLimit * maxFeePerGas;
    const maxFee = BigInt(this.cfg.maxNetworkFeeWei);
    /* THE GATE. Nothing below models cost from this number; sizing reads
       expectedNetworkFeeWei. One constant doing both jobs stalled the Solana bot. */
    if (worstFee > maxFee)
      throw new Error(`worst-case network fee ${worstFee} wei (${gasLimit} gas × ${maxFeePerGas} wei) exceeds the ${maxFee} wei ceiling — refusing`);
    const head = await headConsensus(this.providers);
    const provenAtBlock = head.low;
    const deadlineBlock = provenAtBlock + this.cfg.deadlineBlocks;
    const nonce = await this._nonceWithRunway(intent);
    const tx = Transaction.from({
      type: 2, chainId: CHAIN_ID, nonce, to: prepared.to, data: prepared.data, value,
      gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n,
    });
    const rawTx = await this.wallet.signTransaction(tx);
    const txHash = Transaction.from(rawTx).hash;
    const attempt = this.journal.recordSigned(intent.id, {
      attempt: attemptNo, nonce, chainId: CHAIN_ID, txHash, rawTx, provenAtBlock, deadlineBlock,
      gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(),
      quotedOutputRaw: prepared.quotedOut.toString(), minOutputRaw: prepared.minOut.toString(),
      order: { ...prepared.order, gasPriceWei: gas.max.toString(), estimatedGas: estimated.toString(), to: prepared.to,
        value: value.toString(), worstFeeWei: worstFee.toString() },
    });
    this.log(`${intent.kind} ${intent.id}: signed attempt ${attemptNo} at nonce ${nonce}, hash ${txHash}, ` +
      `proven at block ${provenAtBlock}, deadline ${deadlineBlock}, gas ${gasLimit} × ${maxFeePerGas} wei max`);
    return attempt;
  }

  /* ── disclosure and reconciliation ─────────────────────────────────────── */

  async _resume(intent, attempt) {
    if (attempt.protocol !== CURRENT_TX_ATTEMPT_PROTOCOL) {
      this.log(`recovery ${intent.id}: attempt ${attempt.attempt} carries protocol ${attempt.protocol ?? "null"}, not ${CURRENT_TX_ATTEMPT_PROTOCOL}; observation-only`);
      return this._reconcile(intent, attempt, { finalityTimeoutMs: 0, allowCancel: false, allowSend: false });
    }
    if (attempt.state === "signed") {
      // Never disclosed. If the quote has aged past its deadline the bytes are stale
      // (their floor was measured at provenAtBlock) but they were never sent, so
      // expiring them is free and safe: nothing can land.
      const head = await headConsensus(this.providers);
      if (head.low > attempt.deadlineBlock) {
        this.journal.markExpiredUndisclosed(intent.id, attempt.attempt,
          `signed at block ${attempt.provenAtBlock}, never disclosed, deadline ${attempt.deadlineBlock} passed at ${head.low}`);
        throw new Error(`intent ${intent.id} attempt ${attempt.attempt} expired undisclosed; may be rebuilt next tick`);
      }
      if (this.hardStop()) throw new Error("HARD STOP is present — signed bytes are not disclosed");
      if (intent.kind === "entry") this.submissionGate(intent);
      // WRITE-AHEAD: the journal says "submitted" before the network can know.
      this.journal.markSubmitted(intent.id, attempt.attempt);
      await this._send(intent, attempt);
      return this._reconcile(intent, this.journal.latestAttempt(intent.id), {});
    }
    return this._reconcile(intent, attempt, {});
  }

  async _send(intent, attempt) {
    // How many times these exact bytes have been handed to the network. A resend is the
    // same hash and cannot race itself, but it is still a count the cancel bound reads.
    const sends = Number(attempt.execute?.sends ?? 0) + 1;
    try {
      const returned = await this.primary("eth_sendRawTransaction", [attempt.rawTx]);
      if (lower(returned) !== lower(attempt.txHash)) {
        this.journal.markAmbiguous(intent.id, attempt.attempt,
          `node returned hash ${returned} for bytes journaled as ${attempt.txHash}`);
        throw new Error(`intent ${intent.id}: returned hash does not match the journaled hash; quarantined`);
      }
      this.journal.recordExecuteResponse(intent.id, attempt.attempt, { sentAt: this.now(), hash: returned, sends });
    } catch (error) {
      if (this.journal.getIntent(intent.id).state === "ambiguous") throw error;
      // "nonce too low"/"already known" mean the network already has it or something
      // consumed N; either way reconcile decides. A transport failure is UNKNOWN, never
      // failure — the bytes may have been received.
      this.log(`send ${intent.id}: ${String(error.message).slice(0, 160)}; reconciling ${attempt.txHash}`);
      this.journal.recordExecuteResponse(intent.id, attempt.attempt, { sentAt: this.now(), error: String(error.message).slice(0, 200), sends });
    }
  }

  _hashesAtNonce(intent, attempt) {
    return this.journal.attemptsAtNonce(attempt.nonce)
      .filter((a) => a.intentId === intent.id && a.txHash)
      .map((a) => ({ attempt: a.attempt, txHash: a.txHash, role: a.order?.role === "cancel" ? "cancel" : "tx", cancelOf: a.order?.cancelOf ?? null }));
  }

  async _reconcile(intent, attempt, { finalityTimeoutMs = this.cfg.receiptTimeoutMs, allowCancel = true, allowSend = true } = {}) {
    if (!attempt || attempt.nonce == null) return this.journal.getIntent(intent.id);
    const deadlineAt = this.now() + Math.max(0, finalityTimeoutMs);
    const swapRow = this._hashesAtNonce(intent, attempt).find((h) => h.role === "tx") ??
      { attempt: attempt.attempt, txHash: attempt.txHash, role: "tx" };
    wait: for (;;) {
      const rows = this._hashesAtNonce(intent, attempt);
      // 1. Receipts for every hash this journal holds at nonce N, on both providers.
      for (const row of rows) {
        const seen = await receiptConsensus(this.providers, row.txHash);
        if (seen.agreed) return this._settleReceipt(intent, row, seen.agreed);
        if (seen.disagreement)
          this.log(`reconcile ${intent.id}: providers disagree on ${row.txHash}: ${seen.disagreement}`);
        const oneSided = seen.receipts.some((r) => r) && !seen.receipts.every((r) => r);
        if (oneSided) {
          // AN OBSERVATION ANYWHERE WITHDRAWS REPLACEMENT AUTHORITY. One provider says
          // these bytes landed; until both agree either way nothing at N may be sent,
          // and past the deadline the row is quarantined rather than cancelled over.
          // (`continue wait`, not the row loop: falling through here reached the cancel
          // path on 2026-09-05 and the test caught it.)
          const head = await headConsensus(this.providers);
          if (head.low > attempt.deadlineBlock && this.now() >= deadlineAt) {
            this.journal.markAmbiguous(intent.id, row.attempt,
              `receipt for ${row.txHash} is visible on one provider only past deadline block ${attempt.deadlineBlock}`);
            return this.journal.getIntent(intent.id);
          }
          if (this.now() >= deadlineAt) return this.journal.getIntent(intent.id);
          await this.sleep(500);
          continue wait;
        }
      }
      // 2. No receipt anywhere. Before the deadline, the sequencer may still include it.
      const head = await headConsensus(this.providers);
      const current = this.journal.getIntent(intent.id);
      if (head.low <= attempt.deadlineBlock) {
        if (this.now() >= deadlineAt) return current;
        await this.sleep(500);
        continue;
      }
      // 3. Past the deadline with no receipt: the nonce decides.
      const [na, nb] = await latestNonces(this.providers, this.address);
      const n = attempt.nonce;
      if (na !== nb) {
        this.log(`reconcile ${intent.id}: providers disagree on the mined nonce (${na} vs ${nb}); holding`);
        return current;
      }
      if (na > n) {
        // Something consumed N and it was none of our hashes: quarantine. If a cancel
        // of ours is still unreceipted, keep checking it above on the next pass.
        if (rows.some((r) => r.role === "cancel") && this.now() < deadlineAt) { await this.sleep(500); continue; }
        this.journal.markAmbiguous(intent.id, swapRow.attempt,
          `nonce ${n} was consumed on both providers (mined nonce ${na}) by a transaction this journal does not hold — manual reconciliation`);
        return this.journal.getIntent(intent.id);
      }
      if (na < n) {
        this.log(`reconcile ${intent.id}: mined nonce ${na} is below attempt nonce ${n} on both providers; holding`);
        return current;
      }
      // na === n: nothing at N has landed. Is our hash known to either node?
      const unknowns = [];
      for (const row of rows) unknowns.push(await unknownOnBoth(this.providers, row.txHash));
      if (!unknowns.every((u) => u.unknown)) {
        this.log(`reconcile ${intent.id}: a transaction at nonce ${n} is known to a provider but has no receipt past the deadline; holding`);
        if (this.now() >= deadlineAt) return current;
        await this.sleep(500);
        continue;
      }
      // DROPPED on both. The safe transition is not "rebuild at N": the old bytes never
      // expire and two transactions at N would race. Consume N with a cancel.
      if (current.state === "ambiguous" && !(allowCancel && this._isSafetyExit(current))) return current;
      if (!allowCancel || !allowSend) return current;
      if (this.hardStop()) {
        this.log(`reconcile ${intent.id}: nonce ${n} is dropped but HARD STOP is present; no cancel sent`);
        return current;
      }
      const cancels = rows.filter((r) => r.role === "cancel");
      const cancelRows = this.journal.attempts(intent.id).filter((a) => cancels.some((c) => c.attempt === a.attempt));
      const cancelSends = cancelRows.reduce((sum, a) => sum + Number(a.execute?.sends ?? 1), 0);
      if (cancelSends >= this.cfg.maxCancelResends) {
        this.journal.markAmbiguous(intent.id, swapRow.attempt,
          `nonce ${n} dropped and the cancel was sent ${cancelSends} times without a receipt — cancels were also dropped; same-nonce replacement may not be honoured (exec.nonceReplacementHonoured is unmeasured); manual reconciliation`);
        return this.journal.getIntent(intent.id);
      }
      if (cancels.length) {
        // Resend the identical cancel bytes; same hash, idempotent.
        await this._send(intent, cancelRows.at(-1));
      } else {
        await this._sendCancel(intent, attempt);
      }
      if (this.now() >= deadlineAt) return this.journal.getIntent(intent.id);
      await this.sleep(500);
    }
  }

  async _sendCancel(intent, attempt) {
    const gas = await gasPriceConsensus(this.providers);
    const original = BigInt(attempt.maxFeePerGas);
    const bumped = original * 125n / 100n;
    const maxFeePerGas = bumped > gas.max * 2n ? bumped : gas.max * 2n;
    const worstFee = CANCEL_GAS_LIMIT * maxFeePerGas;
    /* A cancel is a fee-bearing send like any other: at a >5 gwei spike 21,000 gas can be
       half the canary. Above the ceiling we HOLD (the dropped bytes stay dead until their
       nonce is consumed) rather than sign — review, 2026-09-05. */
    const cancelCeiling = this.cfg?.maxNetworkFeeWei != null ? BigInt(this.cfg.maxNetworkFeeWei) : null;
    if (cancelCeiling != null && worstFee > cancelCeiling)
      throw new Error(`cancel at nonce ${attempt.nonce} would cost up to ${worstFee} wei, above the network-fee ceiling ${cancelCeiling} — holding until gas falls`);
    const head = await headConsensus(this.providers);
    const tx = Transaction.from({
      type: 2, chainId: CHAIN_ID, nonce: attempt.nonce, to: this.address, data: "0x", value: 0n,
      gasLimit: CANCEL_GAS_LIMIT, maxFeePerGas, maxPriorityFeePerGas: 0n,
    });
    const rawTx = await this.wallet.signTransaction(tx);
    const txHash = Transaction.from(rawTx).hash;
    const attemptNo = this.journal.attempts(intent.id).length + 1;
    const cancel = this.journal.recordCancel(intent.id, attempt.attempt, {
      attempt: attemptNo, nonce: attempt.nonce, chainId: CHAIN_ID, txHash, rawTx,
      provenAtBlock: head.low, deadlineBlock: head.low + this.cfg.deadlineBlocks,
      gasLimit: CANCEL_GAS_LIMIT.toString(), maxFeePerGas: maxFeePerGas.toString(),
      order: { worstFeeWei: worstFee.toString(), originalMaxFeePerGas: original.toString() },
    });
    this.log(`${intent.id}: nonce ${attempt.nonce} dropped by the sequencer (no receipt on either provider past block ${attempt.deadlineBlock}); ` +
      `CANCEL ${txHash} sent at ${maxFeePerGas} wei/gas (original ${original})`);
    await this._send(intent, cancel);
  }

  async _settleReceipt(intent, row, receipt) {
    const gasUsed = fromHex(receipt.gasUsed, "gasUsed");
    const price = fromHex(receipt.effectiveGasPrice ?? receipt.gasPrice ?? "0x0", "effectiveGasPrice");
    const fee = gasUsed * price;
    const blockNumber = fromHexNumber(receipt.blockNumber, "blockNumber");
    const finalizedAtMs = this.now();
    if (row.role === "cancel") {
      const original = row.cancelOf ?? this.journal.attempts(intent.id).find((a) => a.nonce != null && a.order?.role !== "cancel")?.attempt;
      this.journal.markCancelled(intent.id, original, row.attempt, {
        networkFeeWei: fee.toString(), finalizedAtMs, blockNumber, txHash: row.txHash });
      throw new Error(`intent ${intent.id}: dropped attempt ${original} cancelled by ${row.txHash} in block ${blockNumber}; may be rebuilt next tick`);
    }
    if (receipt.status === "0x0") {
      this.journal.markFinalizedFailure(intent.id, row.attempt,
        `transaction ${row.txHash} reverted on chain in block ${blockNumber} (status 0x0, ${gasUsed} gas burned)`,
        { networkFeeWei: fee.toString(), finalizedAtMs }, { receipt: { blockNumber, status: receipt.status } });
      throw new Error(`intent ${intent.id} attempt ${row.attempt} reverted on chain; fee ${fee} wei accounted`);
    }
    if (receipt.status !== "0x1") {
      this.journal.markAmbiguous(intent.id, row.attempt, `receipt for ${row.txHash} has status ${receipt.status}`);
      throw new Error(`intent ${intent.id}: receipt status ${receipt.status} is neither success nor failure; quarantined`);
    }
    const output = await this._measureOutput(intent, receipt, fee);
    if (intent.kind !== "approval" && output <= 0n) {
      this.journal.markAmbiguous(intent.id, row.attempt,
        `receipt ${row.txHash} succeeded but no ${intent.outputMint} reached ${this.address}`);
      throw new Error(`intent ${intent.id}: success receipt with no observable output; quarantined`);
    }
    const confirmed = this.journal.markConfirmed(intent.id, row.attempt, {
      totalInputAmount: intent.amountRaw, totalOutputAmount: output.toString(),
      networkFeeWei: fee.toString(), txHash: row.txHash, finalizedAtMs,
    }, { receipt: { blockNumber, status: receipt.status, gasUsed: gasUsed.toString(), effectiveGasPrice: price.toString() } });
    if (intent.kind === "approval") return this.journal.markApprovalSettled(intent.id);
    this.log(`${intent.kind} ${intent.id}: CONFIRMED in block ${blockNumber} — in ${intent.amountRaw}, out ${output}, fee ${fee} wei — ${row.txHash}`);
    return confirmed;
  }

  /** Output from the receipt itself (ERC-20 out) or the balance delta across the
   *  block (native out). Both are chain facts; neither is the aggregator's word. */
  async _measureOutput(intent, receipt, fee) {
    if (intent.kind === "approval") return 0n;
    if (isExitAsset(intent.outputMint) && isNative(intent.outputMint)) {
      const block = fromHexNumber(receipt.blockNumber, "blockNumber");
      const [beforeA, beforeB] = await balanceOnBoth(this.providers, this.address, hex(block - 1));
      const [afterA, afterB] = await balanceOnBoth(this.providers, this.address, hex(block));
      if (beforeA !== beforeB || afterA !== afterB)
        throw new Error(`providers disagree on the wallet balance around block ${block}`);
      // The sell spent nothing but gas, so what came back is the delta plus the fee.
      return afterA - beforeA + fee;
    }
    let total = 0n;
    for (const log of receipt.logs ?? []) {
      if (lower(log.address) !== lower(intent.outputMint)) continue;
      if (!Array.isArray(log.topics) || lower(log.topics[0]) !== TRANSFER_TOPIC) continue;
      if (lower("0x" + String(log.topics[2] || "").slice(-40)) !== lower(this.address)) continue;
      total += fromHex(log.data, "transfer amount");
    }
    return total;
  }

  /* ── recovery ──────────────────────────────────────────────────────────── */

  async recoverPending({ observationOnly = false, maxIntents = Infinity } = {}) {
    const recovered = [];
    const limit = maxIntents === Infinity ? Infinity : Number(maxIntents);
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error("recovery maxIntents must be a positive integer");
    const ordered = this.journal.pendingIntents()
      .filter((intent) => intent.state !== "confirmed")
      .sort((left, right) =>
        Number(!this._isSafetyExit(left)) - Number(!this._isSafetyExit(right)) ||
        Number(left.createdAt) - Number(right.createdAt) || left.id.localeCompare(right.id));
    const safety = ordered.filter((intent) => this._isSafetyExit(intent));
    const pool = limit !== Infinity && safety.length ? safety : ordered;
    let rotated = pool;
    if (limit !== Infinity && pool.length > 1 && this.lastBoundedRecoveryIntentId) {
      const prior = pool.findIndex((intent) => intent.id === this.lastBoundedRecoveryIntentId);
      if (prior >= 0) rotated = [...pool.slice(prior + 1), ...pool.slice(0, prior + 1)];
    }
    const pending = rotated.slice(0, limit);
    if (limit !== Infinity && pending.length) this.lastBoundedRecoveryIntentId = pending.at(-1).id;
    for (const intent of pending) {
      const attempt = this.journal.latestAttempt(intent.id);
      if (!attempt) continue;
      try {
        const value = await this._withIntentScope(intent, async () => {
          const current = this.journal.getIntent(intent.id);
          const latest = this.journal.latestAttempt(intent.id);
          if (!latest || current.state === "confirmed" || current.state === "accounted") return current;
          // Observation-only: receipts and nonces are read, nothing is sent or cancelled.
          if (observationOnly)
            return this._reconcile(current, latest, { finalityTimeoutMs: 0, allowCancel: false, allowSend: false });
          if (current.state === "ambiguous")
            return this._reconcile(current, latest, { finalityTimeoutMs: 0, allowCancel: this._isSafetyExit(current) });
          try { this._validateIntentSpec(current); }
          catch (error) {
            this.log(`recovery ${current.id}: ${error.message}; reconciling malformed intent without submission`);
            return this._reconcile(current, latest, { finalityTimeoutMs: 0, allowCancel: false, allowSend: false });
          }
          const blocking = this.journal.hasConflictingIntent(current);
          if (blocking) {
            this.log(`recovery ${current.id}: conflicting intent ${blocking}; reconciling without submission`);
            return this._reconcile(current, latest, { allowSend: false, allowCancel: false });
          }
          return this._resume(current, latest);
        });
        recovered.push(value);
      } catch (error) { this.log(`recovery ${intent.id}: ${error.message}`); }
    }
    return recovered;
  }

  /* ── rehearsal and marks ───────────────────────────────────────────────── */

  /** Nothing signed, nothing journaled: prove both providers, the wallet reserve,
   *  and that a real route at the live cap builds and executes in eth_call. */
  async probeExecutionReadiness({ amountWei } = {}) {
    const amount = positiveWei(amountWei, "execution-readiness amount");
    await proveChain(this.providers);
    const head = await headConsensus(this.providers);
    if (head.high - head.low > 50)
      throw new Error(`providers are ${head.high - head.low} blocks apart (${head.heads.join("/")}); a lagging provider cannot prove absence`);
    const balances = await balanceOnBoth(this.providers, this.address);
    const required = amount + BigInt(this.cfg.maxNetworkFeeWei) + EXECUTION_READINESS_RESERVE_WEI;
    if (balances.some((b) => b < required))
      throw new Error(`execution-readiness wallet reserve is insufficient on one or both RPC providers (need ${required} wei: trade + fee ceiling + 0.001 ETH reserve; have ${balances.join("/")})`);
    const prepared = await prepareSwap(this.primary, {
      tokenIn: NATIVE_SENTINEL, tokenOut: USDG, amountIn: amount, sender: this.address,
      slippageBps: this.cfg.slippageBps, direction: "buy", scopeCheck: true, hazards: null,
    });
    const gas = await gasPriceConsensus(this.providers);
    return Object.freeze({
      ready: true, observedAt: Number(this.now()), route: EXECUTION_READINESS_ROUTE, providers: 2,
      amountWei: amount.toString(), simulatedOut: prepared.simulatedOut.toString(),
      gasPriceWei: gas.max.toString(), heads: head.heads,
    });
  }

  /** Buy leg proven with eth_call (scope + hazards), reverse leg quoted with the exact
   *  output. Quote noise on this chain is ~0.9% (probe.quoteNoisePct); the entry guard
   *  compares against a 12%-class floor, so a quoted return leg is adequate here. */
  async preflightEntry(token, amountWei) {
    const amount = positiveWei(amountWei, "preflight amount");
    const prepared = await prepareSwap(this.primary, {
      tokenIn: NATIVE_SENTINEL, tokenOut: token, amountIn: amount, sender: this.address,
      slippageBps: this.cfg.slippageBps, direction: "buy", hazards: { maxTaxBps: this.cfg.maxTransferTaxBps },
      maxPriceImpactPct: this.cfg.maxPriceImpactPct,
    });
    const reverse = await quote({ tokenIn: token, tokenOut: NATIVE_SENTINEL, amountIn: prepared.simulatedOut, to: this.address });
    const back = BigInt(reverse.amountOut);
    const lossPct = Number((amount - back) * 1_000_000n / amount) / 10_000;
    return { forward: { outAmount: prepared.simulatedOut.toString(), quoted: prepared.quotedOut.toString() },
      reverse: { outAmount: back.toString() }, lossPct, prepared };
  }

  /** The exit mark: what selling the whole position returns, per the aggregator's
   *  route. Documented downgrade from the Solana build, which simulated this — a sell
   *  simulation needs the allowance in place, and the wallet only grants that when it
   *  is actually selling. The policy consumes this number only through
   *  executableExitMark, whose stop logic tolerates quote noise by design. */
  async preflightExitMark({ mint, amountRaw }) {
    const amount = positiveWei(amountRaw, "exit mark amount");
    const route = await quote({ tokenIn: mint, tokenOut: NATIVE_SENTINEL, amountIn: amount, to: this.address });
    return { actualOutputRaw: String(route.amountOut), source: "aggregator-quote", observedAt: this.now() };
  }

  async tokenDecimals(token) { return erc20DecimalsConsensus(this.providers, token); }

  async residualAllowanceAfterExit(token, spender) {
    return residualAllowance(this.primary, { token, owner: this.address, spender });
  }
}

export { RpcError, both };
