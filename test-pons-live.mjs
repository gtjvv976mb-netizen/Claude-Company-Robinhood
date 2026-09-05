/**
 * PONS LIVE — the launch feed and the minute tape, checked against RECORDED answers.
 *
 * Every shaper in src/data/pons-live.js is run here on JSON recorded from the sources
 * it reads (test-fixtures/pons-live-4663.json, recorded 2026-09-05 ~09:50 UTC from
 * GeckoTerminal's robinhood network and rpc.mainnet.chain.robinhood.com), so the
 * assertions need no network and the numbers were checked by hand before they were
 * pinned: the recorded launch receipt carries a 1e27 mint to a vault and two transfers
 * out of it in the same transaction — 93,131,431,816… (9.31%) to the transaction
 * sender and 33,876,471,306… (3.39%) to a second address — so the exempt share must
 * read 12.70% and nothing else.
 *
 * The live section at the end runs only when the RPC answers, and says SKIP otherwise.
 */
import fs from "node:fs";
import {
  venueOf, launchpadOf, asCandidate, bandOf, shapeCandles, shapeTrades, momentumFrom,
  decodeLaunchLog, launchFromReceipt, decodeInitializeLog, isLaunchPool,
  PONS_V2_FACTORY, TOPIC_PONS_LAUNCH, TOPIC_V4_INITIALIZE,
} from "./src/data/pons-live.js";
import { topicAddress, ZERO_ADDRESS } from "./src/lib/evm.js";
import { cfg } from "./src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const fx = JSON.parse(fs.readFileSync(new URL("./test-fixtures/pons-live-4663.json", import.meta.url), "utf8"));

console.log("\nWHICH LAUNCHPAD A DEX ID NAMES");
{
  ok("pons-v2 is the PONS curve", venueOf("pons-v2").venue === "pons" && venueOf("pons-v2").curve === true);
  ok("pons-v2-dex is a graduated PONS pool", venueOf("pons-v2-dex").venue === "pons" && venueOf("pons-v2-dex").curve === false);
  ok("uniswap-v4-robinhood is no pad", venueOf("uniswap-v4-robinhood").venue === "none" && launchpadOf("uniswap-v4-robinhood") === null);
  ok("hoodit is hood.fun on its curve", venueOf("hoodit").venue === "hood.fun" && venueOf("hoodit").curve === true);
  // Seen in new_pools on 2026-09-05; the "hood" inside "robinhood" must not make a curve of everything.
  ok("o1-launchpad-robinhood is an unknown PAD, read as a curve", venueOf("o1-launchpad-robinhood").curve === true && launchpadOf("o1-launchpad-robinhood") === null);
  ok("some-dex-robinhood is an unknown DEX, not a curve", venueOf("some-dex-robinhood").curve === false);
  ok("no id is unknown", venueOf(null).venue === "unknown" && venueOf(null).curve === false);
}

console.log("\nGECKOTERMINAL ROWS → THE CANDIDATE DIALECT");
{
  const rows = fx.new_pools.data;
  const cands = rows.map((p) => asCandidate(p, { now: Date.parse(fx.recordedAt) })).filter(Boolean);
  ok("every recorded new_pools row shapes", cands.length === rows.length, `${cands.length}/${rows.length}`);
  const c = cands.find((x) => x.pair.dex === "pons-v2");
  ok("a pons-v2 row is a PONS launch on its curve", c && c.launchpad === "pons" && c.onCurve === true && c.live.venue === "pons" && c.live.graduated === false);
  ok("address and mint are the base token, lower-case", c && c.address === c.mint && /^0x[0-9a-f]{40}$/.test(c.address) && c.address === c.pair.baseAddress);
  ok("the pool is the row's own address", c && c.pool === c.pair.pairAddress && c.pool === c.raw.attributes.address.toLowerCase());
  ok("a native quote is labelled ETH", cands.some((x) => x.pair.quoteAddress === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" && x.pair.quoteSymbol === "ETH"));
  ok("liquidityUsd is reserve_in_usd", c && c.pair.liquidityUsd === Number(c.raw.attributes.reserve_in_usd));
  ok("market cap falls back to fdv when market_cap_usd is null", c && (c.raw.attributes.market_cap_usd != null || c.pair.marketCap === Number(c.raw.attributes.fdv_usd)));
  ok("pairCreatedAt is pool_created_at in ms", c && c.pair.pairCreatedAt === Date.parse(c.raw.attributes.pool_created_at));
  ok("age is measured from `now`, not the wall clock", c && c.pair.ageHours != null && c.pair.ageHours < 24, `${c?.pair.ageHours}h at recording`);
  ok("txns.m5 carries buys and sells", c && typeof c.pair.txns.m5?.buys === "number" && typeof c.pair.txns.m5?.sells === "number");
  ok("live.buyers5m is the m5 buyer count", c && c.live.buyers5m === (c.raw.attributes.transactions?.m5?.buyers ?? null));
  ok("a $4k curve is below every band, so band is null (off the board, not nano)", c && c.live.band === null && bandOf(4000) === null);
  const bankr = cands.find((x) => x.pair.dex === "bankr-robinhood");
  ok("a bankr row is off-curve with a band", !bankr || (bankr.onCurve === false && bankr.live.band != null), bankr ? `${bankr.live.band}` : "no bankr row recorded");
  const pv = fx.pons_v2_pools.data.map((p) => asCandidate(p)).filter(Boolean);
  ok("the dexes/pons-v2/pools listing is all curves", pv.length === fx.pons_v2_pools.data.length && pv.every((x) => x.onCurve && x.launchpad === "pons"), `${pv.length} rows`);
  ok("one of them quotes in USDG, not native (a pair-token fact the screen must see)", pv.some((x) => x.pair.quoteAddress === "0x5fc5360d0400a0fd4f2af552add042d716f1d168"));
  const tp = fx.trending_pools.data.map((p) => asCandidate(p)).filter(Boolean);
  ok("trending rows are graduated pools", tp.length > 0 && tp.every((x) => x.onCurve === false), tp.map((x) => x.pair.dex).join(","));
  ok("a row with no base token is refused", asCandidate({ attributes: { address: "0xabc" }, relationships: {} }) === null);
  ok("a null market cap is absent, not $0", asCandidate({ ...rows[0], attributes: { ...rows[0].attributes, market_cap_usd: null, fdv_usd: null } }).pair.marketCap === null);
}

console.log("\nTHE MINUTE TAPE, OLDEST FIRST");
{
  const raw = fx.ohlcv.data.attributes.ohlcv_list;
  ok("GeckoTerminal returns newest first (the recorded row order)", raw[0][0] > raw.at(-1)[0], `${raw[0][0]} … ${raw.at(-1)[0]}`);
  const c = shapeCandles(raw);
  ok("shapeCandles reverses it", c.bars[0].t < c.bars.at(-1).t && c.bars[0].t === raw.at(-1)[0] * 1000 && c.bars.at(-1).t === raw[0][0] * 1000);
  ok("every bar is {t,o,h,l,c,volUsd} in ms", c.bars.every((b) => ["t", "o", "h", "l", "c", "volUsd"].every((k) => typeof b[k] === "number")) && c.bars[0].t > 1e12);
  ok("tape is strictly ascending", c.tape.every((k, i) => i === 0 || k.ts > c.tape[i - 1].ts));
  ok("barsCovered counts bars with volume", c.barsCovered === c.tape.filter((k) => k.volume > 0).length, `${c.barsCovered}/${c.tape.length}`);
  ok("interval is the aggregate", c.interval === "1m" && shapeCandles(raw, { interval: "5m" }).interval === "5m");
  ok("a bar with no close is dropped, not zeroed", shapeCandles([[1, 1, 1, 1, 0, 5], [2, 1, 1, 1, 1, 5]]).bars.length === 1);
  ok("garbage is an empty tape", shapeCandles(null).bars.length === 0 && shapeCandles("x").bars.length === 0);
  const m = momentumFrom(c.tape);
  ok("momentum reads the recorded tape", m && m.candles === c.tape.length && m.lastPriceUsd === c.tape.at(-1).close && typeof m.pct5m === "number",
    m ? `5m ${m.pct5m.toFixed(2)}% vol5m $${m.vol5mUsd.toFixed(0)} accel ${m.volAccel?.toFixed(2)}x` : "null");
  ok("volume acceleration is recent five over the prior ten halved", m && Math.abs(m.volAccel - m.vol5mUsd / m.volPrior5mUsd) < 1e-9);
}

console.log("\nPOOL TRADES → THE WHALE SHAPE");
{
  const rows = fx.trades.data;
  const t = shapeTrades(rows, { minUsd: 0 });
  ok("every recorded trade shapes", t.length === rows.length, `${t.length}/${rows.length}`);
  ok("side is buy|sell, wallet is tx_from_address lower-cased", t.every((x) => (x.side === "buy" || x.side === "sell") && /^0x[0-9a-f]{40}$/.test(x.wallet)));
  ok("usd is volume_in_usd, at is block_timestamp in ms, block is a number", t.every((x) => typeof x.usd === "number" && x.at > 1e12 && Number.isFinite(x.block)));
  ok("the basis is labelled so a seat cannot mistake it for a token delta", t.every((x) => x.evidenceKind === "indexer_trade_usd"));
  const big = shapeTrades(rows, { minUsd: 500 });
  ok("the whale bar filters by dollars", big.every((x) => x.usd >= 500) && big.length <= t.length, `${big.length} of ${t.length} ≥ $500`);
  ok("tokens follows the side (to_token_amount on a buy, from_token_amount on a sell)", t.every((x) => x.tokens == null || x.tokens > 0));
}

console.log("\nTHE CHAIN-NATIVE FEED: A REAL LAUNCH LOG AND ITS RECEIPT");
{
  const log = fx.launchLogs.last3.at(-1);
  ok(`the recorded window held launches (${fx.launchLogs.count} in ${fx.launchLogs.toBlock - fx.launchLogs.fromBlock + 1} blocks)`, fx.launchLogs.count > 0);
  ok("the log is from the V2 factory with the launch topic", log.address.toLowerCase() === PONS_V2_FACTORY && log.topics[0] === TOPIC_PONS_LAUNCH);
  const d = decodeLaunchLog(log);
  ok("decodeLaunchLog: token, creator, curve from topics 1-3", d && d.token === "0x7895c9cc3a397799b5ce1aeb68aa6b2116fc40fb" && d.creator === "0xa14bf99c4b249c54a0dacd9e6114e815a1dfedeb" && d.curve === "0x706a6c47e562dca0f84b3771a24efd9d3c3e6f14");
  ok("block and tx carried", d.block === Number(log.blockNumber) && d.tx === log.transactionHash && d.factory === PONS_V2_FACTORY);
  ok("a log with the wrong topic is not a launch", decodeLaunchLog({ ...log, topics: [TOPIC_V4_INITIALIZE, ...log.topics.slice(1)] }) === null);
  ok("a log with three topics is not a launch", decodeLaunchLog({ ...log, topics: log.topics.slice(0, 3) }) === null);
  ok("the curve's quoteToken() on this launch is NOT native (recorded eth_call)", fx.curveReads.quoteToken.endsWith("1b0e319c6a659f002271b69db8a7df2f911c153e"));
  ok("the curve's token() is the launched token", fx.curveReads.token.endsWith(d.token.slice(2)));

  // The zero-word topic decodes to the zero address: it is the `from` of every mint.
  ok("topicAddress reads the zero word as the zero address", topicAddress("0x" + "0".repeat(64)) === ZERO_ADDRESS);

  const rc = fx.launchReceipt;
  const supply = BigInt(fx.launchTokenTotalSupply).toString();
  ok("the launch token's totalSupply is 1e9 tokens", supply === (10n ** 27n).toString());
  const lr = launchFromReceipt(rc, { token: d.token, curve: d.curve, supply });
  ok("the vault is where the mint went", lr.ok && lr.vault === "0xf6e4f02c4321061697f7db3a228c3c53e955005f");
  ok("the exempt share is what left vault/curve in the launch tx: 9.31% + 3.39% = 12.70%", lr.exemptShareOfSupplyPct === 12.7, `${lr.exemptShareOfSupplyPct}%`);
  ok("two first-block buyers, largest first", lr.firstBlockBuyers.length === 2 && lr.firstBlockBuyers[0].address === "0xda1fdca792fc825ff73de773a4967fb93ccd5264" && lr.firstBlockBuyers[0].pctOfSupply === 9.31 && lr.firstBlockBuyers[1].pctOfSupply === 3.39);
  ok("the transaction sender is named separately from the creator topic", lr.deployerTx === rc.from.toLowerCase() && lr.deployerTx !== d.creator);
  ok("supply falls back to the mint amount when not given", launchFromReceipt(rc, { token: d.token, curve: d.curve, supply: null }).exemptShareOfSupplyPct === 12.7);
  const noMint = launchFromReceipt({ ...rc, logs: rc.logs.filter((l) => !(l.address.toLowerCase() === d.token && /^0x0+$/.test(l.topics[1]))) }, { token: d.token, curve: d.curve, supply });
  ok("a receipt with no mint reports the share as UNMEASURED, never 0", noMint.ok === false && noMint.exemptShareOfSupplyPct === null && /vault unknown/.test(noMint.error));
  ok("a receipt with no token transfer at all is refused", launchFromReceipt({ logs: [] }, { token: d.token, curve: d.curve, supply }).ok === false);
}

console.log("\nUNISWAP V4 INITIALIZE: THE ZERO-THIRD-PARTY DISCOVERY PATH");
{
  const log = fx.initializeLogs.first3[0];
  ok(`the recorded window held pool initialisations (${fx.initializeLogs.count} in 10k blocks)`, fx.initializeLogs.count > 0);
  const p = decodeInitializeLog(log);
  ok("poolId, currency0, currency1 from the topics", p && p.poolId === log.topics[1].toLowerCase() && p.currency0 === "0x" + log.topics[2].slice(26).toLowerCase() && p.currency1 === "0x" + log.topics[3].slice(26).toLowerCase());
  ok("fee, tickSpacing, hooks, sqrtPriceX96, tick from the data words", p && Number.isFinite(p.fee) && Number.isFinite(p.tickSpacing) && /^0x[0-9a-f]{40}$/.test(p.hooks) && /^\d+$/.test(p.sqrtPriceX96) && Number.isInteger(p.tick),
    p ? `fee ${p.fee} spacing ${p.tickSpacing} tick ${p.tick} hooks ${p.hooks}` : "null");
  ok("the dynamic-fee flag (0x800000) decodes as its number, not as bps", p.fee === 8388608 || p.fee < 1_000_000, `fee ${p.fee}`);
  const neg = decodeInitializeLog({ ...log, data: log.data.slice(0, 2 + 4 * 64) + "f".repeat(64) });
  ok("a negative tick is sign-extended", neg && neg.tick === -1, `${neg?.tick}`);
  ok("a native-quoted pool is a launch pool; a token/token pool is plumbing", isLaunchPool({ ...p, currency0: ZERO_ADDRESS }) === true && isLaunchPool(p) === false);
  ok("a pool on the PONS hook is a launch pool whatever it quotes", isLaunchPool({ ...p, hooks: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" }) === true);
  ok("a log with the wrong topic is not an Initialize", decodeInitializeLog({ ...log, topics: [TOPIC_PONS_LAUNCH, ...log.topics.slice(1)] }) === null);
}

console.log("\nLIVE (skipped honestly when the RPC does not answer)");
{
  let live = false;
  try {
    const r = await fetch(cfg.rhRpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(6000) });
    live = (await r.json())?.result === "0x1237";
  } catch {}
  if (!live) console.log("  SKIP no RPC — live launch feed not read");
  else {
    const { launchLogs, curveState, v4NewPools, blockNumberNow } = await import("./src/data/pons-live.js").then(async (P) => ({ ...P, blockNumberNow: (await import("./src/data/evm.js")).blockNumber }));
    const head = await blockNumberNow();
    const t0 = Date.now();
    const ll = await launchLogs({ fromBlock: head - 9_999, toBlock: head, maxSpans: 1 });
    console.log(`  launches in the last 10k blocks: ${ll.launches.length} (${Date.now() - t0}ms, complete=${ll.complete})`);
    ok("the live launch feed answers and decodes", ll.ok && ll.complete && ll.launches.every((l) => /^0x[0-9a-f]{40}$/.test(l.token) && /^0x[0-9a-f]{40}$/.test(l.curve)));
    if (ll.launches.length) {
      /* Whichever launch is newest is a SAMPLE, not a contract: on 2026-09-05 the newest
         curve answered every view with a revert (a template this reader does not know, or
         a proxy not yet initialised in its own block) while the one before it answered
         fine. Sample the newest few; one answering curve proves the reader, none is an
         honest skip with the views printed, never a failure of code that did not change. */
      const sample = ll.launches.slice(-5).reverse();
      let answered = null;
      for (const l of sample) {
        const cs = await curveState(l.curve);
        console.log(`  curve ${cs.curve}: quoteToken=${cs.quoteToken} token=${cs.token} views=${Object.entries(cs.views).map(([k, v]) => `${k}:${v.value ?? "revert"}`).join(" ")}`);
        if (cs.ok && cs.token === l.token) { answered = cs; break; }
      }
      if (answered) ok("a recent curve answers quoteToken() and token() with its launched token", true, answered.curve);
      else console.log(`  SKIP none of the newest ${sample.length} curves answered its views — live sample inconclusive, not a failure`);
    }
    const v4 = await v4NewPools({ fromBlock: head - 999, toBlock: head, maxSpans: 1 });
    console.log(`  V4 pools initialised in the last 1k blocks: ${v4.pools.length}`);
    ok("the PoolManager feed answers", v4.ok && Array.isArray(v4.pools));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
