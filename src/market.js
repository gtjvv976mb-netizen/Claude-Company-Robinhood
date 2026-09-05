import { shapePair, CHAIN, searchPairs } from "./data/dexscreener.js";
import { venueOf, launchpadOf } from "./data/pons-live.js";
import { emit } from "./lib/bus.js";

/**
 * The house market sweep.
 *
 * DexScreener's search returns ~30 pairs per query, so one query is not a market scan —
 * it is a keyhole. Sweeping several angles and deduplicating by token takes coverage
 * from a handful of promoted tokens to a hundred-odd real ones. Everything here is
 * free: no model call happens until a coin has survived the deterministic floors.
 *
 * RETUNED FOR CHAIN 4663 (2026-09-05, measured, not guessed): q=PONS → 30/30 robinhood
 * pairs; q=pons median age 27.1h, youngest 1.7h; q=USDG 26/30; q=robinhood 21/30;
 * q=WETH 0/30 (the symbol is too generic to search). The Solana angles — pumpswap,
 * bonk, raydium, SOL — returned nothing on this chain by construction. The sweep is
 * the SLOW lens now: a PONS launch reaches DexScreener hours after GeckoTerminal and
 * the chain log do (pons-live.js), so this is where the graduated book is found, not
 * where a minute-old coin is.
 */
const ANGLES = [
  // launchpads and venues on this chain
  "pons", "PONS", "USDG", "robinhood", "hoodit", "bankr", "pools.trade", "uniswap", "ramses", "giga", "orvex",
  // themes
  "AI", "agent", "cat", "dog", "meme",
];

/**
 * Which launchpad minted this coin.
 *
 * On Solana a launchpad branded its mints with a vanity suffix; a 0x address carries no
 * such mark, so the ONLY signal is the dex the pool sits on. DexScreener's dexId names
 * the venue ("pons", "uniswap", "giga", "up", "0swap" — measured on CASHCAT's 30 pairs)
 * and GeckoTerminal's dex id names the pad ("pons-v2", "pons-dot-family", "hoodit",
 * "uniswap-pools-trade", "bankr-robinhood"). Both dialects are keyed here.
 */
const PADS = [
  { id: "pons",         dexes: ["pons", "pons-v2", "pons-v2-dex", "pons-dot-family", "ponsfamily"] },
  { id: "hood.fun",     dexes: ["hoodit", "hood-fun", "hoodfun"] },
  { id: "pools.trade",  dexes: ["uniswap-pools-trade", "pools-trade", "poolstrade"] },
  { id: "bankr",        dexes: ["bankr", "bankr-robinhood"] },
];

export function launchpad(_address, dexId) {
  for (const p of PADS) if (dexId && p.dexes.includes(dexId)) return p.id;
  return launchpadOf(dexId);
}

/** Still on its bonding curve — it has not graduated to an open AMM yet. */
export const onCurve = (dexId) => venueOf(dexId).curve;

export async function sweep({ angles = ANGLES } = {}) {
  emit("stage", { stage: "scout", note: `sweeping ${angles.length} angles` });
  const best = new Map();

  const results = await Promise.all(angles.map((q) => searchPairs(q).catch(() => [])));

  for (const pairs of results) {
    for (const p of pairs) {
      if (p.chainId !== CHAIN) continue;
      const mint = p.baseToken?.address?.toLowerCase();
      if (!mint) continue;
      // keep the deepest pair per mint — the one an exit would actually route through
      const prev = best.get(mint);
      if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) best.set(mint, p);
    }
  }

  const out = [...best.entries()].map(([mint, pair]) => ({
    mint,
    address: mint,
    pair: shapePair(pair),
    raw: pair,
    launchpad: launchpad(mint, pair.dexId),
    onCurve: onCurve(pair.dexId),
  }));
  const pads = {};
  for (const t of out) if (t.launchpad) pads[t.launchpad] = (pads[t.launchpad] || 0) + 1;
  emit("scout:universe", { total: out.length, fresh: out.length, launchpads: pads });
  // The ledger: keep what this sweep saw, so later gates can ask what a coin
  // looked like when we FIRST saw it, and what its liquidity actually held at.
  try { (await import("./data/snapshots.js")).record(out); } catch {}
  return out;
}

/* ═══ CATEGORISATION ══════════════════════════════════════════════════════
   Decided in code wherever possible. A category is only useful to a tenant
   allocating by type if it is decidable from evidence rather than vibes, so
   anything genuinely ambiguous is labelled `unclear` and says why, instead of
   being guessed at. */

const AI_WORDS = /\b(ai|agent|gpt|llm|neural|model|inference|robot|bot)\b/i;
const DEFI_WORDS = /\b(swap|dex|lend|borrow|vault|yield|stake|staking|perp|amm|liquid)\b/i;
const INFRA_WORDS = /\b(protocol|network|chain|node|oracle|bridge|rpc|infra|validator)\b/i;
const MEME_WORDS = /\b(dog|cat|pepe|wojak|frog|inu|shib|moon|elon|trump|baby|floki|meme|chad|gm)\b/i;

export function classify({ pair, mint }) {
  const why = [];
  const text = `${pair?.baseName ?? ""} ${pair?.baseSymbol ?? ""}`.trim();
  const age = pair?.ageHours ?? null;
  const liq = pair?.liquidityUsd ?? 0;
  const hasSite = (pair?.websites?.length ?? 0) > 0;
  const socials = pair?.socials?.length ?? 0;
  // Keyed on the DEX ID: a 0x address carries no launchpad suffix (see launchpad()).
  const pad = launchpad(mint, pair?.dex);
  const pumpLineage = Boolean(pad);

  if (pad) why.push(`${pad} launch`);
  if (hasSite) why.push("has a website");
  if (age != null) why.push(`${Math.round(age)}h old`);

  // Established first: age and depth outrank naming. A three-year-old token with $50m
  // of liquidity is not a memecoin because its name has a dog in it.
  if (age != null && age > 24 * 90 && liq > 1_000_000) {
    why.push("older than 90 days with deep liquidity");
    return { category: "established", confidence: 0.9, why };
  }

  if (AI_WORDS.test(text)) { why.push("AI/agent naming"); return { category: "ai", confidence: hasSite ? 0.75 : 0.55, why }; }
  if (DEFI_WORDS.test(text)) { why.push("defi naming"); return { category: "defi", confidence: hasSite ? 0.75 : 0.5, why }; }
  if (INFRA_WORDS.test(text)) { why.push("infrastructure naming"); return { category: "infra", confidence: hasSite ? 0.7 : 0.45, why }; }
  if (MEME_WORDS.test(text)) { why.push("meme naming"); return { category: "memecoin", confidence: 0.8, why }; }

  // A fresh launchpad token is a memecoin by construction, whatever it is called and
  // whatever it links to. Requiring "no website" sent 47 of 190 to `unclear`, because a
  // three-hour-old pump.fun coin with a landing page is the norm, not the exception — that
  // site is marketing, not evidence of a product.
  if (pumpLineage && age != null && age < 24 * 30) {
    why.push(hasSite ? `recent ${pad} launch; a website is marketing at this age` : `recent ${pad} launch, no website`);
    return { category: "memecoin", confidence: hasSite ? 0.6 : 0.7, why };
  }
  if (hasSite && socials > 0 && age != null && age > 24 * 14) {
    why.push("website plus socials and not brand new");
    return { category: "utility", confidence: 0.55, why };
  }

  why.push("no decisive signal in the available evidence");
  return { category: "unclear", confidence: 0.2, why };
}

/** Category → how much risk the house is willing to take on it by default. */
export const CATEGORY_RISK = {
  established: { sizeMultiplier: 1.0,  maxHoldHours: 720, note: "deep, old, survivable" },
  utility:     { sizeMultiplier: 0.7,  maxHoldHours: 336, note: "a real product claim, still illiquid" },
  infra:       { sizeMultiplier: 0.7,  maxHoldHours: 336, note: "slow thesis, slow exit" },
  defi:        { sizeMultiplier: 0.6,  maxHoldHours: 240, note: "composability risk on top of price risk" },
  ai:          { sizeMultiplier: 0.5,  maxHoldHours: 168, note: "narrative-led, rotates fast" },
  memecoin:    { sizeMultiplier: 0.25, maxHoldHours: 72,  note: "reflexive; the base rate is near zero" },
  unclear:     { sizeMultiplier: 0.15, maxHoldHours: 48,  note: "unclassified is not a thesis" },
};
