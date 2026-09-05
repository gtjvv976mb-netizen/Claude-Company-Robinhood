import db, { ensureColumn } from "./lib/store.js";
import crypto from "node:crypto";
import { emit } from "./lib/bus.js";
import "./calls.js";

/**
 * ALERTS — the desk can be right and the tenant still lose money because nobody told them.
 *
 * An exit that fires at 3am is worthless if it assumes someone is watching a browser tab.
 * So an exit is recorded as a durable, unread alert the moment it happens: it survives a
 * closed tab, a reload, and a week away, and it is only cleared when a human acknowledges it.
 *
 * Exit alerts are delivered to a floor REGARDLESS of arrears or unpaid fees. Gating an
 * exit on a billing dispute would trap someone in a position, which is indefensible.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_no   INTEGER NOT NULL,
  call_id    INTEGER REFERENCES calls(id),
  kind       TEXT NOT NULL,          -- exit | entry
  urgency    TEXT NOT NULL DEFAULT 'normal',
  title      TEXT NOT NULL,
  body       TEXT,
  mint       TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  UNIQUE (floor_no, call_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_alerts_floor ON alerts(floor_no, id DESC);
`);
ensureColumn("copy_settings", "webhook_url", "TEXT");
// The executor lane: a tenant may point THEIR OWN trading bot at our calls.
// We post signed JSON; their machine verifies the HMAC and does what it likes
// with its own keys. The desk still signs nothing and custodies nothing.
ensureColumn("copy_settings", "executor_url", "TEXT");
ensureColumn("copy_settings", "executor_secret", "TEXT");

/**
 * Where a tenant may be pinged. Restricted on purpose: an arbitrary user-supplied URL that
 * the server fetches is a server-side request forgery hole, so only the messaging hosts
 * people actually use are accepted.
 */
const WEBHOOK_HOSTS = ["discord.com", "discordapp.com", "api.telegram.org", "hooks.slack.com"];

/** An executor endpoint: any public https host, never anything that smells internal. */
export function validExecutorUrl(url) {
  if (!url) return { ok: true, url: null };
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: "not a URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "must be https" };
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")
      || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":"))
    return { ok: false, error: "must be a public hostname, not an address" };
  return { ok: true, url: u.toString() };
}

/** Fire one signed event at a floor's executor. Best effort; never blocks an exit. */
export async function pushExecutor(floorNo, event) {
  // Polling is the durable, non-SSRF delivery path. Push delivery stays disabled until
  // it has a resolved-address egress policy and persistent retry outbox.
  if (process.env.EXECUTOR_WEBHOOKS_ENABLED !== "1") return false;
  const row = db.prepare("SELECT executor_url, executor_secret FROM copy_settings WHERE floor_no=?").get(floorNo);
  if (!row?.executor_url || !row?.executor_secret) return false;
  const eventId = `${floorNo}:${event.type}:${event.call?.id ?? "unknown"}`;
  const body = JSON.stringify({ v: 2, event_id: eventId, ts: Date.now(), floor: floorNo, ...event });
  const sig = crypto.createHmac("sha256", row.executor_secret).update(body).digest("hex");
  let t;
  try {
    const ctl = new AbortController();
    t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(row.executor_url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-cc-signature": sig }, body, signal: ctl.signal });
    return res.ok;
  } catch { return false; }
  finally { if (t) clearTimeout(t); }
}

export function validWebhook(url) {
  if (!url) return { ok: true, url: null };            // clearing it is valid
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: "not a URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "must be https" };
  if (!WEBHOOK_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) {
    return { ok: false, error: `host must be one of: ${WEBHOOK_HOSTS.join(", ")}` };
  }
  return { ok: true, url: u.toString() };
}

export function raise({ floorNo, callId, kind, urgency = "normal", title, body, mint }) {
  try {
    db.prepare(`INSERT INTO alerts (floor_no,call_id,kind,urgency,title,body,mint,created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(floorNo, callId ?? null, kind, urgency, title, body ?? null, mint ?? null, Date.now());
    emit("alert", { floorNo, callId, kind, urgency, title });
    return true;
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return false;   // already alerted; never spam
    throw e;
  }
}

export const unreadFor = (floorNo) =>
  db.prepare("SELECT * FROM alerts WHERE floor_no=? AND read_at IS NULL ORDER BY id DESC LIMIT 20").all(floorNo);

export const recentFor = (floorNo, n = 20) =>
  db.prepare("SELECT * FROM alerts WHERE floor_no=? ORDER BY id DESC LIMIT ?").all(floorNo, n);

export function acknowledge(floorNo, ids) {
  const now = Date.now();
  const stmt = db.prepare("UPDATE alerts SET read_at=? WHERE floor_no=? AND id=? AND read_at IS NULL");
  let n = 0;
  for (const id of ids || []) n += stmt.run(now, floorNo, Number(id)).changes;
  return n;
}

/** Best effort push. A webhook that fails must never hold up an exit reaching the room. */
async function push(url, title, body) {
  const v = validWebhook(url);
  if (!v.ok || !v.url) return false;
  const text = `${title}\n${body ?? ""}`.trim();
  const payload = v.url.includes("api.telegram.org")
    ? { text }                                  // telegram sendMessage needs chat_id in the URL
    : { content: text };                        // discord / slack
  let t;
  try {
    const ctl = new AbortController();
    t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(v.url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: ctl.signal });
    return res.ok;
  } catch { return false; }
  finally { if (t) clearTimeout(t); }
}

/**
 * A new call is worth waking up for too. The trade loop STARTS with knowing the
 * call exists: a tenant whose tab was closed at 3am used to learn about an entry
 * only by opening the Calls pane later — and about the desk's work only at the
 * exit. Durable alert + webhook, same machinery as exits, kind 'entry'.
 */
export async function announceEntry(call) {
  const rows = db.prepare(`SELECT d.floor_no, d.size_eth, c.webhook_url
                           FROM deliveries d LEFT JOIN copy_settings c ON c.floor_no = d.floor_no
                           WHERE d.call_id=? AND d.verdict='offered'`).all(call.id);
  const sym = call.symbol || call.mint.slice(0, 6);
  let sent = 0;
  for (const r of rows) {
    const title = `New call — ${sym}`;
    const body = `${call.thesis || "The desk has published a call."}\n` +
      `Your floor sized it at ${r.size_eth ?? "?"} ETH. Open your floor's Calls tab for the ticket. ` +
      `This is research; you trade from your own wallet or not at all.`;
    const fresh = raise({ floorNo: r.floor_no, callId: call.id, kind: "entry",
      urgency: "normal", title, body, mint: call.mint });
    if (fresh && r.webhook_url) push(r.webhook_url, title, body).catch(() => {});
    if (fresh) pushExecutor(r.floor_no, { type: "entry", call: { id: call.id, mint: call.mint,
      symbol: call.symbol, side: "buy", entry_ref: call.entry_ref, stop: call.stop,
      target: call.target, size_eth: r.size_eth ?? null, thesis: call.thesis,
      invalidation: call.invalidation } }).catch(() => {});
    if (fresh) sent++;
  }
  return { floors: rows.length, alerted: sent };
}

/**
 * Fan an exit out to every floor that was offered the call. Deliberately not filtered by
 * arrears, unpaid fees, or whether the tenant said they took it — someone who quietly
 * bought without pressing the button still needs to hear that it is time to leave.
 */
export async function announceExit(call, exit) {
  const rows = db.prepare(`SELECT d.floor_no, c.webhook_url
                           FROM deliveries d LEFT JOIN copy_settings c ON c.floor_no = d.floor_no
                           WHERE d.call_id=? AND d.verdict='offered'`).all(call.id);
  const sym = call.symbol || call.mint.slice(0, 6);
  const title = exit.urgency === "unconditional"
    ? `EXIT NOW — ${sym}`
    : `Exit called — ${sym}`;
  const body = `${exit.detail}\nThis is a research call. Sell in your own wallet; the desk cannot and does not.`;

  let sent = 0;
  for (const r of rows) {
    const fresh = raise({ floorNo: r.floor_no, callId: call.id, kind: "exit",
      urgency: exit.urgency === "unconditional" ? "urgent" : "normal", title, body, mint: call.mint });
    // Fire and forget. Awaiting here let ONE hung webhook burn its full timeout and
    // hold up every later floor's exit alert — and the executor feed row that tells
    // a bot to sell. Nobody's exit may wait on someone else's Discord.
    if (fresh && r.webhook_url) push(r.webhook_url, title, body).catch(() => {});
    if (fresh) pushExecutor(r.floor_no, { type: "exit", call: { id: call.id, mint: call.mint,
      symbol: call.symbol, side: "sell", code: exit.code, urgency: exit.urgency,
      detail: exit.detail } }).catch(() => {});
    if (fresh) sent++;
  }
  return { floors: rows.length, alerted: sent };
}
