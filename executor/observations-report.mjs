/**
 * WHAT WOULD THAT GATE HAVE DONE? — the other half of "measure before you kill".
 *
 * A refusal clause in this executor is not allowed to go straight to killing trades. It
 * records what it WOULD have done into the journal's gate_observations table, and a human
 * reads the distribution here before promoting it. The reason is in erc20-hazards.mjs and
 * it is the whole argument: A LINT THAT CRIES WOLF GETS SWITCHED OFF. A gate that refuses
 * 40% of calls because its probe is misreading the chain does not get caught by a test —
 * it gets caught by a bot that stops trading and an operator who turns the gate off, and
 * by then the gate is gone for the good cases too.
 *
 * THIS IS A TOOL, NOT RUNTIME. poller.mjs never imports it, it takes no key, it opens the
 * journal read-only and it decides nothing. It lives in TOOL_FILES beside burner-backup,
 * and it must stay out of RUNTIME_FILES: a file that can decide a trade has seven
 * manifests to update and a much higher bar than a reporting script needs.
 *
 * THE PROMOTION VERDICT IS ARITHMETIC, NOT A RECOMMENDATION. It reports whether the
 * sample has cleared the floor, and it says what the numbers are. It never says "promote
 * this" — the decision is the operator's, and a tool that made it for them would be the
 * same mistake the shadow scorecard made when it published a verdict off five coins.
 *
 *   node executor/observations-report.mjs [--gate exit_route_unproven] [--since 7d]
 *   node executor/observations-report.mjs --journal ~/claudeco-executor/.state.sqlite
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionJournal } from "./journal.mjs";
import { GATE_PROMOTION_SAMPLE } from "./live-thresholds.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };

/** "7d" / "36h" / "90m" / a bare number of days. */
export function parseSince(spec, now = Date.now()) {
  if (spec == null) return 0;
  const m = String(spec).trim().match(/^(\d+(?:\.\d+)?)\s*([dhm])?$/i);
  if (!m) throw new Error(`--since wants a span like 7d, 36h or 90m, not "${spec}"`);
  const n = Number(m[1]);
  const ms = { d: 86400e3, h: 3600e3, m: 60e3 }[(m[2] || "d").toLowerCase()];
  return now - n * ms;
}

const pctOf = (n, total) => (total ? (n / total) * 100 : 0);

/** Deciles of the numeric values a gate measured, when it measured a number at all. */
export function deciles(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const at = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))];
  return { n: xs.length, p10: at(0.1), p50: at(0.5), p90: at(0.9), min: xs[0], max: xs[xs.length - 1] };
}

/**
 * Summarise one gate's observations.
 *
 * `unreadable` is broken out rather than folded into either side on purpose. An
 * unreadable probe is not a pass and it is not a refusal — it is the gate failing to
 * measure, and a clause that cannot read the chain a tenth of the time is a clause that
 * will fail CLOSED a tenth of the time once promoted. That number decides whether the
 * gate is ready far more often than the refusal rate does.
 */
export function summarise(rows, { floor = GATE_PROMOTION_SAMPLE } = {}) {
  const n = rows.length;
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const pass = count("pass"), wouldRefuse = count("would_refuse"), unreadable = count("unreadable");
  const enforcing = rows.filter((r) => r.enforcing).length;
  const numeric = rows.map((r) => {
    const v = r.value;
    if (Number.isFinite(v)) return v;
    if (v && typeof v === "object") {
      for (const k of ["measured", "value", "pct", "ratio", "bps"]) if (Number.isFinite(v[k])) return v[k];
    }
    return NaN;
  });
  const reasons = {};
  for (const r of rows) {
    if (r.verdict !== "unreadable") continue;
    const why = (r.value && typeof r.value === "object" && (r.value.reason || r.value.error)) || "unstated";
    reasons[String(why).slice(0, 80)] = (reasons[String(why).slice(0, 80)] ?? 0) + 1;
  }
  return {
    n, pass, wouldRefuse, unreadable, enforcing, floor,
    passPct: pctOf(pass, n), wouldRefusePct: pctOf(wouldRefuse, n), unreadablePct: pctOf(unreadable, n),
    deciles: deciles(numeric),
    unreadableReasons: reasons,
    /* Sample first: a clean-looking rate on nineteen rows is not evidence of anything. */
    promotable: n >= floor,
    verdict: n >= floor
      ? `PROMOTABLE — ${n} observations, unreadable ${pctOf(unreadable, n).toFixed(1)}%, would_refuse ${pctOf(wouldRefuse, n).toFixed(1)}%`
      : `NOT PROMOTABLE — ${n} observations, floor is ${floor}`,
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const journalPath = arg("journal") ||
    process.env.EXECUTOR_JOURNAL ||
    path.join(os.homedir(), "claudeco-executor", ".state.sqlite");
  if (!fs.existsSync(journalPath)) {
    console.error(`\nno journal at ${journalPath}\n` +
      `pass --journal <path> or set EXECUTOR_JOURNAL.\n`);
    process.exit(2);
  }
  let sinceMs;
  try { sinceMs = parseSince(arg("since")); }
  catch (e) { console.error("\n" + e.message + "\n"); process.exit(2); }

  const journal = new ExecutionJournal(journalPath, { create: false });
  const wanted = arg("gate");
  const rows = journal.gateObservations({ gate: wanted, sinceMs, limit: 100000 });
  const gates = [...new Set(rows.map((r) => r.gate))].sort();

  console.log(`\nGATE OBSERVATIONS — ${journalPath}`);
  console.log(`${rows.length} rows${wanted ? ` for ${wanted}` : ` across ${gates.length} gates`}` +
    `${sinceMs ? ` since ${new Date(sinceMs).toISOString().slice(0, 16).replace("T", " ")}` : ""}`);
  console.log(`promotion floor ${GATE_PROMOTION_SAMPLE} (gates.promotionSampleFloor — the desk's claim floor, ASSUMED)\n`);

  if (!rows.length) {
    console.log("  nothing recorded yet. A gate shipped observe-only writes a row per call it saw.\n");
    journal.close();
    process.exit(0);
  }

  for (const gate of gates) {
    const s = summarise(rows.filter((r) => r.gate === gate));
    console.log(`── ${gate} ──`);
    console.log(`   ${String(s.n).padStart(6)} observations` +
      (s.enforcing ? `  (${s.enforcing} recorded while ENFORCING — do not mix these into a promotion decision)` : ""));
    console.log(`   ${String(s.pass).padStart(6)} pass          ${s.passPct.toFixed(1)}%`);
    console.log(`   ${String(s.wouldRefuse).padStart(6)} would_refuse  ${s.wouldRefusePct.toFixed(1)}%`);
    console.log(`   ${String(s.unreadable).padStart(6)} unreadable    ${s.unreadablePct.toFixed(1)}%` +
      `   ← a gate that cannot read the chain fails CLOSED this often once promoted`);
    if (s.deciles)
      console.log(`   measured value  p10 ${s.deciles.p10}  p50 ${s.deciles.p50}  p90 ${s.deciles.p90}` +
        `  (min ${s.deciles.min}, max ${s.deciles.max}, n ${s.deciles.n})`);
    const reasons = Object.entries(s.unreadableReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (reasons.length) {
      console.log(`   unreadable because:`);
      for (const [why, n] of reasons) console.log(`     ${String(n).padStart(5)}  ${why}`);
    }
    console.log(`   ${s.verdict}\n`);
  }

  console.log(`  This prints what the gates measured. It does not recommend promoting one:\n` +
    `  clearing the floor means the sample is big enough to look at, not that the clause\n` +
    `  is right. Read the unreadable rate and the deciles before arming anything.\n`);
  journal.close();
}
