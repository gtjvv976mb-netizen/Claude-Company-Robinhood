/**
 * THE MEASUREMENT CAMPAIGN FOR live-thresholds.mjs — READ-ONLY, WRITES NOTHING.
 *
 * Seven live-path thresholds are VOID and assertLiveReady() refuses to arm until each
 * is measured on THIS chain. This probe produces the numbers, prints them as the exact
 * `M(date, method)` lines an owner can paste into live-thresholds.mjs, and deliberately
 * never edits the registry itself: a number that arms a bot must pass through a human
 * who read how it was measured.
 *
 * What it measures, and what it cannot:
 *   - eth_gasPrice, sampled every few seconds for the run: median and p99 in gwei.
 *     The market brief has it moving 0.02 → 0.7 gwei in two weeks with spikes above 5,
 *     so a five-minute run is a SPOT DISTRIBUTION, not the 24h one exec.maxNetworkFeeWei
 *     wants; run longer (--seconds 86400) for that.
 *   - KyberSwap round trips (buy, then sell the EXACT quoted output) at 0.005 / 0.05 /
 *     0.5 ETH across a liquidity-stratified sample of live pools. QUOTE-based, so bounded
 *     below by probe.quoteNoisePct (~0.9%); an eth_call-simulated sell needs an allowance
 *     the probe's stand-in sender does not hold. Medianed over repeats where it can.
 *   - quote-vs-+K-blocks drift: the same buy quoted again ~K blocks later; the adverse
 *     tail is what exec.slippageBps must cover.
 *   - the pool population's liquidity / 24h volume / age quantiles from GeckoTerminal.
 *   - NOT: inclusion latency, drop rate, nonce replacement. Those need a funded burner
 *     and a real send; this probe sends nothing and says so in its output.
 *
 * Sources: the public RPC (batches avoided — it 429s above ~10), the Kyber aggregator
 * (routes only, never build), GeckoTerminal's public pools API for the sample. Nothing
 * here needs a key, and no request here can move money.
 */
import { createRpc, fromHex, fromHexNumber } from "./evm-rpc.mjs";
import { quote, NATIVE_SENTINEL } from "./evm-swap.mjs";
import { classifyToken, SELECTOR_NAME } from "./scope-guard.mjs";
import { tokenSide } from "./probe-pool-select.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1] ?? "1"] : []).filter(Boolean));
const SECONDS = Number(args.seconds || 300);
const GAS_EVERY_MS = Number(args.gasEveryMs || 2_000);
const DRIFT_BLOCKS = Number(args.driftBlocks || 30);          // ~3s at 100ms blocks
const PER_TIER = Number(args.perTier || 2);
/* Which venues to sample. The first run (2026-09-05, no filter) drew GME, SPCX and USDG
   from GeckoTerminal's top pages — two Stock Tokens the scope guard refuses as positions
   and a stablecoin — so by default only PONS launches and the V4 pools they graduate
   into are sampled, and every base token is passed through the scope guard first. */
/* EVERY VENUE BY DEFAULT, because the executor is venue-agnostic: evm-swap.mjs routes
   through KyberSwap's aggregator, and the only allowlist on the trading path is the
   scope guard on TOKENS. Defaulting to pons-v2-dex + uniswap-v4-robinhood measured a
   market this bot does not trade — and measured almost nothing: of 60 pools, 15 have
   the WETH ERC-20 on a side, and those two venues held ONE of them between them. The
   sample came back as a single pool in a single liquidity tier, which is an anecdote,
   not a measurement. (pons-v2-dex read as ZERO there for a second reason, since fixed:
   its pools quote NATIVE ETH, which GeckoTerminal also labels "WETH", and the sampler
   matched only the ERC-20 — see probe-pool-select.mjs.) Across all
   venues the same run samples 7 pools spanning all four tiers, and the thin ones lose
   84-99% on a round trip — exactly the fact screen.minLiquidityUsd exists to encode,
   and exactly what one pool could never have shown. --dexes still narrows it. */
const DEXES = new Set(String(args.dexes || "").split(",").filter(Boolean));
const RPC_URL = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const rpc = createRpc(RPC_URL, { label: "probe RPC" });
const CLIPS = [5n * 10n ** 15n, 5n * 10n ** 16n, 5n * 10n ** 17n];     // 0.005 / 0.05 / 0.5 ETH
const SENDER = "0x000000000000000000000000000000000000dEaD";      // a stand-in `to` for quotes
const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString(), "PROBE", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${x.toFixed(3)}%`;
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[i];
};
const median = (xs) => quantile(xs, 0.5);
const started = Date.now();
const deadline = started + SECONDS * 1_000;

log(`read-only campaign against ${new URL(RPC_URL).hostname} for ${SECONDS}s; nothing is signed, sent, or written`);
const chainId = await rpc("eth_chainId");
if (chainId !== "0x1237") throw new Error(`RPC is not Robinhood Chain (eth_chainId ${chainId})`);
const head0 = fromHexNumber(await rpc("eth_blockNumber"));
log(`chain 4663 confirmed at block ${head0}`);

/* ── 1. gas price, sampled for the whole run in the background ─────────── */
const gasSamples = [];
const gasLoop = (async () => {
  while (Date.now() < deadline) {
    try { gasSamples.push(Number(fromHex(await rpc("eth_gasPrice"))) / 1e9); }
    catch (e) { log(`gas sample failed: ${e.message}`); }
    await sleep(GAS_EVERY_MS);
  }
})();

/* ── 2. the sample: liquidity-stratified live pools from GeckoTerminal ─── */
/* THE POPULATION MUST CONTAIN THE VENUE YOU ASKED FOR. The chain-wide /pools feed is
   ranked by 24h volume, so three pages are the chain's top 60 — and a small venue is
   represented there only by its handful of loudest pools. Measured 2026-09-07: those
   60 carried 5 pons-v2-dex pools, every one of them USDG-quoted, so `--dexes
   pons-v2-dex` sampled ZERO ETH-quoted pools and looked, for the second time and for
   a second unrelated reason, like a venue with no ETH market. It has seven; they sit
   below the chain's top 60. When --dexes narrows the venues, the population is drawn
   from each venue's OWN pool feed, which is the only place a small venue is complete. */
async function geckoPools(pages = 3) {
  const out = [];
  const feeds = DEXES.size
    ? [...DEXES].map((d) => ({ label: d, url: (pg) => `https://api.geckoterminal.com/api/v2/networks/robinhood/dexes/${encodeURIComponent(d)}/pools?page=${pg}&sort=h24_volume_usd_desc` }))
    : [{ label: "chain-wide", url: (pg) => `https://api.geckoterminal.com/api/v2/networks/robinhood/pools?page=${pg}&sort=h24_volume_usd_desc` }];
  for (const feed of feeds) {
  for (let page = 1; page <= pages; page++) {
    const r = await fetch(feed.url(page),
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { log(`GeckoTerminal ${feed.label} page ${page}: HTTP ${r.status}`); break; }
    const body = await r.json();
    for (const p of body?.data ?? []) {
      const a = p.attributes ?? {};
      const base = String(p.relationships?.base_token?.data?.id ?? "").replace(/^robinhood_/, "");
      const quoteTok = String(p.relationships?.quote_token?.data?.id ?? "").replace(/^robinhood_/, "");
      out.push({ name: a.name, address: a.address, base, quote: quoteTok, dex: p.relationships?.dex?.data?.id,
        reserveUsd: Number(a.reserve_in_usd), volume24hUsd: Number(a.volume_usd?.h24),
        createdAt: Date.parse(a.pool_created_at) || null });
    }
    await sleep(1_500);                    // GeckoTerminal's public tier is ~30 req/min
  }
  }
  return out;
}
const PAGES = Number(args.pages || 3);
const pools = await geckoPools(PAGES);
log(`GeckoTerminal returned ${pools.length} pools across ${PAGES} pages of ${DEXES.size ? [...DEXES].join("/") : "the chain-wide feed"}`);

/* population quantiles → bands.floors / bands.holdWindows inputs */
{
  const liq = pools.map((p) => p.reserveUsd).filter((x) => Number.isFinite(x) && x > 0);
  const vol = pools.map((p) => p.volume24hUsd).filter((x) => Number.isFinite(x) && x >= 0);
  const ageH = pools.map((p) => p.createdAt ? (Date.now() - p.createdAt) / 3_600_000 : null).filter((x) => x != null);
  const q = (xs) => [0.1, 0.5, 0.9].map((k) => quantile(xs, k));
  const [l10, l50, l90] = q(liq), [v10, v50, v90] = q(vol), [a10, a50, a90] = q(ageH);
  console.log(`\nPOPULATION (${pools.length} pools, GeckoTerminal network=robinhood, ${today}):`);
  console.log(`  liquidity USD  p10 ${l10?.toFixed(0)}  p50 ${l50?.toFixed(0)}  p90 ${l90?.toFixed(0)}`);
  console.log(`  24h volume USD p10 ${v10?.toFixed(0)}  p50 ${v50?.toFixed(0)}  p90 ${v90?.toFixed(0)}`);
  console.log(`  age hours      p10 ${a10?.toFixed(1)}  p50 ${a50?.toFixed(1)}  p90 ${a90?.toFixed(1)}`);
  console.log(`  by dex: ${JSON.stringify(Object.fromEntries(Object.entries(pools.reduce((m, p) => (m[p.dex] = (m[p.dex] || 0) + 1, m), {}))))}`);
  console.log(`  → M("${today}", "GeckoTerminal robinhood pools pages 1-3 (${pools.length} pools): liquidity p10/p50/p90 ` +
    `$${l10?.toFixed(0)}/$${l50?.toFixed(0)}/$${l90?.toFixed(0)}; 24h volume p10/p50/p90 $${v10?.toFixed(0)}/$${v50?.toFixed(0)}/$${v90?.toFixed(0)}; ` +
    `age p10/p50/p90 ${a10?.toFixed(1)}h/${a50?.toFixed(1)}h/${a90?.toFixed(1)}h")  # bands.floors input, NOT the floors themselves`);
}

/* stratify by liquidity; ETH-quoted pools on the chosen venues, and only tokens the
   desk could actually hold: the scope guard reads each base token's beacon slot and
   name() before it is sampled, so an equity cannot end up in the round-trip table.
   The ETH-side test lives in probe-pool-select.mjs and is tested there — it has to
   accept NATIVE ETH as well as the WETH ERC-20, and getting that wrong is what made
   pons-v2-dex look like it had no ETH pools at all. */
const tiers = [[0, 10_000], [10_000, 100_000], [100_000, 1_000_000], [1_000_000, Infinity]];
const readSlot = (a, slot) => rpc("eth_getStorageAt", [a, slot, "latest"]);
const readName = (a) => rpc("eth_call", [{ to: a, data: SELECTOR_NAME }, "latest"]);
const sample = [];
const refused = [];
for (const [lo, hi] of tiers) {
  const inTier = pools.filter((p) => p.reserveUsd >= lo && p.reserveUsd < hi && tokenSide(p) &&
    /^0x[0-9a-f]{40}$/i.test(tokenSide(p)) && (DEXES.size === 0 || DEXES.has(p.dex)))
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  let taken = 0;
  for (const p of inTier) {
    if (taken >= PER_TIER) break;
    const token = tokenSide(p);
    if (sample.some((q) => q.token.toLowerCase() === token.toLowerCase())) continue;
    const verdict = await classifyToken(token, readSlot, readName);
    if (!verdict.tradeable) { refused.push(`${p.name}: ${verdict.kind}`); continue; }
    sample.push({ ...p, token, tier: `$${lo}-${hi === Infinity ? "∞" : hi}` });
    taken++;
  }
}
log(`sample: ${sample.length} ETH-quoted pools (WETH ERC-20 or native) on ${[...DEXES].join("/") || "any dex"} — ${sample.map((p) => `${p.name} [${p.tier}]`).join("; ")}`);
if (refused.length) log(`scope guard refused ${refused.length} candidate(s): ${refused.join("; ")}`);

/* ── 3. round trips and drift ──────────────────────────────────────────── */
const roundTrips = [];    // { name, tier, clipEth, lossPct, gas }
const drifts = [];        // { name, clipEth, driftBps, blocks }
for (const p of sample) {
  for (const clip of CLIPS) {
    if (Date.now() > deadline - 20_000) break;
    const clipEth = Number(clip) / 1e18;
    try {
      const b0 = fromHexNumber(await rpc("eth_blockNumber"));
      const buy = await quote({ tokenIn: NATIVE_SENTINEL, tokenOut: p.token, amountIn: clip, to: SENDER });
      const out = BigInt(buy.amountOut);
      if (out <= 0n) throw new Error("zero out");
      const sell = await quote({ tokenIn: p.token, tokenOut: NATIVE_SENTINEL, amountIn: out, to: SENDER });
      const back = BigInt(sell.amountOut);
      const lossPct = Number((clip - back) * 1_000_000n / clip) / 10_000;
      const gas = Number(buy.gas || 0) + Number(sell.gas || 0);
      roundTrips.push({ name: p.name, tier: p.tier, clipEth, lossPct, gas });
      log(`${p.name} @ ${clipEth} ETH: round trip ${pct(lossPct)} (gas quoted ${gas})`);
      // drift: wait ~K blocks and quote the same buy again
      const target = b0 + DRIFT_BLOCKS;
      let b1 = b0;
      while (b1 < target && Date.now() < deadline) { await sleep(500); b1 = fromHexNumber(await rpc("eth_blockNumber")); }
      const again = await quote({ tokenIn: NATIVE_SENTINEL, tokenOut: p.token, amountIn: clip, to: SENDER });
      const out2 = BigInt(again.amountOut);
      const driftBps = Number((out2 - out) * 10_000n / out);
      drifts.push({ name: p.name, clipEth, driftBps, blocks: b1 - b0 });
      log(`${p.name} @ ${clipEth} ETH: quote moved ${driftBps} bps over ${b1 - b0} blocks`);
    } catch (e) {
      log(`${p.name} @ ${clipEth} ETH: ${String(e.message).slice(0, 120)}`);
      roundTrips.push({ name: p.name, tier: p.tier, clipEth, lossPct: null, gas: null, error: String(e.message).slice(0, 80) });
    }
    await sleep(1_200);                    // stay under the aggregator's public rate
  }
}

await gasLoop;

/* ── 4. the numbers, as pasteable M(...) lines ─────────────────────────── */
console.log(`\nGAS (${gasSamples.length} samples over ${((Date.now() - started) / 1000).toFixed(0)}s, every ${GAS_EVERY_MS}ms):`);
if (gasSamples.length) {
  const m = median(gasSamples), p99 = quantile(gasSamples, 0.99), max = Math.max(...gasSamples), min = Math.min(...gasSamples);
  console.log(`  median ${m.toFixed(4)} gwei  p99 ${p99.toFixed(4)}  min ${min.toFixed(4)}  max ${max.toFixed(4)}`);
  const roundTripGas = 660_996;
  const feeAtP99Eth = roundTripGas * p99 / 1e9;
  console.log(`  a 660,996-gas round trip at p99 = ${feeAtP99Eth.toFixed(6)} ETH; one leg ≈ ${(feeAtP99Eth / 2).toFixed(6)} ETH`);
  console.log(`  → GAS_PRICE_GWEI: M("${today}", "eth_gasPrice sampled ${gasSamples.length}× over ${SECONDS}s: median ${m.toFixed(4)} gwei, p99 ${p99.toFixed(4)}, max ${max.toFixed(4)}")`);
  console.log(`  → exec.maxNetworkFeeWei candidate (one swap leg, 330,498 gas × 4 × p99): ${BigInt(Math.round(330_498 * p99 * 4 * 1e9))} wei — ` +
    `a ${SECONDS}s window is NOT the 24h distribution the threshold asks for; rerun with --seconds 86400 before pasting`);
} else console.log("  no gas samples — the RPC did not answer");

console.log(`\nROUND TRIPS (KyberSwap quotes, buy then sell the exact quoted output; quote noise ≈ 0.9%):`);
for (const r of roundTrips) console.log(`  ${r.tier.padEnd(16)} ${r.name.padEnd(28)} ${String(r.clipEth).padEnd(6)} ETH  ${r.lossPct == null ? "no route: " + r.error : pct(r.lossPct)}`);
const byClip = {};
for (const r of roundTrips) if (r.lossPct != null) (byClip[r.clipEth] ||= []).push(r.lossPct);
for (const [clip, xs] of Object.entries(byClip))
  console.log(`  → M("${today}", "${xs.length} quoted round trips at ${clip} ETH across ${new Set(roundTrips.filter((r) => r.clipEth === Number(clip)).map((r) => r.tier)).size} liquidity tiers: median ${pct(median(xs))}, worst ${pct(Math.max(...xs))}")`);
const deep = roundTrips.filter((r) => r.lossPct != null && /1000000-/.test(r.tier)).map((r) => r.lossPct);
const thin = roundTrips.filter((r) => r.lossPct != null && /^\$0-/.test(r.tier)).map((r) => r.lossPct);
if (deep.length) console.log(`  → roundTrip.deepPct: M("${today}", "≥$1M pools, ${deep.length} quotes: median ${pct(median(deep))}")`);
if (thin.length) console.log(`  → roundTrip.thinPct: M("${today}", "<$10k pools, ${thin.length} quotes: median ${pct(median(thin))}, worst ${pct(Math.max(...thin))}")`);
console.log(`  → screen.minLiquidityUsd: the tier where the round trip stays inside the stop budget — read the table above; the probe does not choose it`);

console.log(`\nQUOTE DRIFT (same buy re-quoted after ~${DRIFT_BLOCKS} blocks; negative = adverse to a buyer):`);
for (const d of drifts) console.log(`  ${d.name.padEnd(28)} ${String(d.clipEth).padEnd(6)} ETH  ${d.driftBps} bps over ${d.blocks} blocks`);
if (drifts.length) {
  const adverse = drifts.map((d) => -d.driftBps).filter((x) => x > 0);
  const p95 = adverse.length ? quantile(adverse, 0.95) : 0;
  console.log(`  → exec.slippageBps input: M("${today}", "${drifts.length} re-quotes ~${DRIFT_BLOCKS} blocks apart: adverse p95 ${p95} bps, ` +
    `worst ${Math.max(0, ...adverse)} bps; ${drifts.length - adverse.length} moved in the buyer's favour")  # set bps at the p95 adverse drift over the MEASURED inclusion latency, which this probe cannot measure`);
}

console.log(`\nNOT MEASURED HERE — needs a funded burner and a real send:`);
console.log(`  exec.inclusionLatencyMs, exec.dropRatePct, exec.nonceReplacementHonoured — this probe sends nothing.`);
console.log(`  exec.maxPriceImpactPct — needs eth_call at 1×/2×/4× clip against a funded sender, not quotes.`);
console.log(`\nWROTE NOTHING. ${roundTrips.length} round trips, ${drifts.length} drifts, ${gasSamples.length} gas samples in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
