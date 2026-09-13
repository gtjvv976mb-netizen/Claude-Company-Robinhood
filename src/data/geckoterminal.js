/**
 * GECKOTERMINAL'S TOKEN INDEX — the holder distribution and the launchpad phase, from an
 * indexer that actually answers.
 *
 * WHY THIS EXISTS. The desk had two holder sources and both were dead on this chain:
 *   - evm.holdersFromLedger replays every Transfer since the launch block, which needs a
 *     PONS launch log inside a 120,000-block (~3.4h) budget. Every coin older than that
 *     has no ledger.
 *   - blockscout.holdersFromExplorer read the explorer's index — and on 2026-09-13 the
 *     explorer sits behind a Cloudflare JavaScript challenge ("Just a moment...", HTTP
 *     403) to EVERY non-browser client, browser User-Agent included. Measured that day
 *     on the live desk: 19,335 workups, 19,334 kills, `unverified_holders` on 100% of
 *     them, zero calls ever published. The screen was not judging coins; it was
 *     reporting that it had gone blind, and every coin died of the blindness.
 *
 * GeckoTerminal's public token-info endpoint (no key, ~30 requests/min) indexes the
 * chain's current balances and reports, for a token: the holder COUNT, the share held by
 * the top 10 / next 20 / next 20 / everyone else, the developer's address and holding,
 * and — for launchpad coins — whether the curve completed and which pool it migrated to.
 * Probed live 2026-09-13 on AC (0xfad4…) and DOGE-1 (0x3ec8…): holders.count 741,
 * top_10 37.5%, developer_holding 3.36%, launchpad completed 2026-09-12T14:33:05Z with
 * the migrated V4 pool id.
 *
 * WHAT IT CAN AND CANNOT SAY, stated on the result so the seats read it as it is:
 *   - top10Pct INCLUDES the pool and any locker. A graduated PONS coin keeps most of its
 *     float in one V4 position, so this number is not "the top ten wallets" and is never
 *     compared against holder_concentration's 50% bar. top1Pct is null: the index does
 *     not name individual holders, and a null here means "not read", which the screen's
 *     concentration check treats as not measured rather than as zero.
 *   - the count is the indexer's own, never a page length.
 *   - `launchpad.completed` is the indexer's reading of the curve. It is treated as ONE
 *     source for the phase, never the only one: the chain's own V4 Initialize log stays
 *     primary (pons-live.graduationNear), and a sell that SIMULATES is still required.
 *
 * Fail closed: a 429, a timeout, a 404 or a malformed body returns ok:false and the
 * caller falls through to its next source. Cached ten minutes per token because the
 * public tier is rate-limited and a workup asks about the same coin several times.
 */
import { getJson } from "../lib/http.js";

const BASE = "https://api.geckoterminal.com/api/v2";
export const NETWORK = "robinhood";
export const CACHE_MS = 10 * 60_000;
const cache = new Map();
const lower = (a) => String(a ?? "").toLowerCase();
const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? Number(n.toFixed(2)) : null; };

/** Pure: the wire shape → the desk's. Exported so it is tested against a recorded body. */
export function shapeTokenInfo(body, { now = Date.now() } = {}) {
  const a = body?.data?.attributes;
  if (!a || typeof a !== "object") return { ok: false, error: "no token attributes in the body" };
  const h = a.holders ?? null;
  const dist = h?.distribution_percentage ?? null;
  const lp = a.launchpad_details ?? null;
  const updatedAt = h?.last_updated ? Date.parse(h.last_updated) : null;
  return {
    ok: true,
    address: lower(a.address),
    symbol: a.symbol ?? null,
    name: a.name ?? null,
    decimals: a.decimals != null ? Number(a.decimals) : null,
    holders: h ? {
      count: h.count != null ? Number(h.count) : null,
      top10Pct: pct(dist?.top_10),
      next20Pct: pct(dist?.["11_30"]),
      next20bPct: pct(dist?.["31_50"]),
      restPct: pct(dist?.rest),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
      ageMs: Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : null,
    } : null,
    developer: {
      address: a.developer_address ? lower(a.developer_address) : null,
      holdingPct: pct(a.developer_holding_percentage),
    },
    launchpad: lp ? {
      completed: lp.completed === true ? true : lp.completed === false ? false : null,
      completedAt: lp.completed_at ? Date.parse(lp.completed_at) || null : null,
      graduationPct: pct(lp.graduation_percentage),
      migratedPool: lp.migrated_destination_pool_address ? lower(lp.migrated_destination_pool_address) : null,
    } : null,
    gtScore: a.gt_score != null ? Number(a.gt_score) : null,
    honeypot: a.is_honeypot ?? null,
    socials: { twitter: a.twitter_handle ?? null, telegram: a.telegram_handle ?? null, websites: a.websites ?? [] },
    fetchedAt: now,
  };
}

/** The indexer's view of one token, cached. {ok:false, error} when it did not answer. */
export async function tokenInfo(address, { now = Date.now(), force = false } = {}) {
  const key = lower(address);
  const hit = cache.get(key);
  if (!force && hit && now - hit.fetchedAt < CACHE_MS) return hit;
  const r = await getJson(`${BASE}/networks/${NETWORK}/tokens/${key}/info`,
    { label: "geckoterminal/token-info", timeoutMs: 12_000, headers: { accept: "application/json" } });
  if (!r.ok) return { ok: false, error: `indexer token read failed: ${r.error}`, transient: /429|5\d\d|timeout|abort/i.test(String(r.error)) };
  const shaped = shapeTokenInfo(r.data, { now });
  if (shaped.ok) cache.set(key, shaped);
  return shaped;
}

/**
 * The holder distribution in the SAME shape evm.holdersFromLedger returns, so the screen
 * and the seats read one structure whatever produced it. Fields the index cannot supply
 * are null — "not read" — never zero.
 */
export async function holdersFromIndexer(address, { supply = null, decimals = 18, exclude = [], now = Date.now() } = {}) {
  const info = await tokenInfo(address, { now });
  if (!info.ok) return { ok: false, error: info.error, transient: info.transient === true };
  const h = info.holders;
  if (!h || !(h.count > 0) || h.top10Pct == null)
    return { ok: false, error: "the indexer carries no holder distribution for this token yet" };
  return {
    ok: true,
    source: "geckoterminal",
    complete: false,
    count: h.count,
    /* NOT NAMED BY THE INDEX. Null is the honest value: holder_concentration compares
       top1Pct against 50% and a null never fires it, which is "not measured", not "0%". */
    top1Pct: null,
    top10Pct: h.top10Pct,
    next20Pct: h.next20Pct,
    restPct: h.restPct,
    developerHoldingPct: info.developer.holdingPct,
    developerAddress: info.developer.address,
    clusteredHolders: null,
    bundleSuspect: null,
    midHoldersPct: null,
    headHoldersPct: null,
    midToHead: null,
    accounts: [],
    bundleScannedTop: null,
    excluded: [],
    poolsExcluded: 0,
    poolShareOfSupplyPct: null,
    burnedPct: null,
    updatedAt: h.updatedAt,
    ageMs: h.ageMs,
    note: `Holder distribution read from GeckoTerminal's index (${h.count} holders, updated ` +
      `${h.ageMs != null ? Math.round(h.ageMs / 60_000) + "m ago" : "at an unknown time"}), NOT rebuilt from a ` +
      "Transfer ledger. top10Pct INCLUDES the pool/locker positions and must not be read as ten wallets; " +
      "top1Pct and the bundle fingerprint are not available from this source and are null, not zero. " +
      `The developer holds ${info.developer.holdingPct ?? "an unknown share"}% of supply.`,
  };
}

/** For tests only. */
export const _resetCache = () => cache.clear();
