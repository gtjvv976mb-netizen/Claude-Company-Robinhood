/**
 * COMPATIBILITY SHIM — data/pumpfun was a Solana source and was removed on the Robinhood fork
 * (2026-09-05, data-sources lane). The replacement is the PONS launch log + DexScreener socials (src/data/pons-live.js launchFor/launchTxFacts, evidence.launch/deployer). Every export below keeps its
 * old name and THROWS on use, so an importer that was missed fails loudly at the call
 * site rather than silently reading nothing. The exact replacement import lines for
 * each remaining importer are in docs/HANDOFF-data-sources.md. Delete this file once
 * `grep -rn "data/pumpfun" src test-*.mjs` is empty.
 */
const gone = (fn) => () => { throw new Error(`data/pumpfun.${fn}: Solana source removed on the Robinhood fork — use the PONS launch log + DexScreener socials (src/data/pons-live.js launchFor/launchTxFacts, evidence.launch/deployer) (see docs/HANDOFF-data-sources.md)`); };
export const coinInfo = gone("coinInfo");
export const deployerProfile = gone("deployerProfile");
export const callouts = gone("callouts");
