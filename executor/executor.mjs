/**
 * CLAUDE COMPANY — REFERENCE EXECUTOR (LEGACY WEBHOOK ADAPTER, DRY RUN ONLY)
 *
 * The desk (Claude or Grok) is the BRAIN: it researches and publishes calls, and never
 * touches a wallet. This script is the retired inbound-webhook shape of the HANDS: it
 * verifies signed JSON events from the floor and LOGS what the caps would allow. It
 * never trades, never signs, and rejects EXECUTE=1 at startup. The durable outbound
 * polling service — the one that actually executes on Robinhood Chain — is poller.mjs.
 *
 * Kept because the deploy publishes it as a reference for people writing their own
 * adapter against the signed-event contract; everything chain-specific was removed
 * from it on 2026-09-05 so it carries no signing dependency at all.
 *
 * SETUP
 *   1) On your floor's Calls tab → Desk settings → "Your executor":
 *      paste this machine's public URL and copy the signing secret it shows you.
 *   2) Run:
 *      CC_SECRET=<signing secret> CC_FLOOR=<floor> \
 *      MAX_ETH_PER_TRADE=0.004 DAILY_ETH_CAP=0.04 \
 *      EXECUTE=0 node executor.mjs      # signed-event verification and logging only
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.CC_SECRET || "";
const EXPECTED_FLOOR = Number(process.env.CC_FLOOR || 0);
const EXECUTE = process.env.EXECUTE === "1";
const MAX_ETH = Number(process.env.MAX_ETH_PER_TRADE || 0.004);
const DAILY_CAP = Number(process.env.DAILY_ETH_CAP || 0.04);
const CHAIN_ID = 4663;

if (EXECUTE) {
  console.error("LIVE webhook execution is disabled; use the reviewed polling executor (poller.mjs) for paper mode or the explicit local canary.");
  process.exit(1);
}
if (!SECRET) { console.error("CC_SECRET is required (from your floor's executor panel)"); process.exit(1); }
if (!(MAX_ETH > 0) || !(DAILY_CAP >= MAX_ETH)) { console.error("MAX_ETH_PER_TRADE must be positive and DAILY_ETH_CAP at least one trade"); process.exit(1); }

let spentToday = 0, dayStart = Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

async function onEvent(ev) {
  if (Date.now() - dayStart > 86400e3) { spentToday = 0; dayStart = Date.now(); }
  const c = ev.call || {};
  if (!isAddress(c.mint)) return log(`SKIP ${c.symbol || "?"}: ${c.mint} is not an ERC-20 address on chain ${CHAIN_ID}`);
  if (ev.type === "entry") {
    // Tenant sizes are ETH decimal strings (size_eth); the local cap always wins.
    const wantEth = Math.min(Number(c.size_eth || MAX_ETH), MAX_ETH);
    if (spentToday + wantEth > DAILY_CAP) return log(`SKIP entry ${c.symbol}: daily cap (${spentToday.toFixed(6)}/${DAILY_CAP} ETH spent)`);
    log(`ENTRY ${c.symbol} (${c.mint}) — desk sized ${c.size_eth} ETH, capped to ${wantEth} ETH`,
      `| stop ${c.stop} target ${c.target}`);
    return log("DRY RUN — this adapter never signs; poller.mjs is the executor");
  }
  if (ev.type === "exit") {
    log(`EXIT ${c.symbol} (${c.code}, ${c.urgency}) — ${c.detail}`);
    return log("DRY RUN — this adapter never signs; poller.mjs is the executor");
  }
  log(`ignored event type ${ev.type}`);
}

http.createServer((req, res) => {
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 65536) req.destroy(); });
  req.on("end", async () => {
    const theirs = String(req.headers["x-cc-signature"] || "");
    const ours = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    if (!/^[a-f0-9]{64}$/i.test(theirs) ||
        !crypto.timingSafeEqual(Buffer.from(theirs, "hex"), Buffer.from(ours, "hex"))) {
      log("REJECTED: bad signature"); res.writeHead(401); return res.end("bad signature");
    }
    try {
      const ev = JSON.parse(body);
      const fresh = Number(ev.ts) > Date.now() - 5 * 60000 && Number(ev.ts) < Date.now() + 60000;
      if (ev.v !== 2 || !ev.event_id || !fresh || (EXPECTED_FLOOR > 0 && ev.floor !== EXPECTED_FLOOR) ||
          (ev.chain != null && Number(ev.chain) !== CHAIN_ID)) {
        res.writeHead(400); return res.end("invalid, stale, or wrong-chain event");
      }
      await onEvent(ev);
      res.writeHead(200); res.end("ok");
    } catch (e) {
      log("ERROR:", e.message); res.writeHead(500); res.end("failed");
    }
  });
}).listen(PORT, () => log(`reference executor up on :${PORT} — chain ${CHAIN_ID} — DRY RUN — max ${MAX_ETH} ETH/trade, ${DAILY_CAP} ETH/day — no wallet, no key`));
