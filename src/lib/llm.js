import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { emit, runContext } from "./bus.js";
import { CHARTER, cfg } from "../config.js";
import db, { ensureColumn } from "./store.js";
// No cycle: desk-policy reaches only store, bus and canonical, never back into llm.
import { withPolicy } from "../desk-policy.js";

db.exec(`
CREATE TABLE IF NOT EXISTS llm_spend (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  floor    INTEGER,
  floor_attributed INTEGER NOT NULL DEFAULT 0,
  evidence_scope TEXT NOT NULL DEFAULT 'unattributed',
  seat     TEXT, model TEXT, effort TEXT,
  in_tok   INTEGER, out_tok INTEGER, cached_tok INTEGER,
  usd      REAL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_ts ON llm_spend(ts);
`);

/**
 * WHERE THE MONEY ACTUALLY GOES, per seat.
 *
 * The desk records every model call's seat, model, effort and cost, and nothing has ever
 * read it back. "Make it cheaper" without this is guesswork — and guesswork here means
 * cutting the seat that is cheap and load-bearing while leaving the one that is 44% of
 * the bill untouched. Aggregate only: no prompt text, no evidence, no wallet.
 */
export function spendBySeat({ hours = 24 } = {}) {
  const since = Date.now() - Math.max(1, Number(hours) || 24) * 3600e3;
  const rows = db.prepare(`
    SELECT seat, model, effort,
           COUNT(*) AS calls,
           SUM(usd) AS usd,
           SUM(in_tok) AS inTok,
           SUM(out_tok) AS outTok,
           SUM(cached_tok) AS cachedTok
    FROM llm_spend WHERE ts >= ?
    GROUP BY seat, model, effort
    ORDER BY usd DESC`).all(since);
  const total = rows.reduce((a, r) => a + (Number(r.usd) || 0), 0);
  const workups = db.prepare(
    "SELECT COUNT(DISTINCT ts / 600000) n FROM llm_spend WHERE ts >= ?").get(since)?.n ?? 0;
  return {
    hours, sinceMs: since,
    totalUsd: Number(total.toFixed(4)),
    seats: rows.map((r) => ({
      seat: r.seat, model: r.model, effort: r.effort,
      calls: r.calls,
      usd: Number((Number(r.usd) || 0).toFixed(4)),
      pctOfTotal: total > 0 ? Number(((Number(r.usd) || 0) / total * 100).toFixed(1)) : 0,
      usdPerCall: r.calls > 0 ? Number(((Number(r.usd) || 0) / r.calls).toFixed(4)) : 0,
      inTok: r.inTok, outTok: r.outTok, cachedTok: r.cachedTok,
      // A seat whose input dwarfs its output is paying to READ; one whose output
      // dominates is paying to THINK. They are cut in completely different ways.
      shape: (r.outTok || 0) > (r.inTok || 0) / 4 ? "thinking" : "reading",
    })),
    tenMinuteBuckets: workups,
  };
}

ensureColumn("llm_spend", "floor", "INTEGER");
// Existing nulls predate floor attribution and may contain tenant spend. Keep them out
// of house-only improvement evidence rather than laundering unknown provenance as HQ.
ensureColumn("llm_spend", "floor_attributed", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("llm_spend", "evidence_scope", "TEXT NOT NULL DEFAULT 'unattributed'");
db.exec(`CREATE INDEX IF NOT EXISTS idx_spend_floor_ts
         ON llm_spend(floor_attributed,evidence_scope,floor,ts)`);

/** Billing failures are terminal for a cycle: retrying just burns time. */
export class OutOfCredit extends Error {}

/** The daily cap tripping is handled exactly like an empty balance — every existing
 * OutOfCredit path (halt the cycle, fail the floor run cleanly) already does the
 * right thing, so the brake subclasses it rather than inventing a parallel path. */
export class BudgetExhausted extends OutOfCredit {}

/**
 * THE RESERVE — the publishing lane cannot be starved by the scanning lanes.
 *
 * Measured on the live desk: 160 workups in a day, $20.15 of a $25 cap, and ZERO
 * calls. The cause was not strictness — `call:withheld` never fired once, meaning the
 * desk never reached its publish step at all. It was arithmetic. The fresh scan runs
 * every 5 minutes (288 chances a day to spend) while the full cycle — the ONLY lane
 * carrying the mandate hunt, and so the only lane that reliably publishes — runs four
 * times. The scanner ate the day's budget before the publisher could open its mouth:
 * 33 cycles ended on the budget and 24 halted outright, against 2 that genuinely
 * found nothing in the market.
 *
 * So the cap becomes two caps. Opportunistic lanes (the fresh scan, watch promotion)
 * may spend only up to their share; past that the money is RESERVED and only the
 * cycle may draw on it. A tenant's own floor run is never throttled — they paid
 * 250,000 $CLAUDECO for it, and taking payment for work we then refuse to do is not a
 * budget policy, it is a broken promise.
 */
export const OPPORTUNISTIC_SHARE = Math.min(0.95, Math.max(0.1,
  Number(process.env.DESK_OPPORTUNISTIC_SHARE || 0.55)));

/** Lanes that yield to the reserve. Everything else spends to the full cap. */
const OPPORTUNISTIC = new Set(["fresh", "promote"]);

/**
 * THE PACE — what actually makes a desk run around the clock.
 *
 * A daily cap alone does not produce a 24/7 desk, it produces a desk that works until
 * lunchtime. Left to itself the machine spends as fast as it can find candidates, so a
 * $40 day is gone in a few hours and the next eighteen are silent — which is precisely
 * what happened on the 30th: 163 workups, $22 by mid-afternoon, then nothing.
 *
 * So spending is paced by the HOUR as well as the day. The hourly allowance is the
 * daily cap divided across 24 hours and multiplied by a burst factor, so the desk can
 * still work a cluster of candidates when it finds one, but cannot eat tomorrow
 * morning's budget tonight. Running out of pace is not an error: the cycle ends
 * gracefully, the monitor keeps watching every open position for free, and the next
 * tick picks up where this one stopped.
 *
 * A tenant's paid floor run is exempt. They bought that work and it is not ours to
 * schedule.
 */
export const HOURLY_BURST = Math.max(1, Number(process.env.DESK_HOURLY_BURST || 3));

/** ONE cycle budget, read in ONE place. This used to be read three times with two
 * different defaults — 4 here, 8 in penthouse.js and evaluation.js — so the pace floor
 * below (`cycleBudget * 1.25`) was computed against half the cycle the desk actually
 * runs. Latent at DESK_DAILY_BUDGET_USD=90 (the pace, $11.25/h, exceeds both), but at
 * a $25 day the floor would be $5 against a real $8 cycle: the exact deadlock the
 * comment below describes. penthouse.js and evaluation.js should import this rather
 * than re-read the env var (see docs/HANDOFF-llm-cache.md). llm.js sits below both in
 * the import graph, so the constant lives here. */
export const CYCLE_BUDGET_USD = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || 8);

/**
 * PROMPT-CACHE TTL for the shared rules block. Default 5 minutes.
 *
 * The research loop runs continuously (index.js: 45s after a productive pass, 240s
 * idle) with three workups in flight, so while the desk is working, start-to-start gaps
 * between calls on the same model are well under five minutes and every call after the
 * first is a 0.1x read on the 5m entry. The 1h entry costs 2x to write (5m is 1.25x)
 * and only pays for prefixes reused at 5-60 minute gaps — the first workup after the
 * money brake sleeps the desk, or a floor that runs one tenant call an hour. So 5m is
 * the default and DESK_CACHE_TTL=1h is an operator choice for a sparse desk, not a
 * free upgrade. Only the SHARED_RULES marker carries it: the API requires longer-TTL
 * breakpoints to precede shorter ones, and SHARED_RULES is always first.
 */
export const CACHE_TTL = process.env.DESK_CACHE_TTL === "1h" ? "1h" : "5m";
const cacheMark = (ttl = "5m") => ttl === "1h"
  ? { type: "ephemeral", ttl: "1h" }
  : { type: "ephemeral" };

/** Throws before any tokens are spent if this lane's share of the last 24h is gone. */
export function assertDailyBudget(capUsd, { lane = "cycle" } = {}) {
  if (!capUsd || capUsd <= 0) return;
  const totalSpent = spendSince(Date.now() - 24 * 3600e3).usd;
  const spent = spendSince(Date.now() - 24 * 3600e3,
    { evidenceScope: "house", includeUnattributed: true }).usd;
  const yields = OPPORTUNISTIC.has(lane);
  if (totalSpent >= capUsd) {
    throw new BudgetExhausted(
      `daily provider budget spent: $${totalSpent.toFixed(2)} of $${capUsd} in 24h`);
  }

  // Pace first: it is the brake that keeps the desk alive at 3am, and it binds long
  // before the daily cap does. The tenant's own paid run never waits on it.
  if (lane !== "floor") {
    /* THE FLOOR UNDER THE PACE. A pace tighter than one cycle's own allowance is not
     * a pace, it is a deadlock: the cycle is cut off mid-hunt every single time and
     * can never reach its publish step. That is exactly what shipped — $5/hour
     * against a $10 cycle — and the desk went an hour without completing anything
     * while looking, from outside, like a quiet market.
     *
     * Read from the same env var penthouse.js reads rather than imported from it;
     * llm.js is below penthouse in the graph and must not reach back up. */
    const hourCap = Math.max((capUsd / 24) * HOURLY_BURST, CYCLE_BUDGET_USD * 1.25);
    const spentHour = spendSince(Date.now() - 3600e3,
      { evidenceScope: "house", includeUnattributed: true }).usd;
    if (spentHour >= hourCap) {
      emit("cycle:paced", { lane, spentHourUsd: spentHour, hourCapUsd: Number(hourCap.toFixed(2)),
        dayUsd: spent, capUsd });
      throw new BudgetExhausted(
        `hourly pace reached: $${spentHour.toFixed(2)} of $${hourCap.toFixed(2)} this hour ` +
        `— the desk paces $${capUsd} across the day so it is still working tonight; monitoring continues`);
    }
  }

  // Paid floor work skips pacing and the house reserve, but it cannot spend past the
  // provider-account hard ceiling. The caller's existing failure path handles refunding
  // a run that dies before a model is asked.
  if (lane === "floor") {
    return;
  }

  const laneCap = yields ? capUsd * OPPORTUNISTIC_SHARE : capUsd;
  if (spent >= laneCap) {
    emit("cycle:budget", { usedUsd: spent, capUsd, laneCap: Number(laneCap.toFixed(2)),
      lane, reserved: yields, window: "24h" });
    throw new BudgetExhausted(yields
      ? `the ${lane} lane has spent its share ($${spent.toFixed(2)} of $${laneCap.toFixed(2)}) — ` +
        `the rest of the $${capUsd} day is reserved for the cycle that publishes`
      : `daily budget spent: $${spent.toFixed(2)} of $${capUsd} in 24h — the desk pauses, monitoring continues`);
  }
}

const client = new Anthropic();

// Anthropic list price, USD per 1M tokens. Used only for the desk's own
// running cost meter — it is not billing.
const PRICE = {
  "claude-opus-5":   { in: 5.0,  out: 25.0 },
  "claude-fable-5":  { in: 10.0, out: 50.0 },
  "claude-sonnet-5": { in: 2.0,  out: 10.0 },
  "claude-haiku-4-5":{ in: 1.0,  out: 5.0  },
};

// Reservations use deliberately conservative rates, not the selected model's best
// case. This covers server-side fallback, cache-write premiums, and concurrent seats.
const PROVIDER_RESERVATION_PRICE = {
  // $20/MTok covers the most expensive configured model's 1-hour cache-write
  // rate. This checkout only requests 5-minute cache entries, but reservations
  // are a ceiling, not an estimate.
  anthropic: { in: 20, out: 50, search: 0.01, inputOverhead: 4096,
    serverToolContextTokens: 1_000_000, perSearchContextTokens: 40_000 },
  // Grok 4.6 doubles token rates above its long-context threshold.
  xai: { in: 4, out: 12, search: 0.005, inputOverhead: 2048,
    serverToolContextTokens: 500_000, perSearchContextTokens: 40_000 },
};
let reservedProviderUsd = 0;
let unpersistedProviderUsd = 0;

const rawProviderSpendUsd = (sinceMs) => Number(db.prepare(
  "SELECT COALESCE(SUM(usd),0) usd FROM llm_spend WHERE ts>=?").get(sinceMs)?.usd || 0) +
  unpersistedProviderUsd;

export function noteUnpersistedProviderSpend(usd) {
  unpersistedProviderUsd += Math.max(0, Number(usd) || 0);
}

/** Reserve a worst-case model call before it starts. The synchronous check/increment
 * makes parallel analyst launches atomic within the process, so five calls cannot all
 * observe the same last dollar and overshoot it together. */
export function reserveProviderBudget({ provider = "anthropic", maxTokens = 16000,
  maxSearches = 0, payload = "", capUsd = cfg.dailyBudgetUsd } = {}) {
  if (!(capUsd > 0)) return { usd: 0, release() {} };
  const price = PROVIDER_RESERVATION_PRICE[provider];
  if (!price) throw new Error(`unknown provider budget: ${provider}`);
  let serialized;
  try { serialized = typeof payload === "string" ? payload : JSON.stringify(payload); }
  catch { serialized = String(payload); }
  // One token can never contain less than one source byte, so bytes are a safe upper
  // bound on input tokens; fixed overhead covers request/tool framing not in payload.
  const requestInputCeiling = Buffer.byteLength(serialized || "", "utf8") + price.inputOverhead;
  /* Server-side search results are injected after the request leaves this process, so
   * payload bytes cannot reserve them. This used to reserve a COMPLETE model context —
   * a million tokens, $20.00 — for any call that enabled a tool, whatever it had asked
   * the tool to do. Measured: the narrative seat reserved $20.82 against a real cost of
   * $0.18, a hundred-fold, and on a $200 day a handful of concurrent seats could
   * exhaust the reservation pool and start refusing work the desk had the money for.
   * Those refusals surfaced as "fewer than three analysts returned" — a billing failure
   * wearing a research verdict, 2,532 times in seven days.
   *
   * A ceiling should be generous, not arbitrary. Each search a call is ALLOWED to make
   * can inject a bounded amount of context, so the reservation scales with the number
   * requested and is still capped by the full-context figure for anything unbounded. */
  const toolContextCeiling = maxSearches > 0
    ? Math.min(price.serverToolContextTokens,
      Math.max(price.perSearchContextTokens, maxSearches * price.perSearchContextTokens))
    : 0;
  const inputTokenCeiling = Math.max(requestInputCeiling, toolContextCeiling);
  const outputTokenCeiling = Math.max(1, Math.min(100_000, Number(maxTokens) || 16000));
  const searchCeiling = Math.max(0, Math.min(10_000, Number(maxSearches) || 0));
  const usd = inputTokenCeiling / 1e6 * price.in +
    outputTokenCeiling / 1e6 * price.out + searchCeiling * price.search;
  const spent = rawProviderSpendUsd(Date.now() - 24 * 3600e3);
  if (spent + reservedProviderUsd + usd > capUsd) {
    throw new BudgetExhausted(
      `metered provider ceiling: $${spent.toFixed(2)} spent + $${reservedProviderUsd.toFixed(2)} reserved; ` +
      `next call needs up to $${usd.toFixed(2)} of the $${capUsd.toFixed(2)} limit`);
  }
  reservedProviderUsd += usd;
  let released = false;
  return { usd, release() {
    if (released) return;
    released = true;
    reservedProviderUsd = Math.max(0, reservedProviderUsd - usd);
  } };
}

export async function withProviderBudget(options, fn) {
  const reservation = reserveProviderBudget(options);
  try { return await fn(); }
  finally { reservation.release(); }
}

export const spend = { usd: 0, calls: 0, inTok: 0, outTok: 0, cachedTok: 0 };

/** Cost one completed Anthropic response from provider-reported usage. Cache fields
 * are separate from input_tokens. Cache writes are charged at the maximum supported
 * 2x duration and reads at their documented 0.1x rate, so a future duration change
 * cannot make the local hard brake optimistic. */
export function anthropicUsageCost(requestedModel, message) {
  const model = message?.model || requestedModel;
  const p = PRICE[model] || { in: 10, out: 50 };
  const usage = message?.usage || {};
  const uncached = Math.max(0, Number(usage.input_tokens) || 0);
  const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  const searches = Math.max(0, Number(usage.server_tool_use?.web_search_requests) || 0);
  const usd = uncached / 1e6 * p.in + cacheWrite / 1e6 * p.in * 2 +
    cacheRead / 1e6 * p.in * 0.1 + output / 1e6 * p.out + searches * 0.01;
  return { model, uncached, cacheWrite, cacheRead, output, searches, usd };
}

export function meterAnthropicUsage(requestedModel, message, seat, effort) {
  const cost = anthropicUsageCost(requestedModel, message);
  const { model, uncached, cacheWrite, cacheRead, output, usd } = cost;
  const totalInput = uncached + cacheWrite + cacheRead;
  spend.usd += usd;
  spend.calls += 1;
  spend.inTok += totalInput;
  spend.outTok += output;
  spend.cachedTok += cacheRead;
  const context = runContext.getStore();
  const floor = context?.floor ?? null;
  const evidenceScope = context?.evidenceScope ??
    (floor == null || Number(floor) === 50 ? "house" : "tenant");
  try {
    db.prepare("INSERT INTO llm_spend (floor,floor_attributed,evidence_scope,seat,model,effort,in_tok,out_tok,cached_tok,usd,ts) VALUES (?,1,?,?,?,?,?,?,?,?,?)")
      .run(floor, evidenceScope, seat ?? null, model, effort ?? null,
        totalInput, output, cacheRead, usd, Date.now());
  } catch { noteUnpersistedProviderSpend(usd); } // preserve the brake even if the ledger is unavailable
  return cost;
}

/** What the desk has actually spent, from the database rather than a live process. */
export function spendSince(sinceMs, { evidenceScope, includeUnattributed = false } = {}) {
  const scoped = evidenceScope == null ? ""
    : includeUnattributed
      ? " AND ((floor_attributed=1 AND evidence_scope=?) OR floor_attributed=0)"
      : " AND floor_attributed=1 AND evidence_scope=?";
  const row = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(usd),0) usd,
    COALESCE(SUM(in_tok),0) inTok, COALESCE(SUM(out_tok),0) outTok
    FROM llm_spend WHERE ts >= ?${scoped}`)
    .get(...(evidenceScope == null ? [sinceMs ?? 0] : [sinceMs ?? 0, evidenceScope]));
  return { ...row, usd: Number(row.usd.toFixed(4)) };
}

export const SHARED_RULES = `
You are a specialist on an automated research desk called Claude Company ("Claude Co")
trading memecoins on Robinhood Chain (chain id 4663, an Arbitrum Nitro L2: ~100ms blocks,
first-come-first-served ordering, no priority-fee auction, gas that must be read live per
ticket because it moved 0.02 to 0.7 gwei in two weeks and spikes above 5, and a sequencer
that can silently drop a transaction with no receipt).
You hold exactly one seat. Do that seat's job and no other seat's job.

${CHARTER}

Operating rules for your reply:
- You are given an EVIDENCE bundle fetched deterministically by code. Treat it as the
  only source of numeric fact. Do not state any number that is not derivable from it.
- If a datum you need is missing or null, say so, lower your confidence, and proceed.
  Never substitute a plausible-looking figure for a missing one.
- Each finding needs a source: an evidence key path (e.g. "pair.liquidityUsd"),
  a URL you actually read, or the literal string "inference" when it is your judgment.
- Be concrete and terse. A number with a source beats a paragraph of adjectives.
- You are producing research for a human who will decide. You never execute anything.

THIS DESK TRADES ROBINHOOD CHAIN LAUNCHPADS (PONS V1/V2, hood.fun, pools.trade), AND IT
TRADES A CLOCK.
Every coin sits in one of six market-cap bands, and the bundle states which in
\`band\`, with \`hold.holdMaxMs\` alongside it. That window is not advice: the position
is SOLD when it expires, whether or not the target printed. So a thesis has to be able
to happen inside it.

  nano  $5k-$20k    sold in 30 minutes      micro  $20k-$60k   sold within the hour
  low   $60k-$100k  sold within five hours  medium $100k-$500k sold within five hours
  high  $500k-$1m   sold within five hours  very high $1m-$10m sold within a day

Two consequences you are expected to reason with rather than around:
- "It needs a few days to play out" is a REFUSAL on a nano coin, not a caveat. Judge
  whether the move can happen in the window the coin actually has.
- On nano and micro the coin is minutes old by design. Youth is the ordinary condition
  here, not a reason to abstain. Say "the data is absent" when it is; do not say "too
  new to tell" about the population this desk exists to trade.
Costs here are a FIXED toll plus a pool cost, not a percentage of size. Every position
carries a round trip of roughly 661,000 gas at the live gwei (ROUND_TRIP_GAS in executor/live-thresholds.mjs: median of 9 Kyber round trips, 618k–823k) — a toll that no amount of
pool depth reduces, and that the bundle measures as \`exitProbe.gasUsdRoundTrip\` (read it;
never assume it) — PLUS the pool's fee each way (1% on a PONS curve) and the executor's
slippage. A fixed toll is a larger share of a small clip than of a large one: on a $3-$10
clip it can be 4-12% before slippage. A thesis that cannot clear that toll is not a thesis.
There is no block-0 edge to chase: a PONS launch taxes the first five seconds at 99%
falling to 0%, so the desk's edge is SELECTION among coins that have already graduated,
not speed.
`.trim();

export class Refusal extends Error {}

/**
 * The system prompt as CACHED BLOCKS — two tiers, two of the four breakpoints.
 *
 *   tier 1  SHARED_RULES          shared by every seat on a model; a process constant
 *   tier 2  charter + orders      this seat's charter plus the coach's standing orders
 *
 * The seat block used to be sent UNCACHED on the argument that the standing orders
 * change and "a stale cached copy would mean a seat working under orders that were
 * reverted an hour ago". That argument was wrong about the mechanism: the cache is a
 * byte-prefix lookup, so a changed order changes the bytes, misses, and is re-written —
 * it can never serve the old text. What the marker buys is the common case: orders
 * change at most once per TUTOR_REVIEW_MINS (180), and between changes every seat was
 * paying its 1-2.2k-token charter at 1x on every call (charter sizes measured by bytes:
 * forensics 6,541 B, flow 6,252 B, narrative 8,694 B, red team 5,752 B). A change now
 * costs one miss on the seat block while SHARED_RULES still hits.
 *
 * Two caveats, both from the caching reference, neither faked here:
 *   - Haiku 4.5 caches nothing under 4,096 tokens, and SHARED_RULES is ~2k by bytes/4,
 *     so the scout's marker is a NO-OP. It is left in place because it is harmless and
 *     the scout may be retiered; do not expect cachedTok on that seat.
 *   - A change of `output_config.effort` invalidates the messages tier on every model
 *     and the system tier on models that render effort ahead of it (model-specific).
 *     The analysts run at mixed medium/high (config.js); whether Sonnet 5 keeps the
 *     system tier across that is UNVERIFIED — check cachedTok per seat in
 *     GET /api/spend/seats before trusting the saving on those seats.
 */
export function systemBlocks(seat, system, { ttl = CACHE_TTL, policy = withPolicy } = {}) {
  return [
    { type: "text", text: SHARED_RULES, cache_control: cacheMark(ttl) },
    ...(system
      ? [{ type: "text", text: policy(seat, system), cache_control: cacheMark("5m") }]
      : []),
  ];
}

/** A user-message block the caller composed. Only text blocks, only an ephemeral
 * marker: the caller is trusted with ORDER (stable first, volatile last) and nothing
 * else, and a wrong shape is a programming error caught here, not a 400 three retries
 * later. */
function checkContentBlock(b, i) {
  if (!b || typeof b !== "object" || b.type !== "text" || typeof b.text !== "string") {
    throw new Error(`ask(): content[${i}] must be { type: "text", text: string }`);
  }
  if (b.cache_control != null) {
    const cc = b.cache_control;
    if (typeof cc !== "object" || cc.type !== "ephemeral" ||
        (cc.ttl != null && cc.ttl !== "5m" && cc.ttl !== "1h")) {
      throw new Error(`ask(): content[${i}].cache_control must be { type: "ephemeral", ttl?: "5m"|"1h" }`);
    }
  }
  return b;
}

/**
 * The exact request ask() sends, as a pure function so a test can hold it up to the
 * light without an API key. `content`, when given, is sent as the user message
 * VERBATIM (blocks may carry their own cache_control) and `prompt` is ignored — the
 * analysts use it to put the evidence bundle first under a marker and their seat text
 * after it, so five seats share one cached bundle.
 */
export function buildRequest({ seat, model, effort = "high", schema, prompt, content, system, maxTokens }) {
  // Thinking counts against max_tokens, so the deeper the effort the more headroom the
  // visible answer needs. 8000 flat starved the xhigh seats of any room to reply.
  maxTokens ??= effort === "max" ? 32000 : effort === "xhigh" ? 24000 : 16000;
  // The retier taught this the hard way, in production: `fallbacks` is an
  // Opus 5 / Fable 5 parameter — Sonnet rejects it with a 400 — and
  // `output_config.effort` errors on Haiku 4.5. Every capability gate here
  // exists because a live cycle hit the 400 for its absence.
  const opusTier = /opus-5|fable-5/.test(model);
  const haiku = /haiku/.test(model);
  let userContent;
  /* STANDING ORDERS MUST NOT FORK THE SHARED PREFIX. The five analysts send one system
     (their common contract) so the bundle block behind it is one cache entry for all five.
     withPolicy() appends a seat's standing orders — and if that lands on the system tier,
     a seat with orders gets a different prefix and its bundle can never be the hit the other
     four wrote. So when the caller composed `content`, the orders go onto the block that
     names the seat ("=== YOUR SEAT ===", the analysts' second block) and the system stays
     byte-identical across seats. A caller with `content` but no seat block gets the old
     behaviour: orders on the system tier. Handoff from the agents lane, 2026-09-05. */
  let systemPolicy = withPolicy;
  if (content != null) {
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error("ask(): content must be a non-empty array of text blocks");
    }
    userContent = content.map(checkContentBlock);
    const seatIdx = userContent.findIndex((b) => b.text.startsWith("=== YOUR SEAT ==="));
    if (seatIdx >= 0) {
      systemPolicy = (_seat, text) => text;
      userContent = userContent.map((b, i) => i === seatIdx ? { ...b, text: withPolicy(seat, b.text) } : b);
    }
  } else {
    if (typeof prompt !== "string") throw new Error("ask(): prompt must be a string when content is not given");
    userContent = prompt;
  }
  const req = {
    model,
    max_tokens: maxTokens,
    system: systemBlocks(seat, system, { policy: systemPolicy }),
    messages: [{ role: "user", content: userContent }],
    output_config: haiku
      ? { format: betaZodOutputFormat(schema) }
      : { format: betaZodOutputFormat(schema), effort },
  };
  if (opusTier) {
    // Server-side fallback: if a safety classifier declines, the request is
    // routed to a comparable model instead of failing the whole cycle.
    req.betas = ["server-side-fallback-2026-07-01"];
    req.fallbacks = "default";
  }
  return req;
}

/**
 * One structured call to a seat. Returns the parsed object, validated against `schema`.
 * Throws after retries rather than returning a half-parsed shape — a seat that cannot
 * answer in contract is a seat that gets dropped, not one that gets guessed at.
 */
export async function ask({
  seat,
  model,
  effort = "high",
  schema,
  prompt,
  content,
  system,
  maxTokens,
  attempts = 3,
}) {
  // Built once: the request is a pure function of its inputs, and a shape error in
  // `content` should throw here rather than be retried as if the provider had failed.
  const req = buildRequest({ seat, model, effort, schema, prompt, content, system, maxTokens });
  maxTokens = req.max_tokens;
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      emit("seat:thinking", { seat, model, effort, attempt: a });
      // Streaming, not parse(): the SDK refuses a non-streaming call at these token
      // budgets because it could exceed the HTTP timeout. finalMessage() gives the same
      // assembled response, and the schema check below is the authority on shape anyway.
      const res = await withProviderBudget({ provider: "anthropic", maxTokens, payload: req }, async () => {
        const stream = client.beta.messages.stream(req);
        const message = await stream.finalMessage();
        meterAnthropicUsage(model, message, seat, effort);
        return message;
      });

      if (res.stop_reason === "max_tokens") {
        throw new Error(`${seat}: ran out of tokens before answering (effort ${effort}, cap ${maxTokens})`);
      }
      if (res.stop_reason === "refusal") {
        throw new Refusal(`${seat}: refused (${res.stop_details?.category ?? "unknown"})`);
      }
      // The SDK's auto-parse leaves parsed_output null on this version even when the
      // model returned perfectly valid JSON, so fall back to validating the text block
      // against the same schema. Zod is the authority either way — a seat that cannot
      // answer in contract is dropped, never guessed at.
      let parsed = res.parsed_output ?? res.parsed ?? null;
      if (!parsed) {
        const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        if (!text) throw new Error(`${seat}: empty response`);
        const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
        let raw;
        try { raw = JSON.parse(json); }
        catch { throw new Error(`${seat}: response was not JSON`); }
        const check = schema.safeParse(raw);
        if (!check.success) {
          throw new Error(`${seat}: response did not match contract — ${check.error.issues.slice(0, 2).map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
        }
        parsed = check.data;
      }

      emit("seat:done", { seat, usd: spend.usd });
      return parsed;
    } catch (err) {
      lastErr = err;
      if (err instanceof Refusal) throw err;
      if (/credit balance is too low/i.test(String(err?.message))) {
        emit("desk:out_of_credit", { seat });
        throw new OutOfCredit("the Anthropic balance is empty — the desk cannot think");
      }
      const retryable =
        err?.status === 429 || err?.status >= 500 || err?.name === "APIConnectionError";
      emit("seat:retry", { seat, attempt: a, error: String(err?.message || err) });
      if (a === attempts || (!retryable && !/parse/.test(String(err?.message)))) break;
      await new Promise((r) => setTimeout(r, 800 * a * a));
    }
  }
  emit("seat:failed", { seat, error: String(lastErr?.message || lastErr) });
  throw lastErr;
}

/**
 * Two-step for the narrative seat: server-side web search cannot be combined with a
 * structured output format, so we search in one call and shape the result in a second.
 */
/**
 * THE SHAPING CALL DOES NOT NEED THE TAPE.
 *
 * Call 2 used to append the whole ORIGINAL BRIEF — the evidence bundle included — so
 * the narrative seat was the one analyst whose input was bought twice (measured at
 * ~41k tokens a run before max_uses was cut to 2). The shaping instruction already
 * says "Use ONLY what the notes support"; what it needs to keep the notes honest is
 * the token's identity and the X read, not pools, holders and candles. So the brief
 * is cut at the bundle marker and only the xRead subtree of the bundle survives.
 *
 * `brief` lets a caller hand over the compact object directly; without it the brief is
 * derived from the prompt, and a prompt with no bundle marker is sent unchanged — this
 * must never make the seat blinder than before, only cheaper.
 */
export function compactBrief(prompt, brief) {
  if (brief && typeof brief === "object") return JSON.stringify(brief);
  const MARK = "=== EVIDENCE BUNDLE ===";
  const at = typeof prompt === "string" ? prompt.indexOf(MARK) : -1;
  if (at < 0) return prompt;
  const head = prompt.slice(0, at).trimEnd();
  let xRead = null;
  try { xRead = JSON.parse(prompt.slice(at + MARK.length).trim())?.xRead ?? null; } catch { /* no bundle to mine */ }
  return head + (xRead ? `\n\n=== X READ (from the bundle) ===\n${JSON.stringify(xRead)}` : "");
}

export async function askWithWeb({ seat, model, effort, schema, prompt, brief, system, maxTokens = 16000 }) {
  emit("seat:searching", { seat, model });

  // Server-tool errors do NOT throw: they arrive as a result block whose content is an
  // error object instead of a list. Unchecked, a rate-limited search reads to the agent
  // as "no coverage exists" — which is exactly the absence-of-evidence mistake the
  // charter forbids. Retry, then say plainly that the tool failed.
  let research = null, searchError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const req = {
      model,
      max_tokens: maxTokens,
      /* Cached blocks, not one concatenated string: the string form carried no marker
       * at all, so the ~4.2k-token SHARED_RULES + narrative charter was bought at 1x on
       * every workup. The seat text is sent as it always was here — bare charter, no
       * standing orders; those reach the seat in call 2 through ask() — so the only
       * change to this call is the marker. The tools tier precedes system in the cache
       * prefix, so this call's entries are its own (call 2 has no tools): still a hit
       * workup to workup. */
      system: systemBlocks(seat, system, { policy: (_seat, text) => text }),
      // max_uses 4 fed ~41k tokens of raw results back through the loop per run;
      // two searches answer "is there a story and is it true" or nothing will.
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }],
      output_config: { effort },
      messages: [{ role: "user", content: prompt }],
    };
    research = await withProviderBudget({ provider: "anthropic", maxTokens,
      maxSearches: 2, payload: req }, async () => {
      const message = await client.messages.create(req);
      meterAnthropicUsage(model, message, seat, effort);
      return message;
    });

    const errs = research.content
      .filter((b) => b.type === "web_search_tool_result" && !Array.isArray(b.content))
      .map((b) => b.content?.error_code || "unknown");
    if (!errs.length) { searchError = null; break; }
    searchError = errs[0];
    emit("seat:retry", { seat, attempt, error: `web_search: ${searchError}` });
    if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt));
  }

  const notes = research.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const cited = [];
  for (const block of research.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) cited.push(`${r.title ?? ""} — ${r.url}`);
    }
  }

  return ask({
    seat,
    model,
    effort: "low", // shaping already-gathered notes is mechanical
    schema,
    system,
    maxTokens,
    prompt:
      `Convert your own research notes into the required contract. Use ONLY what the notes support.\n\n` +
      (searchError
        ? `=== TOOL FAILURE ===\nThe web search tool failed with "${searchError}" on every attempt. You have read NOTHING external. ` +
          `Report this as missing data and carry it at zero weight in both directions — you have established neither the presence nor the absence of coverage.\n\n`
        : "") +
      `=== YOUR RESEARCH NOTES ===\n${notes}\n\n` +
      `=== SOURCES YOU ACTUALLY READ ===\n${cited.join("\n") || "(none returned)"}\n\n` +
      `=== ORIGINAL BRIEF (identity and X read only; the evidence bundle is not re-sent) ===\n` +
      compactBrief(prompt, brief),
  });
}
