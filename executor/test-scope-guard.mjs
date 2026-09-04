/**
 * MEMECOINS ONLY, AND THE GUARD THAT MAKES IT TRUE.
 *
 * The owner scoped this fork away from Stock Tokens — tokenized US equities, which are
 * securities. This is the check that makes that a property of the code instead of a
 * promise in a README, so the assertions below are about refusals, not about features.
 *
 * The live half runs against chain 4663 and is skipped without a network, because a
 * test that silently passes offline is worse than one that is honestly absent.
 */
import { classifyFromBeaconWord, classifyToken, beaconFromSlotWord, classifyPairAsset,
  classifyPairAssetOnChain, ALLOWED_PAIR_EQUITIES, classifyFromName, decodeAbiString,
  ROBINHOOD_TOKEN_MARKER, SELECTOR_NAME,
  KNOWN_STOCK_TOKEN_BEACON, ERC1967_BEACON_SLOT } from "./scope-guard.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const word = (addr) => "0x" + "0".repeat(24) + addr.replace(/^0x/, "");
const EMPTY = "0x" + "0".repeat(64);

console.log("\nA STOCK TOKEN IS REFUSED, AND SAID SO PLAINLY");
{
  const r = classifyFromBeaconWord(word(KNOWN_STOCK_TOKEN_BEACON), { address: "0xNVDA" });
  ok("the equity beacon is not tradeable", r.tradeable === false);
  ok("...and is named as a Stock Token, not just rejected", r.kind === "stock_token", r.kind);
  ok("...with a reason that explains the scope", /memecoins only/.test(r.reason));
}

console.log("\nA PLAIN TOKEN IS TRADEABLE");
{
  const r = classifyFromBeaconWord(EMPTY, { address: "0xCASHCAT" });
  ok("an empty beacon slot means an ordinary token", r.tradeable === true && r.kind === "plain");
  ok("a missing word is treated the same as an empty one", beaconFromSlotWord(EMPTY) === null);
  ok("'0x0' in any width still reads as empty", beaconFromSlotWord("0x00") === null);
}

console.log("\nANYTHING UNFAMILIAR FAILS CLOSED");
{
  /* The guard asks "does this delegate to a beacon at all", NOT "is this the one equity
     beacon I know". A second equity beacon must be refused, not waved through for
     failing to match a hardcoded address. */
  const r = classifyFromBeaconWord(word("0x1234567890abcdef1234567890abcdef12345678"), { address: "0xNEW" });
  ok("an unrecognised beacon is refused", r.tradeable === false, r.kind);
  ok("...and the reason says why the strictness exists", /could be an equity/.test(r.reason));
  ok("a malformed word is not read as empty", beaconFromSlotWord("nonsense") === null &&
    classifyFromBeaconWord("nonsense").tradeable === true);
}

console.log("\nAN UNREADABLE SLOT IS NEVER 'NO BEACON'");
{
  const r = await classifyToken("0x020bfC650A365f8BB26819deAAbF3E21291018b4",
    async () => { throw new Error("RPC 429"); });
  ok("a failed read refuses rather than assuming", r.tradeable === false && r.kind === "unreadable");
  ok("...and surfaces the transport error", /429/.test(r.reason));
  let threw = false;
  try { await classifyToken("not-an-address", async () => EMPTY); } catch { threw = true; }
  ok("a bad address is a programming error, not a refusal", threw);
}

console.log("\nAN EQUITY MAY BE A PAIR ASSET, NEVER A POSITION");
{
  /* PONS V2 lets a launch pair against any ERC-20, so a token paired to GOOGL can only be
     bought by someone holding GOOGL. Trading that pool means touching an equity. The line
     moved exactly this far and no further: the desk may hold one as the medium of
     exchange, in and out inside a round trip, and may never take a view on it. */
  const GOOGL = "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3";
  const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
  const eq = word(KNOWN_STOCK_TOKEN_BEACON);

  ok("GOOGL is still refused as a position", classifyFromBeaconWord(eq, { address: GOOGL }).tradeable === false);
  ok("...and allowed as a pair asset", classifyPairAsset(eq, { address: GOOGL }).allowedAsPair === true);
  ok("...named, so the log says which equity is being held",
    classifyPairAsset(eq, { address: GOOGL }).pairSymbol === "GOOGL");
  ok("...and the reason states the limit, not just the permission",
    /never taken as a position/.test(classifyPairAsset(eq, { address: GOOGL }).reason));

  /* THE ALLOWLIST IS THE POINT. "It is a stock, so it is fine" would readmit everything
     the guard exists to keep out — including a token that merely looks like an equity. */
  ok("an equity NOT on the list is refused as a pair asset too",
    classifyPairAsset(eq, { address: TSLA }).allowedAsPair === false, "TSLA");
  ok("...and says it was never chosen deliberately",
    /allowlist/.test(classifyPairAsset(eq, { address: TSLA }).reason));
  ok("the list is short and explicit", ALLOWED_PAIR_EQUITIES.size <= 5, `${ALLOWED_PAIR_EQUITIES.size} entries`);
  ok("...and is matched case-insensitively, as addresses arrive either way",
    classifyPairAsset(eq, { address: GOOGL.toLowerCase() }).allowedAsPair === true);

  ok("a plain token is fine as either", classifyPairAsset(EMPTY, { address: "0xCASHCAT" }).allowedAsPair === true);
  /* An unknown beacon must not become allowed just because it is being spent rather
     than bought. Fail closed on both sides. */
  ok("an unknown beacon is refused as a pair asset",
    classifyPairAsset(word("0x1234567890abcdef1234567890abcdef12345678"), { address: "0xNEW" }).allowedAsPair === false);
  ok("an unreadable slot is refused as a pair asset",
    (await classifyPairAssetOnChain("0x020bfC650A365f8BB26819deAAbF3E21291018b4",
      async () => { throw new Error("RPC down"); })).allowedAsPair === false);
}

console.log("\nTHE SECOND SIGNAL — A STOCK TOKEN SAYS SO IN ITS NAME");
{
  /* Measured 2026-09-05 over all 800 listed tokens: every one of the 130 equities carries
     "• Robinhood Token" in name(); none of the other 670 does. 90 memecoins are 44-byte
     EIP-1167 clones and USDG delegates through the implementation slot, so "delegates"
     is not "equity" and the beacon slot cannot be the only test. */
  const abiStr = (str) => {
    const b = Buffer.from(str, "utf8");
    const hex = b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0");
    return "0x" + (32n).toString(16).padStart(64, "0") + BigInt(b.length).toString(16).padStart(64, "0") + hex;
  };
  const SPCX_NAME = "Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token";
  ok("an ABI string round-trips through the decoder", decodeAbiString(abiStr(SPCX_NAME)) === SPCX_NAME);
  ok("an empty return decodes to null, not to a string", decodeAbiString("0x") === null);
  ok("a short return decodes to null", decodeAbiString("0x" + "00".repeat(40)) === null);
  ok("a non-hex value decodes to null", decodeAbiString(undefined) === null);

  ok("the marker names the equity", classifyFromName(SPCX_NAME, { address: "0xSPCX" }).equityByName === true);
  ok("...and the reason says it is refused by its own label",
    /by its own label/.test(classifyFromName(SPCX_NAME, { address: "0xSPCX" }).reason));
  ok("the marker survives a dropped bullet", classifyFromName("Apple Robinhood Token").equityByName === true);
  ok("...and a case change", classifyFromName("APPLE • ROBINHOOD TOKEN").equityByName === true);
  ok("a memecoin name is not an equity", classifyFromName("Artificial Inu").equityByName === false);
  ok("a null name is not an equity", classifyFromName(null).equityByName === false);
  ok("the exported marker is the measured one", ROBINHOOD_TOKEN_MARKER === "\u2022 Robinhood Token");
  ok("the selector is name()", SELECTOR_NAME === "0x06fdde03");

  const ADDR = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
  /* An equity hidden behind a proxy the beacon test cannot see is caught by its name. */
  const hidden = await classifyToken(ADDR, async () => EMPTY, async () => abiStr("Anthropic • Robinhood Token"));
  ok("an equity behind an unfamiliar proxy is refused by name",
    hidden.tradeable === false && hidden.kind === "stock_token_by_name", hidden.kind);
  ok("...and the name is carried in the verdict", hidden.name === "Anthropic • Robinhood Token");

  /* The name can only take a pass away, never grant one, and never refuse on its own failure. */
  let nameReads = 0;
  const beaconFirst = await classifyToken(ADDR, async () => word(KNOWN_STOCK_TOKEN_BEACON),
    async () => { nameReads++; return abiStr("Cash Cat"); });
  ok("a beacon refusal never reads the name", beaconFirst.kind === "stock_token" && nameReads === 0, `${nameReads} reads`);
  const flaky = await classifyToken(ADDR, async () => EMPTY, async () => { throw new Error("RPC 429"); });
  ok("a failed name read leaves a beacon pass standing", flaky.tradeable === true && flaky.kind === "plain", flaky.kind);
  const nameless = await classifyToken(ADDR, async () => EMPTY, async () => "0x");
  ok("a token with no name() is judged on the beacon alone", nameless.tradeable === true && nameless.name === null);
  const withName = await classifyToken(ADDR, async () => EMPTY, async () => abiStr("Cash Cat"));
  ok("a plain token's name rides along in the verdict", withName.tradeable === true && withName.name === "Cash Cat");
  const legacy = await classifyToken(ADDR, async () => EMPTY);
  ok("callers that pass no name reader behave exactly as before", legacy.tradeable === true && !("name" in legacy));

  /* The pair side carries the same signal. */
  const hiddenPair = await classifyPairAssetOnChain(ADDR, async () => EMPTY, async () => abiStr("Anthropic • Robinhood Token"));
  ok("an equity refused by name is refused as a pair asset too", hiddenPair.allowedAsPair === false);
  ok("...with the name in the reason", /Anthropic/.test(hiddenPair.reason));
}

console.log("\nAGAINST THE LIVE CHAIN");
{
  const RPC = "https://rpc.mainnet.chain.robinhood.com";
  const readStorage = async (address, slot) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt",
        params: [address, slot, "latest"] }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const readName = async (address) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: address, data: SELECTOR_NAME }, "latest"] }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  // Measured 2026-09-04: five equities behind one beacon, four tradeable tokens behind none.
  // 2026-09-05: SPCX — a PRIVATE company, tokenized anyway — and a 44-byte EIP-1167 clone.
  const EQUITIES = { SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    SPCX: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea" };
  const TRADEABLE = { CASHCAT: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
    PONS: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    AI_CLONE: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18" };
  let reachable = true;
  try { await readStorage(TRADEABLE.WETH, ERC1967_BEACON_SLOT); }
  catch { reachable = false; }

  if (!reachable) {
    console.log("  ..   chain unreachable, live assertions skipped (not silently passed)");
  } else {
    for (const [sym, addr] of Object.entries(EQUITIES)) {
      const r = await classifyToken(addr, readStorage, readName);
      ok(`${sym} is refused as a Stock Token`, r.tradeable === false && r.kind === "stock_token",
        r.beacon ?? r.kind);
    }
    for (const [sym, addr] of Object.entries(TRADEABLE)) {
      const r = await classifyToken(addr, readStorage, readName);
      ok(`${sym} is tradeable`, r.tradeable === true, `${r.kind} name=${JSON.stringify(r.name)}`);
    }
    /* The second signal, live: the equity's own name carries the marker; the clone's does not. */
    const spcxName = decodeAbiString(await readName(EQUITIES.SPCX));
    ok("SPCX names itself a Robinhood Token", classifyFromName(spcxName).equityByName === true, spcxName);
    const aiName = decodeAbiString(await readName(TRADEABLE.AI_CLONE));
    ok("the 44-byte clone does not", classifyFromName(aiName).equityByName === false, aiName);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
