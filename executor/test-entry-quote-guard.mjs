import assert from "node:assert/strict";
import { validateExecutableEntryOrder } from "./entry-quote-guard.mjs";
import { ETH_USD_CACHE_SOURCE } from "./eth-usd-oracle.mjs";

/* 0.001 ETH at $2,455 buying 1,000 tokens (3 decimals here, so raw 1,000,000) marks
   each token at $0.002455; the zone and stop/target are authored around that mark. */
const now = 1_800_000_000_000;
const intent = {
  id: "entry:test", kind: "entry", amountRaw: "1000000000000000",
  context: {
    event: { stop: 0.002, target: 0.004 },
    entryReference: { marketMark: 0.002455, entryLow: 0.0022, entryHigh: 0.0027 },
    entryPreflight: { inputAmountRaw: "1000000000000000", forwardOutputRaw: "1000000",
      tokenDecimals: 3, ethUsd: 2455, observedAt: now - 1_000,
      ethUsdSource: ETH_USD_CACHE_SOURCE, ethUsdPublishTime: Math.floor(now / 1_000),
      ethUsdConfidencePct: 0.5, ethUsdProviderDivergencePct: 0.1 },
  },
};
const order = { inAmount: "1000000000000000", outAmount: "1000000", otherAmountThreshold: "980000" };

const valid = validateExecutableEntryOrder(intent, order, { nowMs: now, maxEntryQuoteDriftPct: 3 });
assert.ok(Math.abs(valid.quotedMark - 0.002455) < 1e-12);
assert.ok(valid.worstCaseMark > 0.002505 && valid.worstCaseMark < 0.002506);

assert.throws(() => validateExecutableEntryOrder(intent,
  { ...order, outAmount: "800000", otherAmountThreshold: "790000" }, { nowMs: now, maxEntryQuoteDriftPct: 30 }),
  /outside authored zone/);
assert.throws(() => validateExecutableEntryOrder(intent,
  { ...order, outAmount: "1000000", otherAmountThreshold: "900000" }, { nowMs: now }),
  /drift .* exceeds/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, forwardOutputRaw: "500000" },
} }, order, { nowMs: now, maxEntryQuoteDriftPct: 5 }), /drift .* exceeds/,
"a bad preliminary aggregator rate cannot define its own fair-value anchor");
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryReference: { ...intent.context.entryReference, entryLow: 0.0017 },
} }, { ...order, outAmount: "1250000", otherAmountThreshold: "1240000" },
{ nowMs: now, maxEntryQuoteDriftPct: 30 }), /breached authored stop/);
assert.throws(() => validateExecutableEntryOrder(intent, order,
  { nowMs: now + 61_001, maxEntryQuoteDriftPct: 3 }), /preflight is stale/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, inputAmountRaw: null },
} }, order, { nowMs: now }), /preflight input/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, tokenDecimals: null },
} }, order, { nowMs: now }), /on-chain token decimals/);
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, ethUsdSource: "kyber-amountInUsd" },
} }, order, { nowMs: now }), /independent two-RPC Chainlink/,
"the swap counterparty may not author the USD anchor used to judge its own order");
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight, ethUsdConfidencePct: 0.6 },
} }, order, { nowMs: now }), /oracle confidence is invalid/,
"a confidence wider than the feed's 0.5% deviation threshold is not a reading this oracle produced");
assert.throws(() => validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight,
    ethUsdPublishTime: Math.floor(now / 1_000) - 100_000 },
} }, order, { nowMs: now }), /oracle observation is stale/,
"past the heartbeat plus slack, the entry basis is stale");
// A 24h-heartbeat feed may honestly be a day old; that is inside the policy.
assert.ok(validateExecutableEntryOrder({ ...intent, context: {
  ...intent.context, entryPreflight: { ...intent.context.entryPreflight,
    ethUsdPublishTime: Math.floor(now / 1_000) - 80_000 },
} }, order, { nowMs: now, maxEntryQuoteDriftPct: 3 }));
assert.equal(validateExecutableEntryOrder({ kind: "risk_exit" }, order, { nowMs: now }), null);

console.log("\nfinal executable entry quote stays bound to the authored zone\n");
