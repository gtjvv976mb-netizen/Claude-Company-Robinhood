/**
 * THE LEDGER, V2: WEI, NONCES, HASHES, CANCELS — AND THE FORWARD-ONLY MIGRATION.
 *
 * The Solana journal's tests are kept where the invariant is chain-agnostic (write-ahead
 * durability, idempotent accounting, exact 24h risk windows, corrupt-row refusal, the
 * legacy risk-history quarantine, protocol provenance). What is new is the schema: an
 * attempt now carries the nonce it claims, the hash its bytes hash to and the block
 * window it was proven in; every amount is a wei string; approvals are intents; and a
 * file written by the OLD schema — NOT NULL Solana columns, INTEGER lamports — must
 * open, keep its rows, and treat them as observation-only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CURRENT_TX_ATTEMPT_PROTOCOL, ExecutionJournal, JOURNAL_SCHEMA_VERSION, NATIVE_ASSET,
  acquireProcessLock, positionEntryBlock, trackedBalanceDecision,
} from "./journal.mjs";
import { ETH_USD_CACHE_SOURCE } from "./eth-usd-oracle.mjs";
import { freshState } from "./strategy.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-journal-"));
const file = path.join(dir, "state.sqlite");
const addr = (seed) => "0x" + seed.toString(16).padStart(40, "0");
const hash = (seed) => "0x" + seed.toString(16).padStart(64, "0");
const wallet = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const TOKEN = addr(0xaa);
let tests = 0;
const ok = (name, fn) => {
  fn();
  tests++;
  console.log(`  ok   ${name}`);
};
const evmAttempt = (n, { nonce, txHash, rawTx = "0x02f8" + "ab".repeat(40), quoted = "1000", min = "970" } = {}) => ({
  attempt: n, nonce, chainId: 4663, txHash, rawTx, provenAtBlock: 1_000, deadlineBlock: 1_300,
  gasLimit: "260000", maxFeePerGas: "800000000", quotedOutputRaw: quoted, minOutputRaw: min,
  order: { role: "swap", router: addr(0xbb) },
});

let j = new ExecutionJournal(file, { wallet });
ok("journal is owner-only", () => assert.equal(fs.statSync(file).mode & 0o077, 0));
ok("journal binds its wallet", () => assert.equal(j.getMeta("wallet"), wallet));
ok("a fresh journal records schema version 2", () => assert.equal(j.getMeta("schema_version"), JOURNAL_SCHEMA_VERSION));
ok("a fresh journal has no nonce opinion yet — the chain supplies the first one", () => assert.equal(j.nextNonce(), null));

const spec = {
  id: "entry:50:entry:101", kind: "entry", eventId: "50:entry:101", feedId: 101,
  mint: TOKEN, inputMint: NATIVE_ASSET, outputMint: TOKEN,
  amountRaw: "1000000000000000", context: { callId: 7 },
};
const intent = j.ensureIntent(spec);
ok("intent begins planned", () => assert.equal(intent.state, "planned"));
ok("same feed intent is idempotent", () => assert.equal(j.ensureIntent(spec).id, spec.id));
ok("same id cannot change amount", () => assert.throws(
  () => j.ensureIntent({ ...spec, amountRaw: "1000000000000001" }), /changed amountRaw/));
ok("an approval intent is a first-class kind and may carry a zero amount (zero-first)", () => {
  const a = j.ensureIntent({ id: "x:approve:1", kind: "approval", mint: TOKEN, inputMint: TOKEN, outputMint: addr(0xbb), amountRaw: "0" });
  assert.equal(a.kind, "approval");
  assert.equal(a.amountRaw, "0");
});
ok("a non-approval intent may not carry a zero amount", () => assert.throws(
  () => j.ensureIntent({ ...spec, id: "zero", eventId: "zero", amountRaw: "0" }), /must be positive/));

ok("recordSigned refuses an attempt without EVM provenance", () => {
  assert.throws(() => j.recordSigned(spec.id, { attempt: 1, quotedOutputRaw: "1", minOutputRaw: "1", order: {} }), /nonce must be/);
  assert.throws(() => j.recordSigned(spec.id, evmAttempt(1, { nonce: 5, txHash: "not-a-hash" })), /32-byte hex hash/);
  assert.throws(() => j.recordSigned(spec.id, { ...evmAttempt(1, { nonce: 5, txHash: hash(1) }), chainId: 1 }), /chainId 1 is not 4663/);
  assert.throws(() => j.recordSigned(spec.id, { ...evmAttempt(1, { nonce: 5, txHash: hash(1) }), deadlineBlock: 999 }), /deadlineBlock must follow/);
});
j.recordSigned(spec.id, evmAttempt(1, { nonce: 5, txHash: hash(1) }));
ok("signed bytes, nonce, hash and block window are durable before submission", () => {
  const a = j.latestAttempt(spec.id);
  assert.equal(a.state, "signed");
  assert.equal(a.nonce, 5);
  assert.equal(a.chainId, 4663);
  assert.equal(a.txHash, hash(1));
  assert.equal(a.rawTx, "0x02f8" + "ab".repeat(40));
  assert.equal(a.provenAtBlock, 1_000);
  assert.equal(a.deadlineBlock, 1_300);
  assert.equal(a.gasLimit, "260000");
  assert.equal(a.protocol, CURRENT_TX_ATTEMPT_PROTOCOL);
  assert.equal(a.blockhash, null, "no Solana columns are written");
});
ok("meta.next_nonce advanced in the same transaction as the signature", () => assert.equal(j.nextNonce(), 6));
ok("a hash is unique across the ledger", () => {
  j.ensureIntent({ ...spec, id: "other", eventId: "other", feedId: 102 });
  assert.throws(() => j.recordSigned("other", evmAttempt(1, { nonce: 6, txHash: hash(1) })), /UNIQUE|constraint/i);
});
ok("a fresh signature may never reuse a nonce this ledger handed out", () =>
  assert.throws(() => j.recordSigned("other", evmAttempt(1, { nonce: 5, txHash: hash(2) })), /below the journal's next nonce 6/));
j.close();

j = new ExecutionJournal(file, { wallet, create: false });
ok("restart recovers the identical hash, bytes and nonce", () => {
  const a = j.latestAttempt(spec.id);
  assert.equal(a.txHash, hash(1));
  assert.equal(a.nonce, 5);
  assert.equal(a.rawTx, "0x02f8" + "ab".repeat(40));
  assert.equal(a.protocol, CURRENT_TX_ATTEMPT_PROTOCOL);
  assert.equal(j.pendingIntents()[0].id, spec.id);
  assert.equal(j.nextNonce(), 6);
});
ok("a reopen does not migrate an already-v2 file", () => assert.equal(j.migrated, false));
j.markSubmitted(spec.id, 1);
j.recordExecuteResponse(spec.id, 1, { sentAt: 1, hash: hash(1), sends: 1 });
ok("markConfirmed needs a wei fee and the transaction hash", () => {
  assert.throws(() => j.markConfirmed(spec.id, 1, { totalInputAmount: "1000000000000000", totalOutputAmount: "987", networkFeeWei: "x", txHash: hash(1) }), /non-negative integer/);
  assert.throws(() => j.markConfirmed(spec.id, 1, { totalInputAmount: "1000000000000000", totalOutputAmount: "987", networkFeeWei: "5", txHash: "nope" }), /transaction hash/);
});
j.markConfirmed(spec.id, 1, {
  totalInputAmount: "1000000000000000", totalOutputAmount: "987", networkFeeWei: "60000000000000",
  txHash: hash(1), finalizedAtMs: Date.now(),
}, { receipt: { blockNumber: 1_010, status: "0x1" } });
ok("actual fill totals, not quote output, are recorded, and the fee is wei", () => {
  const value = j.getIntent(spec.id);
  assert.equal(value.actualOutputRaw, "987");
  assert.notEqual(value.actualOutputRaw, "1000");
  assert.equal(value.networkFeeWei, "60000000000000");
  assert.equal(value.txHash, hash(1));
});

const runtime = {
  cursor: 101, primed: true,
  state: freshState(1),
  positions: { [TOKEN]: { mint: TOKEN, symbol: "TEST", qtyRaw: "987",
    paidEth: 0.00106, costBasisWei: "1060000000000000", entryInputWei: "1000000000000000",
    ethUsdAtEntry: 2455, ethUsdSource: ETH_USD_CACHE_SOURCE,
    entryIntentId: spec.id, openedAtMs: 1, entry: 1, stop: 0.6,
    callId: 7, takeProfitX: 2, honorDeskTarget: true, riskF: 0.02 } },
};
j.markAccounted(spec.id, runtime);
const accountedRisk = j.rollingRisk();
j.markAccounted(spec.id, runtime);
/* rollingRisk() stamps riskWindowAsOf with Date.now() on every call; two calls a
   millisecond apart are not "different risk", and the Solana repo's CI runner lost
   exactly that race (…895 vs …894, 2026-09-05). Compare the risk, bound the clock. */
const sansClock = (r) => { const { riskWindowAsOf, ...rest } = r; return rest; };
ok("accounting replay is idempotent and cannot duplicate risk events", () => {
  const again = j.rollingRisk();
  assert.deepEqual(sansClock(again), sansClock(accountedRisk));
  assert.ok(Math.abs(again.riskWindowAsOf - accountedRisk.riskWindowAsOf) < 5_000, "risk window clocks within 5s");
});
ok("rolling risk is exact in wei and only approximate in the shared *Sol vocabulary", () => {
  assert.equal(accountedRisk.deployedTodayWei, "1060000000000000");
  assert.equal(accountedRisk.deployedTodaySol, 0.00106);
});
j.close();
j = new ExecutionJournal(file, { wallet, create: false });
ok("fill accounting and cursor commit together", () => {
  const snap = j.snapshot();
  assert.equal(j.getIntent(spec.id).state, "accounted");
  assert.equal(snap.cursor, 101);
  assert.equal(snap.positions[TOKEN].qtyRaw, "987");
  assert.equal(snap.positions[TOKEN].costBasisWei, "1060000000000000");
});
ok("rolling deployment expires only after its exact 24-hour boundary", () => {
  const occurredAt = j.getIntent(spec.id).confirmedAt;
  assert.equal(j.rollingRisk(occurredAt + 24 * 60 * 60_000 - 1).deployedTodayWei, "1060000000000000");
  assert.equal(j.rollingRisk(occurredAt + 24 * 60 * 60_000).deployedTodayWei, "0");
});
const failedSpec = { ...spec, id: "entry:50:entry:failed-fee", eventId: "50:entry:failed-fee", feedId: 103 };
j.ensureIntent(failedSpec);
j.recordSigned(failedSpec.id, evmAttempt(1, { nonce: 6, txHash: hash(3) }));
j.markSubmitted(failedSpec.id, 1);
j.markFinalizedFailure(failedSpec.id, 1, "status 0x0", { networkFeeWei: "40000000000000", finalizedAtMs: Date.now() }, { receipt: { status: "0x0" } });
ok("a reverted (status 0x0) attempt debits deployment and realized-loss rails by its gas", () => {
  const risk = j.rollingRisk();
  assert.equal(risk.deployedTodayWei, "1100000000000000");
  assert.equal(risk.realizedTodayWei, "-40000000000000");
  assert.equal(j.getIntent(failedSpec.id).state, "failed");
});

/* ── the cancel path in the ledger ─────────────────────────────────────── */
const dropped = { ...spec, id: "risk-exit:drop", eventId: null, feedId: null, kind: "risk_exit", inputMint: TOKEN, outputMint: NATIVE_ASSET,
  context: { position: runtime.positions[TOKEN] } };
j.ensureIntent(dropped);
j.recordSigned(dropped.id, evmAttempt(1, { nonce: 7, txHash: hash(4) }));
ok("a cancel may only be recorded against a submitted or ambiguous attempt", () =>
  assert.throws(() => j.recordCancel(dropped.id, 1, evmAttempt(2, { nonce: 7, txHash: hash(5) })), /only a submitted or ambiguous attempt/));
j.markSubmitted(dropped.id, 1);
ok("a cancel must reuse the dropped attempt's nonce exactly", () =>
  assert.throws(() => j.recordCancel(dropped.id, 1, evmAttempt(2, { nonce: 8, txHash: hash(5) })), /does not equal the dropped attempt's nonce 7/));
j.recordCancel(dropped.id, 1, { ...evmAttempt(2, { nonce: 7, txHash: hash(5), quoted: "0", min: "0" }), order: { worstFeeWei: "1" } });
ok("the cancel row is submitted at nonce 7 and does not advance next_nonce (already past it)", () => {
  const c = j.latestAttempt(dropped.id);
  assert.equal(c.state, "submitted");
  assert.equal(c.nonce, 7);
  assert.equal(c.order.role, "cancel");
  assert.equal(c.order.cancelOf, 1);
  assert.equal(j.nextNonce(), 8);
  assert.equal(j.attemptsAtNonce(7).length, 2);
});
ok("markCancelled refuses a receipt hash that is not the journaled cancel", () =>
  assert.throws(() => j.markCancelled(dropped.id, 1, 2, { networkFeeWei: "8400000000000", txHash: hash(9) }), /is not the journaled cancel/));
j.markCancelled(dropped.id, 1, 2, { networkFeeWei: "8400000000000", finalizedAtMs: Date.now(), blockNumber: 1_400, txHash: hash(5) });
ok("once the cancel lands, both rows are expired, the intent is rebuildable, and the cancel's gas is a fee event", () => {
  const rows = j.attempts(dropped.id);
  assert.deepEqual(rows.map((r) => r.state), ["expired", "expired"]);
  assert.match(rows[0].error, /consumed by cancel/);
  assert.equal(j.getIntent(dropped.id).state, "expired");
  assert.equal(j.rollingRisk().deployedTodayWei, "1108400000000000");
  j.recordSigned(dropped.id, evmAttempt(3, { nonce: 8, txHash: hash(6) }));
  assert.equal(j.latestAttempt(dropped.id).nonce, 8);
});

/* ── approvals settle by fee only ──────────────────────────────────────── */
ok("an approval settles with its gas as the only rail it touches", () => {
  const spender = addr(0xbb);
  j.ensureIntent({ id: "risk-exit:x:approve:1", kind: "approval", mint: TOKEN, inputMint: TOKEN, outputMint: spender, amountRaw: "987",
    context: { forExit: true, parent: "risk-exit:x", position: runtime.positions[TOKEN] } });
  j.recordSigned("risk-exit:x:approve:1", evmAttempt(1, { nonce: 9, txHash: hash(7), quoted: "0", min: "0" }));
  j.markSubmitted("risk-exit:x:approve:1", 1);
  j.markConfirmed("risk-exit:x:approve:1", 1, { totalInputAmount: "987", totalOutputAmount: "0", networkFeeWei: "12000000000000", txHash: hash(7) });
  const before = j.rollingRisk().deployedTodayWei;
  assert.equal(j.markApprovalSettled("risk-exit:x:approve:1").state, "accounted");
  assert.equal(BigInt(j.rollingRisk().deployedTodayWei) - BigInt(before), 12_000_000_000_000n);
  assert.equal(j.markApprovalSettled("risk-exit:x:approve:1").state, "accounted", "idempotent");
  assert.throws(() => j.markApprovalSettled(spec.id), /not an approval/);
});
ok("an exit approval is narrow: it conflicts only with its own token", () => {
  j.ensureIntent({ id: "risk-exit:y:approve:1", kind: "approval", mint: addr(0xcc), inputMint: addr(0xcc), outputMint: addr(0xbb), amountRaw: "1",
    context: { forExit: true, position: { mint: addr(0xcc) } } });
  assert.equal(j.hasConflictingIntent(j.getIntent("risk-exit:y:approve:1")), null);
  j.ensureIntent({ id: "entry:z", kind: "entry", mint: addr(0xdd), inputMint: NATIVE_ASSET, outputMint: addr(0xdd), amountRaw: "1" });
  assert.notEqual(j.hasConflictingIntent(j.getIntent("entry:z")), null, "new exposure is globally serialized");
});

ok("a different wallet cannot reuse the journal", () => assert.throws(
  () => new ExecutionJournal(file, { wallet: addr(0x99), create: false }),
  /journal belongs to wallet/));

ok("the full durable position is exit-eligible when the primary sees it", () => {
  assert.deepEqual(trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "1000" }),
    { verified: true, amountRaw: "1000" });
  assert.deepEqual(trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "1200" }),
    { verified: true, amountRaw: "1000" });
});
ok("a partial primary read cannot shrink and retire the durable position", () => {
  const result = trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "500", secondaryRaw: "1000" });
  assert.equal(result.verified, false);
  assert.match(result.reason, /RPC balance disagreement/);
});
ok("even two zero reads require reconciliation rather than deleting the position", () => {
  const result = trackedBalanceDecision({ trackedRaw: "1000", primaryRaw: "0", secondaryRaw: "0" });
  assert.equal(result.verified, false);
  assert.match(result.reason, /both RPCs report below tracked balance/);
});

const lockFile = path.join(dir, "executor.lock");
const release = acquireProcessLock(lockFile);
ok("single-process lock rejects a live owner", () => assert.throws(
  () => acquireProcessLock(lockFile), /lock already exists \(active pid/));
release();
fs.writeFileSync(lockFile, "99999999\n", { mode: 0o600 });
const releaseReclaimed = acquireProcessLock(lockFile);
ok("a crash-stale lock is atomically reclaimed without allowing two owners", () =>
  assert.ok(fs.existsSync(lockFile)));
releaseReclaimed();

const corruptFile = path.join(dir, "corrupt.sqlite");
let corrupt = new ExecutionJournal(corruptFile, { wallet });
corrupt.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: { [TOKEN]: { ...runtime.positions[TOKEN] } } });
corrupt.close();
let raw = new DatabaseSync(corruptFile);
raw.prepare("UPDATE positions SET data='{' WHERE mint=?").run(TOKEN);
raw.close();
ok("corrupt position JSON refuses startup instead of erasing risk", () => assert.throws(
  () => new ExecutionJournal(corruptFile, { wallet, create: false }), /position .* corrupt JSON/));

const malformedFile = path.join(dir, "malformed.sqlite");
corrupt = new ExecutionJournal(malformedFile, { wallet });
corrupt.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: { [TOKEN]: { ...runtime.positions[TOKEN] } } });
corrupt.close();
raw = new DatabaseSync(malformedFile);
raw.prepare("UPDATE positions SET data=? WHERE mint=?").run(JSON.stringify({ ...runtime.positions[TOKEN], qtyRaw: "0" }), TOKEN);
raw.close();
ok("valid JSON with an invalid position schema also refuses startup", () => assert.throws(
  () => new ExecutionJournal(malformedFile, { wallet, create: false }), /invalid qtyRaw/));
ok("a Solana-shaped position (lamports, paidSol) is refused, not silently reinterpreted as wei", () => {
  const solFile = path.join(dir, "solana-position.sqlite");
  const s = new ExecutionJournal(solFile, { wallet });
  assert.throws(() => s.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: { [TOKEN]: {
    ...runtime.positions[TOKEN], costBasisWei: undefined, paidEth: undefined,
    paidSol: 0.005, costBasisLamports: "5005000", entryInputLamports: "5000000" } } }), /invalid paidEth/);
  s.close();
});

const riskFile = path.join(dir, "bad-risk.sqlite");
corrupt = new ExecutionJournal(riskFile, { wallet });
corrupt.saveRuntime({ cursor: 1, primed: true, state: freshState(1), positions: {} });
corrupt.close();
raw = new DatabaseSync(riskFile);
raw.prepare("UPDATE meta SET value=? WHERE key='risk_state'")
  .run(JSON.stringify({ ...freshState(1), deployedTodaySol: -1000, realizedTodaySol: 1000 }));
raw.close();
ok("valid JSON cannot corrupt rolling risk rails into negative deploy capacity", () => assert.throws(
  () => new ExecutionJournal(riskFile, { wallet, create: false }), /deployedTodaySol is invalid/));
ok("a corrupt next_nonce refuses startup rather than handing out a nonce", () => {
  const nonceFile = path.join(dir, "bad-nonce.sqlite");
  const n = new ExecutionJournal(nonceFile, { wallet });
  n.close();
  const db = new DatabaseSync(nonceFile);
  db.prepare("INSERT INTO meta(key,value) VALUES('next_nonce','-1')").run();
  db.close();
  assert.throws(() => new ExecutionJournal(nonceFile, { wallet, create: false }), /next_nonce is invalid/);
});

ok("every durable reconciliation/monitor/exit flag blocks new exposure", () => {
  assert.match(positionEntryBlock({ riskDataUnavailable: true, riskDataUnavailableReason: "mark outage" }), /mark outage/);
  assert.match(positionEntryBlock({ exitExecutionRequired: true, exitExecutionReason: "stop fired" }), /stop fired/);
});

const incompleteFile = path.join(dir, "incomplete-history.sqlite");
let incomplete = new ExecutionJournal(incompleteFile, { wallet });
incomplete.saveRuntime({ cursor: 1, primed: true, state: { ...freshState(1), deployedTodaySol: 0.005, realizedTodaySol: -0.001 }, positions: {} });
incomplete.close();
incomplete = new ExecutionJournal(incompleteFile, { wallet, create: false });
ok("legacy nonzero counters without ledger events trigger a 24-hour entry quarantine", () => {
  const status = incomplete.riskHistoryStatus();
  assert.equal(status.complete, false);
  assert.ok(status.incompleteUntil > Date.now() + 23 * 60 * 60_000);
});
incomplete.close();

const anchoredHistoryFile = path.join(dir, "anchored-incomplete-history.sqlite");
const firstSeenAt = 1_800_000_000_000;
const riskHistoryWindowMs = 24 * 60 * 60_000;
let anchored = new ExecutionJournal(anchoredHistoryFile, { wallet, now: () => firstSeenAt });
anchored.saveRuntime({ cursor: 1, primed: true, state: { ...freshState(firstSeenAt), deployedTodaySol: 0.005, realizedTodaySol: -0.001 }, positions: {} });
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, { wallet, create: false, now: () => firstSeenAt });
const anchoredDeadline = anchored.riskHistoryStatus(firstSeenAt).incompleteUntil;
ok("first legacy discovery sets an exact durable risk-history deadline", () => {
  assert.equal(anchoredDeadline, firstSeenAt + riskHistoryWindowMs);
  assert.equal(anchored.riskHistoryStatus(firstSeenAt).complete, false);
  assert.equal(anchored.getMeta("risk_history_incomplete_first_seen_at"), firstSeenAt);
});
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, { wallet, create: false, now: () => firstSeenAt + 12 * 60 * 60_000 });
ok("legacy risk-history quarantine deadline is anchored once across reopen", () => {
  assert.equal(anchored.riskHistoryStatus(firstSeenAt + 12 * 60 * 60_000).incompleteUntil, anchoredDeadline);
});
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, { wallet, create: false, now: () => firstSeenAt + 2 * 60 * 60_000 });
ok("clock rollback neither extends nor prematurely clears the anchored quarantine", () => {
  const status = anchored.riskHistoryStatus(firstSeenAt + 2 * 60 * 60_000);
  assert.equal(status.complete, false);
  assert.equal(status.incompleteUntil, anchoredDeadline);
});
anchored.close();
anchored = new ExecutionJournal(anchoredHistoryFile, { wallet, create: false, now: () => firstSeenAt + 25 * 60 * 60_000 });
ok("persisting legacy counters do not renew an elapsed risk-history quarantine", () => {
  const status = anchored.riskHistoryStatus(firstSeenAt + 25 * 60 * 60_000);
  assert.equal(status.complete, true);
  assert.equal(status.incompleteUntil, anchoredDeadline);
});
anchored.close();

const freshCompleteFile = path.join(dir, "fresh-complete-history.sqlite");
let freshComplete = new ExecutionJournal(freshCompleteFile, { wallet, now: () => firstSeenAt });
freshComplete.saveRuntime({ cursor: 1, primed: true, state: freshState(firstSeenAt), positions: {} });
freshComplete.close();
freshComplete = new ExecutionJournal(freshCompleteFile, { wallet, create: false, now: () => firstSeenAt + 12 * 60 * 60_000 });
ok("fresh complete journals remain free of risk-history migration quarantine", () => {
  assert.deepEqual(freshComplete.riskHistoryStatus(), { complete: true, incompleteUntil: null });
  assert.equal(freshComplete.getMeta("risk_history_incomplete_until"), null);
});
freshComplete.close();

/* ── THE FORWARD-ONLY MIGRATION, against a file written by the OLD schema ──
 *
 * The fixture is built from the v1 DDL exactly as committed at 2e92e75 (executor/
 * journal.mjs, the Solana ledger): NOT NULL request_id/signed_tx/signature/blockhash/
 * last_valid_block_height on tx_attempts, INTEGER lamports on risk_events and
 * attempt_fee_events, and a row of each with the Solana protocol marker. Opening it
 * with v2 must rebuild the three tables, keep every row byte-for-byte in the columns
 * both shapes share, leave the old attempt observation-only, and quarantine the risk
 * history because its events carry no wei. */
const V1_DDL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE positions (mint TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
  CREATE TABLE intents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, event_id TEXT, feed_id INTEGER, mint TEXT NOT NULL,
    input_mint TEXT NOT NULL, output_mint TEXT NOT NULL, amount_raw TEXT NOT NULL, state TEXT NOT NULL,
    context TEXT NOT NULL, actual_input_raw TEXT, actual_output_raw TEXT, network_fee_lamports TEXT,
    signature TEXT, error TEXT, confirmed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX idx_intents_event ON intents(event_id) WHERE event_id IS NOT NULL;
  CREATE TABLE deferred_desk_exits (
    entry_intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE RESTRICT, event_id TEXT NOT NULL UNIQUE,
    feed_id INTEGER NOT NULL, call_id INTEGER NOT NULL, mint TEXT NOT NULL, reason TEXT NOT NULL, observed_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE tx_attempts (
    intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE RESTRICT, attempt INTEGER NOT NULL, state TEXT NOT NULL,
    request_id TEXT NOT NULL, signed_tx BLOB NOT NULL, signature TEXT NOT NULL UNIQUE, blockhash TEXT NOT NULL,
    last_valid_block_height INTEGER NOT NULL, quoted_output_raw TEXT NOT NULL, min_output_raw TEXT NOT NULL,
    order_json TEXT NOT NULL, protocol TEXT, execute_json TEXT, error TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, PRIMARY KEY(intent_id, attempt)
  ) STRICT;
  CREATE INDEX idx_attempts_state ON tx_attempts(state);
  CREATE TABLE risk_events (
    intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('deployment','realized')),
    deployed_lamports INTEGER NOT NULL, realized_lamports INTEGER NOT NULL, network_fee_lamports INTEGER NOT NULL,
    occurred_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_risk_events_time ON risk_events(occurred_at);
  CREATE TABLE attempt_fee_events (
    intent_id TEXT NOT NULL REFERENCES intents(id) ON DELETE RESTRICT, attempt INTEGER NOT NULL,
    network_fee_lamports INTEGER NOT NULL, occurred_at INTEGER NOT NULL, PRIMARY KEY(intent_id,attempt)
  ) STRICT;
  CREATE INDEX idx_attempt_fee_events_time ON attempt_fee_events(occurred_at);
`;
const v1File = path.join(dir, "v1-schema.sqlite");
{
  const db = new DatabaseSync(v1File);
  db.exec(V1_DDL);
  const now = Date.now();
  const put = db.prepare("INSERT INTO meta(key,value) VALUES(?,?)");
  put.run("wallet", JSON.stringify(wallet));
  put.run("cursor", "40");
  put.run("primed", "true");
  put.run("risk_state", JSON.stringify({ ...freshState(now), deployedTodaySol: 0.002 }));
  db.prepare(`INSERT INTO intents (id,kind,event_id,feed_id,mint,input_mint,output_mint,amount_raw,state,context,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run("entry:old", "entry", "old", 40, TOKEN, NATIVE_ASSET, TOKEN, "5000000", "submitted", "{}", now, now);
  db.prepare(`INSERT INTO intents (id,kind,event_id,feed_id,mint,input_mint,output_mint,amount_raw,state,context,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run("entry:done", "entry", "done", 39, TOKEN, NATIVE_ASSET, TOKEN, "5000000", "accounted", "{}", now, now);
  db.prepare(`INSERT INTO tx_attempts (intent_id,attempt,state,request_id,signed_tx,signature,blockhash,last_valid_block_height,
    quoted_output_raw,min_output_raw,order_json,protocol,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("entry:old", 1, "submitted", "req-1", Buffer.from("solana bytes"), "5igSolanaSignature", "BlockhashXYZ", 311_000_000,
      "1000", "900", JSON.stringify({ router: "metis" }), "jupiter-dual-rpc-coherent-snapshot-v3", now, now);
  db.prepare("INSERT INTO risk_events (intent_id,kind,deployed_lamports,realized_lamports,network_fee_lamports,occurred_at) VALUES(?,?,?,?,?,?)")
    .run("entry:done", "deployment", 5_005_000, 0, 5_000, now);
  db.prepare("INSERT INTO attempt_fee_events (intent_id,attempt,network_fee_lamports,occurred_at) VALUES(?,?,?,?)")
    .run("entry:done", 1, 5_000, now);
  db.close();
  fs.chmodSync(v1File, 0o600);
}
const columns = (db, table) => Object.fromEntries(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => [c.name, c]));
let migrated = new ExecutionJournal(v1File, { wallet, create: false });
ok("an old-schema file migrates forward on open", () => assert.equal(migrated.migrated, true));
ok("tx_attempts gains the EVM columns and the Solana ones become nullable legacy", () => {
  const c = columns(migrated.db, "tx_attempts");
  for (const name of ["nonce", "chain_id", "tx_hash", "raw_tx", "proven_at_block", "deadline_block", "gas_limit", "max_fee_per_gas"])
    assert.ok(c[name], `missing ${name}`);
  for (const name of ["request_id", "signed_tx", "signature", "blockhash", "last_valid_block_height"])
    assert.equal(c[name].notnull, 0, `${name} should be nullable`);
  assert.equal(migrated.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='sqlite_autoindex_tx_attempts_2'").get().n +
    migrated.db.prepare("SELECT COUNT(*) n FROM pragma_index_list('tx_attempts') WHERE \"unique\"=1").get().n > 0, true, "tx_hash keeps a UNIQUE index");
});
ok("risk_events and attempt_fee_events gain *_wei TEXT siblings and lose the INTEGER NOT NULL", () => {
  const r = columns(migrated.db, "risk_events");
  assert.equal(r.deployed_wei.type, "TEXT");
  assert.equal(r.deployed_lamports.notnull, 0);
  const f = columns(migrated.db, "attempt_fee_events");
  assert.equal(f.network_fee_wei.type, "TEXT");
  assert.equal(f.network_fee_lamports.notnull, 0);
});
ok("every old row survives verbatim in the columns both shapes share", () => {
  const a = migrated.latestAttempt("entry:old");
  assert.equal(a.signature, "5igSolanaSignature");
  assert.equal(a.blockhash, "BlockhashXYZ");
  assert.equal(a.lastValidBlockHeight, 311_000_000);
  assert.equal(a.signedTx.toString(), "solana bytes");
  assert.equal(a.nonce, null);
  assert.equal(a.txHash, null);
  const risk = migrated.db.prepare("SELECT * FROM risk_events WHERE intent_id='entry:done'").get();
  assert.equal(risk.deployed_lamports, 5_005_000);
  assert.equal(risk.deployed_wei, null);
  assert.equal(migrated.getMeta("cursor"), 40);
});
ok("the old attempt keeps its Solana protocol marker — observation-only forever, never backfilled", () => {
  assert.equal(migrated.latestAttempt("entry:old").protocol, "jupiter-dual-rpc-coherent-snapshot-v3");
  assert.notEqual(migrated.latestAttempt("entry:old").protocol, CURRENT_TX_ATTEMPT_PROTOCOL);
  assert.equal(migrated.pendingIntents().some((i) => i.id === "entry:old"), true, "it still blocks, as any submitted row does");
});
ok("lamport-only ledger events quarantine the risk history: their wei rails are unknowable", () => {
  assert.equal(migrated.riskHistoryStatus().complete, false);
  assert.equal(migrated.rollingRisk().deployedTodayWei, "0", "no wei is invented from lamports");
});
ok("after migration the ledger writes v2 rows beside the old ones", () => {
  migrated.ensureIntent({ id: "entry:new", kind: "entry", eventId: "new", feedId: 41, mint: addr(0xee), inputMint: NATIVE_ASSET, outputMint: addr(0xee), amountRaw: "1" });
  migrated.recordSigned("entry:new", evmAttempt(1, { nonce: 0, txHash: hash(0x10) }));
  assert.equal(migrated.latestAttempt("entry:new").nonce, 0);
  assert.equal(migrated.nextNonce(), 1);
  assert.equal(migrated.getMeta("schema_version"), JOURNAL_SCHEMA_VERSION);
});
migrated.close();
migrated = new ExecutionJournal(v1File, { wallet, create: false });
ok("the migration runs once: a second open finds v2 and rebuilds nothing", () => {
  assert.equal(migrated.migrated, false);
  assert.equal(migrated.latestAttempt("entry:old").blockhash, "BlockhashXYZ");
  assert.equal(migrated.latestAttempt("entry:new").txHash, hash(0x10));
});
migrated.close();

// The narrower legacy case: only the nullable protocol column is missing.
const legacyProtocolFile = path.join(dir, "legacy-attempt-protocol.sqlite");
let legacyProtocol = new ExecutionJournal(legacyProtocolFile, { wallet });
const legacyProtocolSpec = { ...spec, id: "entry:50:entry:legacy-protocol", eventId: "50:entry:legacy-protocol", feedId: 103, mint: addr(0xf1), outputMint: addr(0xf1) };
legacyProtocol.ensureIntent(legacyProtocolSpec);
legacyProtocol.recordSigned(legacyProtocolSpec.id, evmAttempt(1, { nonce: 0, txHash: hash(0x20) }));
legacyProtocol.close();
raw = new DatabaseSync(legacyProtocolFile);
raw.exec("ALTER TABLE tx_attempts DROP COLUMN protocol");
raw.close();
legacyProtocol = new ExecutionJournal(legacyProtocolFile, { wallet, create: false });
ok("a missing protocol column is added nullable without backfilling", () => {
  const column = legacyProtocol.db.prepare("PRAGMA table_info(tx_attempts)").all().find((value) => value.name === "protocol");
  assert.equal(column.notnull, 0);
  assert.equal(legacyProtocol.latestAttempt(legacyProtocolSpec.id).protocol, null);
});
const migratedProtocolSpec = { ...spec, id: "entry:50:entry:migrated-protocol", eventId: "50:entry:migrated-protocol", feedId: 104, mint: addr(0xf2), outputMint: addr(0xf2) };
legacyProtocol.ensureIntent(migratedProtocolSpec);
legacyProtocol.recordSigned(migratedProtocolSpec.id, { ...evmAttempt(1, { nonce: 1, txHash: hash(0x21) }), protocol: "caller-spoofed-protocol" });
ok("recordSigned marks new attempts with the exported current protocol, ignoring a caller's claim", () =>
  assert.equal(legacyProtocol.latestAttempt(migratedProtocolSpec.id).protocol, CURRENT_TX_ATTEMPT_PROTOCOL));
legacyProtocol.close();

j.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} journal safety checks passed\n`);
