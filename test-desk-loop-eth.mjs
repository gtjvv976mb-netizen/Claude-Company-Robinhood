/**
 * THE LOOP RUNS ON ETH UNITS, PONS PHASES AND 100 MS BLOCKS.
 *
 * What changed on 2026-09-05 when the desk loop was pointed at chain 4663, asserted
 * where it is deterministic: the phase gate (a curve coin is watched, never published),
 * one spelling per 0x address, the creator-sold tripwire keyed on the launchpad rather
 * than an address suffix, the naming-race stop-words, the slip links, and the pure
 * receipt readers perf.js and passes.js now use instead of Solana balance deltas.
 */
import { canonicalAddress, isEvmAddress, isEvmTxHash } from "./src/canonical.js";
import { openCall, liveCallFor, closeCall, CURVE_LAUNCHPADS } from "./src/calls.js";
import { eligibility } from "./src/mandate.js";
import { wouldSurviveScreen, launchPhaseOf, namingRaces, trendHandoff, contractFlags, CYCLE_BUDGET_USD as PENT_BUDGET }
  from "./src/penthouse.js";
import { CYCLE_BUDGET_USD } from "./src/lib/llm.js";
import { runtimeBehaviorProfile } from "./src/evaluation.js";
import { orderLinks, pairLegOf, routeSummary, WETH, USDG } from "./src/order.js";
import { readFill, transfersIn } from "./src/perf.js";
import { tokenDeltas } from "./src/passes.js";
import { TRANSFER_TOPIC } from "./src/treasury-evm.js";
import { PREFERRED_PAD } from "./src/categories.js";
import { dueForStudy } from "./src/funnel.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const addr = (b) => "0x" + b.toString(16).padStart(2, "0").repeat(20);
const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const hex = (n) => "0x" + BigInt(n).toString(16);

console.log("\nONE SPELLING PER ADDRESS");
{
  const mixed = "0xAbCdEf0000000000000000000000000000000002";
  ok("an EIP-55 address canonicalises to lowercase", canonicalAddress(mixed) === mixed.toLowerCase());
  ok("a base58 string is left alone", canonicalAddress("Mint0111111111111111111111111111111111") === "Mint0111111111111111111111111111111111");
  ok("address and hash shapes are told apart", isEvmAddress(mixed) && !isEvmTxHash(mixed) && isEvmTxHash("0x" + "ab".repeat(32)));
  for (const c of [liveCallFor(mixed)]) if (c) closeCall(c.id, "reset", 1);
  const c1 = openCall({ mint: mixed, symbol: "CASE", category: "memecoin", entryRef: 1, stop: 0.8, target: 2 });
  ok("a call is stored lowercase", c1?.mint === mixed.toLowerCase(), c1?.mint);
  ok("...and is found from any spelling", liveCallFor(mixed.toUpperCase().replace("0X", "0x"))?.id === c1.id);
  const dup = openCall({ mint: mixed.toLowerCase(), symbol: "CASE", category: "memecoin", entryRef: 1, stop: 0.8, target: 2 });
  ok("the same coin spelled differently cannot open a second live call", dup === null);
  closeCall(c1.id, "reset", 1);
}

console.log("\nTHE CREATOR-SOLD TRIPWIRE IS KEYED ON THE LAUNCHPAD, NOT AN ADDRESS SUFFIX");
{
  ok("the curve pads are the contract's", JSON.stringify(CURVE_LAUNCHPADS) === JSON.stringify(["pons-v2", "pons", "hoodit", "pools.trade", "bankr"]));
  const base = { symbol: "TW", category: "memecoin", entryRef: 1, stop: 0.8, target: 2, invalidation: "the story dies" };
  const pons = openCall({ ...base, mint: addr(0x11), launchpad: "pons-v2" });
  ok("a PONS call gains the creator tripwire", /creator wallet sells/.test(pons?.invalidation ?? ""), pons?.invalidation);
  const uni = openCall({ ...base, mint: addr(0x12), launchpad: "uniswap" });
  ok("a plain Uniswap listing does not", uni?.invalidation === "the story dies", uni?.invalidation);
  const suffix = openCall({ ...base, mint: "SomeMintEndingInpump", launchpad: null });
  ok("an address ending in 'pump' no longer triggers anything", suffix?.invalidation === "the story dies", suffix?.invalidation);
  for (const c of [pons, uni, suffix]) if (c) closeCall(c.id, "reset", 1);
}

console.log("\nTHE PHASE GATE — A CURVE COIN IS WATCHED, NEVER PUBLISHED");
{
  const healthy = (over = {}) => ({ mint: addr(0x21), pair: { marketCap: 40_000, liquidityUsd: 9_000, volume: { h24: 50_000 },
    txns: { h24: { buys: 400, sells: 200 } }, ageHours: 5, priceChange: {} }, ...over });
  ok("launch.phase is read first", launchPhaseOf({ launch: { phase: "curve" } }) === "curve" &&
    launchPhaseOf({ phase: "graduated" }) === "graduated" && launchPhaseOf({ onCurve: true }) === "curve" && launchPhaseOf({}) === null);
  ok("a healthy coin still on its curve is held as on_curve", wouldSurviveScreen(healthy({ launch: { phase: "curve" } })) === "on_curve");
  ok("...so is one the sweep flags onCurve", wouldSurviveScreen(healthy({ onCurve: true })) === "on_curve");
  ok("a graduated one passes", wouldSurviveScreen(healthy({ launch: { phase: "graduated" } })) === null);
  ok("no phase at all passes the FREE screen (judged on the paid bundle instead)", wouldSurviveScreen(healthy()) === null);
  const dead = healthy({ launch: { phase: "curve" } }); dead.pair.volume.h24 = 100;
  ok("a dead-tape curve coin is reported for its tape, not its phase", wouldSurviveScreen(dead) === "no_volume");

  const rec = (phase) => ({ mint: addr(0x22), symbol: "PH", outcome: "ok", finalDecision: "APPROVED",
    pm: { decision: "PROPOSE", invalidation: "x", conviction: 70 }, redteam: { verdict: "survived" },
    ticket: { stop_price: 0.8 }, order: { size: 10 },
    ev: { pair: { priceUsd: 1, priceChange: { m5: 0 } }, band: "micro", ...(phase === undefined ? {} : { launch: { phase } }) } });
  const curve = eligibility(rec("curve"));
  ok("mandate: a curve coin is refused as a SAFETY fact", !curve.eligible && curve.safety === true, curve.reason);
  const unknown = eligibility(rec("unknown"));
  ok("mandate: an unknown phase is refused too — unverified is not graduated", !unknown.eligible && unknown.safety === true, unknown.reason);
  ok("mandate: a graduated coin is eligible", eligibility(rec("graduated")).eligible === true);
  ok("mandate: an absent phase is not refused here (UNVERIFIED until the data lane fills it)", eligibility(rec(undefined)).eligible === true);
  const th = await trendHandoff([{ mint: addr(0x23), symbol: "TR", theme: "cats", launch: { phase: "curve" } }]);
  ok("the trend lane will not pay for a curve coin", th.workedUp === 0 && /curve/.test(th.note ?? ""), th.note);
}

console.log("\nTHE CHAIN'S OWN NOUNS ARE NOT A THEME");
{
  const coin = (i, name, sym) => ({ mint: addr(0x30 + i), pair: { ageHours: 2, liquidityUsd: 1000 * (i + 1), baseName: name, baseSymbol: sym } });
  const races = namingRaces([coin(0, "Hood Cat", "HCAT"), coin(1, "Robinhood Cat", "RCAT"), coin(2, "Pons Cat", "PCAT"), coin(3, "Cat ETH", "CETH"),
    coin(4, "Hood Dog", "HDOG")]);
  ok("four cats in two hours is a race about cats, not about 'hood' or 'pons' or 'eth'",
    races.get(addr(0x30))?.theme === "cat" && races.get(addr(0x33))?.theme === "cat", races.get(addr(0x30))?.theme);
  ok("the lone dog is in no race", !races.has(addr(0x34)));
  ok("the deepest book leads the race", races.get(addr(0x33))?.leader === true && races.get(addr(0x30))?.leader === false);
}

console.log("\nONE CYCLE BUDGET, ONE PAD, ONE RPC NAME");
{
  ok("penthouse re-exports llm.js's CYCLE_BUDGET_USD", PENT_BUDGET === CYCLE_BUDGET_USD, `$${PENT_BUDGET}`);
  const prof = runtimeBehaviorProfile();
  ok("the behaviour profile records that same number", prof.runtimeKnobs.cycleBudgetUsd === CYCLE_BUDGET_USD);
  ok("the profile fingerprints RH_RPC, not SOLANA_RPC", "secondaryRpc" in prof.runtimeKnobs && prof.runtimeKnobs.customRpc === Boolean(process.env.RH_RPC));
  ok("the preferred pad is PONS V2 and the funnel's study pick defaults to it", PREFERRED_PAD === "pons-v2" && "pons-v2" in dueForStudy(1).padMix,
    JSON.stringify(dueForStudy(1).padMix));
  const cf = contractFlags({ contract: { flags: [{ flag: "pausable_live" }, "blacklist"] } });
  ok("chain flags come from contract.flags", cf.readable && cf.flags.join(",") === "pausable_live,blacklist");
  ok("a bundle with neither contract nor mintAccount is UNREADABLE, not flagless", contractFlags({}).readable === false);
}

console.log("\nTHE SLIP LINKS TO THIS CHAIN, AND NAMES THE PAIR LEG");
{
  const a = "0xAbCdEf0000000000000000000000000000000003", pool = "0xDeAdBeEf00000000000000000000000000000004";
  const l = orderLinks(a, pool);
  ok("Blockscout token page", l.blockscout === `https://robinhoodchain.blockscout.com/token/${a.toLowerCase()}`);
  ok("DexScreener robinhood pool", l.dexscreener === `https://dexscreener.com/robinhood/${pool.toLowerCase()}`);
  ok("GeckoTerminal robinhood pool", l.geckoterminal === `https://www.geckoterminal.com/robinhood/pools/${pool.toLowerCase()}`);
  ok("no pool: GeckoTerminal is omitted rather than guessed", orderLinks(a).geckoterminal === null);
  const leg = pairLegOf({ pairs: { pools: [{ pairToken: USDG }] } });
  ok("a USDG leg is named with 6 decimals", leg?.symbol === "USDG" && leg?.decimals === 6, JSON.stringify(leg));
  const wleg = pairLegOf({ pair: { quoteToken: { address: WETH, symbol: "WETH" } } });
  ok("a WETH leg from the pair", wleg?.symbol === "WETH" && wleg?.decimals === 18);
  ok("no pair token in the bundle: null, never a guess", pairLegOf({}) === null);
  ok("a route summary names the venue hops",
    /uniswap-v4/.test(routeSummary({ exitProbe: { route: [{ exchange: "uniswap-v4", pool }] } })), routeSummary({ exitProbe: { route: [{ exchange: "uniswap-v4", pool }] } }));
}

console.log("\nFILLS ARE READ FROM TRANSFER LOGS, NOT SOLANA BALANCE DELTAS");
{
  const wallet = addr(0x41), token = addr(0x42), router = addr(0x43);
  const log = (tk, from, to, value) => ({ address: tk, topics: [TRANSFER_TOPIC, word(from), word(to)], data: hex(value) });
  const buy = { status: "0x1", logs: [log(USDG, wallet, router, 6_000_000n), log(token, router, wallet, 1_000n)] };
  const f = readFill(buy, wallet, token, 2_450);
  ok("a 6 USDG buy is a buy priced at $6", f?.side === "buy" && f.quoteUsd === 6 && f.tokenUnits === "1000", JSON.stringify(f));
  const sell = { status: "0x1", logs: [log(token, wallet, router, 1_000n), log(WETH, router, wallet, 2_000_000_000_000_000n)] };
  const s = readFill(sell, wallet, token, 2_450);
  ok("a 0.002 WETH sell is priced through ETH/USD", s?.side === "sell" && Math.abs(s.quoteUsd - 4.9) < 0.001, JSON.stringify(s));
  const voided = readFill({ status: "0x0", logs: [] }, wallet, token, 2_450);
  ok("a voided receipt (ArbOS 61: status 0x0) is no fill", voided === null);
  const xfer = readFill({ status: "0x1", logs: [log(token, addr(0x44), wallet, 500n)] }, wallet, token, 2_450);
  ok("a bare token transfer is a transfer, never a sale to bill", xfer?.side === "transfer_in" && xfer.quoteUsd === null);
  const unpriced = readFill(sell, wallet, token, null);
  ok("no ETH/USD: an ETH-leg sell stays unpriced rather than priced at a guess", unpriced?.side === "transfer_out" && unpriced.quoteUsd === null);
  ok("every Transfer is decoded", transfersIn(buy).length === 2);
}

console.log("\nA GUEST PASS IS JUDGED ON THE TOKEN'S TRANSFER LOG");
{
  const token = addr(0x51), viewer = addr(0x52), owner = addr(0x53);
  const receipt = { status: "0x1", logs: [
    { address: token, topics: [TRANSFER_TOPIC, word(viewer), word(owner)], data: hex(250_000n * 10n ** 18n) },
    { address: addr(0x54), topics: [TRANSFER_TOPIC, word(viewer), word(owner)], data: hex(10n ** 30n) },   // some other token
  ] };
  const d = tokenDeltas(receipt, token);
  ok("the owner gained and the viewer lost exactly the pass, in this token only",
    d.get(owner) === 250_000n * 10n ** 18n && d.get(viewer) === -(250_000n * 10n ** 18n) && d.size === 2,
    `${d.get(owner)} / ${d.get(viewer)}`);
}

console.log("\nONE NAME PER LAUNCHPAD — THE SWEEP'S LABEL AND THE DESK'S CONSTANT MUST MEET");
{
  const { canonicalLaunchpad } = await import("./src/canonical.js");
  const { selectAcrossBoard } = await import("./src/categories.js");
  const { isCurveLaunchpad } = await import("./src/calls.js");
  const { launchpad } = await import("./src/market.js");
  const sweepSays = launchpad(addr(0x60), "pons-v2");
  ok("market.js labels a pons-v2 dex id as its own id (this is the label calls carry)", typeof sweepSays === "string", sweepSays);
  ok("...and that label canonicalises to the constant the quota is keyed on",
    canonicalLaunchpad(sweepSays) === PREFERRED_PAD, `${sweepSays} -> ${canonicalLaunchpad(sweepSays)} vs PREFERRED_PAD ${PREFERRED_PAD}`);
  ok("every dialect of PONS V2 lands on pons-v2", ["pons", "pons-v2", "pons-v2-dex", "PONS"].every((l) => canonicalLaunchpad(l) === "pons-v2"));
  ok("the V1 dialects land on pons", ["pons-v1", "pons-dot-family"].every((l) => canonicalLaunchpad(l) === "pons"));
  ok("hood.fun and hoodit are one pad", canonicalLaunchpad("hood.fun") === "hoodit" && canonicalLaunchpad("hood-fun") === "hoodit");
  ok("a plain Uniswap pool is 'uniswap', unknown is null, an unforeseen pad keeps its name",
    canonicalLaunchpad("uniswap-v4-robinhood") === "uniswap" && canonicalLaunchpad("unknown") === null && canonicalLaunchpad(null) === null &&
    canonicalLaunchpad("NewPad") === "newpad");
  ok("the creator tripwire fires on the sweep's own label", isCurveLaunchpad("pons") && isCurveLaunchpad("hood.fun") && !isCurveLaunchpad("uniswap") && !isCurveLaunchpad(null));

  // A board built from what the sweep emits: two cells, PONS coins labelled "pons".
  const coin = (i, pad) => ({ mint: addr(0x70 + i), launchpad: pad, pair: { liquidityUsd: 1000 } });
  const board = { cells: [
    { key: "micro/meme", band: "micro", type: "meme", coins: [coin(0, "uniswap"), coin(1, "pons")] },
    { key: "low/meme", band: "low", type: "meme", coins: [coin(2, "pons"), coin(3, "hood.fun")] },
  ] };
  const picked = selectAcrossBoard(board, 2, { padQuota: 1, pad: PREFERRED_PAD });
  ok("with the quota at 1 the board pick takes ONLY the sweep's 'pons' coins (before the alias table it took none)",
    picked.length === 2 && picked.every((c) => c.launchpad === "pons") && picked.padMix?.[PREFERRED_PAD] === 2,
    JSON.stringify(picked.map((c) => [c.mint.slice(0, 6), c.launchpad])) + " " + JSON.stringify(picked.padMix));
  const stored = openCall({ mint: addr(0x71), symbol: "PV", category: "memecoin", launchpad: "pons", entryRef: 1, stop: 0.8, target: 2, invalidation: "x" });
  ok("a call opened with the sweep's label is stored under the contract's id and gets the tripwire",
    stored?.launchpad === "pons-v2" && /creator wallet sells/.test(stored?.invalidation ?? ""), `${stored?.launchpad} · ${stored?.invalidation}`);
  if (stored) closeCall(stored.id, "reset", 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
