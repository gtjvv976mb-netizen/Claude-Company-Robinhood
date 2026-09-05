/**
 * COMPATIBILITY SHIM — data/gmgn was a Solana source and was removed on the Robinhood fork
 * (2026-09-05, data-sources lane). The replacement is GeckoTerminal/DexScreener robinhood links (see HANDOFF for order.js). Every export below keeps its
 * old name and THROWS on use, so an importer that was missed fails loudly at the call
 * site rather than silently reading nothing. The exact replacement import lines for
 * each remaining importer are in docs/HANDOFF-data-sources.md. Delete this file once
 * `grep -rn "data/gmgn" src test-*.mjs` is empty.
 */
const gone = (fn) => () => { throw new Error(`data/gmgn.${fn}: Solana source removed on the Robinhood fork — use GeckoTerminal/DexScreener robinhood links (see HANDOFF for order.js) (see docs/HANDOFF-data-sources.md)`); };
export const tokenLink = gone("tokenLink");
export const tradeLink = gone("tradeLink");
export const links = gone("links");
export const GMGN_BASE = "https://gmgn.ai";
