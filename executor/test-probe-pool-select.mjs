import assert from "node:assert/strict";
import fs from "node:fs";
import { tokenSide, isEthSide, WETH, NATIVE_GT } from "./probe-pool-select.mjs";

/* ── "WETH" IN A POOL NAME IS NOT THE WETH ERC-20 ─────────────────────────────
 * GeckoTerminal renders NATIVE ETH (0x000…000) with the symbol "WETH" exactly as
 * it renders the ERC-20 at 0x0bd7…ad73. The probe's sampler matched only the
 * ERC-20, so every native-quoted pool was discarded before it could be measured.
 * That is the whole of pons-v2-dex: `--dexes pons-v2-dex` sampled ZERO pools, and
 * the empty result was read as "PONS has no ETH pools" rather than "the selector
 * cannot see them". The executor quotes NATIVE_SENTINEL, which the aggregator
 * resolves to the same native asset — a native-quoted pool is fully tradeable.
 *
 * These are real PONS pools, addresses as GeckoTerminal returns them (2026-09-07). */
const MEME = "0xafa57c4c5a72d36530c8e816ad6e9a5947941536";      // PORT
const BELL = "0x218d0dc56476b05f131bd6cc82b80c7b052fa9b1";      // BELL
const USDG = "0x1111111111111111111111111111111111111111";      // stand-in non-ETH quote

/* the case the old selector got wrong: a live PONS pool, native on the quote side */
assert.equal(tokenSide({ base: MEME, quote: NATIVE_GT }), MEME,
  "a native-ETH-quoted PONS pool must yield its token — this is the bug that hid all of PONS");
assert.equal(tokenSide({ base: BELL, quote: NATIVE_GT }), BELL,
  "every native-quoted pool, not just the first");

/* the ERC-20 case must keep working, on either side */
assert.equal(tokenSide({ base: MEME, quote: WETH }), MEME, "WETH on the quote side still works");
assert.equal(tokenSide({ base: WETH, quote: MEME }), MEME, "WETH on the base side still works");
assert.equal(tokenSide({ base: NATIVE_GT, quote: MEME }), MEME, "native on the base side too");

/* and the selector must still EXCLUDE what it always excluded */
assert.equal(tokenSide({ base: MEME, quote: USDG }), null, "a non-ETH pair is not ETH-quoted");
assert.equal(tokenSide({ base: WETH, quote: NATIVE_GT }), null,
  "ETH on both sides has no token under test — ETH must never enter the round-trip table");
assert.equal(tokenSide({}), null, "a malformed pool yields null, not a crash");
assert.equal(tokenSide({ base: undefined, quote: undefined }), null, "undefined is not the zero address");

/* case-insensitivity: GeckoTerminal has returned both casings */
assert.equal(tokenSide({ base: MEME, quote: WETH.toUpperCase().replace("0X", "0x") }), MEME,
  "the ETH-side test must be case-insensitive");
assert.ok(isEthSide(NATIVE_GT) && isEthSide(WETH), "both markers are the ETH side");
assert.ok(!isEthSide(MEME), "a memecoin is not the ETH side");

/* the probe must actually USE this module rather than keeping its own copy */
const probe = fs.readFileSync(new URL("./probe-measure-4663.mjs", import.meta.url), "utf8");
assert.match(probe, /import \{ tokenSide \} from "\.\/probe-pool-select\.mjs"/,
  "the probe must import the tested selector");
assert.ok(!/const tokenSide =|const isEthSide =/.test(probe),
  "the probe must not carry a second, untested copy of the selector");

console.log("probe pool select: native ETH counts as the ETH side (PONS is samplable), ETH/ETH excluded");
