/**
 * WHICH POOLS COUNT AS ETH-QUOTED — the pure half of probe-measure-4663.mjs's sampler,
 * split out so it can be tested without the probe's network I/O.
 *
 * "WETH" in a GeckoTerminal pool name is not proof of the WETH ERC-20. GeckoTerminal
 * renders NATIVE ETH — token address 0x000…000 — with the symbol "WETH" as well. A
 * selector that matched only the ERC-20 at 0x0bd7…ad73 silently discarded every
 * native-quoted pool, which is the entirety of pons-v2-dex: `--dexes pons-v2-dex`
 * sampled zero pools, and the run was read as "PONS has no WETH pools" when the truth
 * was a selector that could not see them.
 *
 * The executor quotes NATIVE_SENTINEL (0xEeee…EEeE), which the aggregator resolves to
 * the same native asset, so a native-quoted pool is exactly as tradeable as an ERC-20
 * one. Both markers are the ETH side.
 */
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const NATIVE_GT = "0x0000000000000000000000000000000000000000";

/** Is this token address the ETH side of a pair, by either marker? */
export const isEthSide = (a) => {
  const x = String(a ?? "").toLowerCase();
  return x === WETH || x === NATIVE_GT;
};

/** The non-ETH side of an ETH-quoted pool — the token under test — or null.
 *  A pool with ETH on BOTH sides (a WETH/native wrapper pair) has no token under
 *  test; returning one would put ETH itself in the round-trip table. */
export const tokenSide = (p) => {
  const q = isEthSide(p?.quote), b = isEthSide(p?.base);
  if (q && b) return null;
  if (q) return p.base;
  if (b) return p.quote;
  return null;
};
