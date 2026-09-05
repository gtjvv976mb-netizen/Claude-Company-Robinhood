/**
 * THE EVM EVIDENCE — the rulers checked before anything is measured with them.
 *
 * Every read in src/data/evm.js and every kill in screen() is exercised here against a
 * case whose answer is already known: keccak against published vectors, clone detection
 * against the two minimal-proxy templates byte for byte, the equity test against the
 * beacon word GOOGL actually holds, and the bundle shape against the field list in
 * docs/EVIDENCE-CONTRACT.md — using gather() output RECORDED from the live chain on
 * 2026-09-05 (test-fixtures/gather-*-4663.json), so the shape test needs no network.
 *
 * The live section at the end runs only when the RPC answers, and says SKIP otherwise.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256, selector, topic, cloneTarget, cloneVariant, decodeString, decodeUint, decodeAddress, addressFromWord, topicAddress, toWei, fromWei, encodeCall,
  assemble, TRANSFER_PROBE_CODE, TOPIC_TRANSFER, TOPIC_UPGRADED, TOPIC_BEACON_UPGRADED, SLOT_IMPLEMENTATION, SLOT_BEACON, ZERO_ADDRESS } from "./src/lib/evm.js";
import { classifyKeyHolder, shapeHolders, mappingKey, OZ_ERC20_SLOT, erc7201Slot } from "./src/data/evm.js";
import { classifyFromBeaconWord, classifyFromName } from "./executor/scope-guard.mjs";
import { reconcile } from "./src/data/eth-usd.js";
import { isReadMethod } from "./src/lib/http.js";
import { screen, flowFrom } from "./src/data/evidence.js";
import { cfg } from "./src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nKECCAK-256 AGAINST PUBLISHED VECTORS");
{
  const empty = keccak256("");
  ok("keccak256(\"\")", empty === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", empty);
  const bu = keccak256("BeaconUpgraded(address)");
  ok("keccak256(\"BeaconUpgraded(address)\")", bu === "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e", bu);
  ok("Transfer topic", topic("Transfer(address,address,uint256)") === TOPIC_TRANSFER);
  ok("Upgraded topic", topic("Upgraded(address)") === TOPIC_UPGRADED && TOPIC_BEACON_UPGRADED === bu);
  ok("owner() selector", selector("owner()") === "0x8da5cb5b");
  ok("paused() selector", selector("paused()") === "0x5c975abb");
  ok("PONS curve selectors", selector("quoteToken()") === "0x217a4b70" && selector("token()") === "0xfc0c546a" && selector("approvedPairTokens(address)") === "0x9831705e");
  // Longer than one rate block (136 bytes) exercises the multi-block absorb.
  const long = keccak256("a".repeat(200));
  ok("a 200-byte message hashes to 32 bytes", /^0x[0-9a-f]{64}$/.test(long) && long !== empty, long.slice(0, 18) + "…");
  ok("the ERC-1967 slots are keccak-1 of their labels",
    "0x" + (BigInt(keccak256("eip1967.proxy.implementation")) - 1n).toString(16) === SLOT_IMPLEMENTATION
    && "0x" + (BigInt(keccak256("eip1967.proxy.beacon")) - 1n).toString(16) === SLOT_BEACON);
  ok("the ERC-7201 ERC20 namespace slot matches the one GOOGL read back from (measured 2026-09-05)",
    OZ_ERC20_SLOT === "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00", OZ_ERC20_SLOT);
  ok("erc7201Slot ends in 00 (the spec masks the low byte)", /00$/.test(erc7201Slot("x.y")));
}

console.log("\nABI HELPERS");
{
  const name = "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000084361736820436174000000000000000000000000000000000000000000000000";
  ok("decodeString reads CASHCAT's name() as recorded", decodeString(name) === "Cash Cat");
  ok("decodeString refuses a short return", decodeString("0x") === null && decodeString("0x01") === null);
  ok("decodeUint reads totalSupply 1e27", decodeUint("0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000") === 10n ** 27n);
  ok("decodeAddress right-aligns", decodeAddress("0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00") === "0xe10b6f6b275de231345c20d14ab812db62151b00");
  ok("addressFromWord treats zero as none", addressFromWord("0x" + "0".repeat(64)) === null && addressFromWord("0x0") === null);
  ok("...but topicAddress reads the zero word as the zero address (the from of every mint)", topicAddress("0x" + "0".repeat(64)) === ZERO_ADDRESS && topicAddress("0x" + "0".repeat(24) + "ab".repeat(20)) === "0x" + "ab".repeat(20));
  ok("encodeCall pads an address argument", encodeCall("balanceOf(address)", ["0x000000000000000000000000000000000000dEaD"]) === "0x70a08231" + "0".repeat(24) + "000000000000000000000000000000000000dead");
  ok("toWei is exact to 18 places", toWei("0.030554") === 30554000000000000n && toWei("1") === 10n ** 18n);
  ok("fromWei round-trips", Math.abs(fromWei(30554000000000000n) - 0.030554) < 1e-12);
  ok("mappingKey(addr, slot 0) is keccak(pad(addr).pad(0))",
    mappingKey("0x000000000000000000000000000000000000dead", 0) === keccak256(Buffer.from("0".repeat(24) + "000000000000000000000000000000000000dead" + "0".repeat(64), "hex")));
}

console.log("\nTHE TRANSFER PROBE'S BYTECODE");
{
  ok("assemble resolves a label to its offset", assemble(["JUMPDEST", ["PUSH1", "x"], "JUMPI", "x:", "JUMPDEST", "STOP"]) === "0x5b6004575b00");
  ok("assemble refuses an unknown op", (() => { try { assemble(["SELFDESTRUCT"]); return false; } catch { return true; } })());
  ok("assemble refuses an unresolved label", (() => { try { assemble([["PUSH1", "nowhere"]]); return false; } catch { return true; } })());
  // Pinned after being validated live on 2026-09-05: delta == amount on CASHCAT (1e18), GOOGL (1e18) and USDG (1e6).
  const pinned = "0x6370a0823160e01b600052602035600452602060a0602460006000355afa15607d5763a9059cbb60e01b600052602035600452604035602452600060006044600060006000355af115607d576370a0823160e01b60005260203560045260206080602460006000355afa15607d5760a0516080510360c052602060c0f35b60006000fd";
  ok("the probe assembles to the pinned 131 bytes", TRANSFER_PROBE_CODE === pinned, `${(TRANSFER_PROBE_CODE.length - 2) / 2} bytes`);
  const failAt = parseInt(pinned.slice(pinned.indexOf("607d57") + 2, pinned.indexOf("607d57") + 4), 16);
  ok("every failure branch jumps to the JUMPDEST at 0x7d", failAt === 0x7d && pinned.slice(2 + 0x7d * 2, 2 + 0x7d * 2 + 2) === "5b");
}

console.log("\nMINIMAL-PROXY CLONE DETECTION, BYTE FOR BYTE");
{
  const impl = "a125492aca28449d2291f5415a818697345cfa09";
  const std = "0x363d3d373d3d3d363d73" + impl + "5af43d82803e903d91602b57fd5bf3";
  const oage = "0x3d3d3d3d363d3d37363d73" + impl + "5af43d3d93803e602a57fd5bf3";
  ok("the 45-byte EIP-1167 template yields its implementation", cloneTarget(std) === "0x" + impl && cloneVariant(std) === "eip1167");
  ok("the 44-byte 0age template yields its implementation", cloneTarget(oage) === "0x" + impl && cloneVariant(oage) === "0age");
  ok("upper-case hex is accepted", cloneTarget(oage.toUpperCase().replace("0X", "0x")) === "0x" + impl);
  ok("a template with one extra byte is NOT a clone", cloneTarget(oage + "00") === null);
  ok("a template with a byte changed is NOT a clone", cloneTarget(oage.replace("5af43d3d", "5af43d3e")) === null);
  // CASHCAT's real runtime code prefix (recorded 2026-09-05): a full contract, not a clone.
  ok("a real full contract is not a clone", cloneTarget("0x60806040526004361015610011575f80fd5b5f3560e01c806306fdde03146108e1") === null);
  ok("GOOGL's 283-byte beacon proxy is not a clone", cloneTarget("0x6080604052600a600c565b005b60186014601a565b609d565b565b5f7f000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00") === null);
}

console.log("\nTHE EQUITY TEST, ON THE WORDS THE CHAIN ACTUALLY HOLDS");
{
  const googlWord = "0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00";
  const empty = "0x" + "0".repeat(64);
  ok("GOOGL's beacon word is a Stock Token", classifyFromBeaconWord(googlWord).kind === "stock_token");
  ok("CASHCAT's empty beacon word is plain", classifyFromBeaconWord(empty).tradeable === true);
  ok("an unknown beacon is refused, not waved through", classifyFromBeaconWord("0x" + "0".repeat(24) + "ab".repeat(20)).kind === "unknown_beacon");
  ok("the name marker fires on GOOGL's recorded name()", classifyFromName("Alphabet Class A • Robinhood Token").equityByName === true);
  ok("...and not on Cash Cat", classifyFromName("Cash Cat").equityByName === false);
  ok("an EOA holding the upgrade key is called an EOA", classifyKeyHolder({ address: "0x" + "1".repeat(40), code: "0x" }).kind === "eoa");
  ok("a timelock is called a timelock with its delay", classifyKeyHolder({ address: "0x" + "1".repeat(40), code: "0x6080", minDelay: 86400n }).delaySec === 86400);
  ok("a Safe is called a multisig", classifyKeyHolder({ address: "0x" + "1".repeat(40), code: "0x6080", threshold: 2n }).kind === "multisig");
  ok("no key is none", classifyKeyHolder({ address: null }).kind === "none");
}

console.log("\nTHE READ ALLOWLIST");
{
  for (const m of ["eth_call", "eth_getCode", "eth_getStorageAt", "eth_getLogs", "eth_blockNumber", "eth_gasPrice", "eth_getBalance", "eth_getTransactionCount", "eth_getBlockByNumber", "eth_chainId"])
    ok(`${m} is a read`, isReadMethod(m));
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4", "debug_traceTransaction"])
    ok(`${m} is refused`, !isReadMethod(m));
}

console.log("\nHOLDERS FROM A LEDGER, WITH KNOWN ANSWERS");
{
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40), P = "0x" + "d".repeat(40), DEAD = "0x000000000000000000000000000000000000dead";
  const h = shapeHolders(new Map([[A, 300n], [B, 200n], [C, 100n], [P, 350n], [DEAD, 50n]]), { supply: 1000n, exclude: [{ address: P, label: "pool:uniswap-v4" }] });
  ok("the pool is excluded by label and its share reported", h.excluded.some((e) => e.label === "pool:uniswap-v4" && e.pctOfSupply === 35));
  ok("poolShareOfSupplyPct counts pool-labelled exclusions only", h.poolShareOfSupplyPct === 35, `${h.poolShareOfSupplyPct}%`);
  ok("burn is excluded and counted as burned", h.burnedPct === 5);
  ok("top1 is the largest REMAINING holder", h.top1Pct === 30, `${h.top1Pct}%`);
  ok("top10 sums the rest", h.top10Pct === 60, `${h.top10Pct}%`);
  ok("count is holders, not addresses", h.count === 3);
  const bundle = shapeHolders(new Map([["0x1".padEnd(42, "1"), 100n], ["0x2".padEnd(42, "2"), 101n], ["0x3".padEnd(42, "3"), 99n], ["0x4".padEnd(42, "4"), 102n], ["0x5".padEnd(42, "5"), 5n]]), { supply: 10_000n });
  ok("four near-identical balances read as a bundle", bundle.bundleSuspect === true && bundle.clusteredHolders === 4, `${bundle.clusteredHolders} clustered`);
  ok("no supply is no answer", shapeHolders(new Map(), { supply: 0n }).ok === false);
}

console.log("\nETH/USD RECONCILIATION");
{
  ok("two sources 0.016% apart agree", reconcile({ cgUsd: 2451.61, kyberUsd: 2452.0, cgAt: Date.now() - 5000, now: Date.now() }).ok === true);
  const bad = reconcile({ cgUsd: 2451.61, kyberUsd: 2600, cgAt: Date.now(), now: Date.now() });
  ok("6% apart is refused, not averaged", bad.ok === false && bad.source === "disputed" && bad.value === null, bad.error);
  ok("CoinGecko alone is single-source, not disputed", reconcile({ cgUsd: 2451.61, kyberUsd: null, cgAt: Date.now(), now: Date.now() }).source === "coingecko_only");
  ok("nothing is nothing", reconcile({ cgUsd: null, kyberUsd: null }).ok === false);
  ok("staleness is measured against the CoinGecko stamp", reconcile({ cgUsd: 2451.61, kyberUsd: 2452.0, cgAt: Date.now() - 45_000, now: Date.now() }).stalenessSec === 45);
}

console.log("\nFLOW STATISTICS");
{
  const f = flowFrom([{ wallet: "a", side: "buy", usd: 100, at: 1000, block: 1 }, { wallet: "a", side: "sell", usd: 100, at: 2000, block: 1 }, { wallet: "b", side: "buy", usd: 50, at: 4000, block: 2 }]);
  ok("unique traders", f.uniqueTraders === 2);
  ok("round-trip wallet share is by dollars", f.roundTripWalletPct === 80, `${f.roundTripWalletPct}%`);
  ok("same-block share", Math.abs(f.sameBlockTradePct - 66.7) < 0.01, `${f.sameBlockTradePct}%`);
  ok("an empty tape reports nulls, not zeros", flowFrom([]).uniqueTraders === null);
}

console.log("\nTHE RECORDED BUNDLE CARRIES EVERY FIELD THE CONTRACT NAMES");
const cashcat = JSON.parse(fs.readFileSync(new URL("./test-fixtures/gather-cashcat-4663.json", import.meta.url), "utf8"));
const googl = JSON.parse(fs.readFileSync(new URL("./test-fixtures/gather-googl-4663.json", import.meta.url), "utf8"));
{
  const doc = fs.readFileSync(new URL("./docs/EVIDENCE-CONTRACT.md", import.meta.url), "utf8");
  const fields = [...doc.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  ok("the contract table was parsed", fields.length >= 50, `${fields.length} rows`);
  const paths = fields.flatMap((f) => f.split(/ and | \/ /).map((s) => s.trim()).filter(Boolean));
  const has = (obj, path) => {
    let cur = obj;
    // `xRead.*` in the table means "the xRead block, whatever keys the read returned".
    for (const seg of path.replace(/^evidence\./, "").replace(/\.\*$/, "").split(".")) {
      if (cur == null || typeof cur !== "object") return false;
      const key = seg.replace(/\[\]$/, "");
      if (!(key in cur)) return false;
      cur = cur[key];
      if (/\[\]$/.test(seg)) { if (!Array.isArray(cur) || !cur.length) return false; cur = cur[0]; }
    }
    return true;
  };
  const missing = paths.filter((p) => !has(cashcat, p));
  ok("every contract key path resolves on the recorded CASHCAT bundle", missing.length === 0, missing.length ? "missing: " + missing.join(", ") : `${paths.length} paths`);
  const missingG = paths.filter((p) => !has(googl, p));
  ok("...and on the recorded GOOGL bundle", missingG.length === 0, missingG.length ? "missing: " + missingG.join(", ") : `${paths.length} paths`);
  ok("evidence.address is the 0x address and mint is its alias", cashcat.address === "0x020bfc650a365f8bb26819deaabf3e21291018b4" && cashcat.mint === cashcat.address && cashcat.token === cashcat.address);
  ok("the chain is 4663", cashcat.chainId === 4663);
  ok("candles are oldest-first", cashcat.candles.bars.length > 2 && cashcat.candles.bars[0].t < cashcat.candles.bars.at(-1).t, `${cashcat.candles.bars.length} bars, ${cashcat.candles.barsCovered} covered`);
  ok("the exit probe is in wei and carries gas in dollars", typeof cashcat.exitProbe.quoteAmountWei === "string" && cashcat.exitProbe.gasUsdRoundTrip > 0, `$${cashcat.exitProbe.gasUsdRoundTrip} gas on a $${cashcat.exitProbe.targetSizeUsd} probe`);
  ok("ETH/USD was cross-checked", cashcat.ethUsd.source === "coingecko+kyber" && cashcat.ethUsd.divergencePct < 2, `$${cashcat.ethUsd.value} (${cashcat.ethUsd.divergencePct}% apart)`);
  ok("the sell was SIMULATED, not quoted, at the sequential slot 0", cashcat.sellSim.ok === true && cashcat.sellSim.status === "simulated" && cashcat.sellSim.slot === 0, `slot ${cashcat.sellSim.slot}, route gap ${cashcat.sellSim.effectiveTaxBps}bps`);
  ok("the transfer ruler reads 0 bps on a no-fee token, whatever the route gap said", cashcat.sellSim.transferFeeBps === 0 && cashcat.contract.transferFeeBps === 0 && cashcat.contract.taxsellFeeBps === 0 && cashcat.contract.tax.simulated === true,
    `transfer ${cashcat.sellSim.transferFeeBps}bps vs route gap ${cashcat.sellSim.routeGapBps}bps`);
  ok("the route gap is reported separately, never folded into the fee", cashcat.contract.tax.sellRouteGapBps === cashcat.sellSim.routeGapBps && "buyRouteGapBps" in cashcat.contract.tax);
  ok("pools carry pairToken and the contract's class vocabulary", cashcat.pairs.pools.every((p) => p.pairToken === p.quoteAddress && ["native", "weth", "stable", "allowed_equity", "equity_unlisted", "other", null].includes(p.pairTokenClass)), cashcat.pairs.pools.map((p) => p.pairTokenClass).join(","));
  ok("the deepest CASHCAT pool is WETH-quoted and allowed", cashcat.pairs.pools[0].pairTokenClass === "weth" && cashcat.pairs.pools[0].pairAllowed === true);
  ok("GOOGL's deepest pool is USDG-quoted (stable)", googl.pairs.pools[0].pairTokenClass === "stable");
  ok("the planned creator-fee rows are null WITH a reason, not zero", cashcat.launch.creatorTaxBps === null && typeof cashcat.launch.creatorFeeReason === "string");
  ok("lp.kind uses the contract's vocabulary", ["v2_lp_tokens", "v3_position", "v4_position", "curve", "unknown"].includes(cashcat.lp.kind), cashcat.lp.kind);
  ok("GOOGL carries the equity flag and the live pause flag", googl.contract.flags.some((f) => f.flag === "equity_token") && googl.contract.flags.some((f) => f.flag === "pausable_live"));
  ok("an old token's holders are UNVERIFIED, not invented", cashcat.holders.ok === false && /scan budget/.test(cashcat.holders.error));
  ok("...but the pool share is still read directly", cashcat.holders.poolShareOfSupplyPct > 0, `${cashcat.holders.poolShareOfSupplyPct}% in ${cashcat.holders.excluded.length} pools`);
  ok("GOOGL is an equity behind the known beacon", googl.contract.isEquity === true && googl.contract.proxyKind === "erc1967_beacon" && googl.contract.beacon === "0xe10b6f6b275de231345c20d14ab812db62151b00");
  ok("GOOGL's balance slot is the ERC-7201 namespace", googl.sellSim.slot === OZ_ERC20_SLOT);
  ok("GOOGL's pools are classed by quote", googl.pairs.pools.every((p) => typeof p.pairTokenClass === "string"));
}

console.log("\nSCREEN(): EVERY NEW KILL FIRES ON ITS FLAG, AND ONLY ON ITS FLAG");
{
  const clone = () => JSON.parse(JSON.stringify(cashcat));
  /* A base that PASSES: the recorded bundle is too big for the board and its ledger is
     older than the scan budget, so both are set to values inside the floors. */
  const clean = () => {
    const ev = clone();
    ev.pair.marketCap = ev.pair.fdv = 400_000;
    ev.holders = { ok: true, top1Pct: 3.1, top10Pct: 14, count: 900, clusteredHolders: 1, bundleSuspect: false, excluded: [], poolShareOfSupplyPct: 3 };
    return ev;
  };
  const kills = (ev) => screen(ev).fails.map((f) => f.code);
  const base = kills(clean());
  ok("the cleaned recorded bundle passes the screen", base.length === 0, base.join(", ") || "clean");
  ok("the recorded CASHCAT bundle is refused for size and unverified holders", (() => { const k = kills(cashcat); return k.includes("too_big") && k.includes("unverified_holders"); })(), kills(cashcat).join(", "));
  ok("the recorded GOOGL bundle is KILLED as an equity", kills(googl).includes("equity"), kills(googl).join(", "));

  /* Each case names the EXACT set of kills. The screen's own codes and the rails'
     (risk-rails.js evmGateFailures: live_authority, unverified_code, not_graduated,
     graduated_too_recently, pair_token_gate) both appear where both fire — that is
     the point of running one definition in both places. */
  const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const flagKill = (flag, codes) => { const ev = clean(); ev.contract.flags = [{ flag, detail: "test" }]; const k = kills(ev); ok(`${flag} → ${codes.join(" + ")}`, same(k, codes), k.join(", ")); };
  flagKill("mint_role_live", ["live_mint_role", "live_authority"]);
  flagKill("paused_now", ["paused"]);
  flagKill("pausable_live", ["live_pause", "live_authority"]);
  flagKill("blacklist", ["blacklist_present", "live_authority"]);
  flagKill("transfer_blocked", ["transfer_blocked"]);
  flagKill("upgradeable_eoa", ["upgrade_key_eoa", "live_authority"]);
  flagKill("equity_token", ["equity"]);
  flagKill("unknown_beacon", ["unknown_beacon"]);
  flagKill("upgraded", ["upgraded_recently"]);

  const one = (name, mutate, codes) => { const ev = clean(); mutate(ev); const k = kills(ev); ok(`${name} → ${codes.join(" + ")}`, same(k, codes), k.join(", ")); };
  one("an unsimulated sell", (ev) => { ev.sellSim = { ok: false, unverified: true, reason: "no slot" }; }, ["unverified_sellsim", "unverified_code"]);
  one("a reverting sell", (ev) => { ev.sellSim = { ok: false, revertReason: "execution reverted" }; }, ["sellsim_reverted", "unverified_code"]);
  one("no sellSim at all", (ev) => { delete ev.sellSim; }, ["unverified_sellsim"]);
  one("a 12% route gap on the sell", (ev) => { ev.sellSim.effectiveTaxBps = 1200; }, ["sell_tax"]);
  one("an unreadable contract", (ev) => { ev.contract = { error: "429" }; }, ["unverified_contract"]);
  one("no contract block at all", (ev) => { delete ev.contract; }, ["unverified_contract"]);
  one("an unverified ledger", (ev) => { ev.holders = { ok: false, error: "budget" }; }, ["unverified_holders"]);
  one("no round trip", (ev) => { ev.exitProbe = { targetSizeUsd: 75, error: "no route" }; }, ["unverified_exit"]);
  one("no ETH/USD", (ev) => { ev.ethUsd = { value: null, error: "disputed" }; }, ["unverified_eth_usd"]);
  one("a pullable v2 LP", (ev) => { ev.lp = { kind: "v2_lp_tokens", pullableSharePct: 61 }; }, ["lp_pullable"]);
  one("a v3 position is not judged by the v2 rule", (ev) => { ev.lp = { kind: "v3_position", pullableSharePct: 100 }; }, []);
  one("a pool quoted in an unlisted equity", (ev) => { ev.pairs.pools[0].pairAllowed = false; ev.pairs.pools[0].pairTokenClass = "equity_unlisted"; ev.pair.pairAddress = ev.pairs.pools[0].address; }, ["pair_token_unallowed", "pair_token_gate"]);
  one("a pool whose quote class could not be read", (ev) => { ev.pairs.pools[0].pairAllowed = false; ev.pairs.pools[0].pairTokenClass = null; ev.pair.pairAddress = ev.pairs.pools[0].address; }, ["pair_token_unallowed", "unverified_pair_token"]);
  one("no pools at all", (ev) => { ev.pairs.pools = []; }, ["unverified_pair_token"]);
  one("a coin still on its curve", (ev) => { ev.launch.onCurve = true; ev.launch.phase = "curve"; }, ["on_curve", "not_graduated"]);
  one("a launch of unknown phase", (ev) => { ev.launch.phase = "unknown"; }, ["not_graduated"]);
  one("no launch block at all", (ev) => { delete ev.launch; }, ["unverified_launch_phase"]);
  one("a pool that graduated sixty seconds ago", (ev) => { ev.launch.graduatedAt = Date.now() - 60_000; }, ["graduated_too_recently"]);
  one("a launch that handed 30% of supply out in its own transaction", (ev) => { ev.launch.exemptShareOfSupplyPct = 30; }, ["insider_float"]);
  one("one wallet holding 60%", (ev) => { ev.holders.top1Pct = 60; }, ["holder_concentration"]);
  one("a round trip over the ceiling", (ev) => { ev.exitProbe.roundTripLossPct = cfg.maxRoundTripSlippagePct + 1; }, ["cannot_exit"]);
  one("a disputed mark", (ev) => { ev.crosscheck = { verdicts: [{ verdict: "KILLED", check: "price_disputed", detail: "x" }] }; }, ["price_disputed"]);
  ok("a 20% exempt share is the boundary, not a kill", (() => { const ev = clean(); ev.launch.exemptShareOfSupplyPct = 20; return kills(ev).length === 0; })());
  ok("the screen does not throw on a bundle missing lp and launch (test-mcap's shape)", (() => { const ev = clean(); delete ev.lp; delete ev.launch; try { screen(ev); return true; } catch { return false; } })());
}

console.log("\nLIVE (skipped honestly when the RPC does not answer)");
{
  let live = false;
  try {
    const r = await fetch(cfg.rhRpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(6000) });
    live = (await r.json())?.result === "0x1237";
  } catch {}
  if (!live) console.log("  SKIP no RPC — live gather() not run");
  else {
    const { gather } = await import("./src/data/evidence.js");
    const t0 = Date.now();
    const ev = await gather("0x020bfc650a365f8bb26819deaabf3e21291018b4", "probe");
    ok("gather(CASHCAT) completes", ev.ok === true, `${Date.now() - t0}ms; ${ev.error ?? ""}`);
    if (ev.ok) {
      console.log("  bundle keys: " + Object.keys(ev).join(", "));
      console.log(`  sellSim: ok=${ev.sellSim.ok} routeGap=${ev.sellSim.effectiveTaxBps}bps transferFee=${ev.sellSim.transferFeeBps}bps slot=${ev.sellSim.slot} revert=${ev.sellSim.revertReason}`);
      if (ev.sellSim.transferFeeBps == null && /429|timeout|fetch failed|ECONN/i.test(String(ev.contract?.tax?.reason ?? ev.sellSim?.revertReason ?? "")))
        console.log("  ..   the transfer ruler was rate-limited (HTTP 429) — live assertion skipped, not passed");
      else
        ok("the transfer ruler reads 0 bps on CASHCAT live", ev.sellSim.transferFeeBps === 0, `${ev.sellSim.transferFeeBps}bps`);
      const E = await import("./src/data/evm.js");
      const self = await E.transferSim("0x020bfc650a365f8bb26819deaabf3e21291018b4", 10n ** 18n, { recipient: E.PROBE_EOA });
      if (/429|timeout|fetch failed|ECONN/i.test(String(self.revertReason ?? "")))
        console.log("  ..   the self-transfer control was rate-limited (HTTP 429) — live assertion skipped, not passed");
      else
        ok("negative control: a self-transfer's delta is 0, so the ruler is measuring a delta and not echoing the amount", self.ok === false && self.received === "0", JSON.stringify({ sent: self.sent, received: self.received, reason: self.revertReason }));
      // The probe holds 1e18 by override and is asked to move 2e18: the token must revert, and the probe with it.
      const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
      const short = await E.read("eth_call", [{ to: E.PROBE_EOA, gas: "0xf4240",
        data: "0x" + "0".repeat(24) + CASHCAT.slice(2) + "0".repeat(24) + E.PROBE_RECIPIENT.slice(2) + (2n * 10n ** 18n).toString(16).padStart(64, "0") }, "latest",
        { [CASHCAT]: { stateDiff: { [E.mappingKey(E.PROBE_EOA, 0)]: "0x" + (10n ** 18n).toString(16).padStart(64, "0") } }, [E.PROBE_EOA]: { code: TRANSFER_PROBE_CODE } }], { attempts: 1 });
      ok("negative control: transferring more than the overridden balance REVERTS the probe", short.ok === false, String(short.error).slice(0, 80));
      console.log(`  exit: ${ev.exitProbe.roundTripLossPct}% pool, $${ev.exitProbe.gasUsdRoundTrip} gas at ${ev.gasPriceWei} wei, ETH $${ev.ethUsd.value} (${ev.ethUsd.source})`);
      ok("CASHCAT's sell simulates without revert", ev.sellSim.ok === true);
      ok("CASHCAT is not an equity", ev.contract.isEquity === false);
    }
    const g = await gather("0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", "probe");
    const k = g.ok ? screen(g).fails.map((f) => f.code) : [];
    ok("gather(GOOGL) completes and screen() KILLS it as an equity", g.ok && k.includes("equity"), k.join(", ") || g.error);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
