import db, { ensureColumn } from "./lib/store.js";
import { holdWindowFor } from "./categories.js";
import { emit } from "./lib/bus.js";
import { canonicalAddress, canonicalLaunchpad } from "./canonical.js";
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "../executor/trade-policy.mjs";

/* THE PADS WITH A CREATOR AND A CURVE, keyed by launchpad id rather than by a vanity
 * suffix on the address. On Solana every pump.fun mint ended in "pump", so one string
 * test identified the pad; an EVM address carries no such mark, and the launchpad is a
 * fact the sweep already knows (market.js launchpad(), from the dex id / factory). The
 * ids are the copy-trading LAUNCHPADS vocabulary, minus the two that have no creator
 * to watch: a plain Uniswap listing and `other`. Owned here, below copy.js in the
 * import graph, so copy.js can build its list from it without a cycle. */
export const CURVE_LAUNCHPADS = Object.freeze(["pons-v2", "pons", "hoodit", "pools.trade", "bankr"]);
// Through the alias table (canonical.js): the sweep says "pons" and "hood.fun" for what
// this list calls "pons-v2" and "hoodit", and a tripwire keyed on the raw label would
// have fired for neither. Re-exported so the pad's consumers read one name.
export { canonicalLaunchpad };
export const isCurveLaunchpad = (pad) => CURVE_LAUNCHPADS.includes(canonicalLaunchpad(pad));

/**
 * THE CALL SHEET — what the house team is actually doing.
 *
 * The penthouse publishes the shared house sheet once, and deterministic floor filters
 * copy it without another model bill. A paid tenant workup can also publish a scoped call
 * to its source floor; source_floor/source_scope preserve which path produced each row.
 *
 * A call is research plus an unsigned ticket. The desk never signs, never sends, never
 * holds a key. "Exit" here means the house has published an exit call — never that
 * anything was sold on anyone's behalf.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mint          TEXT NOT NULL,
  symbol        TEXT,
  category      TEXT,
  launchpad     TEXT,
  source_floor  INTEGER,
  source_scope  TEXT NOT NULL DEFAULT 'unattributed',
  source_attributed INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'live',   -- live | closed
  conviction    REAL,
  entry_ref     REAL,          -- the mark when the call was published
  entry_lo      REAL,
  entry_hi      REAL,
  stop          REAL,
  target        REAL,
  thesis        TEXT,
  invalidation  TEXT,
  -- the chain facts as they stood at the call; an exit fires if any of them change
  flags_at_call TEXT,
  liq_at_call   REAL,
  rt_loss_at_call REAL,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER,
  close_reason  TEXT,
  close_mark    REAL,
  report_file   TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_calls_live_mint ON calls(mint) WHERE status='live';

-- Every exit trigger that fired, kept even when a higher-precedence one won, so the
-- record shows what the desk saw rather than only what it acted on.
CREATE TABLE IF NOT EXISTS call_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id   INTEGER NOT NULL REFERENCES calls(id),
  kind      TEXT NOT NULL,
  detail    TEXT,
  mark      REAL,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_events ON call_events(call_id, id DESC);
`);

ensureColumn("calls", "launchpad", "TEXT");
ensureColumn("calls", "image_url", "TEXT");
// A close print is provisional until one confirming read agrees with it (subTickMarks).
ensureColumn("calls", "close_confirmed", "INTEGER");
// Sea Otter: when the thesis last cleared the screen it was admitted on.
ensureColumn("calls", "last_verified_at", "INTEGER");
// The market cap AT THE CALL, so a tenant's sleeve filter (micro / low / mid) has a
// number to compare against. Without it every floor sees every call regardless of the
// end of the market it asked for.
ensureColumn("calls", "mcap_at_call", "REAL");
// The team-authored size and loss budget must survive publication. Without these,
// every floor discarded Risk and CEO's work and independently invented a fresh size.
ensureColumn("calls", "desk_size_usd", "REAL");
ensureColumn("calls", "desk_risk_usd", "REAL");
ensureColumn("calls", "desk_equity_usd", "REAL");
ensureColumn("calls", "policy_version", "TEXT");
/* THE HOLD WINDOW THE BAND DESERVES. A call is an instruction to buy AND to sell, and
   until now only the buy carried a number: every position sat under one 12-hour age
   exit whatever it was. A $9k coin resolves inside half an hour and a $5m coin needs
   most of a day, so the window travels with the call (categories.js) and the bot sells
   on it. NULL on a legacy row and on any call whose market cap was unreadable — the
   bot then falls back to its own configured age exit, exactly as before. */
ensureColumn("calls", "hold_min_ms", "INTEGER");
ensureColumn("calls", "hold_max_ms", "INTEGER");
ensureColumn("calls", "hold_band", "TEXT");
/* THE GAS TERM AT THE MOMENT OF THE CALL. On this chain gas is a flat toll that does not
 * scale with the clip (660,996 gas a round trip, live-thresholds.mjs), so the smallest
 * executable size is a function of the gas price at the time — and a tenant's size is
 * decided in copy.js from the CALL ROW, hours after the bundle that measured it is gone.
 * Both numbers ride on the row; copy.js minExecutableEth() reads them and falls back to
 * its constant when they are null (a call published before these columns existed). */
ensureColumn("calls", "gas_usd_at_call", "REAL");
ensureColumn("calls", "eth_usd_at_call", "REAL");
// Historical calls were not stamped at publication, so NULL cannot safely be called
// house evidence. Only new, explicitly attributed rows enter improvement scorecards.
ensureColumn("calls", "source_floor", "INTEGER");
ensureColumn("calls", "source_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
ensureColumn("calls", "source_attributed", "INTEGER NOT NULL DEFAULT 0");
db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_provenance
         ON calls(source_attributed,source_scope,opened_at,closed_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_closed_provenance
         ON calls(source_attributed,source_scope,closed_at)`);

export function openCall(c) {
  /* The `mint` column keeps its name for schema stability — every index, feed field,
   * viewer and executor reads it — but it now holds a lowercase 0x address. Canonical
   * on the way in, so the live-call UNIQUE index means one coin, not one spelling. */
  c = { ...c, mint: canonicalAddress(c.mint), launchpad: canonicalLaunchpad(c.launchpad) };
  const hold = holdWindowFor(c.mcapUsd ?? null);
  // Every launchpad-origin call carries the one invalidation the research pass found
  // casually decisive: the observed profitable snipers' exit rule was "the creator
  // sold". Keyed on the launchpad the sweep identified, not on an address suffix — an
  // EVM address has none. Tenants deserve the same tripwire in writing.
  if (isCurveLaunchpad(c.launchpad) && c.invalidation && !/deployer|creator/i.test(c.invalidation)) {
    c = { ...c, invalidation: c.invalidation.replace(/\.?\s*$/, "") + ". Thesis void if the creator wallet sells." };
  }
  try {
    const info = db.prepare(`
      INSERT INTO calls (mint,symbol,category,launchpad,source_floor,source_scope,source_attributed,image_url,conviction,entry_ref,entry_lo,entry_hi,stop,target,
                         thesis,invalidation,flags_at_call,liq_at_call,rt_loss_at_call,mcap_at_call,
                         desk_size_usd,desk_risk_usd,desk_equity_usd,policy_version,opened_at,report_file,last_verified_at,
                         hold_band,hold_min_ms,hold_max_ms,gas_usd_at_call,eth_usd_at_call)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.mint, c.symbol ?? null, c.category ?? null, c.launchpad ?? null,
      c.sourceFloor ?? null, c.sourceScope ?? "unattributed", c.sourceAttributed === true ? 1 : 0,
      c.imageUrl ?? null, c.conviction ?? null,
      c.entryRef ?? null, c.entryLo ?? null, c.entryHi ?? null, c.stop ?? null, c.target ?? null,
      c.thesis ?? null, c.invalidation ?? null,
      c.flags == null ? null : JSON.stringify(c.flags), c.liqUsd ?? null, c.rtLossPct ?? null, c.mcapUsd ?? null,
      c.deskSizeUsd ?? null, c.deskRiskUsd ?? null, c.deskEquityUsd ?? null, c.policyVersion ?? POLICY_VERSION,
      Date.now(), c.reportFile ?? null,
      Date.now(),           // last_verified_at — clearing the gauntlet IS the first verification
      hold?.band ?? null, hold?.holdMinMs ?? null, hold?.holdMaxMs ?? null,
      Number(c.gasUsdRoundTrip) > 0 ? Number(c.gasUsdRoundTrip) : null,
      Number(c.ethUsd) > 0 ? Number(c.ethUsd) : null);
    const call = getCall(info.lastInsertRowid);
    emit("call:open", { callId: call.id, mint: call.mint, symbol: call.symbol, category: call.category, launchpad: call.launchpad });
    return call;
  } catch (e) {
    // A live call on this mint already exists; the desk does not stack calls on one coin.
    if (/UNIQUE/i.test(String(e.message))) return null;
    throw e;
  }
}

export const getCall = (id) => db.prepare("SELECT * FROM calls WHERE id=?").get(id) || null;
export const liveCalls = () => db.prepare("SELECT * FROM calls WHERE status='live' ORDER BY id DESC").all();
export const recentCalls = (n = 30) => db.prepare("SELECT * FROM calls ORDER BY id DESC LIMIT ?").all(n);
export const liveCallFor = (mint) =>
  db.prepare("SELECT * FROM calls WHERE mint=? AND status='live'").get(canonicalAddress(mint)) || null;

export function noteEvent(callId, kind, detail, mark) {
  db.prepare("INSERT INTO call_events (call_id,kind,detail,mark,ts) VALUES (?,?,?,?,?)")
    .run(callId, kind, detail ?? null, mark ?? null, Date.now());
  emit("call:event", { callId, kind, detail });
}

export function closeCall(id, reason, mark) {
  const c = getCall(id);
  if (!c || c.status !== "live") return null;
  db.prepare("UPDATE calls SET status='closed', closed_at=?, close_reason=?, close_mark=? WHERE id=?")
    .run(Date.now(), reason, mark ?? null, id);
  noteEvent(id, "closed", reason, mark);
  const pnl = c.entry_ref && mark ? ((mark - c.entry_ref) / c.entry_ref) * 100 : null;
  emit("call:close", { callId: id, mint: c.mint, symbol: c.symbol, reason, mark, pnlPct: pnl });
  return getCall(id);
}

/**
 * The exit triggers, in precedence order. Chain facts fire on one observation because
 * they are facts, not prices; price-based triggers need confirmation so one thin print
 * cannot close a call.
 */
/** The call's best CONFIRMED price since it opened, from the marks the monitor
 * already writes.
 *
 * MAX(mark) was a one-witness ratchet: a single anomalous mark entered history and
 * set the high-water mark forever, arming trails and breakeven stops off a price
 * that never traded twice — the exact defect the shared policy's two-witness rule
 * (snipe-v3) exists to prevent, which this pre-computed high was quietly bypassing
 * on the server path. The confirmed high is the best MIN of two CONSECUTIVE marks:
 * a spike flanked by honest neighbours contributes only its neighbour, while a real
 * run confirms one observation later. Same invariant as pricePolicy's pendingHigh,
 * derived from history instead of carried state. */
export function highWaterMark(callId) {
  const r = db.prepare(`SELECT MAX(pairLow) hwm FROM (
      SELECT MIN(mark, LAG(mark) OVER (ORDER BY id)) pairLow
      FROM call_events WHERE call_id=? AND mark IS NOT NULL
    )`).get(callId);
  return r?.hwm ?? null;
}

export function evaluateExit(call, now) {
  // "Unreadable" and "zero flags" are different facts. A call opened during an
  // RPC flake stores flags_at_call = null; comparing that as [] would report every
  // pre-existing authority as "appeared" on the first healthy read and fire a
  // spurious EXIT NOW on a sound thesis. Skip the comparison unless BOTH reads
  // are real. Corrupt JSON likewise disables this one trigger, not the monitor.
  let flagsAtCall = null;
  try { if (call.flags_at_call != null) flagsAtCall = new Set(JSON.parse(call.flags_at_call)); } catch {}
  const flagsNow = now.flags ?? [];
  const mark = now.mark ?? null;

  const newFlag = (flagsAtCall && now.flagsReadable !== false)
    ? flagsNow.find((f) => !flagsAtCall.has(f)) : null;
  if (newFlag) return { fire: true, code: "authority_appeared", urgency: "unconditional",
    detail: `a control appeared that was not there at the call: ${newFlag}`, pct: 100 };

  if (now.rtLossPct != null && now.rtLossPct > 12) return { fire: true, code: "cannot_exit", urgency: "unconditional",
    detail: `round trip is now ${now.rtLossPct.toFixed(1)}% — the position can no longer be left cleanly`, pct: 100 };

  if (call.liq_at_call && now.liqUsd != null && now.liqUsd < 0.6 * call.liq_at_call)
    return { fire: true, code: "liq_collapse", urgency: "unconditional",
      detail: `liquidity fell from $${Math.round(call.liq_at_call).toLocaleString()} to $${Math.round(now.liqUsd).toLocaleString()}`, pct: 100 };

  /* ONE VERSIONED PRICE POLICY. The server's paper record and the user's executor
   * import this same pure function, so a target/stop/expiry has one meaning. Chain
   * failures above still outrank price because only the desk can observe them. */
  /* Do NOT pre-max the current mark into the high — that hands pricePolicy a high
   * that already contains the unconfirmed sample, making its two-witness staging dead
   * code on this path. The current mark goes in as `mark`, where the policy stages
   * it; history confirms it on the next monitor pass via highWaterMark's pair rule. */
  const policyHwm = Math.max(highWaterMark(call.id) ?? 0, call.entry_ref ?? 0);
  const policy = pricePolicy({
    // The band's clock rides on the position, so the paper record closes a call at the
    // same moment a tenant's bot closes the trade. Without it the two paths disagreed
    // by hours on exactly the coins the desk holds for minutes.
    position: { entry: call.entry_ref, stop: call.stop, target: call.target,
      high: policyHwm, openedAtMs: call.opened_at,
      holdBand: call.hold_band ?? null, holdMaxMs: call.hold_max_ms ?? null },
    mark,
    // Tests and replay jobs may supply the observation timestamp. Live monitoring
    // omits it and uses the wall clock.
    nowMs: Number.isFinite(Number(now?.nowMs)) ? Number(now.nowMs) : Date.now(),
    config: { ...POLICY_DEFAULTS,
      takeProfitX: Number(process.env.DESK_TAKE_PROFIT_X || POLICY_DEFAULTS.takeProfitX),
      maxAgeHours: Number(process.env.DESK_MAX_AGE_HOURS || POLICY_DEFAULTS.maxAgeHours),
      trailPct: Number(process.env.DESK_TRAIL_PCT || POLICY_DEFAULTS.trailPct) },
  });
  if (policy.action === "sell") return { fire: true, code:
      policy.reason.startsWith("take profit") ? "take_profit" :
      policy.reason.startsWith("age exit") || / window closed /.test(policy.reason) ? "thesis_expired" :
      policy.reason === "desk target hit" ? "target_hit" : "stop_hit",
    urgency: "level", detail: `${policy.reason} · policy ${POLICY_VERSION}`, pct: 100 };
  return { fire: false, policyVersion: POLICY_VERSION };

}

export function stats() {
  const closed = db.prepare("SELECT entry_ref, close_mark, close_reason FROM calls WHERE status='closed' AND entry_ref IS NOT NULL AND close_mark IS NOT NULL").all();
  const pnls = closed.map((c) => ((c.close_mark - c.entry_ref) / c.entry_ref) * 100);
  const wins = pnls.filter((p) => p > 0).length;
  return {
    live: db.prepare("SELECT COUNT(*) n FROM calls WHERE status='live'").get().n,
    closed: closed.length,
    winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    avgPnlPct: pnls.length ? Number((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)) : null,
  };
}
