import assert from "node:assert/strict";
import {
  ExitTriggerNotMetError, clearExitMarkFailureWitness, clearPriceExitWitness,
  confirmExitMarkFailureWitness, confirmPriceExitWitness, executableExitMark, priceExitTrigger,
  validateExecutableExitOrder,
} from "./exit-trigger.mjs";

/* The position paid 0.005 ETH (5e15 wei) for 1,000 raw units at $2,455/ETH. */
const position = { mint: "0x" + "aa".repeat(20), stop: 0.8, entry: 1, target: 1.9, takeProfitX: 2,
  qtyRaw: "1000", entryInputWei: "5000000000000000", ethUsdAtEntry: 2455 };
const stopDecision = { action: "sell", reason: "stop loss" };
const first = priceExitTrigger(position, stopDecision, 0.79, 2455, 1_000);
assert.equal(confirmPriceExitWitness(position, first).confirmed, false);
assert.equal(position.pendingPriceExit.witnesses, 1);
const second = priceExitTrigger(position, stopDecision, 0.78, 2455, 16_000);
const confirmed = confirmPriceExitWitness(position, second);
assert.equal(confirmed.confirmed, true);
assert.equal(confirmed.trigger.witnesses, 2);
assert.equal(confirmed.trigger.ethUsd, 2455, "the trigger records the ETH/USD it was judged at");
assert.equal(position.pendingPriceExit, undefined);

const recovered = { ...position };
confirmPriceExitWitness(recovered, first);
const hold = confirmPriceExitWitness(recovered,
  priceExitTrigger(recovered, stopDecision, 0.79, 2455, 90_000));
assert.equal(hold.confirmed, false, "non-consecutive observations restart the witness pair");
clearPriceExitWitness(recovered);
assert.equal(recovered.pendingPriceExit, undefined);

const markFailurePosition = {};
assert.equal(confirmExitMarkFailureWitness(markFailurePosition,
  { observedAt: 1_000, reason: "inflated minimum failed simulation" }).confirmed, false);
const markFailureConfirmed = confirmExitMarkFailureWitness(markFailurePosition,
  { observedAt: 16_000, reason: "order unavailable" });
assert.equal(markFailureConfirmed.confirmed, true);
assert.equal(markFailureConfirmed.trigger.kind, "risk-data");
assert.equal(markFailureConfirmed.trigger.witnesses, 2);
assert.equal(markFailurePosition.pendingExitMarkFailure, undefined);
confirmExitMarkFailureWitness(markFailurePosition, { observedAt: 1_000, reason: "first" });
assert.equal(confirmExitMarkFailureWitness(markFailurePosition,
  { observedAt: 90_000, reason: "non-consecutive" }).confirmed, false);
clearExitMarkFailureWitness(markFailurePosition);
assert.equal(markFailurePosition.pendingExitMarkFailure, undefined);

// The aggregator may claim 9e15 wei back, but policy never sees that field: the
// chain-anchored 3e15-wei delta is the mark and breaches the stop.
const manipulatedQuote = "9000000000000000";
const simulatedActual = "3000000000000000";
const chainMark = executableExitMark(position, simulatedActual, 2455);
assert.equal(chainMark, 0.6);
assert.ok(chainMark < position.stop);
assert.notEqual(chainMark, Number(manipulatedQuote) / Number(position.entryInputWei));
// The mark is in USD terms: a stronger ETH lifts it, a weaker ETH lowers it.
assert.ok(Math.abs(executableExitMark(position, simulatedActual, 2455 * 1.1) - 0.66) < 1e-12);
// Wei precision survives: 18-decimal amounts do not lose digits through the ratio.
assert.ok(Math.abs(executableExitMark({ ...position, entryInputWei: "123456789012345678901" }, "123456789012345678901", 2455) - 1) < 1e-9);

const stopIntent = { kind: "risk_exit", amountRaw: "1000", context: { position, trigger: confirmed.trigger } };
assert.ok(validateExecutableExitOrder(stopIntent,
  { outAmount: "3900000000000000", otherAmountThreshold: "3800000000000000" }, { nowMs: 20_000 }));
assert.throws(() => validateExecutableExitOrder(stopIntent,
  { outAmount: "4500000000000000", otherAmountThreshold: "4300000000000000" }, { nowMs: 20_000 }),
  (error) => error instanceof ExitTriggerNotMetError && error.code === "EXIT_TRIGGER_NOT_MET");

const targetTrigger = priceExitTrigger(position, { action: "sell", reason: "desk target hit" }, 1.95, 2455, 30_000);
const targetIntent = { kind: "risk_exit", amountRaw: "1000", context: { position, trigger: targetTrigger } };
assert.ok(validateExecutableExitOrder(targetIntent,
  { outAmount: "10000000000000000", otherAmountThreshold: "9600000000000000" }, { nowMs: 31_000 }));
assert.throws(() => validateExecutableExitOrder(targetIntent,
  { outAmount: "10000000000000000", otherAmountThreshold: "9000000000000000" }, { nowMs: 31_000 }),
  /no longer confirms/);
assert.throws(() => validateExecutableExitOrder(stopIntent,
  { outAmount: "3900000000000000", otherAmountThreshold: "3800000000000000" }, { nowMs: 100_000 }),
  /trigger is stale/);
assert.throws(() => validateExecutableExitOrder({ ...stopIntent, context: { ...stopIntent.context,
  position: { ...position, entryInputWei: undefined, entryInputLamports: "5000000" } } },
{ outAmount: "3900000000000000", otherAmountThreshold: "3800000000000000" }, { nowMs: 20_000 }),
/position entry input/, "a Solana-shaped position is refused, never read as wei");
assert.equal(validateExecutableExitOrder({ kind: "desk_exit", context: { position } }, {}, {}), null);

console.log("\nprice exits need two witnesses and a still-breached final order\n");
