/**
 * THE BUY BOT — chain 4663, posted to Telegram.
 *
 * Every buy of the token, in the group, seconds after it lands. The usual
 * Telegram buy bots (Rick, Maestro and friends) do not support this chain, so
 * this reads GeckoTerminal's public trades feed instead: no RPC, no explorer,
 * no API key. Blockscout is deliberately not in the hot path — it answers 403
 * to anything that is not a browser, and a bot that depends on it dies quietly.
 *
 * FOUR THINGS THAT DECIDE WHETHER A BUY BOT IS ANY GOOD, all of them learned
 * the hard way by other people's:
 *
 *   1. IT MUST NOT DUMP HISTORY ON START. The feed returns ~150 recent trades;
 *      a bot that posts what it finds on boot spams a hundred messages into the
 *      group the first time you restart it. This one ADOPTS the current position
 *      silently and only posts what happens after (the same rule the executor's
 *      cursor follows, for the same reason).
 *   2. IT MUST NOT REPOST. Trades are keyed by tx hash, and the seen-set is
 *      written to disk, so a restart is silent rather than a second wave.
 *   3. IT MUST NOT SPAM DUST. A floor in USD, because a group that scrolls past
 *      $0.40 buys stops reading the $400 one.
 *   4. IT MUST NOT DIE. Every tick is wrapped; a rate limit backs off instead of
 *      exiting. A buy bot that stops at 3am is worse than none, because nobody
 *      notices it stopped.
 *
 * Run it with --dry to print what it WOULD post and send nothing.
 */
import fs from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry");
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const CHAT = process.env.TELEGRAM_CHAT_ID || "";
const NETWORK = process.env.GT_NETWORK || "robinhood";
/* Pools, comma-separated, each optionally labelled `address:LABEL`. Two pools
   quote the same token here — a bot watching only one looks dead while the
   other fills. */
const POOLS = (process.env.POOLS ||
  "0x595aa54d2a32d9c6ced42e88355dae507aaf6fa5:NVDA,0x16490a58e924b22078237a3f20634aca25b97c45:WETH")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [address, label] = s.split(":"); return { address: address.toLowerCase(), label: label || "pool" }; });

const MIN_USD = Number(process.env.MIN_BUY_USD || 5);
const POLL_MS = Number(process.env.POLL_MS || 20_000);
const STATE_FILE = path.resolve(process.env.BUYBOT_STATE || "./.buybot-state.json");
const TOKEN_NAME = process.env.TOKEN_NAME || "CLAUDECO";
const SITE = process.env.SITE_URL || "https://claudedotcompany.com";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fail = (m) => { console.error(`buybot: ${m}`); process.exit(1); };

if (!DRY && (!TOKEN || !CHAT)) {
  fail("TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are required (or pass --dry to print instead of post)");
}
if (!Number.isFinite(MIN_USD) || MIN_USD < 0) fail("MIN_BUY_USD must be a non-negative number");
if (!Number.isFinite(POLL_MS) || POLL_MS < 5000) fail("POLL_MS must be at least 5000 — the feed is rate limited");

/* ── state: what we have already posted ─────────────────────────────────── */
let S = { primed: false, seen: [] };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
const seen = new Set(S.seen);
const save = () => {
  try {
    // Keep the tail only: the set exists to stop reposts across a restart, and
    // an unbounded file would eventually be the slowest part of the tick.
    fs.writeFileSync(STATE_FILE, JSON.stringify({ primed: S.primed, seen: [...seen].slice(-800) }));
  } catch (e) { log("state save failed:", e.message); }
};

/* ── the feed ───────────────────────────────────────────────────────────── */
const GT = "https://api.geckoterminal.com/api/v2";
let backoff = 0;

async function trades(pool) {
  const url = `${GT}/networks/${NETWORK}/pools/${pool}/trades`;
  const res = await fetch(url, { headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000) });
  if (res.status === 429) { backoff = Math.min(5, backoff + 1); throw new Error("rate limited"); }
  if (!res.ok) throw new Error(`trades ${res.status}`);
  backoff = 0;
  const body = await res.json();
  return Array.isArray(body?.data) ? body.data : [];
}

/* Price, market cap and liquidity for the header.
 *
 * Fetched ON DEMAND — when there is a buy to post and the cache is stale — not on
 * a tick counter. The counter version refreshed every fifth tick and swallowed
 * failures, so one rate-limited call left every post for the next minute and a
 * half with no market cap on it: the single number a group reads first, missing,
 * with nothing in the log to say why. */
const POOL_TTL_MS = 120_000;
const poolInfo = new Map();
async function poolStats(pool) {
  const hit = poolInfo.get(pool);
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit;
  try {
    const res = await fetch(`${GT}/networks/${NETWORK}/pools/${pool}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) { log(`pool stats ${res.status} — posting without a header`); return hit || null; }
    const a = (await res.json())?.data?.attributes;
    if (!a) return hit || null;
    const info = {
      at: Date.now(),
      price: Number(a.base_token_price_usd) || null,
      fdv: Number(a.fdv_usd) || null,
      liq: Number(a.reserve_in_usd) || null,
      name: a.name || null,
    };
    poolInfo.set(pool, info);
    return info;
  } catch (e) {
    log(`pool stats failed (${e.message}) — posting without a header`);
    return hit || null;                 // stale beats blank
  }
}

/* ── the message ────────────────────────────────────────────────────────── */
const usd = (n) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The emoji wall, scaled to size — one per $10, floored at 3 and capped at 48
 *  so a whale is obvious and a group message is still readable. */
function wall(amountUsd) {
  const n = Math.max(3, Math.min(48, Math.round(amountUsd / 10)));
  return "🟢".repeat(n);
}

function render(t, label, info) {
  const a = t.attributes;
  const amount = Number(a.volume_in_usd) || 0;
  const got = Number(a.to_token_amount) || 0;
  const price = Number(a.price_to_in_usd) || info?.price || null;
  const lines = [
    `<b>${esc(TOKEN_NAME)} BUY!</b>  <i>${esc(label)}</i>`,
    wall(amount),
    "",
    `💵 <b>${usd(amount)}</b>`,
    got ? `🪙 ${got.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${esc(TOKEN_NAME)}` : null,
    price ? `📈 $${price.toPrecision(3)}` : null,
    info?.fdv ? `🏦 MCap ${usd(info.fdv)}` : null,
    info?.liq ? `💧 Liq ${usd(info.liq)}` : null,
    `👤 <a href="https://robinhoodchain.blockscout.com/address/${a.tx_from_address}">${short(a.tx_from_address)}</a>`,
    `🧾 <a href="https://robinhoodchain.blockscout.com/tx/${a.tx_hash}">tx</a> · ` +
      `<a href="https://dexscreener.com/robinhood/${t.__pool}">chart</a> · ` +
      `<a href="${SITE}">claudedotcompany.com</a>`,
  ].filter(Boolean);
  return lines.join("\n");
}

async function post(text) {
  if (DRY) { console.log("\n----- would post -----\n" + text.replace(/<[^>]+>/g, "") + "\n"); return true; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML",
        disable_web_page_preview: true }),
    });
    if (!res.ok) { log(`telegram ${res.status}: ${(await res.text()).slice(0, 140)}`); return false; }
    return true;
  } catch (e) { log("telegram failed:", e.message); return false; }
}

/* ── the loop ───────────────────────────────────────────────────────────── */
let ticks = 0;
async function tick() {
  for (const { address, label } of POOLS) {
    let rows;
    try { rows = await trades(address); }
    catch (e) { log(`${label}: ${e.message}`); continue; }

    // Oldest first, so a burst posts in the order it happened.
    rows.reverse();
    const fresh = rows.filter((t) => !seen.has(t.attributes.tx_hash));

    if (!S.primed) {
      // FIRST RUN: adopt everything silently. The alternative is 150 messages.
      for (const t of rows) seen.add(t.attributes.tx_hash);
      continue;
    }

    // Only worth a call when something is actually going to be posted.
    const postable = fresh.filter((t) => t.attributes.kind === "buy"
      && (Number(t.attributes.volume_in_usd) || 0) >= MIN_USD);
    const info = postable.length ? await poolStats(address) : null;

    for (const t of fresh) {
      const a = t.attributes;
      seen.add(a.tx_hash);
      if (a.kind !== "buy") continue;
      const amount = Number(a.volume_in_usd) || 0;
      if (amount < MIN_USD) continue;
      t.__pool = address;
      const ok = await post(render(t, label, info));
      log(`${ok ? "posted" : "FAILED"} ${label} buy ${usd(amount)} ${a.tx_hash.slice(0, 12)}…`);
      await new Promise((r) => setTimeout(r, 400));   // Telegram dislikes bursts
    }
  }

  if (!S.primed) {
    S.primed = true;
    log(`primed on ${seen.size} historic trades — posting only what happens from here`);
  }
  ticks++;
  save();
}

log(`buybot up — ${POOLS.map((p) => p.label).join(", ")} on ${NETWORK}` +
  ` · floor ${usd(MIN_USD)} · every ${POLL_MS / 1000}s` + (DRY ? " · DRY RUN (nothing is posted)" : ""));

const loop = async () => {
  try { await tick(); }
  catch (e) { log("tick failed:", e.message); }       // never let one bad tick end the bot
  setTimeout(loop, POLL_MS * (backoff ? 2 ** backoff : 1));
};
loop();
