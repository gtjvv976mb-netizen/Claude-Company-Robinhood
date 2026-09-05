import { runCycle, workup } from "./desk.js";
import { startOffice } from "./office.js";
import { startScanner } from "./treasury-evm.js";
import { runPenthouseCycle, monitorCalls, freshScan, promoteWatches, startSubTickMarks } from "./penthouse.js";
import { autoSyncAll, collectOwed } from "./perf.js";
import { startWorld } from "./world.js";
import { chroniclePrune } from "./lib/bus.js";
import { chargeDueRent, settleArrears } from "./leasing.js";
import { bus } from "./lib/bus.js";
import { spend } from "./lib/llm.js";
import * as store from "./lib/store.js";
import db from "./lib/store.js";
import { cfg } from "./config.js";

/** The chain the doctor checks. Same env name and default as the executor's poller. */
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const RH_CHAIN_ID_HEX = "0x1237";   // 4663

const [, , cmd, ...args] = process.argv;

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", x: "\x1b[0m" };

function narrate() {
  bus.on("event", (e) => {
    const t = new Date(e.ts).toLocaleTimeString();
    const line = {
      "cycle:start": () => `${C.b}▶ cycle ${e.cycle}${C.x}`,
      "scout:universe": () => `${C.c}SCOUT${C.x} universe ${e.total} → ${e.fresh} fresh`,
      "scout:shortlist": () => `${C.c}SCOUT${C.x} shortlist: ${e.count}`,
      "scout:skip": () => `${C.dim}skip ${e.mint.slice(0, 6)} — ${e.reason}${C.x}`,
      "token:start": () => `\n${C.b}── ${e.mint.slice(0, 8)}…${C.x} ${C.dim}${e.hook || ""}${C.x}`,
      "token:evidence": () => `   evidence: ${e.symbol} $${e.price} liq $${Math.round(e.liq || 0).toLocaleString()}`,
      "seat:thinking": () => `${C.dim}   ${e.seat} thinking…${C.x}`,
      "seat:searching": () => `${C.dim}   ${e.seat} searching the web…${C.x}`,
      "seat:verdict": () => `   ${C.y}${e.seat}${C.x}: ${e.detail ?? ""}${e.score != null ? ` ${e.score}/100` : ""}${e.kill ? ` ${C.r}KILL${C.x}` : ""}${e.pass === false ? ` ${C.r}FAIL${C.x}` : ""}`,
      "seat:failed": () => `   ${C.r}${e.seat} failed${C.x}: ${e.error}`,
      "token:end": () => `   ${C.b}→ ${e.outcome}${C.x}${e.report ? ` ${C.dim}${e.report}${C.x}` : ""}`,
      "cycle:end": () => `\n${C.b}■ cycle done${C.x} — ${e.count ?? 0} tokens, $${e.spendUsd ?? 0} spent`,
    }[e.type];
    if (line) console.log(`${C.dim}${t}${C.x} ${line()}`);
  });
}

/**
 * The penthouse works on a schedule. Research is expensive, so it runs a few times a day;
 * monitoring open calls is free of model calls, so it runs often — an exit trigger that
 * fires six hours late is not an exit trigger.
 */
/** The books run whether or not the brain does. Rent and fill-syncing are pure
 * accounting — no model calls — and used to sit behind the penthouse guard, which
 * meant a server without an API key also silently stopped charging rent. */
function startBooks() {
  const rent = () => {
    try { const r = chargeDueRent();
      if (r.charged || r.unpaid) console.log(`[rent] charged ${r.charged}, in arrears ${r.unpaid}`);
    } catch (e) { console.log(`[rent] ${e.message}`); }
    // Retry what could not be collected before: unpaid rent against topped-up
    // balances, and performance fees that settled while the balance was short.
    try { const a = settleArrears();
      if (a.settled) console.log(`[rent] cleared ${a.settled} arrears (${a.remaining} remain)`);
    } catch (e) { console.log(`[rent] arrears: ${e.message}`); }
    try {
      const owed = dbOwedWallets();
      for (const w of owed) collectOwed(w).catch(() => {});
    } catch (e) { console.log(`[fees] ${e.message}`); }
  };
  setInterval(rent, 3600000);
  setTimeout(rent, 30000);
  setInterval(() => chroniclePrune(), 3600000);
  setInterval(() => { import("./data/snapshots.js").then((sn) => sn.prune()).catch(() => {}); }, 3600000);

  const sync = async () => {
    try { const r = await autoSyncAll();
      if (r.fills || r.settled) console.log(`[books] synced ${r.floors} floors: ${r.fills} fills, ${r.settled} settled`);
    } catch (e) { console.log(`[books] ${e.message}`); }
  };
  const syncMins = Number(process.env.BOOKS_SYNC_MINS || 10);
  setInterval(sync, syncMins * 60000);
  setTimeout(sync, 45000);
  console.log(`[books] rent hourly, fill sync every ${syncMins}m`);
}

function startMonitoring() {
  const monitorMins = Number(process.env.PENTHOUSE_MONITOR_MINS || 10);
  // Sub-tick price witnesses between full passes: the two-witness high needs
  // neighbours closer than the 10-minute monitor gap, and fresh close prints
  // need one confirming read before the book treats them as fact. startSubTickMarks
  // arms ONCE per process however many start paths call it — office mode calls both
  // startMonitoring and startPenthouse, and two 45s intervals firing back-to-back
  // wrote near-duplicate marks that satisfied the two-witness pair rule by racing it.
  startSubTickMarks(Number(process.env.PENTHOUSE_SUBMARK_SECS || 45));
  const watch = async () => {
    try { const r = await monitorCalls();
      if (r.closed) console.log(`[monitor] closed ${r.closed} of ${r.checked} open calls`);
    } catch (e) { console.log(`[monitor] failed: ${e.message}`); }
  };
  setInterval(watch, monitorMins * 60000);
  setTimeout(watch, 20000);
  console.log(`[monitor] exit checks every ${monitorMins}m — key or no key`);

  /* THE COACH'S SHIFT. Grading is arithmetic over marks that have already landed, so
     it runs often and costs nothing; the technique review thinks, so it runs rarely.
     Both are wrapped: a coach that throws must never take the desk down with it, and
     a desk that trades without a coach is exactly what it was last week. */
  const tutorMins = Number(process.env.TUTOR_REVIEW_MINS || 180);
  const coach = async () => {
    try {
      const { tutorTick } = await import("./agents/codex-tutor.js");
      const r = await tutorTick();
      const applied = (r.review?.changes || []).filter((c) => c.ok).length;
      if (r.graded.calls || applied || r.health?.reverted) {
        console.log(`[coach] graded ${r.graded.calls} calls / ${r.graded.seats} seat-verdicts` +
          (applied ? `, applied ${applied} change(s)` : "") +
          (r.health?.reverted ? `, REVERTED ${r.health.why}` : "") +
          (r.review?.held ? `, holding: ${r.review.held}` : ""));
      }
    } catch (e) { console.log(`[coach] ${e.message}`); }
  };
  setInterval(coach, tutorMins * 60000);
  setTimeout(coach, 90000);
  console.log(`[coach] grading + technique review every ${tutorMins}m`);
}

function dbOwedWallets() {
  return db.prepare("SELECT DISTINCT wallet FROM results WHERE fee_paid=0 AND fee_usd>0").all()
    .map((r) => r.wallet);
}

/**
 * THE GRIND — tenant teams that hunt on their own clock. A grinding floor gets
 * an automatic research run every grind_hours: target = the best-ranked coin in
 * the current sweep that the floor has not judged in 24h. Paid like any tenant
 * run ($CLAUDECO, free runs first), refunded on no_data, capped at 6 a day.
 * requestRun itself enforces busy/credit, so this scheduler only picks targets.
 */
function startGrind() {
  const tick = async () => {
    try {
      const { grindingFloors, floorJudgedRecently, requestRun, isBusy } = await import("./rooms.js");
      const floors = grindingFloors();
      const due = floors.filter((f) => !isBusy(f.floor_no) && (f.runs_24h ?? 0) < 6 &&
        (!f.last_run_at || Date.now() - f.last_run_at > f.grind_hours * 3600e3));
      if (!due.length) return;
      const { sweep } = await import("./market.js");
      const { rank } = await import("./penthouse.js");
      const universe = await sweep();
      const ranked = universe.map((c) => ({ c, r: rank(c) })).sort((a, b) => b.r.score - a.r.score);
      for (const f of due) {
        // The tenant's pinned watchlist comes FIRST: a coin they chose to stand
        // on is researched before the open-market hunt. Only when every pin has
        // been judged recently does the team fall back to the best-ranked sweep.
        let pinned = [];
        try { pinned = JSON.parse(f.watchlist || "[]"); } catch {}
        const pin = pinned.find((m) => typeof m === "string" && m.length >= 32 && !floorJudgedRecently(f.floor_no, m));
        const pick = pin
          ? { c: { mint: pin, pair: ranked.find((x) => x.c.mint === pin)?.c.pair }, pinned: true }
          : ranked.find((x) => x.r.score > 20 && !floorJudgedRecently(f.floor_no, x.c.mint));
        if (!pick) continue;
        const res = await requestRun({ floorNo: f.floor_no, wallet: f.wallet, mint: pick.c.mint });
        console.log(`[grind] floor ${f.floor_no} -> ${pick.c.pair?.baseSymbol ?? pick.c.mint.slice(0, 6)}${pick.pinned ? " (pinned)" : ""}` +
          (res.ok ? ` (run ${res.runId}${res.free ? ", free" : ""})` : ` refused: ${res.error}`));
      }
    } catch (e) { console.log(`[grind] ${e.message}`); }
  };
  const mins = Number(process.env.GRIND_CHECK_MINS || 20);
  setInterval(tick, mins * 60000);
  setTimeout(tick, 60000);
  console.log(`[grind] tenant auto-runs checked every ${mins}m`);
}

function startPenthouse() {
  /* 45 minutes, not 6 hours. With three slots in the book a position can close at any
   * time, and a six-hourly cycle would leave that slot empty for most of a day — the
   * desk would look idle while it was simply waiting for a clock.
   *
   * Frequent ticks are cheap because the expensive part is gated twice over: a cycle
   * that finds the book full returns immediately having spent nothing, and the hourly
   * pace in llm.js stops the desk eating the day's budget by lunchtime. So this sets
   * how OFTEN the desk may look, while the money decides how often it may work. */
  /* 20-minute cycles studied ~8 coins an hour and proposed about one in forty. The
   * pipeline's judgement is sound — a re-run of two live calls returned honest WATCHes
   * with named, machine-checkable promote rules — so the lever for more published
   * calls is throughput, not a lower bar: more distinct candidates studied per hour.
   * 12 minutes is ~1.7x the studies; the daily pacer in llm.js still caps the spend.
   * Render can override with PENTHOUSE_CYCLE_MINS. */
  const cycleMins = Number(process.env.PENTHOUSE_CYCLE_MINS || 12);
  const monitorMins = Number(process.env.PENTHOUSE_MONITOR_MINS || 10);
  // Sub-tick price witnesses between full passes: the two-witness high needs
  // neighbours closer than the 10-minute monitor gap, and fresh close prints
  // need one confirming read before the book treats them as fact. startSubTickMarks
  // arms ONCE per process however many start paths call it — office mode calls both
  // startMonitoring and startPenthouse, and two 45s intervals firing back-to-back
  // wrote near-duplicate marks that satisfied the two-witness pair rule by racing it.
  startSubTickMarks(Number(process.env.PENTHOUSE_SUBMARK_SECS || 45));
  if (process.env.PENTHOUSE_ENABLED === "0") { console.log("[penthouse] disabled"); return; }
  if (!process.env.ANTHROPIC_API_KEY) { console.log("[penthouse] no API key — the house team cannot work"); return; }

  const research = async () => {
    try { const r = await runPenthouseCycle();
      console.log(`[penthouse] cycle: ${r.considered} seen, ${r.workedUp} worked up, ${r.opened} calls, $${r.costUsd}`);
      return r;
    } catch (e) { console.log(`[penthouse] cycle failed: ${e.message}`); return null; }
  };
  // The boot cycle made every DEPLOY a paid research run — and with the
  // mandate hunting to exhaustion, every push could burn to the daily brake.
  // A restart now only fires the boot cycle if no cycle ran recently.
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
  const getKv = (k) => Number(db.prepare("SELECT value FROM kv WHERE key=?").get(k)?.value ?? 0);
  const setKv = (k, v) => db.prepare(
    "INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(k, String(v));

  /* THE STAMP MUST RECORD COMPLETION, NOT INTENT.
   *
   * It used to be written BEFORE the cycle ran, to stop every deploy firing a paid
   * cycle. But a cycle takes minutes and this process does not reliably live that
   * long — Render restarts it on every deploy, and an idle instance is spun down and
   * cold-started. So the sequence was: boot, stamp, start working, get killed. The
   * next boot then read its own fresh stamp, concluded a cycle had just run, skipped
   * the boot cycle, and fell back on a SIX-HOUR setInterval that a short-lived
   * process never survives to fire.
   *
   * The desk therefore started cycles constantly and finished none: the live record
   * showed 33 budget stops, 24 halts and no `cycle:end` for sixteen hours, while the
   * scanning lane kept ticking over and calls stayed at zero. A stamp that records an
   * intention rather than an outcome is indistinguishable from success, which is the
   * same class of mistake as grading a trade by whether the order was sent.
   *
   * Now: `last_cycle_done_at` moves only when a cycle actually returns, so an
   * interrupted cycle is correctly seen as never having happened and the next boot
   * retries it. `last_cycle_start_at` survives as the anti-stampede guard on its own
   * — a redeploy loop still cannot fire cycles back to back. A NEW key deliberately,
   * so the old start-stamps left in production cannot be misread as completions. */
  /* AND "COMPLETION" MUST MEAN THE CYCLE ACTUALLY GOT TO WORK.
   *
   * The first version of this stamped in a `finally`, which reintroduced the same bug
   * one level down: research() swallows its own errors, so a cycle that halted on an
   * exhausted budget after zero workups still stamped itself done — and blocked the
   * next boot for three hours on the strength of a failure. A halt is not a day's
   * work. It counts as done only if it worked something up, published something, or
   * legitimately had nothing to do because a position is already open. */
  /* researchStamped lived here and stamped completion itself. The continuous loop
   * below does that inline, and two copies of the same rule is how they drift apart —
   * which already cost a day once, when a stamp recorded intent instead of outcome. */
  const MIN_RETRY_MS = Number(process.env.PENTHOUSE_MIN_RETRY_MINS || 20) * 60000;
  const sinceDone = Date.now() - getKv("last_cycle_done_at");
  const sinceStart = Date.now() - getKv("last_cycle_start_at");

  /* THE SELF-HEAL. A stamp written by an earlier, buggier version of this same code
   * cannot be told apart from an honest one — and the version that stamped every
   * attempt, halts included, was live while cycles were halting on an exhausted
   * budget. So the desk could carry a fake completion and skip its boot cycle for
   * three hours on the strength of it, with no way to inspect the value remotely.
   *
   * A desk that has NEVER published a call is the one case where no stamp deserves
   * belief: whatever it claims, nothing has come out the other end. Until the first
   * call exists, boot on the retry guard alone. This stops applying by itself the
   * moment the desk works, so it is a bootstrap, not a permanent override. */
  const everPublished = (() => {
    try { return db.prepare("SELECT COUNT(*) n FROM calls").get().n > 0; }
    catch { return true; }   // table missing -> do not force; fail toward the stamp
  })();
  if (!everPublished && sinceStart > MIN_RETRY_MS) {
    console.log(`[penthouse] no call has ever published — the continuous loop starts without trusting any completion stamp`);
    // the continuous loop below starts on its own
  } else if (sinceDone > (cycleMins / 2) * 60000 && sinceStart > MIN_RETRY_MS) {
    console.log(`[penthouse] no cycle has COMPLETED in ${Math.round(sinceDone / 60000)}m — the continuous loop picks it up`);
    // the continuous loop below starts on its own
  } else if (sinceStart <= MIN_RETRY_MS) {
    console.log(`[penthouse] boot cycle held — one started ${Math.round(sinceStart / 60000)}m ago, inside the ${MIN_RETRY_MS / 60000}m retry guard`);
  } else {
    console.log(`[penthouse] boot cycle skipped — last COMPLETED ${Math.round(sinceDone / 60000)}m ago`);
  }
  /* CONTINUOUS, NOT ON A CLOCK.
   *
   * A fixed 20-minute interval means the desk works for about five minutes and then
   * sits idle for fifteen — roughly three quarters of the clock spent waiting while
   * memecoins move. That is the wrong shape for this market, and "runs 24/7" was only
   * true of the process, not of the work.
   *
   * So the loop goes again as soon as it finishes, and the BRAKES set the pace instead
   * of a timer. That is the right way round: the hourly pace and the daily cap already
   * know how fast the desk can afford to think, and they are measured in money rather
   * than minutes. A timer was always a crude proxy for them.
   *
   * The backoff is what stops a continuous loop becoming a hot one. Three cases, and
   * they need different answers:
   *   worked   — go again almost immediately; there is more market to read.
   *   nothing  — the pool was empty or the book full. Nothing is wrong, but nothing
   *              will change in ten seconds either, so wait a little.
   *   blocked  — paced or out of budget. Waiting is the entire remedy, so wait longer
   *              rather than spinning against a brake that will refuse identically.
   */
  const GAP_WORKED = Number(process.env.PENTHOUSE_GAP_WORKED_S || 45) * 1000;
  const GAP_IDLE = Number(process.env.PENTHOUSE_GAP_IDLE_S || 240) * 1000;
  const GAP_BLOCKED = Number(process.env.PENTHOUSE_GAP_BLOCKED_S || 600) * 1000;

  let running = false;
  async function continuousResearch() {
    if (running) return;                 // never two cycles in flight
    running = true;
    let gap = GAP_IDLE;
    try {
      const r = await research();
      if (r && ((r.workedUp ?? 0) > 0 || (r.opened ?? 0) > 0)) {
        setKv("last_cycle_done_at", Date.now());
        gap = GAP_WORKED;
      } else if (r?.stopped || r?.skipped === "budget") {
        gap = GAP_BLOCKED;
      } else if (r?.skipped === "position_open") {
        // The book is full, which is success, not a stall — a slot frees when a trade
        // closes and the monitor is what notices that, not this loop.
        setKv("last_cycle_done_at", Date.now());
        gap = GAP_IDLE;
      }
    } catch (e) {
      console.log(`[penthouse] loop error: ${e.message}`);
      gap = GAP_BLOCKED;
    } finally {
      running = false;
      setTimeout(continuousResearch, gap);
    }
  }
  setKv("last_cycle_start_at", Date.now());
  setTimeout(continuousResearch, 20000);
  console.log(`[penthouse] research runs CONTINUOUSLY — ${GAP_WORKED / 1000}s after a productive pass, ` +
    `${GAP_IDLE / 1000}s when idle, ${GAP_BLOCKED / 1000}s when the money brake is on`);

  // The sniper lane: cheap, frequent, and only ever pays for ignition.
  const freshMins = Number(process.env.PENTHOUSE_FRESH_MINS || 5);
  const fresh = async () => {
    try { const r = await freshScan();
      if (r.workedUp) console.log(`[fresh] worked up the top ignition: ${r.outcome}`);
      // A lane that dies silently is a lane that is dead for weeks — this line
      // is how "cfg is not defined" would have been caught on day one.
      if (r.error) console.log(`[fresh] scan error: ${r.error}`);
      if (r.halted) console.log(`[fresh] ${r.halted}`);
    } catch (e) { console.log(`[fresh] ${e.message}`); }
  };
  setTimeout(fresh, 90000);
  setInterval(fresh, freshMins * 60000);

  // The criteria, acted on: watches whose rules hold go back through the desk.
  const promoteMins = Number(process.env.PENTHOUSE_WATCH_MINS || 5);
  const promote = async () => {
    try { const r = await promoteWatches();
      if (r.workedUp) console.log(`[watch] promoted ${r.outcome} (${r.checked} watched)`);
      if (r.error) console.log(`[watch] ${r.error}`);
      if (r.halted) console.log(`[watch] ${r.halted}`);
    } catch (e) { console.log(`[watch] ${e.message}`); }
  };
  setTimeout(promote, 120000);
  setInterval(promote, promoteMins * 60000);

  /* THE LORE LANE. Grok reads what X is accelerating on, and the desk hunts the coins
   * wearing that story before the story is priced — the launchpads (PONS, hood.fun,
   * pools.trade) first, where a coin for a theme that broke ten minutes ago actually
   * is. This lane was written in full and never called by anything: a repo-wide search
   * for scanTrends found its definition and nothing else, so the desk has never once
   * front-run a narrative it could see.
   *
   * It costs one Grok call per pass, so it runs on its own slow clock rather than
   * inside the research loop, and each theme carries its own 90-minute cooldown. With
   * no XAI key it returns "no grok key" and nothing happens.
   *
   * GATED ON DESK STATE. Ungated, this was ~120 Grok calls a day (every 12 minutes
   * while a key exists), each reserving twelve searches, spent on days the desk could
   * not have worked a candidate up anyway: the only guard was the provider ceiling
   * inside xai(). Two conditions now stop the scan before it costs anything —
   *   book full  — trendHandoff refuses the workup when a call is live (penthouse.js),
   *                so the scan would buy an answer nothing can act on;
   *   no budget  — assertDailyBudget on the "trend" lane, the same lane the handoff's
   *                workup is charged to, so the scan and its consequence share a brake.
   * Both are checked here, in the scheduler, so the Grok call is never made. */
  const trendMins = Number(process.env.PENTHOUSE_TREND_MINS || 12);
  const trendHunt = async () => {
    try {
      const { bookState } = await import("./mandate.js");
      const book = bookState();
      if (book.full) {
        console.log(`[trend] scan skipped — book full at ${book.live}` +
          (book.holding?.symbol ? ` (${book.holding.symbol})` : ""));
        return;
      }
      const { assertDailyBudget, BudgetExhausted } = await import("./lib/llm.js");
      try { assertDailyBudget(cfg.dailyBudgetUsd, { lane: "trend" }); }
      catch (e) {
        if (e instanceof BudgetExhausted) { console.log(`[trend] scan skipped — ${e.message}`); return; }
        throw e;
      }
      const { scanTrends } = await import("./trends.js");
      const r = await scanTrends({ maxThemes: 4 });
      if (!r.ok) { console.log(`[trend] ${r.error}`); return; }
      if (r.candidates.length) {
        console.log(`[trend] ${r.candidates.length} candidate(s) from ${r.themes.length} live theme(s): ` +
          r.candidates.slice(0, 3).map((c) => `${c.symbol} (${c.theme})`).join(", "));
        // ...and act on the best one. Logging it and moving on meant paying Grok every
        // twelve minutes for an answer nothing ever read.
        const { trendHandoff } = await import("./penthouse.js");
        const h = await trendHandoff(r.candidates);
        if (h.workedUp) console.log(`[trend] worked up ${h.symbol} for "${h.theme}": ${h.outcome}`);
        else if (h.halted) console.log(`[trend] ${h.halted}`);
      } else if (r.empty?.length)
        console.log(`[trend] ${r.empty.length} story/stories live with no coin launched yet: ${r.empty.join(", ")}`);
    } catch (e) { console.log(`[trend] ${e.message}`); }
  };
  setTimeout(trendHunt, 150000);
  setInterval(trendHunt, trendMins * 60000);

  console.log(`[penthouse] fresh scan every ${freshMins}m, watch checks every ${promoteMins}m, ` +
    `trend hunt every ${trendMins}m`);
}

async function main() {
  switch (cmd) {
    case "doctor": {
      console.log(`${C.b}Claude Company doctor${C.x}`);
      // "set" is not the same as "usable" — a copied placeholder looks set and 401s.
      const key = process.env.ANTHROPIC_API_KEY || "";
      const keyState = !key ? C.r + "MISSING" + C.x
        : key.length < 40 || key.includes("...") ? C.r + "PLACEHOLDER — replace it with the real key" + C.x
        : !key.startsWith("sk-ant-") ? C.y + "unexpected format (should start sk-ant-)" + C.x
        : C.g + `set (${key.length} chars)` + C.x;
      console.log(`  API key      : ${keyState}`);
      if (key.length >= 40 && key.startsWith("sk-ant-")) {
        try {
          const Anthropic = (await import("@anthropic-ai/sdk")).default;
          const r = await new Anthropic().messages.create({
            model: "claude-opus-5", max_tokens: 8,
            messages: [{ role: "user", content: "say: ok" }],
          });
          console.log(`  API call     : ${C.g}works${C.x} (${r.model})`);
        } catch (e) {
          console.log(`  API call     : ${C.r}${e.status || ""} ${String(e.message).slice(0, 80)}${C.x}`);
        }
      }
      console.log(`  Treasury     : ${process.env.TREASURY_OWNER_RH ? C.g + "set — leasing open" + C.x : C.y + "TREASURY_OWNER_RH not set — leasing closed" + C.x}`);
      // The endpoint may carry a key in its query string; print the origin only.
      /* Host only: an Alchemy/Infura/QuickNode key lives in the PATH, and a URL printed
         with just its query stripped put it into scrollback and Render logs (LESSONS 313). */
      console.log(`  RPC          : ${(() => { try { return new URL(RH_RPC).host; } catch { return "(unparseable RH_RPC)"; } })()}`);
      /* Two reads, no ALLOWED list: readRpc() refuses anything that is not a Solana
       * read method, and eth_* is deliberately not on that list, so the doctor speaks
       * plain JSON-RPC. eth_chainId proves the endpoint is Robinhood Chain and not some
       * other EVM — a wrong RPC answers every other call plausibly — and eth_blockNumber
       * proves it is live. Both are read-only. */
      const { rpc } = await import("./lib/http.js");
      const chain = await rpc(RH_RPC, "eth_chainId", []);
      const chainOk = chain.ok && String(chain.data).toLowerCase() === RH_CHAIN_ID_HEX;
      console.log(`  Chain id     : ${!chain.ok ? C.r + chain.error + C.x
        : chainOk ? C.g + `${chain.data} (4663, Robinhood Chain)` + C.x
        : C.r + `${chain.data} — NOT Robinhood Chain (expected ${RH_CHAIN_ID_HEX}); fix RH_RPC` + C.x}`);
      const head = await rpc(RH_RPC, "eth_blockNumber", []);
      console.log(`  RPC reachable: ${head.ok
        ? C.g + `yes (block ${parseInt(head.data, 16)})` + C.x
        : C.r + head.error + C.x}`);
      console.log(`  Book equity  : $${cfg.equityUsd}  |  max risk/idea ${cfg.maxRiskPct}%`);
      console.log(`  Screen floors: liq $${cfg.screen.minLiquidityUsd}, age ${cfg.screen.minPairAgeHours}h, vol $${cfg.screen.minVolume24hUsd}`);
      const { spendSince } = await import("./lib/llm.js");
      const day = spendSince(Date.now() - 86400000), all = spendSince(0);
      console.log(`  Spend 24h    : $${day.usd} over ${day.calls} calls   |  all time: $${all.usd} over ${all.calls}`);
      console.log(`  Journal      : ${JSON.stringify(store.stats())}`);
      break;
    }
    case "office": {
      const { url } = startOffice(Number(args[0]) || Number(process.env.PORT) || 4949);
      startScanner();          // watches the treasury's ERC-20 Transfer logs on 4663; no-ops until TREASURY_OWNER_RH is set
      startBooks();            // rent + fill sync, always
      startWorld();            // the server runs the office; clients only watch
      startMonitoring();       // exit checks are a DUTY: they run with no key and no research
      if (process.env.ANTHROPIC_API_KEY) startGrind();   // tenant teams in grind mode
      /* Close out any run the last restart killed mid-flight, and re-queue the newest.
       * Without this a run that died looks, from the UI, exactly like a run that was
       * never started: you press the button, refresh, and there is nothing. */
      import("./rooms.js").then((r) => {
        const sw = r.sweepInterruptedRuns({ retry: true });
        if (sw.swept) console.log(`[runs] ${sw.swept} interrupted by a restart, ${sw.requeued} re-queued`);
      }).catch(() => {});
      startPenthouse();        // the house team's schedule
      console.log(`${C.b}Trading floor live at ${url}${C.x}  (Ctrl-C to close)`);
      narrate();
      break;
    }
    case "one": {
      if (!args[0]) { console.error("usage: npm run one -- <mint> [--office]"); process.exit(1); }
      if (args.includes("--office")) {
        const { url } = startOffice();
        console.log(`${C.b}Trading floor: ${url}${C.x}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      narrate();
      const r = await workup(new Date().toISOString().replace(/[:.]/g, "-"), args[0], "operator-specified");
      console.log(`\n${C.b}Outcome:${C.x} ${r.finalDecision || r.outcome}`);
      if (r.reportFile) console.log(`Report: ${r.reportFile}`);
      const { spend } = await import("./lib/llm.js");
      console.log(`${C.b}Cost:${C.x} $${spend.usd.toFixed(4)}  ` +
        `(${spend.calls} calls, ${spend.inTok.toLocaleString()} in / ${spend.outTok.toLocaleString()} out` +
        `${spend.cachedTok ? `, ${spend.cachedTok.toLocaleString()} cached` : ""})`);
      if (!args.includes("--office")) process.exit(0);
      break;
    }
    case "ledger": {
      const rows = store.ledger(30);
      if (!rows.length) { console.log("No proposals yet."); break; }
      console.log(`${C.b}date                 symbol    decision   conviction  size      stop${C.x}`);
      for (const r of rows) {
        console.log(
          `${new Date(r.ts).toISOString().slice(0, 16)}  ${String(r.symbol).padEnd(9)} ${String(r.decision).padEnd(10)} ` +
          `${String(r.conviction ?? "").padEnd(11)} $${String(r.size_usd ?? "").padEnd(8)} ${r.stop ?? ""}`
        );
      }
      console.log(`\n${JSON.stringify(store.stats(), null, 2)}`);
      break;
    }
    case "watch": {
      const mins = Number(args[0]) || 30;
      const { url } = startOffice();
      console.log(`${C.b}Trading floor: ${url}${C.x} — cycling every ${mins} min`);
      narrate();
      const loop = async () => {
        try { await runCycle({}); } catch (e) { console.error(C.r + String(e?.message || e) + C.x); }
        console.log(`${C.dim}next cycle in ${mins}m — total spend $${spend.usd.toFixed(4)}${C.x}`);
      };
      await loop();
      setInterval(loop, mins * 60_000);
      break;
    }
    case "run":
    default: {
      if (args.includes("--office")) {
        const { url } = startOffice();
        console.log(`${C.b}Trading floor: ${url}${C.x}`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      narrate();
      await runCycle({ limit: Number(process.env.DESK_MAX_CANDIDATES) || cfg.maxCandidates });
      console.log(`\nSpend: $${spend.usd.toFixed(4)} over ${spend.calls} calls`);
      if (!args.includes("--office")) process.exit(0);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
