/**
 * THE BAND'S CLOCK.
 *
 * A call is an instruction to buy and to sell. Until 2026-09-03 only the buy carried a
 * number: every position, a $9k coin and a $5m coin alike, sat under one 12-hour age
 * exit. This desk buys low to sell high inside a session, so each market-cap band now
 * carries the window it deserves, the window travels with the call, and the bot closes
 * on it whether or not the target printed.
 */
import assert from "node:assert/strict";
import { CAP_BANDS, holdWindowFor } from "./src/categories.js";
import { openPosition, stepPosition, DEFAULTS } from "./executor/strategy.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const MIN = 60_000, HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;

const held = (call, afterMs, cfg = {}) => {
  const pos = openPosition({ call: { mint: "m", symbol: "T", stop: 0.5, target: 2,
    openedAtMs: T0, ...call }, sol: 0.05, fillPrice: 1, cfg: { ...DEFAULTS, ...cfg } });
  return stepPosition({ pos, mark: 1.0, cfg: { ...DEFAULTS, ...cfg }, nowMs: T0 + afterMs });
};

console.log("\nTHE WINDOW TRAVELS WITH THE CALL");
for (const [band, b] of Object.entries(CAP_BANDS)) {
  const call = { hold_band: band, hold_max_ms: b.holdMaxMs };
  const inside = held(call, b.holdMaxMs - MIN);
  const expired = held(call, b.holdMaxMs);
  ok(`${band} holds at ${Math.round((b.holdMaxMs - MIN) / MIN)}m`, inside.action === "hold", inside.reason);
  ok(`${band} sells at ${Math.round(b.holdMaxMs / MIN)}m`,
    expired.action === "sell" && new RegExp(`the ${band} window closed`).test(expired.reason), expired.reason);
}

console.log("\nA CALL IS CLOSED ON ITS OWN BAND WINDOW, NOT ON A GLOBAL CLOCK");
/* Derived from CAP_BANDS rather than written as a literal. The original read "a nano
   position is closed 31 minutes in", which pinned pump.fun's 30-minute clock into the
   test — so when the RH clocks were re-measured (see src/bands.js) this failed while
   describing correct behaviour. A test that hardcodes the value it is meant to protect
   fails the day that value is legitimately updated. */
const nano = { hold_band: "nano", hold_max_ms: CAP_BANDS.nano.holdMaxMs };
const justPast = CAP_BANDS.nano.holdMaxMs + MIN;
ok(`a nano position is closed just past its ${CAP_BANDS.nano.holdMaxMs / HOUR}h window`,
  held(nano, justPast).action === "sell", held(nano, justPast).reason);
/* THE CONTRAST NEEDS A BAND SHORTER THAN THE BACKSTOP, and on this chain every band is
   now 120h — the same as the backstop, deliberately (src/bands.js). So the distinction is
   shown with an explicitly short window instead of with the nano band, which no longer
   differs from the fallback at that instant. */
const shortWindowed = { hold_band: "nano", hold_max_ms: 30 * MIN };
ok("a call WITH a short window closes on it", held(shortWindowed, 31 * MIN).action === "sell",
  held(shortWindowed, 31 * MIN).reason);
ok("...where a call carrying NO window is still holding at the same instant",
  held({}, 31 * MIN).action === "hold", held({}, 31 * MIN).reason);

console.log("\nTHE SHORTER OF THE TWO ALWAYS WINS");
/* An operator may shorten every hold; a call may never extend one past what the operator
 * configured. Both directions matter: the first is the operator's prerogative, and the
 * second stops a server-authored number from overriding a local risk limit. */
const long = { hold_band: "very_high", hold_max_ms: CAP_BANDS.very_high.holdMaxMs };
ok("an operator's 1-hour age exit beats a 24-hour band window",
  held(long, 61 * MIN, { maxAgeHours: 1 }).action === "sell", held(long, 61 * MIN, { maxAgeHours: 1 }).reason);
ok("...and reports itself as the age exit, not the band",
  /age exit/.test(held(long, 61 * MIN, { maxAgeHours: 1 }).reason));
/* A band window SHORTER than the operator's ceiling governs — the other direction of
   "the shorter of the two wins". Both sides derived, so neither can go stale. */
const shortBand = { hold_band: "nano", hold_max_ms: 30 * MIN };
ok("a band window shorter than the operator's ceiling governs",
  held(shortBand, 31 * MIN, { maxAgeHours: DEFAULTS.maxAgeHours }).action === "sell",
  held(shortBand, 31 * MIN, { maxAgeHours: DEFAULTS.maxAgeHours }).reason);

console.log("\nA CALL WITHOUT A WINDOW FALLS BACK, NEVER FORWARD");
const pastBackstop = (DEFAULTS.maxAgeHours + 1) * HOUR;
const insideBackstop = (DEFAULTS.maxAgeHours - 1) * HOUR;
ok("no window means the configured age exit still governs",
  held({}, pastBackstop).action === "sell" && /age exit/.test(held({}, pastBackstop).reason));
ok("a zero window is not a window", held({ hold_max_ms: 0 }, pastBackstop).action === "sell");
ok("a nonsense window is ignored", held({ hold_max_ms: "soon" }, insideBackstop).action === "hold");
ok("the backstop is never shorter than the longest band",
  DEFAULTS.maxAgeHours * 3600e3 >= CAP_BANDS.very_high.holdMaxMs,
  `${DEFAULTS.maxAgeHours}h backstop vs a ${CAP_BANDS.very_high.holdMaxMs / HOUR}h band`);
ok("an unreadable market cap publishes no window", holdWindowFor(null) === null);

console.log("\nTHE CLOCK RUNS EVEN WHEN THE PRICE DOES NOT");
/* The old age check ran before the mark check and that must not change: a position whose
 * mark cannot be read is exactly the one that must not be held indefinitely. */
const posNoMark = openPosition({ call: { mint: "m", symbol: "T", stop: 0.5, target: 2,
  openedAtMs: T0, ...nano }, sol: 0.05, fillPrice: 1, cfg: DEFAULTS });
const noMark = stepPosition({ pos: posNoMark, mark: null, cfg: DEFAULTS,
  nowMs: T0 + CAP_BANDS.nano.holdMaxMs + MIN });
ok("an unreadable mark does not stop the clock", noMark.action === "sell", noMark.reason);

console.log("\nA STOP STILL OUTRANKS NOTHING — THE CLOCK IS AN ADDITION");
const stopped = (() => {
  const pos = openPosition({ call: { mint: "m", symbol: "T", stop: 0.9, target: 2, openedAtMs: T0, ...nano },
    sol: 0.05, fillPrice: 1, cfg: DEFAULTS });
  return stepPosition({ pos, mark: 0.5, cfg: DEFAULTS, nowMs: T0 + MIN });
})();
ok("a stop inside the window still sells on the stop", stopped.action === "sell" && /stop/.test(stopped.reason),
  stopped.reason);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
