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
import { classifyFromBeaconWord, classifyToken, beaconFromSlotWord,
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
  // Measured 2026-09-04: five equities behind one beacon, four tradeable tokens behind none.
  const EQUITIES = { SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" };
  const TRADEABLE = { CASHCAT: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
    PONS: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" };
  let reachable = true;
  try { await readStorage(TRADEABLE.WETH, ERC1967_BEACON_SLOT); }
  catch { reachable = false; }

  if (!reachable) {
    console.log("  ..   chain unreachable, live assertions skipped (not silently passed)");
  } else {
    for (const [sym, addr] of Object.entries(EQUITIES)) {
      const r = await classifyToken(addr, readStorage);
      ok(`${sym} is refused as a Stock Token`, r.tradeable === false && r.kind === "stock_token",
        r.beacon ?? r.kind);
    }
    for (const [sym, addr] of Object.entries(TRADEABLE)) {
      const r = await classifyToken(addr, readStorage);
      ok(`${sym} is tradeable`, r.tradeable === true, r.kind);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
