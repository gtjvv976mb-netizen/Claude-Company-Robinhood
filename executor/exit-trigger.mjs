const positive = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive and finite`);
  return number;
};
const raw = (value, label) => {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error(`${label} must be a positive integer`);
  return BigInt(text);
};
const breached = (trigger, mark) => trigger.direction === "below"
  ? mark <= trigger.threshold : mark >= trigger.threshold;

/** Price a held token only from the chain-simulated executable ETH delta. */
export function executableExitMark(position, actualOutputRaw, currentSolUsd) {
  const output = raw(actualOutputRaw, "chain-simulated exit output");
  const entryWei = raw(position?.entryInputWei, "position entry input");
  const ethUsdRatio = positive(currentSolUsd, "current ETH/USD") /
    positive(position?.ethUsdAtEntry, "entry ETH/USD");
  const scale = 1_000_000_000n; // fixed-point precision for the ratio, not a unit
  const mark = Number(output * scale / entryWei) / Number(scale) * ethUsdRatio;
  if (!Number.isFinite(mark) || mark <= 0) throw new Error("chain-simulated executable exit mark is invalid");
  return mark;
}

export class ExitTriggerNotMetError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExitTriggerNotMetError";
    this.code = "EXIT_TRIGGER_NOT_MET";
  }
}

/** Convert a shared price-policy sell into a durable, executable threshold. */
export function priceExitTrigger(position, decision, mark, ethUsd, nowMs = Date.now()) {
  const reason = String(decision?.reason || "");
  let direction = null;
  let threshold = null;
  if (reason === "stop loss" || reason === "ratcheted stop") {
    direction = "below"; threshold = positive(position?.stop, "position stop");
  } else if (reason.startsWith("take profit:")) {
    direction = "above";
    threshold = positive(position?.entry, "position entry") * positive(position?.takeProfitX, "take-profit rule");
  } else if (reason === "desk target hit") {
    direction = "above"; threshold = positive(position?.target, "position target");
  } else return null; // age and explicit desk/rug exits are not price-only exits
  const observedMark = positive(mark, "exit trigger mark");
  if (!breached({ direction, threshold }, observedMark))
    throw new Error(`price policy requested ${reason} without a breached threshold`);
  return { kind: "price", direction, threshold, observedMark,
    ethUsd: positive(ethUsd, "exit ETH/USD"), observedAt: Number(nowMs), reason };
}

/** A price-only exit needs two distinct, consecutive observations. */
export function confirmPriceExitWitness(position, trigger, {
  minGapMs = 1, maxGapMs = 60_000,
} = {}) {
  if (!trigger) {
    delete position.pendingPriceExit;
    return { confirmed: true, trigger: null };
  }
  const prior = position?.pendingPriceExit;
  const gap = Number(trigger.observedAt) - Number(prior?.observedAt || 0);
  const same = prior?.kind === "price" && prior.direction === trigger.direction &&
    Math.abs(Number(prior.threshold) - Number(trigger.threshold)) <=
      Math.max(1e-12, Math.abs(Number(trigger.threshold)) * 1e-9);
  if (same && gap >= minGapMs && gap <= maxGapMs &&
      breached(prior, Number(prior.observedMark)) && breached(trigger, Number(trigger.observedMark))) {
    delete position.pendingPriceExit;
    return { confirmed: true, trigger: { ...trigger, firstObservedAt: Number(prior.observedAt), witnesses: 2 } };
  }
  position.pendingPriceExit = { ...trigger, witnesses: 1 };
  return { confirmed: false, trigger: position.pendingPriceExit };
}

export function clearPriceExitWitness(position) {
  if (position && Object.hasOwn(position, "pendingPriceExit")) delete position.pendingPriceExit;
}

/**
 * Missing executable marks are themselves a risk signal. A malicious or broken
 * order service must not be able to suppress a breached stop indefinitely simply
 * by returning an inflated minimum-output floor that fails simulation. One failure
 * freezes new exposure; two distinct consecutive ticks latch a risk-reducing exit.
 */
export function confirmExitMarkFailureWitness(position, failure, {
  minGapMs = 1, maxGapMs = 60_000,
} = {}) {
  const observedAt = Number(failure?.observedAt);
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0)
    throw new Error("exit-mark failure observation time is invalid");
  const prior = position?.pendingExitMarkFailure;
  const gap = observedAt - Number(prior?.observedAt || 0);
  if (prior?.kind === "executable-mark-unavailable" && gap >= minGapMs && gap <= maxGapMs) {
    delete position.pendingExitMarkFailure;
    return { confirmed: true, trigger: {
      kind: "risk-data", reason: "independent executable exit mark unavailable",
      firstObservedAt: Number(prior.observedAt), observedAt, witnesses: 2,
    } };
  }
  position.pendingExitMarkFailure = {
    kind: "executable-mark-unavailable", observedAt,
    reason: String(failure?.reason || "executable exit mark unavailable"), witnesses: 1,
  };
  return { confirmed: false, trigger: position.pendingExitMarkFailure };
}

export function clearExitMarkFailureWitness(position) {
  if (position && Object.hasOwn(position, "pendingExitMarkFailure"))
    delete position.pendingExitMarkFailure;
}

/** Re-price a latched price exit using the exact final order before signing. */
export function validateExecutableExitOrder(intent, order, {
  nowMs = Date.now(), maxExitTriggerAgeMs = 60_000,
} = {}) {
  if (intent?.kind === "entry") return null;
  const trigger = intent?.context?.trigger;
  if (!trigger || trigger.kind !== "price") return null;
  const age = Number(nowMs) - Number(trigger.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > Number(maxExitTriggerAgeMs))
    throw new ExitTriggerNotMetError(`price-exit trigger is stale (${Math.max(0, Math.round(age))}ms)`);
  if (!['below', 'above'].includes(trigger.direction)) throw new Error("price-exit direction is invalid");

  const position = intent?.context?.position;
  const heldRaw = raw(position?.qtyRaw, "position quantity");
  const sellRaw = raw(intent?.amountRaw, "exit amount");
  if (sellRaw > heldRaw) throw new Error("exit amount exceeds its durable position");
  const entryWei = raw(position?.entryInputWei, "position entry input");
  const proportionalBasis = sellRaw === heldRaw ? entryWei : entryWei * sellRaw / heldRaw;
  if (proportionalBasis <= 0n) throw new Error("proportional exit basis rounded to zero");
  const ethUsdRatio = positive(trigger.ethUsd, "exit ETH/USD") /
    positive(position?.ethUsdAtEntry, "entry ETH/USD");
  const markFor = (outputRaw) => {
    const scale = 1_000_000_000n; // fixed-point precision for the ratio, not a unit // fixed-point precision for the ratio, not a unit
    const ratio = raw(outputRaw, "exit output") * scale / proportionalBasis;
    const mark = Number(ratio) / Number(scale) * ethUsdRatio;
    if (!Number.isFinite(mark) || mark <= 0) throw new Error("executable exit mark is invalid");
    return mark;
  };
  const quotedMark = markFor(order?.outAmount);
  const minimumMark = markFor(order?.otherAmountThreshold);
  const threshold = positive(trigger.threshold, "price-exit threshold");
  const stillTriggered = trigger.direction === "below"
    ? quotedMark <= threshold
    : minimumMark >= threshold;
  if (!stillTriggered)
    throw new ExitTriggerNotMetError(`final executable mark no longer confirms ${trigger.reason || "price exit"}: ` +
      `quote ${quotedMark.toFixed(6)}, minimum ${minimumMark.toFixed(6)}, threshold ${threshold.toFixed(6)}`);
  return { quotedMark, minimumMark, threshold, direction: trigger.direction, observedAt: trigger.observedAt };
}
