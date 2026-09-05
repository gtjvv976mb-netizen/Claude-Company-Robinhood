import crypto from "node:crypto";

export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/* ONE SPELLING PER CONTRACT.
 *
 * An EVM address is 20 bytes and has no canonical case on the wire: DexScreener returns
 * lowercase, GeckoTerminal lowercase, Kyber mixed-case EIP-55, and a tenant pastes
 * whatever their wallet shows. The `calls` table has a UNIQUE index on (mint) WHERE
 * status='live' — so the same coin spelled two ways would open two live calls on one
 * position, and `liveCallFor()` would find neither of them from the third spelling.
 * Every id that enters a table or keys a map goes through here first: lowercase 0x for
 * a 40-hex-digit address, and anything that is not one is returned untouched, so the
 * legacy base58 rows and the test fixtures ("Mint0111...") keep their identity. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export const isEvmAddress = (s) => typeof s === "string" && EVM_ADDRESS.test(s);
export const isEvmTxHash = (s) => typeof s === "string" && EVM_TX_HASH.test(s);
export const canonicalAddress = (s) => (isEvmAddress(s) ? s.toLowerCase() : s);
export const canonicalTxHash = (s) => (isEvmTxHash(s) ? s.toLowerCase() : s);

/* ONE NAME PER LAUNCHPAD.
 *
 * Three dialects name the same pad on this chain, and on 2026-09-05 the desk keyed its
 * quota on one of them while the sweep spoke another: market.js launchpad() collapses
 * every PONS dex id ("pons", "pons-v2", "pons-v2-dex", "pons-dot-family") to "pons" and
 * hoodit to "hood.fun" (the evidence contract's launchpad.venue vocabulary), while the
 * tenant-facing LAUNCHPADS list (copy.js, from the shared contract) says "pons-v2",
 * "pons" (V1) and "hoodit". PREFERRED_PAD = "pons-v2" therefore matched NO coin the
 * sweep produced — the exact "pump.fun on a chain with no pump.fun" failure the port
 * was meant to close, re-created with a different string. So every comparison goes
 * through this table first: the sweep's label, GeckoTerminal's dex id and DexScreener's
 * dexId all land on the contract's id. The V1/V2 split follows the data lane's
 * semantics: its "pons" is the current (V2) factory and "pons-v1" the WETH-paired V3
 * one. A label the table does not know is returned lowercased, never dropped, so an
 * unforeseen pad still reads as itself rather than as nothing. */
const LAUNCHPAD_ALIASES = new Map([
  ["pons", "pons-v2"], ["pons-v2", "pons-v2"], ["pons-v2-dex", "pons-v2"], ["ponsfamily", "pons-v2"],
  ["pons-v1", "pons"], ["pons-dot-family", "pons"],
  ["hoodit", "hoodit"], ["hood.fun", "hoodit"], ["hood-fun", "hoodit"], ["hoodfun", "hoodit"],
  ["pools.trade", "pools.trade"], ["uniswap-pools-trade", "pools.trade"], ["pools-trade", "pools.trade"], ["poolstrade", "pools.trade"],
  ["bankr", "bankr"], ["bankr-robinhood", "bankr"],
  ["uniswap", "uniswap"], ["uniswap-v4-robinhood", "uniswap"], ["uniswap-v3-robinhood", "uniswap"], ["uniswap-v2-robinhood", "uniswap"],
  ["none", "uniswap"],
  ["other", "other"],
]);
export function canonicalLaunchpad(label) {
  if (label == null) return null;
  const key = String(label).trim().toLowerCase();
  if (!key || key === "unknown" || key === "null") return null;
  return LAUNCHPAD_ALIASES.get(key) ?? key;
}
