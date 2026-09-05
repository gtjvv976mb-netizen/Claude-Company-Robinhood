import * as ds from "./data/dexscreener.js";
import { gather, screen, enrichWithXRead } from "./data/evidence.js";
import { ANALYSTS, runAnalyst, runNarrative } from "./agents/analysts.js";
import { runScout, runRedTeam, runRisk, runPM, runExecution } from "./agents/decision.js";
import { complianceCheck } from "./agents/compliance.js";
import { enforceRiskRails, enforceCeoRails, retainedBookRiskUsd } from "./agents/risk-rails.js";
import { applyRedTeamBar } from "./agents/redteam-policy.js";
import { runCEO } from "./agents/ceo.js";
import { writeOrderSlip } from "./order.js";
import { emit } from "./lib/bus.js";
import { spend, assertDailyBudget} from "./lib/llm.js";
import { cfg } from "./config.js";
import * as store from "./lib/store.js";
import { writeReport } from "./report.js";
import { liveCalls } from "./calls.js";
import { composite } from "./agents/composite.js";
import * as evaluation from "./evaluation.js";

const cycleId = () => new Date().toISOString().replace(/[:.]/g, "-");

/** How long the lead analyst seat runs alone before the rest of its batch is launched,
 *  so its cache write of the evidence bundle lands before the parallel reads. Tests
 *  set it to 0; a live cycle keeps the second. */
export const CACHE_LEAD_MS = process.env.NODE_ENV === "test" ? 0
  : Math.max(0, Number(process.env.DESK_CACHE_LEAD_MS) || 1000);

/** Stage 0: build the raw universe from public feeds. */
export async function buildUniverse() {
  emit("stage", { stage: "scout", note: "pulling feeds" });
  const [b, p] = await Promise.all([ds.boosted(), ds.profiles()]);
  const seen = new Map();
  for (const t of [...b, ...p]) {
    if (!seen.has(t.mint)) seen.set(t.mint, t);
    else seen.get(t.mint).hook += `, ${t.hook}`;
  }

  const fresh = [];
  for (const t of seen.values()) {
    const killed = store.recentKill(t.mint);
    if (killed) { emit("scout:skip", { mint: t.mint, reason: `killed ${killed.seat}: ${killed.reason}` }); continue; }
    fresh.push(t);
  }
  emit("scout:universe", { total: seen.size, fresh: fresh.length });
  return fresh;
}

/**
 * The full workup for one token. Returns a record regardless of outcome — a kill is
 * a result the desk wants written down, not a silent drop.
 */
/**
 * The first seat that refuses, or null.
 *
 * Named and exported because it is now load-bearing in TWO places: the desk has always
 * ended a workup on any analyst's kill, and the same rule now decides whether the
 * reputation read — 44.6% of the desk's entire model bill — is worth buying at all. A
 * coin the cheap seats condemn is a coin no X read can save, so the read is never
 * bought for it. If this ever returns null where a seat did refuse, the desk goes back
 * to paying for research about coins it is about to reject.
 */
export function firstKiller(analysts) {
  return Object.entries(analysts || {}).find(([, a]) => a?.kill) ?? null;
}

/**
 * Whether the desk should buy the reputation read for this coin.
 * True only while every seat that has reported so far has let the coin live.
 */
export function shouldBuyReputationRead(analysts) {
  return firstKiller(analysts) === null;
}

export async function workup(cycle, mint, hook = "", opts = {}) {
  // Evaluation provenance must retain the spending/trigger lane. It is evidence about
  // how a signal was produced, not merely a label for the live scheduler.
  const recordEvaluation = (record) => evaluation.recordDecision(cycle, {
    ...record,
    runKind: opts.lane ?? "cycle",
    pmProvider: record?.pm?._provider ?? "none",
  });
  // Both spenders — the penthouse cycle and a tenant's floor run — pass through here,
  // so this is where the daily cap bites. Before the free stages, deliberately: a
  // workup that cannot afford its model stages should not pretend to start.
  // The lane decides WHOSE money this is. The scanning lanes yield to a reserve so
  // they cannot eat the day before the publishing cycle has run; a tenant's paid
  // floor run is never throttled. See assertDailyBudget.
  assertDailyBudget(cfg.dailyBudgetUsd, { lane: opts.lane ?? "cycle" });
  emit("token:start", { mint, hook });

  const ev = await gather(mint, hook);
  if (!ev.ok) {
    emit("token:end", { mint, outcome: "no_data", detail: ev.error });
    const rec = { mint, outcome: "no_data", error: ev.error, finalDecision: "no_data" };
    recordEvaluation(rec);
    return rec;
  }
  store.touchSeen(mint, ev.symbol);
  emit("token:evidence", { mint, symbol: ev.symbol, liq: ev.pairs.totalLiquidityUsd, price: ev.pair?.priceUsd });

  // --- Stage 1: deterministic screen. No tokens spent. ---
  const sc = screen(ev);
  emit("seat:verdict", { seat: "Screener", mint, symbol: ev.symbol, pass: sc.pass, detail: sc.fails.map((f) => f.code).join(", ") });
  if (!sc.pass) {
    store.recordVerdict(cycle, mint, ev.symbol, "Screener",
      { verdict: "FAIL", kill: true, kill_reason: sc.fails.map((f) => `${f.code}: ${f.detail}`).join("; ") });
    const rec = { mint, symbol: ev.symbol, outcome: "screened_out", fails: sc.fails, ev,
      finalDecision: "screened_out" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "screened_out",
      detail: sc.fails.map((f) => f.code).join(", "), report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  }

  /* SAFETY CLEARED — only now does the desk buy anything about this coin.
   *
   * The screen above answered the question that disqualifies outright: can this be used
   * against a holder, and can the position be left. Reputation research is expensive
   * and only matters once that answer is yes, so the paid X read happens HERE rather
   * than inside gather(), where it was costing 107 reads against 235 screen kills. */
  /* THE MOST EXPENSIVE OPINION ON THE DESK IS NO LONGER THE FIRST ONE BOUGHT.
   *
   * Measured over the trailing 24 hours: XRead $84.87 of a $190.39 bill — 44.6% of
   * everything the desk spends, 573 calls at $0.148 each — against $26.81 for the four
   * analyst seats put together. It was bought for every coin that cleared the free
   * screen, before a single cheap seat had looked at the chart, the pool or the tape.
   *
   * Any analyst returning kill ends the workup (see below), so a coin the cheap seats
   * condemn never needed a reputation read at all. The order is now: the three seats
   * that do not consult ev.xRead run first and in parallel; the X read, forensics and
   * narrative are bought only if the coin is still alive. Nothing is skipped for a coin
   * that survives, so no call this desk would have published is lost — the saving is
   * entirely in reads the desk was buying about coins it was about to reject anyway.
   *
   * The cost of the reorder is one extra round trip on surviving coins. The screen
   * still runs first, so the desk still never researches a honeypot. */
  emit("stage", { stage: "analysis", mint, symbol: ev.symbol });
  /* ORDER MATTERS FOR THE CACHE, NOT ONLY FOR THE BILL.
   *
   * The five analyst seats now send the evidence bundle as one byte-identical cached
   * block (analysts.js analystBlocks), so four of the five reads of it can be 0.1x cache
   * hits — but only if ONE request has written the entry before the others arrive.
   * Three seats fired in the same tick are three concurrent writers and every one of
   * them misses. So the first cheap seat is launched alone and the other two follow
   * CACHE_LEAD_MS later; technical goes first because it is the cheapest of the three
   * (measured 2026-09-05: charter 4,595 bytes against liquidity's 6,284 and flow's
   * 6,672, and the lightest weight on the desk) — the lead seat pays the write and the
   * rest read it. The deep batch (forensics,
   * narrative) arrives seconds later, after the X read, and reads the same entry: the
   * read rides as a separate block after the bundle precisely so the bundle does not
   * change between the two batches. Whether the write has landed after one second is
   * UNVERIFIED against the live API; cachedTok in /api/spend/seats is the ruler. */
  const cheapKeys = ["technical", "liquidity", "flow"];
  const analysts = {};
  const seatFailures = [];
  const collect = (k, r) => {
    if (r.status === "fulfilled") {
      analysts[k] = r.value;
      store.recordVerdict(cycle, mint, ev.symbol, k, r.value);
      emit("seat:verdict", { seat: ANALYSTS[k]?.label ?? "Narrative", mint, symbol: ev.symbol,
        score: r.value.score, confidence: r.value.confidence, kill: r.value.kill });
    } else {
      seatFailures.push({ seat: k, error: String(r.reason?.message || r.reason) });
      emit("seat:failed", { seat: k, mint, error: String(r.reason?.message || r.reason) });
    }
  };

  const cheap = await Promise.allSettled(cheapKeys.map((k, i) =>
    i === 0 ? runAnalyst(k, ev)
      : new Promise((r) => setTimeout(r, CACHE_LEAD_MS)).then(() => runAnalyst(k, ev))));
  cheap.forEach((r, i) => collect(cheapKeys[i], r));

  /* A kill here is final, exactly as it is after the full batch — so stop, and keep the
     X read's $0.148 plus two more seats. This is the whole saving, and it is recorded
     so the effect is auditable rather than asserted. */
  const cheapKiller = firstKiller(analysts);
  if (cheapKiller) {
    emit("stage", { stage: "xread_skipped", mint, symbol: ev.symbol,
      detail: `${cheapKiller[0]} killed it before the reputation read was bought` });
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: cheapKiller[0],
      reason: cheapKiller[1].kill_reason, ev, analysts, seatFailures, finalDecision: "killed" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `${cheapKiller[0]}: ${cheapKiller[1].kill_reason}`, report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  }

  /* STARTED, NOT AWAITED, and only for a coin still standing. Forensics reads the
     deployer's public record and narrative reads the story, so both wait on it; nothing
     else does. A failed read must not take the workup down — enrichWithXRead degrades
     to "no read", and the seats say so themselves when the read is missing.
     enrichWithXRead attaches the read to ev.xRead, where the red team, the PM, the
     best pick and the record want it; the analyst prompts strip that key out of the
     bundle block and carry the read as a separate block (analysts.js), so the cached
     bundle the cheap batch wrote is the bundle the deep batch reads. */
  const xRead = enrichWithXRead(ev, hook);
  const deepKeys = ["forensics", "narrative"];
  const deep = await Promise.allSettled([
    xRead.then(() => runAnalyst("forensics", ev)),
    xRead.then(() => runNarrative(ev)),
  ]);
  await xRead.catch(() => {});
  deep.forEach((r, i) => collect(deepKeys[i], r));

  // A desk missing half its analysts is not a desk. Refuse to decide on a thin book.
  if (Object.keys(analysts).length < 3) {
    emit("token:end", { mint, symbol: ev.symbol, outcome: "insufficient_coverage" });
    const rec = { mint, symbol: ev.symbol, outcome: "insufficient_coverage", seatFailures, ev, analysts,
      finalDecision: "insufficient_coverage" };
    recordEvaluation(rec);
    return rec;
  }

  const killer = firstKiller(analysts);
  if (killer) {
    const rec = { mint, symbol: ev.symbol, outcome: "killed", killedBy: killer[0],
      reason: killer[1].kill_reason, ev, analysts, finalDecision: "killed" };
    rec.reportFile = writeReport(cycle, rec);
    emit("token:end", { mint, symbol: ev.symbol, outcome: "killed",
      detail: `${killer[0]}: ${killer[1].kill_reason}`, report: rec.reportFile });
    recordEvaluation(rec);
    return rec;
  }

  // --- Stage 7-9: adversary, risk, decision. ---
  const weighted = composite(analysts);
  emit("stage", { stage: "redteam", mint, symbol: ev.symbol, weighted: Number(weighted.toFixed(1)) });
  const redteamRaw = await runRedTeam(ev, analysts);
  let redteam = redteamRaw;

  /* HOLD THE RED TEAM TO ITS OWN CHARTER.
   *
   * Measured over 57 verdicts: refuted 41 (72%), wounded 16, survives ZERO. A seat that
   * has never once let anything through is not discriminating — it is a constant, and a
   * constant carries no information. It also stops the desk dead, because an unanswered
   * refutation is a safety refusal in the mandate.
   *
   * Its own charter already draws the line and is worth quoting: refuted means "a
   * SPECIFIC, CHECKABLE fact breaks the thesis premise... NAME the fact. If your
   * refutation would read verbatim on any other token of this class, it is not a
   * refutation — it is the base rate."
   *
   * Prose could not enforce that, so code does. A refutation must be backed by at least
   * one attack the seat ITSELF marked fatal and evidenced. Where it is, the kill stands
   * untouched and is as decisive as ever. Where it is not, the finding is preserved in
   * full as `wounded` — which the desk already handles as "tradeable but smaller" —
   * and the downgrade is recorded so the seat's calibration stays auditable.
   *
   * This does not soften the red team. It requires it to show its work, which is the
   * standard it was written to. */
  /* THE BAR HAD A HOLE IN IT. "severity: fatal plus 20 characters of text" is
   * something the seat can always produce, so the rule caught nothing: across the last
   * two cycles refuted went 42 -> 44 with ZERO downgrades. It was measuring effort, not
   * evidence.
   *
   * The charter's actual standard is that a refutation names a SPECIFIC, CHECKABLE
   * fact — and the checkable facts on a memecoin are a short, closed list. So a fatal
   * attack now has to be ABOUT one of them. "The volume is 3 wallets round-tripping"
   * qualifies. "This is speculative and could go to zero" does not, however
   * confidently it is written, because nobody could go and find it false.
   *
   * Deliberately generous: any one of these words anywhere in the attack or its
   * evidence passes. The test is whether the seat is pointing at a fact of the right
   * KIND, not whether it phrased it a particular way. */
  const barred = applyRedTeamBar(redteam, ev);
  redteam = barred.redteam;
  const fatal = barred.verifiedFatal;
  if (redteam.downgraded_from) emit("seat:downgraded", { seat: "Red Team", mint, symbol: ev.symbol,
    from: "refuted", to: "wounded", reason: redteam.downgrade_reason });

  store.recordVerdict(cycle, mint, ev.symbol, "redteam", { verdict: redteam.verdict, confidence: redteam.confidence, ...redteam });
  emit("seat:verdict", { seat: "Red Team", mint, symbol: ev.symbol, detail: redteam.verdict,
    kill: redteam.verdict === "refuted",
    fatalAttacks: fatal.length,
    ...(redteam.downgraded_from ? { downgradedFrom: redteam.downgraded_from } : {}) });

  const modelRisk = await runRisk(ev, analysts, redteam);
  const openRiskUsd = retainedBookRiskUsd(liveCalls());
  const risk = enforceRiskRails({ risk: modelRisk, ev, redteam, openRiskUsd });
  if (risk.rail_notes?.length) emit("seat:adjusted", { seat: "Risk", mint, symbol: ev.symbol,
    detail: risk.rail_notes.join("; "), modelTier: modelRisk.risk_tier,
    finalSize: risk.position_size_usd });
  store.recordVerdict(cycle, mint, ev.symbol, "risk", { score: risk.position_size_usd, confidence: risk.confidence, ...risk });
  emit("seat:verdict", { seat: "Risk", mint, symbol: ev.symbol, detail: `$${risk.position_size_usd}` });

  const pm = await runPM(ev, analysts, redteam, risk, weighted, opts);
  store.recordVerdict(cycle, mint, ev.symbol, "pm", { verdict: pm.decision, score: pm.conviction, ...pm });
  emit("seat:verdict", { seat: "PM", mint, symbol: ev.symbol, detail: pm.decision, score: pm.conviction });

  // A WATCH becomes a standing order, not a note to self: the rules go on the
  // watchlist and a free checker promotes the token back through this whole
  // pipeline the moment they hold. Before this, WATCH terminated nowhere.
  if (pm.decision === "WATCH" && pm.watch_rules) {
    import("./watchlist.js").then((w) => w.addWatch({
      mint, symbol: ev.symbol, rules: pm.watch_rules,
      note: (pm.watch_triggers || []).join("; "),
    })).catch(() => {});
  }

  // --- Stage 10: the unsigned ticket. ---
  // Normally drafted only for a proposal. Under the mandate (one cycle, one trade)
  // the cycle ranks its contenders and publishes the best, so a WATCH may end up
  // being the call — and a call without a stop authored by the execution seat is
  // unpublishable and unmanageable. `alwaysTicket` buys that stop for anything the
  // PM did not actively pass on; a PASS still gets no ticket, because the mandate
  // never trades a coin the team named a flaw in.
  const wantTicket = pm.decision === "PROPOSE" || (opts.alwaysTicket && pm.decision === "WATCH");
  let ticket = null;
  if (wantTicket && risk.position_size_usd > 0) {
    ticket = await runExecution(ev, pm, risk);
    emit("seat:verdict", { seat: "Execution", mint, symbol: ev.symbol,
      detail: pm.decision === "PROPOSE" ? "ticket drafted" : "contingency ticket drafted (watch)" });
  }

  // --- Stage 11: compliance veto (code, not model). ---
  const comp = complianceCheck({ pm, risk, redteam, ticket, ev });
  emit("seat:verdict", { seat: "Compliance", mint, symbol: ev.symbol, pass: comp.pass,
    detail: comp.violations.map((v) => v.code).join(", ") || "clear" });

  let finalDecision = pm.decision;
  if (!comp.pass) finalDecision = "VETOED";

  const record = { mint, symbol: ev.symbol, outcome: "decided", weighted, ev, analysts,
    redteamRaw, redteam, risk, pm, ticket, compliance: comp, finalDecision };

  // --- Stage 12: the CEO. Only a clean proposal reaches the door. ---
  if (finalDecision === "PROPOSE") {
    emit("stage", { stage: "ceo", mint, symbol: ev.symbol });
    const modelCeo = await runCEO({ ev, pm, risk, redteam, ticket, compliance: comp },
      { ...opts, pmProvider: pm._provider ?? "claude" });
    const ceo = enforceCeoRails({ ceo: modelCeo, risk });
    if (ceo.rail_notes?.length) emit("seat:adjusted", { seat: "CEO", mint, symbol: ev.symbol,
      detail: ceo.rail_notes.join("; "), modelSize: modelCeo.order_size_usd,
      finalSize: ceo.order_size_usd });
    record.ceo = ceo;
    store.recordVerdict(cycle, mint, ev.symbol, "ceo",
      { verdict: ceo.ruling, score: ceo.order_size_usd, confidence: ceo.confidence, ...ceo });
    emit("seat:verdict", { seat: "CEO", mint, symbol: ev.symbol, detail: ceo.ruling,
      score: ceo.order_size_usd, one_line: ceo.one_line });

    record.order = await writeOrderSlip(cycle, { ev, ceo, pm, risk, ticket });
    finalDecision = ceo.ruling === "APPROVE" ? "APPROVED" : ceo.ruling === "HOLD" ? "HELD" : "DECLINED";
    record.finalDecision = finalDecision;
    record.proposalId = store.recordProposal(cycle, ev, { ...pm, decision: finalDecision }, risk, ticket);
  }

  // --- Stage 13: scribe. ---
  const file = writeReport(cycle, record);
  record.reportFile = file;
  emit("token:end", { mint, symbol: ev.symbol, outcome: finalDecision, conviction: pm.conviction,
    thesis: pm.thesis, size: record.order?.size ?? risk.position_size_usd, stop: ticket?.stop_price,
    gmgn: record.order?.links?.gmgn, report: file });
  // Publication happens later in the penthouse. Carry only the immutable row id so the
  // call sheet can link the strategy actually selected back to this exact evidence.
  record.decisionRunId = recordEvaluation(record);
  return record;
}

/** A full desk cycle: scout the universe, then work up the shortlist. */
export async function runCycle({ limit = cfg.maxCandidates, mints = null } = {}) {
  const cycle = cycleId();
  emit("cycle:start", { cycle });
  const results = [];

  let shortlist;
  if (mints?.length) {
    shortlist = mints.map((m) => ({ mint: m, why_now: "operator-specified", interest: 100 }));
    emit("scout:manual", { count: shortlist.length });
  } else {
    const universe = await buildUniverse();
    if (!universe.length) {
      emit("cycle:end", { cycle, note: "empty universe" });
      return { cycle, results: [] };
    }
    const scouted = await runScout(universe.slice(0, 60));
    shortlist = (scouted.picks || []).slice(0, limit);
    emit("scout:shortlist", { count: shortlist.length, picks: shortlist.map((p) => p.mint) });
  }

  for (const pick of shortlist.slice(0, limit)) {
    try {
      results.push(await workup(cycle, pick.mint, pick.why_now));
    } catch (e) {
      emit("token:end", { mint: pick.mint, outcome: "error", detail: String(e?.message || e) });
      results.push({ mint: pick.mint, outcome: "error", error: String(e?.message || e) });
    }
  }

  emit("cycle:end", { cycle, count: results.length, spendUsd: Number(spend.usd.toFixed(4)) });
  return { cycle, results, spend: { ...spend } };
}
