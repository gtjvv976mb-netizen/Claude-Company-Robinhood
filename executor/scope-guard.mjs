/**
 * WHAT THIS DESK MAY SPECULATE ON, AND WHAT IT MAY MERELY HOLD TO TRADE WITH.
 *
 * The owner scoped this fork to memecoins and away from Stock Tokens — tokenized US
 * equities, which are securities. Then PONS V2 turned out to allow a launch to pair
 * against any ERC-20, including those equities, and a token paired to GOOGL can only be
 * bought by someone holding GOOGL. Trading such a pool at all means touching one.
 *
 * So the line moved, and it moved as narrowly as it can:
 *
 *   AN EQUITY MAY BE A PAIR ASSET. IT MAY NEVER BE A POSITION.
 *
 * The desk still never takes a directional view on a security. It may hold one
 * transiently as the medium of exchange for the memecoin it is actually trading, in the
 * same way it holds WETH — in, through, and out within a single round trip. What it will
 * not do is buy an equity because it thinks the equity goes up, which is the thing that
 * made the original line worth drawing.
 *
 * That distinction is enforced by two different questions, not one flag. `assertTradeable`
 * is unchanged and still refuses every equity as a TARGET. `assertPairAsset` is the new
 * one, and it is an explicit allowlist rather than "any equity": an unknown beacon proxy
 * showing up as a quote asset is refused exactly as before, because "it is a stock, so it
 * is fine" is how the narrow permission becomes a wide one.
 *
 * Measured on chain 4663 on 2026-09-04. Every Stock Token is an ERC-1967 beacon proxy
 * whose beacon slot holds 0xe10b6f6b275de231345c20d14ab812db62151b00 — SPY, NVDA, AAPL,
 * TSLA and GOOGL all point at that one beacon and all carry exactly 283 bytes of proxy
 * code. Nothing tradeable does: PONS, CASHCAT, WETH and both USDGs hold an empty beacon
 * slot and carry 2,202 to 5,274 bytes of their own logic.
 *
 * FAIL CLOSED ON ANYTHING UNFAMILIAR, both sides. The check is not "is this the known
 * equity beacon" — it is "does this token hand its logic to a beacon at all". A second
 * equity beacon is refused rather than waved through for failing to match one hardcoded
 * address.
 *
 * BUT "DELEGATES" DOES NOT MEAN "EQUITY", measured 2026-09-05 over all 800 listed tokens:
 * 130 are 283-byte beacon proxies and every one is a Robinhood Token; 90 are 44-byte
 * EIP-1167 clones (PONS launches, the memecoins this desk exists to trade); USDG is a
 * 170-byte proxy that delegates through the ERC-1967 IMPLEMENTATION slot, not the beacon.
 * So the beacon slot alone would pass an equity that Robinhood chose to ship behind a
 * different proxy. Hence a SECOND, INDEPENDENT signal: every one of the 130 carries
 * "• Robinhood Token" in name(), and none of the other 670 on that list does. A token is
 * refused if EITHER signal fires. The name is defence in depth, never a grant: a token
 * that fails the beacon test is refused before its name is read, and a token whose name
 * cannot be read is judged on the beacon alone — the secondary read can add a refusal,
 * not remove one.
 *
 * OFF THE WHITELIST, IMPERSONATORS USE THE MARKER TOO — found 2026-09-05 through the
 * Blockscout index (robinhoodchain.blockscout.com; 403 to a curl UA, 200 to a browser
 * UA): "AnthropicAI • Robinhood Token" as a 44-byte clone, "ANTHROPIC • Pre IPO Token"
 * behind a 295-byte proxy on a beacon that is not Robinhood's. The name signal refuses
 * the first and the unknown-beacon rule refuses the second, and both refusals are
 * deliberate: a memecoin dressed as a security is not one this desk wants to be seen
 * holding, whatever it is under the costume. Robinhood's own registry —
 * https://api.robinhood.com/rhj/assets, 194 assets, no auth — is the authority on which
 * tokens are genuine; a beacon match is how the chain agrees with it.
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

/* THE EQUITIES THIS DESK WILL HOLD TO TRADE WITH, by address, deliberately short.
 *
 * An allowlist rather than a rule, because "any beacon proxy is an equity and equities
 * are allowed as pairs" would readmit everything the guard exists to keep out — a token
 * that merely LOOKS like an equity would qualify. These are the ones checked by hand
 * against the live chain on 2026-09-04. Adding to it is a deliberate act.
 *
 * GOOGL and AMZN are here because they are Anthropic's two largest outside shareholders
 * and so the nearest honest thing to the pairing the owner asked for. There is no Claude
 * or Anthropic stock token on this chain — measured 2026-09-05 across all 130 equity
 * proxies, none is Anthropic, Claude or OpenAI. NOT because Anthropic is private: SPCX
 * (0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea) is "Space Exploration Technologies Corp.
 * Class A Common Stock • Robinhood Token", 283 bytes on the same beacon, and SpaceX is
 * private too. Robinhood tokenizes private companies; it simply has not tokenized this
 * one. That is an absence, not an impossibility, so re-measure before assuming. */
/* THE DESK'S OWN ACCESS TOKEN IS NEVER A POSITION. $CLAUDECO (Robinhood edition,
 * launched 2026-09-04 on PONS V2 paired to NVDA) opens a floor and pays rent; the desk
 * trading it would be the house marking its own paper. Refused here by address, before
 * any beacon or name is read, so no upstream mistake can route it to the router. */
export const NEVER_POSITIONS = Object.freeze(new Map([
  ["0x7039986cac6c7885b53f10c7492e653055470ab9", "CLAUDECO (the access token)"],
]));
export function assertNotAccessToken(address) {
  const why = NEVER_POSITIONS.get(String(address ?? "").toLowerCase());
  if (why) throw new Error(`scope guard: ${address} is ${why} — it opens a floor and is never a position`);
}

export const ALLOWED_PAIR_EQUITIES = Object.freeze(new Map([
  ["0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", "GOOGL"],
  ["0x12f190a9f9d7d37a250758b26824b97ce941bf54", "AMZN"],
  ["0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", "NVDA"],
]));

/**
 * May this token be held as the medium of exchange for a trade?
 *
 * Plain tokens (WETH, a stablecoin, a memecoin) pass as they always did. An equity
 * passes ONLY if it is on the short allowlist above. Everything else — an unknown
 * beacon, an unreadable slot — is refused exactly as it is for a target.
 */
export function classifyPairAsset(word, { address = null } = {}) {
  const base = classifyFromBeaconWord(word, { address });
  if (base.tradeable) return { ...base, allowedAsPair: true };
  if (base.kind === "stock_token") {
    const name = ALLOWED_PAIR_EQUITIES.get(String(address ?? "").toLowerCase());
    if (name) return { ...base, allowedAsPair: true, kind: "allowed_pair_equity", pairSymbol: name,
      reason: `${name} is allowed as a PAIR ASSET only — held in and out within a round trip, ` +
        `never taken as a position` };
    return { ...base, allowedAsPair: false,
      reason: `${address ?? "token"} is a Stock Token that is not on this desk's pair-asset ` +
        `allowlist — an equity may be a medium of exchange only when it was chosen deliberately` };
  }
  return { ...base, allowedAsPair: false };
}

/** The live-chain form of classifyPairAsset. Same injected reader as classifyToken. */
export async function classifyPairAssetOnChain(address, readStorage, readName = null) {
  const v = await classifyToken(address, readStorage, readName);
  if (v.kind === "unreadable" || v.kind === "unknown_beacon") return { ...v, allowedAsPair: false };
  /* Refused by NAME while passing the beacon test means an equity behind an unfamiliar
     proxy. Nothing on the allowlist looks like that — the three allowed equities are all
     beacon proxies — so this is refused as a pair asset too, with the name in the reason. */
  if (v.kind === "stock_token_by_name") return { ...v, allowedAsPair: false };
  const word = v.beacon ? "0x" + v.beacon.replace(/^0x/, "").padStart(64, "0") : "0x" + "0".repeat(64);
  return classifyPairAsset(word, { address });
}

/** The marker every Robinhood Stock Token carries in name(), 130/130 measured 2026-09-05.
 *  U+2022 bullet, then the words. Matched case-insensitively on the words alone as well,
 *  so a renamed bullet does not become a loophole. */
export const ROBINHOOD_TOKEN_MARKER = "• Robinhood Token";
const MARKER_RE = /robinhood\s+token/i;

/** ERC-20 name() / symbol() selector words. */
export const SELECTOR_NAME = "0x06fdde03";

/** Decode a single ABI-encoded string return. Returns null for anything that is not
 *  one — an empty return, a short return, a bytes32-style name — rather than throwing,
 *  because "this contract has no readable name" is not evidence of anything. */
export function decodeAbiString(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return null;
  const b = hex.slice(2);
  if (b.length < 128) return null;
  const off = Number(BigInt("0x" + b.slice(0, 64)));
  if (!Number.isFinite(off) || off * 2 + 64 > b.length) return null;
  const len = Number(BigInt("0x" + b.slice(off * 2, off * 2 + 64)));
  const start = off * 2 + 64;
  if (!Number.isFinite(len) || start + len * 2 > b.length) return null;
  try { return Buffer.from(b.slice(start, start + len * 2), "hex").toString("utf8"); }
  catch { return null; }
}

/** The name-marker signal on its own. Pure. */
export function classifyFromName(name, { address = null } = {}) {
  if (typeof name !== "string" || !MARKER_RE.test(name)) return { equityByName: false, name: name ?? null };
  return { equityByName: true, name,
    reason: `${address ?? "token"} names itself "${name}" — a Robinhood Stock Token by its own label, ` +
      `whatever proxy it sits behind; this desk is scoped to memecoins only` };
}

/**
 * The same decision against a live chain. `readStorage(address, slot)` is injected so
 * this file needs no transport and can be tested without a network. `readName(address)`
 * is optional and returns the raw eth_call hex of name(); when given it is the second
 * signal described at the top of this file.
 */
export async function classifyToken(address, readStorage, readName = null) {
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
  const primary = classifyFromBeaconWord(word, { address });
  if (!primary.tradeable || typeof readName !== "function") return primary;

  /* THE SECOND SIGNAL. Only reached by a token the beacon test already passed, and only
     able to take that pass away. A transport failure here changes nothing — the primary
     gate has spoken, and a secondary that could refuse on its own hiccup would turn every
     RPC 429 into a missed trade without making the desk any safer. */
  let name = null;
  try { name = decodeAbiString(await readName(address)); } catch { name = null; }
  const byName = classifyFromName(name, { address });
  if (byName.equityByName)
    return { tradeable: false, kind: "stock_token_by_name", beacon: null, name, reason: byName.reason };
  return { ...primary, name };
}
