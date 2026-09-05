/**
 * THE IGNITION LANE — the ruler before the measurement.
 *
 * Every number this lane produces decides which coins the expensive desk looks at
 * first, so each one is checked here against a tape whose answer is already known by
 * hand. The lane itself makes no model call and no trade; its failure mode is not a
 * loss, it is looking at the wrong coins all day while believing otherwise.
 */
import assert from "node:assert/strict";
import { CAP_BANDS } from "./src/categories.js";
import { asCandidate, bandOf, momentumFrom } from "./src/data/pons-live.js";
import { ignitionScore, shortlist } from "./src/ignition.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const NOW = 1_788_400_000_000;
const MIN = 60_000;

/** A tape with known answers: 20 flat minutes at $1, then a clean climb to $2. */
const tape = (closes, volumes = null) => closes.map((close, i) => ({
  ts: NOW - (closes.length - 1 - i) * MIN, open: close, high: close, low: close, close,
  volume: volumes ? volumes[i] : 100,
}));

console.log("\nTHE MOMENTUM RULER SAYS WHAT A PERSON WOULD SAY");
{
  // 31 minutes: 1.00 held for 25, then +10% a minute for five, ending at 1.61.
  const closes = [...Array(26).fill(1), 1.1, 1.21, 1.331, 1.4641, 1.61051];
  const m = momentumFrom(tape(closes));
  ok("a 61% five-minute climb reads as 61%", Math.abs(m.pct5m - 61.051) < 0.01, `${m.pct5m.toFixed(3)}%`);
  ok("...and the same over fifteen, because nothing moved before it",
    Math.abs(m.pct15m - 61.051) < 0.01, `${m.pct15m.toFixed(3)}%`);
  ok("a flat tape reads as zero, not as noise", momentumFrom(tape(Array(30).fill(1))).pct5m === 0);
  ok("the tape length is reported honestly", m.candles === 31 && m.coverageMins === 30,
    `${m.candles} candles over ${m.coverageMins} minutes`);
  ok("the drawdown from the high is zero at the high", Math.abs(m.drawdownFromHighPct) < 1e-9);
  const off = momentumFrom(tape([1, 1, 1, 2, 2, 2, 1.5]));
  ok("a coin 25% off its high says so", Math.abs(off.drawdownFromHighPct + 25) < 0.01,
    `${off.drawdownFromHighPct.toFixed(1)}%`);
}

console.log("\nVOLUME ACCELERATION COMPARES LIKE WITH LIKE");
{
  /* The prior window is TEN minutes and the recent one is FIVE. Summing both and
   * dividing would report every steady tape as accelerating 2x — a ruler that says
   * "rising" about a market doing nothing at all. It is halved for that reason. */
  const steady = momentumFrom(tape(Array(20).fill(1), Array(20).fill(100)));
  ok("a steady tape accelerates exactly 1.00x", Math.abs(steady.volAccel - 1) < 1e-9,
    `${steady.volAccel.toFixed(4)}x`);
  const doubled = momentumFrom(tape(Array(20).fill(1),
    [...Array(15).fill(100), ...Array(5).fill(200)]));
  ok("a genuine doubling reads as 2.00x", Math.abs(doubled.volAccel - 2) < 1e-9,
    `${doubled.volAccel.toFixed(4)}x`);
  const fromNothing = momentumFrom(tape(Array(20).fill(1),
    [...Array(15).fill(0), ...Array(5).fill(500)]));
  ok("a standing start has no ratio, and does not claim one", fromNothing.volAccel === null);
  ok("...but its volume is still counted", fromNothing.vol5mUsd === 2500);
  ok("too short a tape says nothing at all", momentumFrom(tape([1, 2])) === null);
  ok("an empty tape says nothing at all", momentumFrom([]) === null && momentumFrom(null) === null);
}

console.log("\nA \u201c1m\u201d CANDLE IS NOT A MINUTE");
{
  /* THE CASE EVERY TEST ABOVE MISSED. Each tape above has one candle per minute, which
   * is the one shape pump.fun never returns: it emits a row only for a minute that
   * traded. Measured on eight live coins, the span of the last five candles ran from 4
   * minutes to 2,665 — so the old ruler, which summed the last five ROWS and called it
   * five minutes, reported forty-four hours of trickle as a busy five minutes. The
   * sparser the tape, the bigger the number: it rewarded exactly the inactivity it
   * existed to detect. Every assertion here is on a gapped tape. */
  const at = (minsAgo, close, volume) => ({ ts: NOW - minsAgo * MIN, open: close, high: close,
    low: close, close, volume });
  // Six rows spanning three hours. Only the last two are inside a five-minute window.
  const sparse = [
    at(180, 1, 900), at(120, 1, 900), at(60, 1, 900),
    at(30, 1, 900), at(4, 1, 40), at(0, 1.2, 60),
  ];
  const m = momentumFrom(sparse);
  ok("only the volume inside the five minutes is counted", m.vol5mUsd === 100,
    `$${m.vol5mUsd} (row count would have said $${900 + 900 + 900 + 40 + 60})`);
  ok("the tape reports the span it truly covers", m.coverageMins === 180, `${m.coverageMins} min`);
  ok("six rows are six rows, not six minutes", m.candles === 6);
  ok("the five-minute change is measured from five minutes ago", Math.abs(m.pct5m - 20) < 1e-9,
    `${m.pct5m}%`);
  // Nothing printed between 30 and 15 minutes ago, so the prior window is genuinely empty.
  ok("an empty prior window claims no ratio", m.volAccel === null);

  /* A tape that stops an hour before you read it has no five-minute reading, and the
     old code would have handed one over from whatever its last five rows happened to
     be. Staleness is only knowable against a clock, so it is null until one is given. */
  const stale = momentumFrom(sparse, { now: NOW + 90 * MIN });
  ok("a tape read 90 minutes later says so", stale.stalenessMins === 90, `${stale.stalenessMins} min`);
  ok("...and reports no volume in the last five minutes", stale.vol5mUsd === 0);
  ok("without a clock, staleness is unknown rather than zero", m.stalenessMins === null);

  // A dense tape must still give exactly the answers it always gave.
  const dense = momentumFrom(tape([...Array(15).fill(1), ...Array(5).fill(2)],
    [...Array(15).fill(100), ...Array(5).fill(200)]));
  ok("a one-per-minute tape is unchanged: 2.00x acceleration", Math.abs(dense.volAccel - 2) < 1e-9,
    `${dense.volAccel.toFixed(4)}x`);
  ok("...and a 100% five-minute move", Math.abs(dense.pct5m - 100) < 1e-9, `${dense.pct5m}%`);
}

console.log("\nBANDS COME FROM THE MARKET CAP, NEVER FROM A GUESS");
for (const [band, b] of Object.entries(CAP_BANDS)) {
  ok(`${band} claims its own floor`, bandOf(b.lo) === band, `$${b.lo.toLocaleString()}`);
  ok(`${band} does not claim its ceiling`, bandOf(b.hi) !== band);
}
ok("below the board is not a band", bandOf(4_999) === null);
ok("above the board is not a band", bandOf(10_000_001) === null);
ok("an unreadable cap is not a band", bandOf(null) === null && bandOf(0) === null && bandOf("soon") === null);

console.log("\nONE COIN, READ THE WAY THE REST OF THE DESK READS COINS");
{
  /* A GeckoTerminal pool row, in the exact shape /networks/robinhood/new_pools returned
     on 2026-09-05 (PANE / WETH, pons-v2, reserve $11,731, fdv $14,661). The desk reads
     the pad's own listing, so the fixture is the listing's own dialect. */
  const gtPool = (over = {}, attrs = {}) => ({
    id: "robinhood_" + (over.pool ?? "0x7816e7aa1fb0c32073ba45111eda46802cf6dde8"), type: "pool",
    attributes: {
      base_token_price_usd: "0.0000148663321815765", address: over.pool ?? "0x7816e7aa1fb0c32073ba45111eda46802cf6dde8",
      name: over.name ?? "PANE / WETH", pool_created_at: new Date(NOW - (over.ageMin ?? 6) * MIN).toISOString(),
      fdv_usd: String(over.mcap ?? 30_000), market_cap_usd: over.mcapUsd ?? null,
      price_change_percentage: { m5: "18.783", h1: "18.783" },
      transactions: { m5: { buys: over.buys5m ?? 2, sells: 0, buyers: over.buyers5m ?? 2, sellers: 0 }, h1: { buys: 2, sells: 0, buyers: 2, sellers: 0 } },
      volume_usd: { m5: "483.24888", h24: "483.24888" }, reserve_in_usd: String(over.reserve ?? 11_731.14), ...attrs,
    },
    relationships: {
      base_token: { data: { id: "robinhood_" + (over.mint ?? "0x809f251c342d96ccbc4a13dc4168501f13caa67b"), type: "token" } },
      quote_token: { data: { id: "robinhood_0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", type: "token" } },
      dex: { data: { id: over.dex ?? "pons-v2", type: "dex" } },
    },
  });
  const c = asCandidate(gtPool(), { now: NOW });
  ok("the launchpad is not inferred, it is known from the dex id", c.launchpad === "pons", c.launchpad);
  ok("the band is the micro sleeve", c.live.band === "micro", `${c.live.band} at $30,000`);
  ok("the curve's reserve is the liquidity", c.pair.liquidityUsd === 11_731.14, `$${c.pair.liquidityUsd}`);
  ok("age is in hours, from the creation stamp", Math.abs(c.pair.ageHours - 0.1) < 0.01, `${c.pair.ageHours}h`);
  ok("the price is the indexer's own mark", Math.abs(c.pair.priceUsd - 0.0000148663321815765) < 1e-18, `$${c.pair.priceUsd}`);
  ok("the symbol comes off the pool name", c.pair.baseSymbol === "PANE" && c.pair.quoteSymbol === "ETH");
  ok("the token is the base token id, lower-cased", c.mint === "0x809f251c342d96ccbc4a13dc4168501f13caa67b" && c.address === c.mint);
  ok("the tape is keyed by pool", c.pool === "0x7816e7aa1fb0c32073ba45111eda46802cf6dde8");
  ok("a pons-v2 pool is on the curve", c.onCurve === true && c.live.graduated === false);
  ok("a pons-v2-dex pool has graduated", asCandidate(gtPool({ dex: "pons-v2-dex" }), { now: NOW }).onCurve === false);
  ok("market_cap_usd wins over fdv when present", asCandidate(gtPool({ mcapUsd: "45000" }), { now: NOW }).pair.marketCap === 45_000);
  ok("no market cap means no band, and no invented one",
    asCandidate(gtPool({}, { fdv_usd: null, market_cap_usd: null }), { now: NOW }).live.band === null);
  ok("no reserve means unknown liquidity, not zero",
    asCandidate(gtPool({}, { reserve_in_usd: null }), { now: NOW }).pair.liquidityUsd === null);
  ok("a row without a base token is not a candidate",
    asCandidate({ attributes: { address: "0x1" }, relationships: {} }) === null);
}

console.log("\nTHE SHORTLIST SPENDS ATTENTION, AND ONLY ATTENTION");
{
  const make = (over = {}) => asCandidate({
    id: "x", type: "pool",
    attributes: {
      address: "0xp" + (over.mint || Math.random()), name: (over.symbol || "S") + " / WETH",
      pool_created_at: new Date(NOW - (over.ageMin ?? 5) * MIN).toISOString(),
      fdv_usd: String(over.mcap ?? 30_000), market_cap_usd: null, reserve_in_usd: "3000",
      transactions: { m5: { buys: over.buys5m ?? 3, sells: 0, buyers: over.buyers5m ?? 3, sellers: 0 } },
      volume_usd: {}, price_change_percentage: {},
    },
    relationships: {
      base_token: { data: { id: "robinhood_" + (over.mint || "M" + Math.random()) } },
      quote_token: { data: { id: "robinhood_0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" } },
      dex: { data: { id: "pons-v2" } },
    },
  }, { now: NOW });

  // Token ids are addresses and come back lower-cased, so the fixture names are too.
  const live = make({ mint: "live" });
  const picked = shortlist([
    live,
    make({ mint: "offboard", mcap: 2_000 }),
    make({ mint: "stale", buys5m: 0 }),
    make({ mint: "ancient", mcap: 8_000, ageMin: 60 * 24 * 30 }),
  ], { now: NOW, limit: 10 });
  const mints = picked.map((p) => p.mint);
  ok("a live in-band coin is shortlisted", mints.includes("live"));
  ok("a coin off the board is not", !mints.includes("offboard"));
  ok("a coin with no trades in five minutes is not", !mints.includes("stale"));
  ok("a month-old nano coin is not — that move is long over", !mints.includes("ancient"));

  // Youth is the whole point of the lane, so it must actually win the ordering.
  const order = shortlist([make({ mint: "old", ageMin: 300 }), make({ mint: "young", ageMin: 2 })],
    { now: NOW, limit: 10 }).map((p) => p.mint);
  ok("the younger coin is looked at first", order[0] === "young", order.join(" > "));
  ok("the shortlist honours its limit", shortlist(Array.from({ length: 50 }, (_, i) =>
    make({ mint: "X" + i })), { now: NOW, limit: 7 }).length === 7);
}

console.log("\nTHE SCORE PREFERS A REAL MOVE TO A CHART ARTEFACT");
{
  const real = ignitionScore(momentumFrom(tape(
    [...Array(26).fill(1), 1.1, 1.2, 1.3, 1.4, 1.5],
    [...Array(15).fill(200), ...Array(11).fill(400), ...Array(5).fill(9_000)])), { band: "micro" });
  const artefact = ignitionScore(momentumFrom(tape(
    [...Array(26).fill(1), 2, 4, 6, 8, 10], Array(31).fill(3))), { band: "nano" });
  ok("a 50% move on real volume outscores a 900% move on nothing",
    real.score > artefact.score, `${real.score} vs ${artefact.score}`);
  ok("the artefact is told it traded nothing",
    artefact.reasons.some((r) => /traded in five minutes/.test(r)), artefact.reasons.join(" · "));
  ok("the real move is told its volume accelerated",
    real.reasons.some((r) => /volume .*x its prior/.test(r)), real.reasons.join(" · "));

  const dumping = ignitionScore(momentumFrom(tape(
    [...Array(26).fill(2), 1.9, 1.8, 1.7, 1.6, 1.5], Array(31).fill(5_000))), { band: "micro" });
  ok("a coin falling on volume scores below zero", dumping.score < 0, `${dumping.score}`);
  ok("a coin with no tape has no score", ignitionScore(null) === null);
  ok("the band travels with the score", real.band === "micro");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
