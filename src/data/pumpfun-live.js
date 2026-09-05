/**
 * COMPATIBILITY SHIM — data/pumpfun-live was a Solana source and was removed on the Robinhood fork
 * (2026-09-05, data-sources lane). The replacement is src/data/pons-live.js (same export names: newLaunches, recentlyTraded, asCandidate, bandOf, candles, momentumFrom, momentumFor). Every export below keeps its
 * old name and THROWS on use, so an importer that was missed fails loudly at the call
 * site rather than silently reading nothing. The exact replacement import lines for
 * each remaining importer are in docs/HANDOFF-data-sources.md. Delete this file once
 * `grep -rn "data/pumpfun-live" src test-*.mjs` is empty.
 */
const gone = (fn) => () => { throw new Error(`data/pumpfun-live.${fn}: Solana source removed on the Robinhood fork — use src/data/pons-live.js (same export names: newLaunches, recentlyTraded, asCandidate, bandOf, candles, momentumFrom, momentumFor) (see docs/HANDOFF-data-sources.md)`); };
export const newLaunches = gone("newLaunches");
export const recentlyTraded = gone("recentlyTraded");
export const asCandidate = gone("asCandidate");
export const candles = gone("candles");
export const momentumFor = gone("momentumFor");
/* Pure helpers that never touched the network keep working through pons-live so the
   momentum ruler is one implementation wherever it is imported from. */
export { momentumFrom, bandOf } from "./pons-live.js";
export const PAGE_ROWS = 20;
