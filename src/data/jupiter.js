/**
 * COMPATIBILITY SHIM — data/jupiter was a Solana source and was removed on the Robinhood fork
 * (2026-09-05, data-sources lane). The replacement is src/data/kyber.js (quote, roundTrip in wei, price, withRetry). Every export below keeps its
 * old name and THROWS on use, so an importer that was missed fails loudly at the call
 * site rather than silently reading nothing. The exact replacement import lines for
 * each remaining importer are in docs/HANDOFF-data-sources.md. Delete this file once
 * `grep -rn "data/jupiter" src test-*.mjs` is empty.
 */
const gone = (fn) => () => { throw new Error(`data/jupiter.${fn}: Solana source removed on the Robinhood fork — use src/data/kyber.js (quote, roundTrip in wei, price, withRetry) (see docs/HANDOFF-data-sources.md)`); };
export { withRetry } from "./kyber.js";
export const price = gone("price");
export const quote = gone("quote");
export const roundTrip = gone("roundTrip");
