/**
 * THE SIX SLEEVES — the desk's market-cap bands, and how long each is held.
 *
 * A LEAF. This module imports nothing, on purpose: the bands are the desk's one
 * taxonomy and both the screen (config.js) and the board (categories.js) must read the
 * same numbers. When the boundaries lived in categories.js, config.js could not import
 * them without a cycle, so it kept its own copy — and on 2026-09-03 the two drifted a
 * full rung apart, the screen calling a $250k coin "low" while the desk called it
 * "medium". One definition, no cycle, no drift.
 */
/* THE SIX SLEEVES, AND HOW LONG EACH ONE IS MEANT TO BE HELD (owner, 2026-09-03).
 *
 * The ladder moved down a rung and grew a nano band, because the money on this desk is
 * made buying low and selling high inside a session, not holding: a $5k coin that works
 * does it within half an hour, and a $5m coin needs most of a day. `hold` is not a
 * suggestion — a call carries its band's window, and the executor sells at `holdMaxMs`
 * whether or not the target printed. Nothing here is a safety limit; the stop, the
 * liquidity floor and the exit probe are, and they did not move. */
/* ── THE CLOCKS ARE ROBINHOOD CHAIN'S, MEASURED. THE CAP LADDER IS THE OWNER'S. ──────
 *
 * The boundaries above are untouched: they are the owner's, and the desk's own live
 * candidate board shows its coins landing on them ($5.4k, $6.7k, $299k, $655k), so the
 * ladder fits this market. THE HOLD WINDOWS DO NOT, and they were never measured here.
 *
 * The note this table used to carry — "minutes old, decided in minutes" for nano, with a
 * 30-minute forced sell — is a true statement about pump.fun, where every coin is born at
 * ~$5k on a curve and re-rates or dies within hours. On Robinhood Chain a $5k-$20k coin is
 * NOT young: measured on the desk's own DexScreener universe 2026-09-07, zero of eighteen
 * sub-$1m coins were under an hour old, thirteen were over a week, and the median was 539
 * hours. Members of the nano band on this chain run from 11.8h to 1,592h. A small cap here
 * does not mean "early", it means "launched weeks ago and went nowhere" — the opposite
 * signal from the same number.
 *
 * The clocks are set from cost, which is what actually decides them. Two independent
 * measurements agree on where the line is:
 *
 *   1. FAVOURABLE EXCURSION. Across real RH minute and hourly candles, the median best
 *      move within a window is 1.14% at 30 minutes, 1.85% at 1 hour, 4.21% at 6 hours,
 *      6.32% at 3 days and 12.96% at 7 days. An all-in round trip is 7.35% at the
 *      cheapest clip (0.0112 ETH) and 9.16% at the operator's 0.004 cap. The median trade
 *      therefore cannot clear its own cost until roughly the four-to-five day mark.
 *   2. THE SAME 41 DAYS TRADED. Holding the bracket fixed at -25%/+1.6x and varying ONLY
 *      the hold, over 730 published calls: 1h -14.71%, 6h -12.43%, 12h -11.94%, 24h
 *      -7.36%, 48h -4.29%, 72h -2.31%, 120h +2.19%, 168h +4.31%, 240h +8.85%. Monotonic,
 *      and the sign flips between 72h and 120h.
 *
 * 120 hours is the shortest window that is not measurably loss-making, so that is the
 * number. Longer looked better still, but a 41-day sample holds only three or four
 * NON-OVERLAPPING ten-day periods, so the apparent confidence out there is mostly the
 * same weeks counted repeatedly — it is not evidence and is not used.
 *
 * EVERY BAND GETS THE SAME WINDOW, and that is deliberate. pump.fun's ordering (small
 * caps fast, large caps slow) follows from cap and age being correlated there. On this
 * chain they are not, and nothing in the RH data justifies a different clock per band. A
 * flat measured window beats a differentiated unmeasured one; when per-band behaviour is
 * measured here, differentiate then and say what measured it.
 *
 * NOTE FOR THE OWNER: the previous clocks were yours (2026-09-03) and tuned on pump.fun.
 * These replace them on the Robinhood tower ONLY — the Solana tower keeps yours — and
 * they are a measurement, not a preference, so they should be overruled by a better
 * measurement rather than by argument. */
const HOLD_MAX_MS = 120 * 60 * 60_000;   // 5 days — the measured break-even horizon
const HOLD_MIN_MS = 6 * 60 * 60_000;     // recorded on the call; the executor does not enforce it
export const CAP_BANDS = {
  nano:      { lo: 5_000,     hi: 20_000,     label: "nano",      note: "$5k-$20k — small here means old and quiet, not new",
               holdMinMs: HOLD_MIN_MS,        holdMaxMs: HOLD_MAX_MS },
  micro:     { lo: 20_000,    hi: 60_000,     label: "micro",     note: "$20k-$60k — the first re-rate, sharpest rugs",
               holdMinMs: HOLD_MIN_MS,        holdMaxMs: HOLD_MAX_MS },
  low:       { lo: 60_000,    hi: 100_000,    label: "low",       note: "$60k-$100k — a crowd is forming",
               holdMinMs: HOLD_MIN_MS,        holdMaxMs: HOLD_MAX_MS },
  medium:    { lo: 100_000,   hi: 500_000,    label: "medium",    note: "$100k-$500k — room to re-rate, thin book",
               holdMinMs: HOLD_MIN_MS,        holdMaxMs: HOLD_MAX_MS },
  high:      { lo: 500_000,   hi: 1_000_000,  label: "high",      note: "$500k-$1m — a tape worth reading",
               holdMinMs: HOLD_MIN_MS,        holdMaxMs: HOLD_MAX_MS },
  very_high: { lo: 1_000_000, hi: 10_000_000, label: "very high", note: "$1m-$10m — needs real money to move",
               holdMinMs: HOLD_MIN_MS,        holdMaxMs: HOLD_MAX_MS },
};

/** The hold window for a market cap, or null when the cap is unreadable or off-board. */
export function holdWindowFor(mcap) {
  if (mcap == null || !(mcap > 0)) return null;
  for (const [band, b] of Object.entries(CAP_BANDS))
    if (mcap >= b.lo && mcap < b.hi) return { band, holdMinMs: b.holdMinMs, holdMaxMs: b.holdMaxMs };
  return null;
}

/** The band a market cap sits in, or null when it is unreadable or off the board. */
export function bandForMarketCap(mcap) {
  const mc = Number(mcap);
  if (!Number.isFinite(mc) || !(mc > 0)) return null;
  for (const [band, b] of Object.entries(CAP_BANDS)) if (mc >= b.lo && mc < b.hi) return band;
  return null;
}
