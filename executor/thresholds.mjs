/**
 * EVERY NUMBER THIS DESK TRADES ON, AND HOW IT WAS ESTABLISHED.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. The Solana desk's thresholds are good numbers —
 * each was earned by a real measurement and each carries a comment explaining the
 * measurement that produced it. That is exactly what makes them dangerous here: a
 * threshold with a convincing justification is the one nobody re-examines. The port
 * research put it plainly — every calibrated threshold is void on this chain and they
 * all look trustworthy. The liquidity floor in the Solana penthouse is justified by four
 * measured Jupiter round trips at $75 (4.53%, 5.49%, 5.58%, 3.70%). The equivalent here
 * measured 0.015-0.018% on a deep pool and 8.92% on a thin one. A number that is two
 * orders of magnitude wrong, wearing a citation, is worse than no number at all.
 *
 * So a number is not a number here. It is a value plus a claim about where it came from,
 * and `assertLiveReady()` refuses to let the executor arm while anything on the live
 * path is still carrying a Solana measurement or a guess. Phase 7 of the port plan — the
 * re-derivation — cannot be skipped, because skipping it means the bot does not start.
 *
 * This is deliberately not a document. A document saying "remember to re-measure" is a
 * lesson that depends on being remembered, which is the same as no lesson.
 */

/** Where a number came from. `measured` is the only state that may trade. */
export const PROVENANCE = Object.freeze({
  MEASURED: "measured",     // measured on THIS chain, with a date and a method
  INHERITED: "inherited",   // carried from the Solana desk; void until re-measured
  ASSUMED: "assumed",       // a starting guess nobody has checked
});

const REGISTRY = new Map();

/**
 * Register a threshold. `live: true` means the executor may not arm without it being
 * measured on this chain — that is the whole mechanism, so mark anything that decides
 * how much money moves, or whether a trade happens at all.
 */
export function defineThreshold(name, value, meta) {
  if (REGISTRY.has(name)) throw new Error(`threshold ${name} defined twice`);
  const { provenance, live = false, unit = null, at = null, method = null, note = null } = meta ?? {};
  if (!Object.values(PROVENANCE).includes(provenance))
    throw new Error(`threshold ${name} needs a provenance, got ${String(provenance)}`);
  if (provenance === PROVENANCE.MEASURED && !(at && method))
    throw new Error(`threshold ${name} claims to be measured but names no date or method`);
  REGISTRY.set(name, Object.freeze({ name, value, provenance, live, unit, at, method, note }));
  return value;
}

export const thresholds = () => [...REGISTRY.values()];
export const threshold = (name) => {
  const t = REGISTRY.get(name);
  if (!t) throw new Error(`no threshold named ${name}`);
  return t;
};

/** Everything on the live path that is not yet measured on this chain. */
export function unmeasuredLiveThresholds() {
  return thresholds().filter((t) => t.live && t.provenance !== PROVENANCE.MEASURED);
}

/**
 * The gate. Called before the executor arms; throws with the full list rather than the
 * first offender, because re-measuring is a batch of work and a one-at-a-time drip is
 * how people start disabling the check.
 */
export function assertLiveReady() {
  const pending = unmeasuredLiveThresholds();
  if (!pending.length) return true;
  const lines = pending.map((t) =>
    `  ${t.name} = ${t.value}${t.unit ? " " + t.unit : ""} (${t.provenance})` +
    (t.note ? `\n      ${t.note}` : ""));
  throw new Error(
    `${pending.length} threshold${pending.length === 1 ? " is" : "s are"} not measured on this chain, ` +
    `so the executor will not arm:\n${lines.join("\n")}\n` +
    `Each of these decides how much money moves or whether a trade happens at all. ` +
    `Measure it here, then set provenance to "measured" with the date and method. ` +
    `Numbers carried from the Solana desk are void: its round trips were 4.5-5.6% where ` +
    `this chain measured 0.015-0.018% deep and 8.92% thin.`);
}
