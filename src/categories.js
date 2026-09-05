/**
 * THE BOARD — every coin the desk sees, sorted into a grid it can be held to.
 *
 * The desk used to hold one shortlist and publish its single best. That works, and it
 * hides something: a "best" chosen from whatever the sweep happened to surface is not
 * the best of the MARKET, it is the best of an accident. Two of three candidates being
 * launch farms told us nothing about whether a good $400k coin existed that hour,
 * because nobody looked in that drawer.
 *
 * So the market is divided twice — by SIZE, because a $40k coin and a $15m coin are
 * different trades with different odds and different reasons to be wrong, and by WHAT
 * THE COIN IS, because a game token with a build behind it and a dog picture are not
 * the same asset even at the same market cap.
 *
 * The grid is the point. Filling every cell forces the desk to look where it would
 * otherwise not, and an empty cell is itself information: "nothing legitimate under
 * $100k this hour" is a finding, not a gap.
 *
 * Nothing here costs money. Every judgement below comes from pair data already in
 * hand — the expensive seats are spent only on what this narrows down to.
 */
import { cfg } from "./config.js";
import { canonicalLaunchpad } from "./canonical.js";

/* What share of each cycle's paid attention goes to the preferred launchpad. A floor, not a cap. */
/* ONE PAD ONLY (owner, 2026-09-03, on pump.fun). This was a 0.6 FLOOR — fill 60% of the
   paid seats with the pad's coins, then fill the rest from anywhere — and the desk was
   spending 40% of its research on launchpads the owner does not want traded. At 1 it is
   the whole board. Set PENTHOUSE_PAD_QUOTA below 1 to let other launchpads back in. */
export const PAD_QUOTA = Math.min(1, Math.max(0, Number(process.env.PENTHOUSE_PAD_QUOTA ?? 1)));
/* THE PAD THE QUOTA IS KEYED ON. On chain 4663 that is PONS V2 — 207,893 launches a
   month, 1.55% graduating, the pad that carries the volume (Bitquery, Sep 2026). The
   copy has promised a PONS preference since the port; until 2026-09-05 the code still
   keyed the quota on "pump.fun", a pad no coin on this chain carries, so the quota pass
   took nothing every cycle and the general pass filled — a preference that existed
   only in prose. One constant, read by the board pick and the funnel pick alike. */
export const PREFERRED_PAD = process.env.PENTHOUSE_PREFERRED_PAD || "pons-v2";

/** Market-cap bands, as the owner specified them. */
/* The bands live in their own leaf module so the screen can read the same numbers
   without an import cycle. Re-exported here because this is where the desk has always
   found them. */
export { CAP_BANDS, holdWindowFor, bandForMarketCap } from "./bands.js";
import { CAP_BANDS } from "./bands.js";

/** What KIND of thing this is. Three, deliberately — more would be false precision. */
export const COIN_TYPES = {
  memecoin:    "a true memecoin — the story IS the asset, no product is claimed",
  web3_gaming: "a game or gaming ecosystem token, with something playable claimed",
  utility:     "claims a working product or service the token is used for",
};

const GAMING = /\b(game|gaming|gamefi|play|player|quest|arena|battle|guild|metaverse|nft game|p2e|rpg|mmo|esport|studio)\b/i;
const UTILITY = /\b(protocol|swap|dex|lend|borrow|stake|staking|yield|vault|bridge|oracle|infra|network|node|validator|ai agent|api|sdk|launchpad|wallet|payment|rwa|index)\b/i;

/**
 * Which band does this coin sit in? Null when the cap is unreadable — an unknown
 * number must never be assigned a drawer it might not belong in, and the rest of the
 * desk already follows that rule everywhere else.
 */
export function capBandOf(coin) {
  const mc = coin?.pair?.marketCap ?? coin?.pair?.fdv ?? null;
  if (mc == null || !(mc > 0)) return null;
  for (const [key, b] of Object.entries(CAP_BANDS))
    if (mc >= b.lo && mc < b.hi) return key;
  return null;                                    // outside every band the desk trades
}

/**
 * What kind of coin is this?
 *
 * Read from the name, symbol and the project's own links — which is all a free sweep
 * carries. It is a first pass, not a verdict: the narrative seat reads the actual site
 * and X account later and can contradict it. Defaults to memecoin, because on this
 * chain that is the base rate and claiming otherwise needs evidence.
 */
export function coinTypeOf(coin) {
  const p = coin?.pair ?? {};
  const text = `${p.baseName ?? ""} ${p.baseSymbol ?? ""} ${(p.websites ?? []).map((w) => w?.url ?? w).join(" ")}`;
  if (GAMING.test(text)) return "web3_gaming";
  if (UTILITY.test(text)) return "utility";
  return "memecoin";
}

/** The grid cell a coin belongs to, or null if it is outside the board entirely. */
export function cellOf(coin) {
  const band = capBandOf(coin);
  if (!band) return null;
  return { band, type: coinTypeOf(coin), key: `${band}/${coinTypeOf(coin)}` };
}

/**
 * Build the board: every cell, with its best candidates ranked inside it.
 *
 * `perCell` is how many the desk shortlists per cell — the owner's "at least 5 per
 * category". They are CANDIDATES, not calls: nothing here has been researched yet, and
 * putting a coin on the board costs nothing.
 *
 * `viable` is the free-screen filter passed in by the caller, so the board never
 * shortlists a coin the desk was always going to refuse on arrival.
 */
export function buildBoard(scored, { perCell = 5, viable = () => true } = {}) {
  const cells = new Map();
  let offBoard = 0;
  for (const c of scored) {
    const cell = cellOf(c);
    if (!cell) { offBoard++; continue; }
    if (!viable(c)) continue;
    if (!cells.has(cell.key)) cells.set(cell.key, { ...cell, coins: [] });
    cells.get(cell.key).coins.push(c);
  }
  for (const cell of cells.values()) {
    cell.coins.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    cell.total = cell.coins.length;
    cell.coins = cell.coins.slice(0, perCell);
  }
  return {
    cells: [...cells.values()].sort((a, b) => (b.coins[0]?.score ?? 0) - (a.coins[0]?.score ?? 0)),
    offBoard,
    filled: cells.size,
    possible: Object.keys(CAP_BANDS).length * Object.keys(COIN_TYPES).length,
  };
}

/**
 * Pick who gets the expensive seats.
 *
 * ONE PER CELL FIRST, best cell first — so the desk's paid attention is spread across
 * the board before it doubles up anywhere. A cycle that spends all eight workups inside
 * one drawer learns a great deal about that drawer and nothing about the market, which
 * is exactly the failure the board exists to prevent. Only once every cell has been
 * sampled does it come back for second-bests.
 */
export function selectAcrossBoard(board, budget, { padQuota = PAD_QUOTA, pad = PREFERRED_PAD } = {}) {
  const take = (c, cell) => ({ ...c, cellKey: cell.key, band: cell.band, coinType: cell.type });
  const seen = new Set();
  const picked = [];

  /* Stop on EXHAUSTION, not on a barren depth.
   *
   * The obvious loop breaks when a depth adds nothing — which is right for an
   * unfiltered pass and wrong for a filtered one. Measured: asking for 60%
   * pump.fun returned 50%, because depth 1 of every cell happened to be another
   * pad, the pass called that the end of the board, and gave up four rows above
   * the pump.fun coin sitting at depth 4. The filter has to be allowed to walk
   * PAST the rows it rejects. So the exit condition is "no cell had a coin at
   * this depth at all". */
  const sweepBoard = (want, filter) => {
    for (let depth = 0; picked.length < want; depth++) {
      let sawAny = false;
      for (const cell of board.cells) {
        if (picked.length >= want) break;
        const c = cell.coins[depth];
        if (!c) continue;
        sawAny = true;                              // it EXISTS, even if filtered out
        if (seen.has(c.mint) || !filter(c)) continue;
        seen.add(c.mint);
        picked.push(take(c, cell));
      }
      if (!sawAny) break;                           // the board really is exhausted
    }
  };

  /* THE PREFERRED PAD FIRST, DELIBERATELY.
   *
   * Measured on a live Solana sweep: pump.fun was 41% of everything surfaced and 53% of
   * what survived the free screen — already the largest pad, because it carried the
   * volume. But 53% is a majority by accident, and an accident is not a policy: on a
   * quiet hour the mix could just as easily come back mostly another pad. On 4663 the
   * same argument names PONS V2 (PREFERRED_PAD); the share here is UNMEASURED.
   *
   * So the quota is filled first, one per cell as always, and only then is the rest of
   * the budget spent on the whole board. It is a FLOOR, not a cap — if the other pads
   * have nothing viable the quota pass simply takes fewer and the general pass fills
   * in, because refusing to look at a good coin for being born on the wrong launchpad
   * would be a worse mistake than the one this fixes. */
  const quota = Math.min(budget, Math.ceil(budget * padQuota));
  // The sweep labels a PONS V2 coin "pons" (market.js PADS) and this constant says
  // "pons-v2": compared raw, the quota pass can match nothing by construction — the
  // same failure as keying on "pump.fun" here, with a different string (found by
  // reading both vocabularies side by side, 2026-09-05; test-desk-loop-eth.mjs pins
  // it). One alias table, both sides.
  const onPad = (c) => canonicalLaunchpad(c.launchpad) === canonicalLaunchpad(pad);
  sweepBoard(quota, onPad);
  const fromPad = picked.length;
  /* AT A FULL QUOTA THE FLOOR BECOMES A WALL. The owner's instruction is to search and
     trade the preferred pad's coins only, so when the quota is the whole budget the general pass
     is filtered too — otherwise a quiet hour on pump.fun silently spends the desk's
     research on the launchpads it was told to leave alone. Below 1 it behaves exactly
     as before: a floor, never a cap. */
  if (padQuota >= 1) sweepBoard(budget, onPad);
  else sweepBoard(budget, () => true);

  if (picked.length) picked.padMix = { [pad]: fromPad, other: picked.length - fromPad };
  return picked;
}
