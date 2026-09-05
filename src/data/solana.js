/**
 * COMPATIBILITY SHIM — data/solana was a Solana source and was removed on the Robinhood fork
 * (2026-09-05, data-sources lane). The replacement is src/data/evm.js (contractFacts, holdersFromLedger, sellSim) — wallet balances become eth_getBalance. Every export below keeps its
 * old name and THROWS on use, so an importer that was missed fails loudly at the call
 * site rather than silently reading nothing. The exact replacement import lines for
 * each remaining importer are in docs/HANDOFF-data-sources.md. Delete this file once
 * `grep -rn "data/solana" src test-*.mjs` is empty.
 */
const gone = (fn) => () => { throw new Error(`data/solana.${fn}: Solana source removed on the Robinhood fork — use src/data/evm.js (contractFacts, holdersFromLedger, sellSim) — wallet balances become eth_getBalance (see docs/HANDOFF-data-sources.md)`); };
export const mintInfo = gone("mintInfo");
export const topHolders = gone("topHolders");
export const health = gone("health");
export const walletSolBalances = gone("walletSolBalances");
export const walletSolBalance = gone("walletSolBalance");
