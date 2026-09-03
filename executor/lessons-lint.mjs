/**
 * THE FOUR MISTAKES THIS DESK HAS ALREADY PAID FOR, CHECKED BY A MACHINE.
 *
 * Mined from the Solana build's own comments, its git history and the owner's notes:
 * 180 distinct lessons, 68 of which cost real money. Most are judgement and cannot be
 * automated. These four are structural, they recur, and each has a shape a checker can
 * actually see — so they are checked instead of remembered.
 *
 * A lint that cries wolf gets switched off, so every rule here is deliberately narrow.
 * It would rather miss a real instance than flag a false one, and each rule is tested
 * against known-good and known-bad samples in test-lessons-lint.mjs.
 */

/** A latch that can be set and never released disarms the system silently.
 *  Cost, measured: the readiness rehearsal on 2026-09-03 set an in-flight flag, the
 *  probe never settled, and the bot stopped self-checking for hours with NOTHING in the
 *  log. Two restarts and a wrongly-reverted commit went into chasing it. */
export function latchesWithoutRelease(src) {
  const out = [];
  const declared = new Set();
  for (const m of src.matchAll(/^\s*let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:false|null|0)\s*;/gm))
    declared.add(m[1]);
  for (const name of declared) {
    const setTrue = new RegExp(`(?<![.\\w])${name}\\s*=\\s*(?:true|Date\\.now\\(\\))`, "g");
    const setBack = new RegExp(`(?<![.\\w])${name}\\s*=\\s*(?:false|null|0)\\b`, "g");
    const sets = [...src.matchAll(setTrue)].length;
    const clears = [...src.matchAll(setBack)].length;
    // A declaration initialises it; only ASSIGNMENTS after that count as a release.
    if (sets > 0 && clears <= 1) out.push({ name, sets, clears: clears - 1 < 0 ? 0 : clears - 1 });
  }
  return out;
}

/** A window named in time must be cut on time, not on row count.
 *  Cost, measured: `vol5mUsd` summed the last five candles and called it five minutes.
 *  pump.fun emits a candle only for a minute that traded, so on ZODs it summed
 *  forty-four hours of trickle and reported it as five busy minutes — the ruler rewarded
 *  exactly the inactivity it existed to detect. */
export function timeNamedFromRowCount(src) {
  const out = [];
  const re = /\b([A-Za-z_$][\w$]*(?:5m|15m|30m|1h|24h|Min|Hour|Daily)[\w$]*)\s*=\s*([^;\n]{0,160})/g;
  for (const m of src.matchAll(re)) {
    const [, name, expr] = m;
    if (/\.slice\(\s*-?\d+/.test(expr) || /\.at\(\s*-\d+\s*\)/.test(expr))
      out.push({ name, expr: expr.trim().slice(0, 90) });
  }
  return out;
}

/** "No answer" and "the answer is no" must not share a code path.
 *  Cost, measured: a caught error returning a permissive value is how an unreadable
 *  mint became a tradeable one. The scope guard's unreadable-slot branch exists because
 *  of this; so does the executor's rule that a network read may never be fatal while a
 *  configuration fact must be. */
export function unknownReadAsPermissive(src) {
  const out = [];
  // catch blocks that hand back a value meaning "fine, proceed"
  for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*return\s+(true|\[\]|\{\s*\}|0)\s*;?\s*\}/g))
    out.push({ kind: "catch-returns-permissive", value: m[1] });
  // a safety-shaped field defaulted to a passing value when absent
  for (const m of src.matchAll(/\b(\w*(?:[Ss]afe|[Vv]alid|[Aa]llowed|[Tt]radeable|[Vv]erified|[Rr]enounced)\w*)\s*(?:\?\?|\|\|)\s*(true|1)\b/g))
    out.push({ kind: "missing-defaults-to-pass", field: m[1] });
  return out;
}

/** One constant may not be both a refusal gate and a cost model.
 *  Cost, measured: maxNetworkFeeLamports was the fee ABOVE WHICH an entry is refused
 *  and, in two other places, the fee the desk ASSUMED it would pay. Raising the gate
 *  raised the assumed cost, the reserve shrank the position, and a review reproducing
 *  the real sizing engine found no stop width from 8% to 95% that still produced a buy.
 *  Shipped as one line it would have stopped the bot trading altogether. */
export function constantAsGateAndCost(src) {
  const out = [];
  const names = new Set();
  for (const m of src.matchAll(/\b(\w*(?:max|Max|min|Min|cap|Cap|ceiling|limit|Limit)\w*)\s*[),;\]]/g))
    names.add(m[1]);
  for (const name of names) {
    if (name.length < 5) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // used as a threshold in a comparison…
    const gate = new RegExp(`[<>]=?\\s*[\\w.]*\\b${esc}\\b|\\b${esc}\\b\\s*[<>]=?`).test(src);
    // …and also multiplied or divided into an amount, which makes it an assumed cost
    const cost = new RegExp(`\\b${esc}\\b\\s*[*/]|[*/]\\s*[\\w.]*\\b${esc}\\b`).test(src);
    if (gate && cost) out.push({ name });
  }
  return out;
}

export const RULES = [
  { id: "latch-without-release", run: latchesWithoutRelease,
    say: (f) => `${f.name} is set but never released — a latch with no exit disarms the system silently` },
  { id: "time-named-from-rows", run: timeNamedFromRowCount,
    say: (f) => `${f.name} is named in time but cut on row count: ${f.expr}` },
  { id: "unknown-as-permissive", run: unknownReadAsPermissive,
    say: (f) => f.field ? `${f.field} defaults to passing when absent — unknown is not "no"`
                        : `a catch returns ${f.value}, turning "could not check" into "checked, fine"` },
  { id: "gate-doubles-as-cost", run: constantAsGateAndCost,
    say: (f) => `${f.name} is compared as a refusal threshold AND multiplied as an assumed cost — split it` },
];

export function lintSource(src, { rules = RULES } = {}) {
  return rules.flatMap((r) => r.run(src).map((f) => ({ rule: r.id, message: r.say(f) })));
}
