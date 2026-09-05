/**
 * THE BOARD — cap band x coin type, and paid attention spread across it.
 *
 * The desk used to take the top N by score, which meant a cycle could spend every
 * workup inside one drawer and learn nothing about the rest of the market. Worse, an
 * empty drawer was invisible: "no legitimate coin under $100k this hour" is a finding,
 * and it looked exactly like not having looked.
 */
import { CAP_BANDS, COIN_TYPES, capBandOf, coinTypeOf, cellOf, buildBoard, selectAcrossBoard, PAD_QUOTA, PREFERRED_PAD }
  from "./src/categories.js";
/* The pad the quota is keyed on: PONS V2 on chain 4663. The fixtures are attributed to
   it by the same name the selection reads, so a rename of the constant cannot leave
   this file testing a pad the desk no longer prefers. */
const PAD = PREFERRED_PAD;

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/* Attributed to the preferred pad on purpose. Since 2026-09-03 a full launchpad quota
   is exclusive, so an unattributed coin is not selected at all — the desk was told to
   trade one pad, and "we could not tell which pad this is" is not that. */
const coin = (mcap, name = "Dog", sym = "DOG", score = 50) => ({
  mint: `${sym}${mcap}`, score, launchpad: PAD,
  pair: { marketCap: mcap, baseName: name, baseSymbol: sym, websites: [] },
});

console.log("\nCAP BANDS — the owner's six, exactly");
for (const [mcap, want] of [[10_000, "nano"], [50_000, "micro"], [75_000, "low"],
                            [250_000, "medium"], [750_000, "high"], [5_000_000, "very_high"]])
  ok(`$${mcap.toLocaleString()} -> ${want}`, capBandOf(coin(mcap)) === want, capBandOf(coin(mcap)));
ok("under $5k is off the board", capBandOf(coin(4_000)) === null, "too little coin to trade");
ok("over $10m is off the board", capBandOf(coin(50_000_000)) === null, "somebody else's business");
ok("an UNREADABLE cap is never assigned a band",
  capBandOf({ pair: { marketCap: null, fdv: null } }) === null,
  "an unknown number must not be given a drawer it may not belong in");

console.log("\nCOIN TYPE — read from what the project says it is");
ok("a dog picture is a memecoin", coinTypeOf(coin(1e5, "Doge Wif Hat", "WIF")) === "memecoin");
ok("a game token is web3_gaming", coinTypeOf(coin(1e5, "Battle Arena Quest", "ARENA")) === "web3_gaming");
ok("a protocol token is utility", coinTypeOf(coin(1e5, "Lending Protocol", "LEND")) === "utility");
ok("the DEFAULT is memecoin, not utility",
  coinTypeOf(coin(1e5, "Zorp", "ZORP")) === "memecoin",
  "on this chain that is the base rate; claiming otherwise needs evidence");

console.log("\nTHE BOARD SPREADS PAID ATTENTION ACROSS CELLS");
// A market where one drawer is stuffed and the others hold one coin each. The old
// top-N would have spent every slot inside the stuffed drawer.
const market = [
  ...Array.from({ length: 10 }, (_, i) => coin(200_000, "Meme" + i, "M" + i, 90 - i)),  // medium/memecoin
  coin(50_000, "Micro Dog", "MD", 40),                                                  // micro/memecoin
  coin(750_000, "Mid Quest Game", "MQ", 35),                                            // high/web3_gaming
  coin(5_000_000, "Big Protocol", "BP", 30),                                            // very_high/utility
];
const board = buildBoard(market, { perCell: 5 });
ok("four cells are filled", board.filled === 4, `${board.filled} of ${board.possible} possible`);
ok("the stuffed cell is capped at perCell",
  board.cells.find((c) => c.key === "medium/memecoin").coins.length === 5,
  "10 seen, 5 shortlisted");
ok("...and still records how many it SAW",
  board.cells.find((c) => c.key === "medium/memecoin").total === 10);

const picked = selectAcrossBoard(board, 4);
const cells = new Set(picked.map((p) => p.cellKey));
ok("four workups touch FOUR different cells", cells.size === 4, [...cells].join(", "));
ok("the top-scored coin is still taken first", picked[0].pair.baseSymbol === "M0",
  "best cell first, then one from each");

const deep = selectAcrossBoard(board, 8);
ok("only once every cell is sampled does it double up",
  deep.slice(0, 4).every((p, i, a) => a.filter((x) => x.cellKey === p.cellKey).length === 1),
  "first pass is one per cell");
ok("and a deeper budget does come back for second-bests", deep.length === 8, `${deep.length} picked`);

console.log("\nAN EMPTY CELL IS A FINDING, NOT A GAP");
ok("cells the market did not fill are visibly absent",
  board.filled < board.possible,
  `${board.possible - board.filled} cells had nothing legitimate in them this sweep`);

console.log("\nTHE FREE SCREEN STILL GATES WHAT REACHES THE BOARD");
const strict = buildBoard(market, { perCell: 5, viable: (c) => c.pair.marketCap >= 500_000 });
ok("a coin the screen would refuse never gets shortlisted",
  strict.cells.every((c) => c.coins.every((x) => x.pair.marketCap >= 500_000)),
  "the board never shortlists what the desk was always going to refuse");

console.log(`\nTHE PREFERRED PAD (${PAD}) GETS THE MAJORITY OF PAID ATTENTION`);
ok("the preferred pad is PONS V2, the pad that carries the volume on 4663", PAD === "pons-v2", PAD);
// A market rigged AGAINST the quota: every top-scoring coin is another pad, and the
// preferred pad's coins are buried at the bottom of their cells.
const padded = (mcap, pad, sym, score) => ({
  mint: sym, score, launchpad: pad,
  pair: { marketCap: mcap, baseName: sym, baseSymbol: sym, websites: [] },
});
const padMarket = [
  padded(200_000, "uniswap", "MET1", 99), padded(210_000, "hoodit", "BAG1", 98),
  padded(220_000, "pools.trade", "MOON1", 97),   padded(230_000, "uniswap", "MET2", 96),
  padded(240_000, PAD, "PF1", 60),     padded(60_000, PAD, "PF2", 55),
  padded(700_000, PAD, "PF3", 50),     padded(3_000_000, PAD, "PF4", 45),
];
const padBoard = buildBoard(padMarket, { perCell: 5 });
const padPick = selectAcrossBoard(padBoard, 6);
const pf = padPick.filter((p) => p.launchpad === PAD).length;
ok("the preferred pad is the MAJORITY of a cycle's workups", pf / padPick.length > 0.5,
  `${pf} of ${padPick.length} — where the preferred pad carries the volume, it gets the attention`);
const padAvailable = padMarket.filter((c) => c.launchpad === PAD).length;
ok("...and it meets the quota, up to what the board actually holds",
  pf >= Math.min(padAvailable, Math.ceil(6 * PAD_QUOTA)),
  `${pf} of ${padAvailable} available, quota ${Math.ceil(6 * PAD_QUOTA)}`);
/* AT A FULL QUOTA IT IS EXCLUSIVE. The owner's instruction is the preferred pad only, so a seat
   the pad cannot fill is left empty rather than handed to a launchpad the desk was told
   not to trade. Below 1 the quota stays a floor and the rest of the board fills in. */
if (PAD_QUOTA >= 1) {
  ok("nothing but the preferred pad is studied at a full quota",
    padPick.every((p) => p.launchpad === PAD),
    padPick.map((p) => p.launchpad).join(", "));
  ok("...and a seat it cannot fill is simply not taken", padPick.length === padAvailable,
    `${padPick.length} picked from ${padAvailable} available, against a budget of 6`);
  const mixed = selectAcrossBoard(buildBoard(padMarket, { perCell: 5 }), 6, { padQuota: 0.5 });
  ok("a lowered quota lets the other pads back in",
    mixed.some((p) => p.launchpad !== PAD),
    mixed.map((p) => p.launchpad).join(", "));
}
ok("a preferred-pad coin beats a HIGHER-SCORING coin from another pad",
  padPick.some((p) => p.launchpad === PAD && p.score < 99) &&
  padPick.findIndex((p) => p.launchpad === PAD) === 0,
  "the quota is filled first, so the free score no longer decides the top of the list alone");

/* The bug this test exists for: a filtered pass that stops at the first barren depth
 * quits above coins it was sent to find. It returned 50% against a 60% quota. */
ok("the filtered pass walks PAST rows it rejects to reach a buried coin",
  padPick.some((p) => p.pair.baseSymbol === "PF1"),
  "PF1 sits at depth 4 of its cell behind four coins from other pads");

console.log("\nAT A FULL QUOTA, AN EMPTY SEAT BEATS THE WRONG LAUNCHPAD");
/* This assertion is the exact reverse of what it said until 2026-09-03, and
 * deliberately so. The quota was a FLOOR then — "refusing a good coin for being born on
 * the wrong pad would be the worse mistake" — which was right while the desk traded
 * every launchpad. The owner has since said the preferred pad only. A rule that quietly spends
 * the desk's research elsewhere whenever the preferred pad is quiet is not that rule, so at a
 * full quota an unfillable seat is left unfilled. Lower PENTHOUSE_PAD_QUOTA and the old
 * behaviour comes back verbatim, which is what the second case here checks. */
const noPump = buildBoard(padMarket.filter((c) => c.launchpad !== PAD), { perCell: 5 });
const noPumpPick = selectAcrossBoard(noPump, 4);
ok("a market with NO the preferred pad is not studied at all at a full quota",
  PAD_QUOTA >= 1 ? noPumpPick.length === 0 : noPumpPick.length === 4,
  `${noPumpPick.length} picked at quota ${PAD_QUOTA}`);
ok("...and the same market fills the budget once the quota is lowered",
  selectAcrossBoard(buildBoard(padMarket.filter((c) => c.launchpad !== PAD),
    { perCell: 5 }), 4, { padQuota: 0.5 }).length === 4,
  "the floor behaviour is one environment variable away");
ok("no coin is ever picked twice", new Set(padPick.map((p) => p.mint)).size === padPick.length,
  "the quota pass and the general pass share one seen-set");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
