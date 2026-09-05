import * as ds from "./data/dexscreener.js";
import { trades as poolTrades } from "./data/pons-live.js";
import { emit } from "./lib/bus.js";

/**
 * WHALE CALLOUTS — who is actually taking size, and which way.
 *
 * Read-only. On Solana this replayed ~25 transactions per coin through the RPC, one at
 * a time, and the worst case was fourteen MINUTES for a single coin — which is how 21
 * cycles once started and never finished. On chain 4663 the same question is one
 * indexer request: GeckoTerminal's pool trades, filtered server-side to trades at or
 * above the whale bar (measured 2026-09-05: …/pools/{pool}/trades?trade_volume_in_usd
 * _greater_than=500 → 200, trades carrying kind, volume_in_usd, tx_from_address and
 * block_timestamp). The 45-second whale deadline stops biting because nothing here
 * takes 45 seconds.
 *
 * What changed in the evidence: `usd` is the indexer's dollar value AT EXECUTION, not
 * a token delta priced at the current mark, so it is a better number than the Solana
 * one and is labelled as such (evidenceKind/valueBasis). `wallet` is tx_from_address
 * — the sender, which for a bot routing through a contract is the bot's EOA.
 */

const configuredWhaleUsd = Number(process.env.WHALE_MIN_USD || 500);
export const WHALE_USD = Number.isFinite(configuredWhaleUsd) && configuredWhaleUsd > 0
  ? configuredWhaleUsd : 500;

/** Recent large trades in one token's deepest pool, largest first. */
export async function callouts(address, {
  scan = 300,
  minUsd = WHALE_USD,
  deadline = null,
  includeEvidence = false,
} = {}) {
  const px = await ds.pairsFor(address);
  if (!px.ok || !px.pairs.length) return { ok: false, error: px.error || "no pairs" };

  const cons = ds.consensus(px.pairs);
  const pair = cons.ok ? cons.deepest : px.pairs[0];
  const price = cons.ok ? cons.priceUsd : Number(pair.priceUsd);
  const pool = pair.pairAddress;
  if (!price || !pool) return { ok: false, error: "no price or pool" };
  if (deadline && Date.now() > deadline) return { ok: false, error: "deadline passed before the read started" };

  const r = await poolTrades(pool, { minUsd });
  if (!r.ok) return { ok: false, error: r.error };
  const trades = r.trades.slice(0, scan);

  const buys = trades.filter((t) => t.side === "buy");
  const sells = trades.filter((t) => t.side === "sell");
  const boughtUsd = buys.reduce((a, t) => a + t.usd, 0);
  const soldUsd = sells.reduce((a, t) => a + t.usd, 0);

  const result = {
    ok: true, mint: address, address, pool, priceUsd: price, scanned: trades.length,
    // The indexer returns what it has; nothing here was skipped for time. A thin
    // sample is still reported as its count so it is never mistaken for a quiet tape.
    unread: 0, skipped: 0, failed: 0, partial: false,
    trades: trades.slice(0, 12),
    buys: buys.length, sells: sells.length,
    boughtUsd: Number(boughtUsd.toFixed(2)),
    soldUsd: Number(soldUsd.toFixed(2)),
    netUsd: Number((boughtUsd - soldUsd).toFixed(2)),
    // distinct wallets matter: one wallet round-tripping is not accumulation
    uniqueBuyers: new Set(buys.map((t) => t.wallet)).size,
    uniqueSellers: new Set(sells.map((t) => t.wallet)).size,
  };
  if (includeEvidence) result.evidenceTrades = trades;
  emit("whales:read", { address, pool, trades: trades.length, netUsd: result.netUsd });
  return result;
}

/**
 * A ranking signal from whale flow, deliberately conservative. Unchanged.
 *
 * Net dollars alone is easy to fake — one wallet buying and selling itself moves the
 * number without moving conviction. Distinct wallets on the buy side is the harder thing
 * to manufacture, so it carries most of the weight.
 */
export function whaleScore(c) {
  if (!c?.ok) return { score: 0, why: [] };
  const why = [];
  let s = 0;
  if (c.netUsd > 0 && c.uniqueBuyers >= 3) { s += 14; why.push(`${c.uniqueBuyers} separate wallets accumulating`); }
  else if (c.netUsd > 0 && c.uniqueBuyers >= 2) { s += 7; why.push("a couple of wallets accumulating"); }
  if (c.netUsd < 0 && c.uniqueSellers >= 3) { s -= 16; why.push(`${c.uniqueSellers} wallets distributing`); }
  else if (c.netUsd < 0) { s -= 8; why.push("net whale selling"); }
  if (c.buys + c.sells === 0) why.push("no size trading either way");
  if (c.uniqueBuyers === 1 && c.buys > 2) { s -= 6; why.push("one wallet doing all the buying"); }
  return { score: s, why };
}
