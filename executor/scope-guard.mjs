/**
 * MEMECOINS ONLY, ENFORCED IN CODE.
 *
 * The owner scoped this fork to memecoins and away from Stock Tokens. Stock Tokens are
 * tokenized US equities — securities — and a desk that publishes calls on them to paying
 * tenants is a completely different legal proposition from one that calls memecoins.
 * That decision is worth more than a line in a README: a promise degrades silently, and
 * the day something reaches for a ticker nobody would notice until it had traded.
 *
 * Measured on chain 4663 on 2026-09-04. Every Stock Token is an ERC-1967 beacon proxy
 * whose beacon slot holds 0xe10b6f6b275de231345c20d14ab812db62151b00 — SPY, NVDA, AAPL,
 * TSLA and GOOGL all point at that one beacon and all carry exactly 283 bytes of proxy
 * code. Nothing tradeable does: PONS, CASHCAT, WETH and both USDGs hold a zero beacon
 * slot and carry 2,202 to 5,274 bytes of their own logic. The separation is clean, and
 * it is a property of how Robinhood deploys rather than a list somebody maintains.
 *
 * FAIL CLOSED ON ANYTHING UNFAMILIAR. The check is not "is this the known equity
 * beacon" — it is "does this token hand its logic to a beacon at all". A second equity
 * beacon, or a Stock Token deployed behind a different proxy, must be refused rather
 * than waved through because it failed to match one hardcoded address. The cost of that
 * strictness is refusing an unrelated beacon-proxy memecoin, which is rare, visible in
 * the refusal reason, and the right way round.
 */

/** bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1) */
export const ERC1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

/** The beacon every Stock Token measured on 2026-09-04 points at. Named for the
 *  refusal message; the guard does NOT depend on matching it. */
export const KNOWN_STOCK_TOKEN_BEACON =
  "0xe10b6f6b275de231345c20d14ab812db62151b00";

const ZERO_WORD = /^0x0*$/;

/** The address held in a storage word, or null when the word is empty. */
export function beaconFromSlotWord(word) {
  if (typeof word !== "string" || !word.startsWith("0x")) return null;
  if (ZERO_WORD.test(word)) return null;
  return ("0x" + word.slice(-40)).toLowerCase();
}

/**
 * Decide whether a token may be traded by this desk, from its beacon slot alone.
 * Pure, so the rule can be tested against words whose answer is already known.
 */
export function classifyFromBeaconWord(word, { address = null } = {}) {
  const beacon = beaconFromSlotWord(word);
  if (beacon === null) return { tradeable: true, kind: "plain", beacon: null };
  if (beacon === KNOWN_STOCK_TOKEN_BEACON)
    return { tradeable: false, kind: "stock_token", beacon,
      reason: `${address ?? "token"} is a Robinhood Stock Token (equity beacon ${beacon}) — this desk is scoped to memecoins only` };
  return { tradeable: false, kind: "unknown_beacon", beacon,
    reason: `${address ?? "token"} delegates to an unrecognised beacon ${beacon} — refused because an unknown beacon could be an equity behind a different proxy` };
}

/**
 * The same decision against a live chain. `readStorage(address, slot)` is injected so
 * this file needs no transport and can be tested without a network.
 */
export async function classifyToken(address, readStorage) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error(`scope guard needs a 20-byte address, got ${String(address)}`);
  let word;
  try {
    word = await readStorage(address, ERC1967_BEACON_SLOT);
  } catch (e) {
    /* AN UNREADABLE SLOT IS NOT AN EMPTY SLOT. A failed read must never be reported as
       "no beacon, go ahead" — that is the shape of every unknown-treated-as-zero bug. */
    return { tradeable: false, kind: "unreadable", beacon: null,
      reason: `could not read the beacon slot of ${address}: ${e.message} — refusing rather than assuming it has none` };
  }
  return classifyFromBeaconWord(word, { address });
}
