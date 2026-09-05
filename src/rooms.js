import db, { ensureColumn } from "./lib/store.js";
import { runFor, emit } from "./lib/bus.js";
import { leaseFor, leaseOf, balanceOf, DECIMALS } from "./leasing.js";
import { isEvmAddress, normalise } from "./lib/address.js";
import { workup } from "./desk.js";
import { identityFor, ordinal } from "./identity.js";

/**
 * A floor is a rented desk, not a window onto someone else's.
 *
 * Each floor has its own settings, its own journal, and its own research runs, which the
 * tenant triggers and pays for in $CLAUDECO. Runs are metered rather than continuous for
 * a reason worth stating plainly: a full multi-model workup costs real money, and a
 * one-time lease cannot fund unlimited compute. Metering is what keeps the promise honest.
 */

export const RUN_PRICE_TOKENS = Number(process.env.RUN_PRICE_CLAUDECO || 250_000);
export const RUN_PRICE_BASE_UNITS = BigInt(Math.round(RUN_PRICE_TOKENS)) * 10n ** BigInt(DECIMALS);
export const FREE_RUNS_WITH_LEASE = Number(process.env.FREE_RUNS_WITH_LEASE || 5);

db.exec(`
CREATE TABLE IF NOT EXISTS room_settings (
  floor_no    INTEGER PRIMARY KEY REFERENCES floors(n),
  desk_name   TEXT,
  risk_pct    REAL DEFAULT 1.0,
  equity_usd  REAL DEFAULT 10000,
  watchlist   TEXT DEFAULT '[]',
  updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no    INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  outcome     TEXT,
  detail      TEXT,
  paid        TEXT NOT NULL DEFAULT '0',
  free_run    INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_floor ON runs(floor_no, id DESC);
`);
// Take a break / let's grind: 'break' = the team works only when asked;
// 'grind' = it hunts on its own clock for as long as the credit lasts.
ensureColumn("room_settings", "mode", "TEXT NOT NULL DEFAULT 'break'");
ensureColumn("room_settings", "grind_hours", "REAL NOT NULL DEFAULT 4");
// Which brain manages this floor: Claude (default) or Grok, per the owner.
ensureColumn("room_settings", "md_brain", "TEXT NOT NULL DEFAULT 'claude'");

export function settings(floorNo) {
  let s = db.prepare("SELECT * FROM room_settings WHERE floor_no=?").get(floorNo);
  if (!s) {
    db.prepare("INSERT INTO room_settings (floor_no, updated_at) VALUES (?,?)").run(floorNo, Date.now());
    s = db.prepare("SELECT * FROM room_settings WHERE floor_no=?").get(floorNo);
  }
  return { ...s, watchlist: JSON.parse(s.watchlist || "[]") };
}

export function saveSettings(floorNo, patch) {
  const cur = settings(floorNo);
  const next = {
    desk_name: patch.deskName ?? cur.desk_name,
    risk_pct: Math.min(10, Math.max(0.1, Number(patch.riskPct ?? cur.risk_pct))),
    equity_usd: Math.max(0, Number(patch.equityUsd ?? cur.equity_usd)),
    watchlist: JSON.stringify((patch.watchlist ?? cur.watchlist).slice(0, 25)),
    mode: patch.mode === "grind" || patch.mode === "break" ? patch.mode : cur.mode,
    md_brain: patch.mdBrain === "grok" || patch.mdBrain === "claude" ? patch.mdBrain : cur.md_brain,
    grind_hours: Math.min(24, Math.max(1, Number(patch.grindHours ?? cur.grind_hours))),
  };
  db.prepare(`UPDATE room_settings SET desk_name=?, risk_pct=?, equity_usd=?, watchlist=?, mode=?, grind_hours=?, md_brain=?, updated_at=?
              WHERE floor_no=?`)
    .run(next.desk_name, next.risk_pct, next.equity_usd, next.watchlist, next.mode, next.grind_hours, next.md_brain, Date.now(), floorNo);
  if (patch.mode) emit("room:mode", { floor: floorNo, mode: next.mode });
  return settings(floorNo);
}

/** Floors currently grinding, with what they need for the auto-run decision. */
export function grindingFloors() {
  return db.prepare(`SELECT rs.floor_no, rs.grind_hours, rs.watchlist, l.wallet,
      (SELECT MAX(started_at) FROM runs r WHERE r.floor_no = rs.floor_no) AS last_run_at,
      (SELECT COUNT(*) FROM runs r2 WHERE r2.floor_no = rs.floor_no AND r2.started_at > ?) AS runs_24h
    FROM room_settings rs JOIN leases l ON l.floor_no = rs.floor_no
    WHERE rs.mode = 'grind'`).all(Date.now() - 86400e3);
}

/** Has this floor already researched this mint recently? Grinding must not re-buy the question. */
export const floorJudgedRecently = (floorNo, mint, withinMs = 24 * 3600e3) =>
  !!db.prepare("SELECT 1 FROM runs WHERE floor_no=? AND mint=? AND started_at > ? LIMIT 1")
    .get(floorNo, mint, Date.now() - withinMs);

export const runsFor = (floorNo, limit = 25) =>
  db.prepare("SELECT * FROM runs WHERE floor_no=? ORDER BY id DESC LIMIT ?").all(floorNo, limit);

const freeUsed = (floorNo) =>
  db.prepare("SELECT COUNT(*) n FROM runs WHERE floor_no=? AND free_run=1").get(floorNo).n;

export const freeRunsLeft = (floorNo) => Math.max(0, FREE_RUNS_WITH_LEASE - freeUsed(floorNo));

/** One run at a time per floor: a tenant cannot queue ten and drain their own balance. */
const busy = new Set();
export const isBusy = (floorNo) => busy.has(floorNo);

/**
 * RUNS DO NOT SURVIVE A RESTART, AND THIS PROCESS RESTARTS CONSTANTLY.
 *
 * A run is an in-memory async function. When the host recycles — and this one recycles
 * often enough to have killed 21 research cycles mid-flight in a single day — the
 * workup dies where it stands. Its row keeps `finished_at = NULL` forever, so the
 * journal shows a run that is permanently "in progress", and the in-memory busy flag
 * that would have told the UI is gone with the process.
 *
 * From the outside that is indistinguishable from the run never having been started:
 * you press the button, refresh, and there is nothing. Which is exactly what it looks
 * like, and exactly what it is.
 *
 * A queue would be the real answer. Short of that, this is the honest minimum: on
 * boot, any run left open past the point one could plausibly still be working is
 * marked `interrupted` with a reason, so the record says what happened instead of
 * lying quietly. RETRY_ON_BOOT re-queues the most recent one, because the person who
 * asked for it is not watching a log to find out it died.
 */
const RUN_STALE_MS = Number(process.env.RUN_STALE_MINS || 12) * 60000;

export function sweepInterruptedRuns({ retry = true } = {}) {
  const cutoff = Date.now() - RUN_STALE_MS;
  const orphans = db.prepare(
    "SELECT id, floor_no, wallet, mint, started_at FROM runs WHERE finished_at IS NULL AND started_at < ? ORDER BY id DESC")
    .all(cutoff);
  if (!orphans.length) return { swept: 0, requeued: 0 };

  db.prepare(`UPDATE runs SET outcome='interrupted',
                detail='the server restarted while this run was working — it was not finished',
                finished_at=? WHERE finished_at IS NULL AND started_at < ?`)
    .run(Date.now(), cutoff);
  for (const o of orphans) busy.delete(o.floor_no);
  emit("run:interrupted", { count: orphans.length,
    floors: [...new Set(orphans.map((o) => o.floor_no))],
    note: "runs killed by a restart, now closed in the record rather than left open forever" });

  /* Re-queue the newest one only. Retrying all of them would turn one restart into a
   * burst of paid workups, and the oldest are no longer decisions anyone is waiting on. */
  let requeued = 0;
  if (retry && orphans.length) {
    const o = orphans[0];
    if (Date.now() - o.started_at < 6 * 3600e3) {
      setTimeout(() => {
        requestRun({ floorNo: o.floor_no, wallet: o.wallet, mint: o.mint, houseSeat: o.floor_no === 50 })
          .then((r) => emit("run:requeued", { floor: o.floor_no, mint: o.mint, ok: r.ok, error: r.error ?? null }))
          .catch(() => {});
      }, 20_000);   // let the rest of boot settle first
      requeued = 1;
    }
  }
  return { swept: orphans.length, requeued };
}

/**
 * `houseSeat` is the HQ's owner running on floor 50.
 *
 * The route already worked this out and let them through — and then this function ran
 * its OWN lease check, found none (floor 50 is never for sale), and answered "this
 * floor is not leased". The button did nothing and said nothing. Two layers disagreeing
 * about the same permission is how a control ends up dead with no error to follow.
 *
 * The house seat also never pays $CLAUDECO. That token is the ACCESS key for tenants;
 * the HQ's owner is the person whose Anthropic bill the run lands on, so charging them
 * for their own compute is a fiction with an accounting entry.
 */
export async function requestRun({ floorNo, wallet, mint, houseSeat = false }) {
  const lease = leaseFor(floorNo);
  if (!houseSeat) {
    if (!lease) return { ok: false, error: "this floor is not leased" };
    if (lease.wallet !== wallet) return { ok: false, error: "this is not your floor" };
  }
  if (busy.has(floorNo)) return { ok: false, error: "your team is already working — one at a time" };
  // A token on Robinhood Chain is an ERC-20 contract address, stored lowercase.
  if (!isEvmAddress(mint)) return { ok: false, error: "that is not a token address (expected 0x…)" };
  mint = normalise(mint);

  const useFree = houseSeat || freeRunsLeft(floorNo) > 0;
  if (!useFree && balanceOf(wallet) < RUN_PRICE_BASE_UNITS) {
    return {
      ok: false, error: "not enough $CLAUDECO for a research run",
      needBaseUnits: RUN_PRICE_BASE_UNITS.toString(), haveBaseUnits: balanceOf(wallet).toString(),
    };
  }

  // Charge before working, so a crash cannot hand out free compute. Refunded below only
  // if the run dies before any model was asked anything.
  const paid = useFree ? 0n : RUN_PRICE_BASE_UNITS;
  if (!useFree) {
    db.prepare("INSERT INTO spends (wallet, base_units, created_at) VALUES (?,?,?)")
      .run(wallet, paid.toString(), Date.now());
  }
  const run = db.prepare(`INSERT INTO runs (floor_no, wallet, mint, paid, free_run, started_at)
                          VALUES (?,?,?,?,?,?)`)
    // A house run is neither PAID nor one of the tenant's INCLUDED runs, so it must
    // not decrement the free-run counter the UI shows. Recording it as free_run=1
    // would walk that number to zero on the one floor where it means nothing.
    .run(floorNo, wallet, mint, paid.toString(), (!houseSeat && useFree) ? 1 : 0, Date.now());
  const runId = run.lastInsertRowid;

  busy.add(floorNo);
  // Fire and forget: the room watches the event stream rather than holding the request open.
  (async () => {
    try {
      const brain = settings(floorNo).md_brain === "grok" ? "grok" : undefined;
      const res = await runFor(floorNo, () => workup(`floor${floorNo}-${runId}`, mint,
        brain ? "tenant request \u00b7 MD thinking on Grok" : "tenant request",
        // 'floor' is deliberately NOT an opportunistic lane: the tenant already paid
        // 250,000 $CLAUDECO for this run, so it draws on the full daily cap. Throttling
        // work someone has bought is not budgeting, it is keeping the money.
        { lane: houseSeat ? "house-floor" : "floor", ...(brain ? { pmProvider: brain } : {}) }));
      db.prepare("UPDATE runs SET symbol=?, outcome=?, detail=?, finished_at=? WHERE id=?")
        .run(res?.symbol ?? null, res?.outcome ?? "done", res?.detail ?? null, Date.now(), runId);

      /* A VERDICT THE TENANT CAN ACT ON.
       *
       * This is where a paid run used to end: the outcome went into a journal row and
       * stopped. So the desk could work a coin with all sixteen seats, have the PM
       * propose it and the CEO approve it — which happened for the first time with
       * AURA — and produce nothing anyone could trade. No call, no delivery, no bot
       * execution. The tenant paid 250,000 $CLAUDECO for a conclusion with no exit
       * from the database.
       *
       * A run that clears the same gauntlet a house call clears now becomes a call,
       * delivered to THIS floor only. The mandate's book gate still applies, so it
       * cannot open a second position while one is working, and every safety refusal
       * in mandate.js applies unchanged — this is a new road to the publish step, not
       * a way around it. */
      try {
        const { publishCall } = await import("./penthouse.js");
        const { classify, launchpad } = await import("./market.js");
        let category = null, pad = null;
        try {
          const c = { mint, pair: res?.ev?.pair };
          category = classify(c).category; pad = launchpad(c);
        } catch {}
        const pub = publishCall(res, { category, launchpad: pad, toFloors: [floorNo], sourceFloor: floorNo });
        if (pub?.callId) {
          db.prepare("UPDATE runs SET detail=? WHERE id=?")
            .run(`${res?.detail ?? res?.finalDecision ?? "decided"} · published as call #${pub.callId}`, runId);
          emit("run:published", { floor: floorNo, runId, callId: pub.callId, symbol: res?.symbol });
        } else if (pub?.reason) {
          emit("run:not_published", { floor: floorNo, runId, symbol: res?.symbol,
            outcome: pub.outcome, reason: pub.reason });
        }
      } catch (e) {
        // A publish failure must never lose the research the tenant paid for.
        emit("run:publish_error", { floor: floorNo, runId, error: String(e?.message || e) });
      }

      // Nothing was asked of a model, so nothing should have been charged — and a
      // FREE run must not be burned either. `screened_out` never reaches a seat any
      // more than `no_data` does; charging 250k $CLAUDECO (or silently spending an
      // included run) for work that never happened is money for nothing.
      const nothingStudied = res?.outcome === "no_data" || res?.outcome === "screened_out";
      if (nothingStudied) {
        if (useFree) {
          // Give the included run back by retiring the row from the free-run count.
          db.prepare("UPDATE runs SET free_run=0, outcome=? WHERE id=?")
            .run(res?.outcome ?? "no_data", runId);
          emit("run:refunded", { floor: floorNo, runId, reason: res?.outcome, free: true });
        } else {
          db.prepare("INSERT INTO credits (signature,dest_account,wallet,base_units,seen_at) VALUES (?,?,?,?,?)")
            .run(`refund:${runId}`, "refund", wallet, paid.toString(), Date.now());
          emit("run:refunded", { floor: floorNo, runId, reason: res?.outcome });
        }
      }
    } catch (e) {
      db.prepare("UPDATE runs SET outcome='error', detail=?, finished_at=? WHERE id=?")
        .run(String(e?.message || e), Date.now(), runId);
      if (!useFree) {
        db.prepare("INSERT INTO credits (signature,dest_account,wallet,base_units,seen_at) VALUES (?,?,?,?,?)")
          .run(`refund:${runId}`, "refund", wallet, paid.toString(), Date.now());
      }
    } finally {
      busy.delete(floorNo);
      emit("run:done", { floor: floorNo, runId });
    }
  })();

  return { ok: true, runId, charged: paid.toString(), free: useFree, freeRunsLeft: freeRunsLeft(floorNo) };
}

export function roomState(floorNo, wallet, { houseSeat = false } = {}) {
  const identity = identityFor(floorNo);
  const floorLabel = ordinal(floorNo);
  // The HQ floor has no lease row by design; for a house owner it reads as
  // their own room, under the house's name.
  const lease = leaseFor(floorNo)
    ?? (houseSeat ? { floor_no: floorNo, wallet, name: "The House Desk", base_units: "0", created_at: 0 } : null);
  const mine = Boolean(houseSeat || (wallet && lease && lease.wallet === wallet));
  /* The Team tab's WALL-ST-E tile said "local status not linked" forever, because this
   * payload reads room_settings while the executor's self-reported heartbeat lands in
   * copy_settings — two tables, one bot. Bridge it here, owner-only like the feed's
   * settings: the pulse is the tenant's own telemetry, not a public claim. */
  let executorHeartbeat = null;
  if (mine) {
    try { executorHeartbeat = db.prepare(
      "SELECT executor_heartbeat FROM copy_settings WHERE floor_no=?").get(floorNo)?.executor_heartbeat ?? null; }
    catch { executorHeartbeat = null; }
  }
  return {
    identity, floorLabel,
    floorNo,
    lease,
    isMine: mine,
    executorHeartbeat,
    settings: settings(floorNo),
    runs: runsFor(floorNo),
    busy: isBusy(floorNo),
    runPriceTokens: RUN_PRICE_TOKENS,
    runPriceBaseUnits: RUN_PRICE_BASE_UNITS.toString(),
    freeRunsLeft: lease ? freeRunsLeft(floorNo) : FREE_RUNS_WITH_LEASE,
    balanceBaseUnits: wallet ? balanceOf(wallet).toString() : "0",
    decimals: DECIMALS,
  };
}
