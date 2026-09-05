/**
 * GROK — the xAI client, for the two jobs Grok is genuinely best at here:
 *
 *   1. THE X READ. Grok's x_search tool reads X natively — the one evidence
 *      source this desk could never reach: real cashtag velocity, whether
 *      distinct pre-existing voices or one pasted script carry a story, which
 *      event fired a naming race. One read per shortlisted candidate.
 *   2. THE TENANT'S MD BRAIN. A floor may hire Grok as its Managing Director:
 *      the PM seat of THAT floor's runs thinks on grok-4.6 instead of Claude.
 *      Every guard rail around the seat — screen, Pinocchio gate, red team,
 *      compliance, the no-keys wall — is ours and does not move.
 *
 * Everything here fails OPEN and quiet: no XAI_API_KEY, a changed response
 * shape, a refusal to emit JSON — all read as "no signal", never as a block.
 * Spend is metered into the same llm_spend ledger as every other seat, so the
 * daily brake sees Grok dollars too.
 */
import db from "./store.js";
import { noteUnpersistedProviderSpend, spend, withProviderBudget } from "./llm.js";
import { emit, runContext } from "./bus.js";

const BASE = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
export const GROK_MODEL = process.env.DESK_MODEL_GROK || "grok-4.6";
export const hasGrok = () => !!process.env.XAI_API_KEY;

// $/M tokens (grok-4.6 list) + a flat estimate per x_search tool invocation.
const PRICE = { in: 2, out: 6, perSearch: 0.005 };

export function grokUsageCost(data, searches = 0) {
  const usage = data?.usage || {};
  const i = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const o = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const ticks = Number(usage?.cost_in_usd_ticks);
  // Current xAI responses report the exact all-in billed amount, including every
  // server-side tool turn. Keep the token estimate only for older response shapes.
  const usd = Number.isFinite(ticks) && ticks >= 0
    ? ticks / 10_000_000_000
    : (i / 1e6) * PRICE.in + (o / 1e6) * PRICE.out + searches * PRICE.perSearch;
  return { model: data?.model || GROK_MODEL, i, o, cached, usd,
    exact: Number.isFinite(ticks) && ticks >= 0 };
}

function meterGrok(seat, data, searches = 0) {
  const { model, i, o, cached, usd } = grokUsageCost(data, searches);
  spend.usd += usd; spend.calls += 1; spend.inTok += i; spend.outTok += o;
  spend.cachedTok += cached;
  const context = runContext.getStore();
  const floor = context?.floor ?? null;
  const evidenceScope = context?.evidenceScope ??
    (floor == null || Number(floor) === 50 ? "house" : "tenant");
  try {
    db.prepare(`INSERT INTO llm_spend
      (floor,floor_attributed,evidence_scope,seat,model,effort,in_tok,out_tok,cached_tok,usd,ts)
      VALUES (?,1,?,?,?,?,?,?,?,?,?)`)
      .run(floor, evidenceScope, seat, model, null, i, o, cached, usd, Date.now());
  } catch { noteUnpersistedProviderSpend(usd); }
}

/** Pull the first JSON object out of model text, tolerant of fences and prose. */
export function parseLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  // walk to the matching close brace rather than trusting lastIndexOf
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) {
      try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** The text of a /v1/responses reply, wherever this month's shape put it. */
function responseText(r) {
  if (typeof r?.output_text === "string" && r.output_text) return r.output_text;
  const parts = [];
  for (const item of r?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  if (parts.length) return parts.join("\n");
  return r?.choices?.[0]?.message?.content ?? null;
}

async function xai(path, body, timeoutMs = 90000,
  { seat, maxTokens = 8000, maxSearches = 0, minSearches = 0 } = {}) {
  return withProviderBudget({ provider: "xai", maxTokens, maxSearches, payload: body }, async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.XAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false,
        error: `xai ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}` };
      const searches = Math.max(minSearches,
        (data?.output ?? []).filter((item) => /search/i.test(item?.type ?? "")).length);
      meterGrok(seat, data, searches);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally { clearTimeout(t); }
  });
}

/**
 * A structured Grok call: same contract as ask() — you get the parsed object —
 * but via prompt-described JSON, parsed defensively. `validate` (a zod schema)
 * gets the final say; a shape Grok cannot hold is an error the CALLER handles,
 * usually by falling back to the Claude seat.
 */
export async function grokAsk({ seat, system, prompt, shape, validate, maxTokens = 8000 }) {
  if (!hasGrok()) return { ok: false, error: "XAI_API_KEY not set" };
  const r = await xai("/chat/completions", {
    model: GROK_MODEL,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system + `\n\nAnswer with ONLY a JSON object of exactly this shape:\n${shape}` },
      { role: "user", content: prompt },
    ],
  }, 90000, { seat, maxTokens });
  if (!r.ok) return r;
  const obj = parseLoose(r.data?.choices?.[0]?.message?.content);
  if (!obj) return { ok: false, error: "grok returned no parseable JSON" };
  if (validate) {
    const v = validate.safeParse(obj);
    if (!v.success) return { ok: false, error: "grok JSON failed validation: " + v.error.issues?.[0]?.message };
    return { ok: true, out: v.data };
  }
  return { ok: true, out: obj };
}

/**
 * THE X-READ BRIEF, hoisted: everything that is the SAME for every token.
 *
 * xAI's prompt caching is prefix-based, like Anthropic's. The read used to open with
 * the volatile part — `Search X for the token "${symbol}" (contract ${mint})...` — and
 * put these ~3.5 KB of instructions AFTER it, so no two reads ever shared a cacheable
 * prefix beyond the framing. The X read was 40-44% of the desk's whole bill (desk.js;
 * the turn note below), and its question never changes, so the question is now sent
 * first as its own input item and the token goes last. Whether xAI actually populates
 * `cached_tokens` on /responses with x_search is UNVERIFIED from here; the ledger
 * already records it (grokUsageCost), so the answer is in llm_spend.cached_tok.
 */
export const XREAD_INSTRUCTIONS =
  `You are the X reader for a research desk trading memecoins on Robinhood Chain (chain ` +
  `id 4663, an Arbitrum L2). The token you must read is named in the LAST message; ` +
  `everything here is how to read it. Assess the ATTENTION, not the price.\n\n` +
  `THE CREATOR IS THE MAIN SUBJECT. Coins on PONS, hood.fun and pools.trade are ` +
  `promoted by the account that launched them, and the launchpad usually links it — ` +
  `if the last message names an account, START THERE and read it directly rather than ` +
  `spending searches discovering who launched this; if it turns out not to be the ` +
  `creator's account, say so. Their account IS the primary evidence — more ` +
  `informative than the volume of chatter around the ticker. Find the account ` +
  `that launched or promotes this coin and read it like a record:\n` +
  `- How old is it and how many followers? A week-old account with 50k followers ` +
  `bought them.\n` +
  `- Does it post as a person with a history, or does it exist only to push tokens?\n` +
  `- HAVE THEY LAUNCHED BEFORE, and what happened? Prior tickers from the same ` +
  `account or person, on this chain or any other, and whether those ran, died ` +
  `quietly, or rugged. A creator who has rugged before is the most decisive fact ` +
  `available and it is usually sitting in public on their own timeline.\n` +
  `- Did they post the contract address themselves, and are they replying to ` +
  `holders now, or did they post once and go quiet?\n` +
  `- Are they PAYING for attention? One wording repeated across accounts with no ` +
  `shared community, sudden reply swarms, engagement pods. A coin that has to buy ` +
  `its attention does not have any.\n` +
  `- WHO IS THE AUDIENCE? Say whether the people talking are Robinhood app users, ` +
  `EU stock-token holders, the Arbitrum/EVM crowd, or Solana accounts cross-posting; ` +
  `and whether @RobinhoodChain, the launchpad, or a Robinhood-verified account ` +
  `amplified it. An equity cashtag ($NVDA, $GOOGL) belongs to the STOCK, not to a ` +
  `coin that borrows its name — count only posts that name this coin or its contract.\n` +
  `- IS THIS A SERIAL RUGGER? This is the single most valuable thing you can find, ` +
  `and X is the only place it is visible. A rugger rotates WALLETS between launches ` +
  `— on-chain forensics loses them every time — but they keep the ACCOUNT, because ` +
  `the audience is the asset they cannot rebuild. So the pattern lives on their ` +
  `timeline: repeated launches, each hyped the same way, each followed by silence, ` +
  `angry replies, or the post being deleted. Search their handle alongside "rug", ` +
  `"scam" and "dev sold", and read what other people say happened. Two or more ` +
  `prior coins that died on this account is a pattern, not bad luck.\n` +
  `- A WIPED TIMELINE IS ITSELF EVIDENCE. An account that pushes tokens but whose ` +
  `history starts abruptly, or which has been renamed, has usually deleted a past ` +
  `worth deleting. Note it; do not assume what was in it.\n\n` +
  `THEN READ THE MOMENT. A memecoin is a bet that a piece of culture is about to ` +
  `matter more than it does right now, so the second question after "who is ` +
  `promoting this" is "is the thing it references real, is it big, and is it ` +
  `EARLY". Judge:\n` +
  `- IS THE STORY TRUE? A coin about an event that did not happen, a quote never ` +
  `said, or a person who is not involved has a thesis with nothing under it. ` +
  `Check the claim, do not repeat it.\n` +
  `- HOW BIG IS THE THING ITSELF? A niche in-joke and a story on every front page ` +
  `are different sizes of opportunity. Say which this is.\n` +
  `- WHERE IN THE ARC? The same true story is a different trade depending on ` +
  `whether it broke an hour ago or has been traded for a week. Being late to a real ` +
  `story still loses money.\n` +
  `- SEASON AND CALENDAR. Halloween, Christmas, an election, a sports final, a ` +
  `product launch, a court date. These have windows that OPEN and CLOSE on known ` +
  `dates — say whether this one is opening, peaking, or already closing, and name ` +
  `the date if there is one.\n` +
  `- WEATHER AND LIVE EVENTS. Hurricanes, eclipses, disasters and freak weather ` +
  `reliably spawn coins. If this rides one, is the event still unfolding or over? ` +
  `An event that has finished has no more surprise left in it.\n` +
  `- WHAT IS EMERGING RIGHT NOW. Independently of this coin: which memes, formats ` +
  `or themes are RISING on X today, and does this one belong to any of them? A coin ` +
  `at the front of a wave and a coin at the back look identical on a chart.\n\n` +
  `If the last message carries the launcher's own description, judge whether the ` +
  `story it claims is real, and whether anyone outside the coin is repeating it.\n\n` +
  `Then answer with ONLY a JSON object:\n` +
  `{"mentions_level":"none|low|building|hot",` +
  `"story_is_true":<true|false|null — is the referenced event/claim real and checkable>,` +
  `"truth_note":"what you actually verified, or why you could not",` +
  `"significance":"niche|notable|major|global",` +
  `"trend_name":"the meta or wave this belongs to, or null",` +
  `"trend_stage":"emerging|building|peaking|fading|none",` +
  `"seasonal_hook":"the season, holiday, event or date it rides, or null",` +
  `"season_window":"opening|peak|closing|none",` +
  `"live_event":"an unfolding event it rides (weather, disaster, sport), or null",` +
  `"event_still_unfolding":<true|false|null>,` +
  `"emerging_trends":["themes rising on X right now, whether or not this coin is in them"] (max 4),` +
  `"early_or_late":"early|on_time|late",` +
  `"velocity":"rising|flat|fading",` +
  `"distinct_voices":<true if several PRE-EXISTING accounts discuss it in their own words, false if one script is pasted everywhere>,` +
  `"audience":"robinhood_app|eu_stock_tokens|arbitrum_evm|solana_crosspost|mixed|unknown",` +
  `"amplified_by_official":<true|false|null — did @RobinhoodChain, the launchpad, or a Robinhood-verified account amplify it>,` +
  `"dev_handle":"the creator/promoter X handle, or null if not found",` +
  `"dev_account_age":"e.g. '3 years', '6 days', or null",` +
  `"dev_followers":<number or null>,` +
  `"dev_looks_real":<true if a person with a history, false if a token-pushing shell, null if unknown>,` +
  `"dev_posted_ca":<true|false|null — did the creator post the contract address themselves>,` +
  `"dev_engaging_now":<true|false|null — actively replying to holders>,` +
  `"dev_prior_tokens":[{"ticker":"...","outcome":"ran|died|rugged|unknown"}] (max 4, only what you can source),` +
  `"dev_red_flags":["short, specific, sourced"],` +
  `"serial_rugger":<true|false|null — has THIS ACCOUNT launched coins that rugged, MORE THAN ONCE>,` +
  `"rug_evidence":"how you know: the tickers, the dates, the posts or the accusations you actually found — or null",` +
  `"deleted_history":<true|false|null — signs of wiped posts, a renamed handle, or a timeline that starts abruptly>,` +
  `"paid_promotion_signs":<true|false>,` +
  `"kol_posts":[{"handle":"...","gist":"..."}] (max 3, only genuinely notable accounts),` +
  `"lore_origin":"the traceable origin post/moment/person, or null",` +
  `"paid_or_botted_signs":<true|false>,` +
  `"verdict":"organic|mixed|manufactured|no_signal",` +
  `"summary":"two sentences a portfolio manager can use"}\n\n` +
  `Say null rather than guessing. An invented follower count or an imagined prior ` +
  `rug is worse than admitting you could not find the account.`;

/** The volatile tail: everything about THIS token, and nothing else. */
export function xReadTokenBlock({ symbol, mint, hook = "", handle = null, lore = null, venue = null }) {
  return `TOKEN: "${symbol}" at ${mint} on Robinhood Chain (chain 4663)` +
    `${venue ? `, launched on ${venue}` : ""}.\n` +
    `CONTEXT: ${hook || "(none)"}.\n` +
    `ACCOUNT: ${handle ? `${handle} — the launchpad lists this as the coin's own account` : "not listed by the launchpad"}.\n` +
    (lore ? `LORE, the launcher's own description verbatim: "${lore}"` : `LORE: (none given)`);
}

/** The whole /responses body for one X read — pure, so a test can diff two of them. */
export function xReadBody(token) {
  return {
    model: GROK_MODEL,
    max_output_tokens: 8000,
    /* TURNS ARE THE BILL. Measured on the live desk over 24 hours: 298 billed turns
     * across ~111 workups — 2.7 per read — and this seat alone was $55.85 of a $138.89
     * day, 40% of everything the desk spent. Each turn re-sends the accumulated
     * context, which is why the seat's token shape is "reading" rather than "thinking".
     * Its questions are bounded and about ONE account — how old, how many followers,
     * what did they launch before, are they paying for reach — and those are answered
     * in the first search or they are not in public at all. Two turns and twelve
     * searches keep the question and drop the wandering. */
    max_turns: Number(process.env.DESK_GROK_MAX_TURNS || 2),
    /* NO from_date. It was pinned to the last seven days, which made the question this
     * prompt itself calls the single most decisive fact available — has this creator
     * launched before, and what happened — unanswerable by construction: a rug from
     * last month sits outside the window. Recency belongs in the prose, where it
     * applies to the ATTENTION half only; a creator's record is history, and history is
     * old by definition. The trend scan below keeps its window, because a story that
     * broke last month is not a story that is breaking. */
    tools: [{ type: "x_search" }],
    // Stable instruction FIRST, the token LAST: the whole point of the split.
    input: [
      { role: "user", content: XREAD_INSTRUCTIONS },
      { role: "user", content: xReadTokenBlock(token) },
    ],
  };
}

/**
 * THE X READ — one live look at X for one token, through Grok's native search.
 * Returns deterministic-shaped evidence for the bundle; the seats do the
 * judging. Fails open: no key, no signal, no drama.
 */
export async function grokXRead({ symbol, mint, hook = "", handle = null, lore = null, venue = null }) {
  if (!hasGrok()) return { ok: false, error: "no key" };
  const body = xReadBody({ symbol, mint, hook, handle, lore, venue });
  const r = await xai("/responses", body, 120000, { seat: "XRead", maxTokens: 8000,
    maxSearches: Number(process.env.DESK_GROK_MAX_SEARCHES || 12), minSearches: 1 });
  if (!r.ok) return r;
  const obj = parseLoose(responseText(r.data));
  if (!obj) return { ok: false, error: "x-read returned no parseable JSON" };
  const citations = (r.data?.citations ?? []).slice(0, 8);
  emit("seat:verdict", { seat: "XRead", symbol, detail: `${obj.verdict ?? "?"} · ${obj.mentions_level ?? "?"} attention, ${obj.velocity ?? "?"}` });
  return { ok: true, read: obj, citations };
}

/**
 * THE TREND SCAN — the desk's discovery running BACKWARDS.
 *
 * Every other lane starts on-chain: sweep the pairs that already exist, then ask Grok
 * whether the story behind one is real. That is structurally late. By the time a coin
 * carries enough volume and liquidity to surface on a pair feed, whatever made it
 * interesting happened hours ago and the desk is reading an echo.
 *
 * The documented Grok memecoin trade worked the other way round, and the mechanism is
 * worth stating plainly because the whole lane is built on it: a high-reach X event
 * fires with a NAMEABLE gap, dozens of coins launch racing to claim the name, one wins
 * the race and runs, and the rest go to zero. The tradeable fact is the RACE, and the
 * race is visible on X before it is visible on chain.
 *
 * So this asks Grok the opposite question: not "is this coin's story real" but "what
 * story is happening right now that coins will be launched for". The answer is a list
 * of themes and the terms to hunt them by — trends.js does the hunting.
 *
 * The hard part is EARLINESS, not detection. Anything already saturated is worthless
 * here: by then the winner has run and the desk would be buying the top. So the prompt
 * spends most of its weight on stage rather than on volume.
 */
export async function grokTrendScan({ limit = 6 } = {}) {
  if (!hasGrok()) return { ok: false, error: "no key" };
  const from = new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10);
  const r = await xai("/responses", {
    model: GROK_MODEL,
    max_output_tokens: 6000,
    // The same reasoning as the X read above: a trend either shows in the first passes
    // or it is not a trend yet. This lane runs every twelve minutes on its own clock.
    max_turns: Number(process.env.DESK_GROK_MAX_TURNS || 2),
    tools: [{ type: "x_search", from_date: from }],
    input: [{
      role: "user",
      content:
        `You are the scout for a memecoin desk on Robinhood Chain (chain id 4663, an ` +
        `Arbitrum L2 whose launchpads are PONS, hood.fun and pools.trade; the crowd is ` +
        `Robinhood app users, EU stock-token holders and the Arbitrum/EVM audience, and an ` +
        `equity cashtag such as $NVDA belongs to the stock, not to a coin). Do NOT analyse ` +
        `any specific coin. ` +
        `Answer one question: WHAT IS HAPPENING ON X RIGHT NOW THAT PEOPLE WILL LAUNCH ` +
        `MEMECOINS FOR — in the next hours, not the last week?\n\n` +
        `Memecoins are launched for nameable things: a viral clip or phrase, a fresh ` +
        `meme format, a public figure doing something absurd, a breaking news moment ` +
        `with a funny angle, an in-joke escaping its community, a season or holiday ` +
        `arriving, a movement gathering a name. Search X broadly and read what is ` +
        `ACCELERATING.\n\n` +
        `EARLINESS IS THE ENTIRE VALUE. A trend everyone has already posted about is ` +
        `worthless to us — the coins for it launched hours ago and already ran. Prefer ` +
        `something climbing fast from a small base over something enormous and flat. Be ` +
        `honest in "stage": most of what you find will already be peaking, and saying ` +
        `so is more useful than dressing it up.\n\n` +
        `For each, give the exact words a launcher would put in a ticker or name — that ` +
        `is what we search the chain for. Short, literal, no hashtags.\n\n` +
        `Answer with ONLY JSON:\n` +
        `{"themes":[{` +
        `"theme":"short name for what is happening",` +
        `"what_happened":"one sentence, concrete and checkable",` +
        `"stage":"just_broke|building|peaking|over",` +
        `"reach":"niche|notable|mainstream",` +
        `"first_seen":"roughly when it started, or null",` +
        `"why_coinable":"why this specifically gets a token, not just posts",` +
        `"search_terms":["2-5 literal words or tickers a launcher would use"],` +
        `"source_handles":["accounts driving it, max 3"]` +
        `}] (max ${limit}, strongest first)}\n\n` +
        `An empty list is a valid and useful answer. Do not invent a trend to fill it — ` +
        `a fabricated theme sends the desk hunting coins that do not exist.`,
    }],
  }, 120000, { seat: "TrendScan", maxTokens: 6000,
    maxSearches: Number(process.env.DESK_GROK_MAX_SEARCHES || 12), minSearches: 1 });
  if (!r.ok) return r;
  const obj = parseLoose(responseText(r.data));
  const themes = Array.isArray(obj?.themes) ? obj.themes : [];
  emit("trend:scan", { found: themes.length,
    themes: themes.map((t) => `${t.theme} (${t.stage})`).slice(0, 6) });
  return { ok: true, themes, citations: (r.data?.citations ?? []).slice(0, 8) };
}
