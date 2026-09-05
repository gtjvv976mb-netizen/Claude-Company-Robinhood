import * as ds from "./dexscreener.js";
import * as kyber from "./kyber.js";
import * as evm from "./evm.js";
import * as pons from "./pons-live.js";
import { ethUsd as ethUsdRead, coingecko } from "./eth-usd.js";
import { cfg, TOKENS, TOKEN_DECIMALS, floorsFor } from "../config.js";
import { bandForMarketCap, holdWindowFor } from "../bands.js";
import * as snapshots from "./snapshots.js";
import { grokXRead, hasGrok } from "../lib/grok.js";
import { emit } from "../lib/bus.js";
import { whaleFeed } from "../identity.js";
import { regime } from "./regime.js";
import { isAddress, lower, encodeCall, decodeBool, decodeUint, toWei, fromWei, addressFromWord, SLOT_BEACON, DEAD_ADDRESS, ZERO_ADDRESS } from "../lib/evm.js";
import { ALLOWED_PAIR_EQUITIES, KNOWN_STOCK_TOKEN_BEACON } from "../../executor/scope-guard.mjs";
import { evmGateFailures } from "../agents/risk-rails.js";

/**
 * Everything the desk knows about one token, fetched deterministically.
 * This object is the ONLY numeric ground truth the agents are permitted to use.
 *
 * REWRITTEN FOR CHAIN 4663 against docs/EVIDENCE-CONTRACT.md. The Solana bundle read
 * one mint account and one Jupiter quote; this one reads code, storage, logs and a
 * simulated sell, and it cites sources that were each probed live before being trusted
 * (see the headers of evm.js, pons-live.js, kyber.js and eth-usd.js for the numbers).
 *
 * The rule that did not change: for SAFETY, an unreadable fact is a refusal, never a
 * pass. Every read below that decides whether the token can be used against a holder
 * lands in screen() as an `unverified_*` kill when it did not complete.
 */
/* pairTokenClass vocabulary is the contract's (docs/EVIDENCE-CONTRACT.md) and
   risk-rails.js EVM_GATES.allowedPairTokenClasses reads it verbatim: native | weth |
   stable | allowed_equity | equity_unlisted | other. PONS itself is `other`: the
   executor's scope guard holds ETH/WETH/USDG and the three allowed equities, nothing
   else, so a PONS-quoted pool is one the bot cannot exit through. */
const PAIR_ASSETS = new Map([
  [lower(TOKENS.WETH), { class: "weth", symbol: "WETH", allowed: true }],
  [lower(TOKENS.NATIVE), { class: "native", symbol: "ETH", allowed: true }],
  [ZERO_ADDRESS, { class: "native", symbol: "ETH", allowed: true }],
  [lower(TOKENS.USDG), { class: "stable", symbol: "USDG", allowed: true }],
  [lower(TOKENS.PONS), { class: "other", symbol: "PONS", allowed: false, reason: "PONS is not an asset the executor holds" }],
]);

/** Blocks between two timestamps, measured on the chain rather than assumed 100ms. */
async function blockMs(head) {
  const [a, b] = await Promise.all([evm.blockTimeMs(head), evm.blockTimeMs(head - 10_000)]);
  return a && b && a > b ? (a - b) / 10_000 : 100;
}

/**
 * Which class of asset a pool quotes against. Unknown quotes get ONE storage read
 * (the beacon slot): an equity beacon says equity; the allowlist says whether it is
 * one the desk may hold in a round trip. Read in one batch for all pools.
 */
async function classifyPairTokens(quoteAddrs) {
  const out = new Map();
  const unknown = [];
  for (const q of quoteAddrs) {
    if (!q) continue;
    if (PAIR_ASSETS.has(q)) out.set(q, { ...PAIR_ASSETS.get(q) });
    else if (ALLOWED_PAIR_EQUITIES.has(q)) out.set(q, { class: "allowed_equity", symbol: ALLOWED_PAIR_EQUITIES.get(q), allowed: true });
    else unknown.push(q);
  }
  if (unknown.length) {
    const rs = await evm.readMany(unknown.map((q) => ({ method: "eth_getStorageAt", params: [q, SLOT_BEACON, "latest"] })));
    rs.forEach((r, i) => {
      const beacon = r.ok ? addressFromWord(r.data) : undefined;
      /* An unreadable slot is `null`, not a class: the rails report a null class as
         UNVERIFIED and the screen refuses it, which is the fail-closed answer. */
      out.set(unknown[i], beacon === undefined ? { class: null, symbol: null, allowed: false, reason: `beacon slot unreadable: ${r.error}` }
        : beacon === KNOWN_STOCK_TOKEN_BEACON ? { class: "equity_unlisted", symbol: null, allowed: false, reason: "a Stock Token not on the pair-asset allowlist" }
        : beacon ? { class: "other", symbol: null, allowed: false, reason: `delegates to unrecognised beacon ${beacon}` }
        : { class: "other", symbol: null, allowed: false, reason: "an arbitrary ERC-20 quote the desk does not hold" });
    });
  }
  return out;
}

/** Flow statistics from an indexer's recent trades. Pure. */
export function flowFrom(trades, { volume24 = null } = {}) {
  const rows = (trades || []).filter((t) => t.wallet && t.at);
  if (!rows.length) return { sample: 0, uniqueTraders: null, roundTripWalletPct: null, sameBlockTradePct: null, interArrivalCv: null };
  const byWallet = new Map();
  for (const t of rows) { const w = byWallet.get(t.wallet) ?? { buy: 0, sell: 0, usd: 0 }; w[t.side]++; w.usd += t.usd; byWallet.set(t.wallet, w); }
  const totalUsd = rows.reduce((a, t) => a + t.usd, 0);
  const rtUsd = [...byWallet.values()].filter((w) => w.buy && w.sell).reduce((a, w) => a + w.usd, 0);
  const blocks = new Map();
  for (const t of rows) if (t.block != null) blocks.set(t.block, (blocks.get(t.block) ?? 0) + 1);
  const inSharedBlock = rows.filter((t) => t.block != null && blocks.get(t.block) > 1).length;
  const times = rows.map((t) => t.at).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g >= 0);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sd = gaps.length > 1 ? Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / (gaps.length - 1)) : 0;
  return {
    sample: rows.length,
    sampleUsd: Number(totalUsd.toFixed(2)),
    uniqueTraders: byWallet.size,
    roundTripWalletPct: totalUsd > 0 ? Number((rtUsd / totalUsd * 100).toFixed(1)) : null,
    sameBlockTradePct: Number((inSharedBlock / rows.length * 100).toFixed(1)),
    interArrivalCv: mean > 0 ? Number((sd / mean).toFixed(2)) : null,
    note: volume24 ? `computed on the indexer's most recent ${rows.length} trades, not the full 24h tape` : null,
  };
}

async function candlesFor(pool) {
  if (!pool) return { bars: [], barsCovered: 0, interval: "1m", pool: null, error: "no pool" };
  try {
    const c = await pons.candles(pool, { limit: 60 });
    return { bars: c.bars, barsCovered: c.barsCovered, interval: c.interval, pool, tape: c.tape, error: c.bars.length ? null : "no candles for this pool id" };
  } catch (e) { return { bars: [], barsCovered: 0, interval: "1m", pool, error: e.message }; }
}

async function symbolCollisions(symbol, address) {
  if (!symbol || symbol === "?") return { symbolCollisions: false, collidingContracts: [], resolvedBy: "address" };
  const r = await ds.searchPairs?.(symbol) ?? null;
  const set = new Map();
  for (const p of r ?? []) {
    const a = lower(p.baseToken?.address);
    if (a && a !== lower(address) && (p.baseToken?.symbol ?? "").toUpperCase() === symbol.toUpperCase()) set.set(a, p.baseToken?.name ?? null);
  }
  return { symbolCollisions: set.size > 0, collidingContracts: [...set].map(([a, name]) => ({ address: a, name })), resolvedBy: "address" };
}

/** Uniswap v2 LP facts, measurable in two calls: the LP token is the pair itself. */
async function lpFor(pair, launch) {
  // lp.kind vocabulary is the contract's: v2_lp_tokens | v3_position | v4_position | curve | unknown.
  const base = { kind: "unknown", burnedPct: null, lockedPct: null, locker: null, lockerAddress: null, positionNftOwner: null,
    pullableSharePct: null, unlockAt: null, basis: "unmeasured" };
  if (launch?.onCurve) return { ...base, kind: "curve", pullableSharePct: 0, basis: "on a bonding curve — no LP exists yet; the curve's reserve is the depth" };
  if (!pair) return base;
  if (pair.version === "v2" && isAddress(pair.pairAddress)) {
    const [ts, dead, zero] = await evm.readMany([
      { method: "eth_call", params: [{ to: pair.pairAddress, data: encodeCall("totalSupply()") }, "latest"] },
      { method: "eth_call", params: [{ to: pair.pairAddress, data: encodeCall("balanceOf(address)", [DEAD_ADDRESS]) }, "latest"] },
      { method: "eth_call", params: [{ to: pair.pairAddress, data: encodeCall("balanceOf(address)", [ZERO_ADDRESS]) }, "latest"] },
    ]);
    const total = ts.ok ? decodeUint(ts.data) : null;
    if (total > 0n) {
      const burned = (dead.ok ? decodeUint(dead.data) : 0n) + (zero.ok ? decodeUint(zero.data) : 0n);
      const burnedPct = Number((Number(burned * 10_000n / total) / 100).toFixed(2));
      return { ...base, kind: "v2_lp_tokens", burnedPct, lockedPct: null, pullableSharePct: Number((100 - burnedPct).toFixed(2)),
        basis: "v2 LP token supply vs the share at 0xdead/0x0; locker holdings not classified, so unburned is counted pullable" };
    }
  }
  if (pair.version === "v3") return { ...base, kind: "v3_position", basis: "v3 positions are NFTs on the position manager; owner not read (no free index)" };
  if (pair.version === "v4") return { ...base, kind: "v4_position",
    basis: launch?.venue === "pons" ? "PONS V2 documents a full-range V4 position moved to a permanent locker; not verified on chain here" : "V4 position in the PoolManager; owner not read" };
  return base;
}

export async function gather(address, hook = "") {
  const a = lower(address);
  if (!isAddress(a)) return { ok: false, address: a, mint: a, error: `not an EVM address: ${address}` };
  emit("evidence:fetch", { mint: a, address: a });
  const markAt = Date.now();

  /* STAGE 1 — the market as the indexers see it, plus the chain's clock and gas. */
  const [px, gasPrice, head, cg, marketRegime, promo] = await Promise.all([
    ds.pairsFor(a),
    evm.gasPriceWei(),
    evm.blockNumber(),
    coingecko().catch(() => ({ eth: null })),
    regime().catch(() => ({ regime: "unknown" })),
    ds.paidOrders(a),
  ]);
  if (!px.ok) return { ok: false, address: a, mint: a, error: `dexscreener: ${px.error}` };
  const cons = ds.consensus(px.pairs);
  if (!cons.ok) return { ok: false, address: a, mint: a, error: `pricing: ${cons.error}` };
  const best = ds.shapePair(cons.deepest);
  if (best) best.priceUsd = cons.priceUsd;
  const totalLiquidityUsd = cons.liquidityUsd;
  if (head == null) return { ok: false, address: a, mint: a, error: "chain head unreadable" };

  /* The probe size in wei needs an ETH price. CoinGecko first; if it did not answer,
     a tiny Kyber quote supplies one and the reading is marked single-source. */
  let ethGuess = cg.eth;
  if (!(ethGuess > 0)) {
    const q = await kyber.quote({ tokenIn: TOKENS.NATIVE, tokenOut: TOKENS.USDG, amountIn: 10n ** 16n });
    ethGuess = q.ok ? q.impliedEthUsd : null;
  }
  const targetWei = ethGuess > 0 ? toWei((cfg.targetSizeUsd / ethGuess).toFixed(18)) : null;

  /* STAGE 2 — independent chain and aggregator reads, in one wait. */
  const msPerBlock = await blockMs(head);
  const pairAge = best?.pairCreatedAt ? markAt - best.pairCreatedAt : null;
  const scanBudget = Number(process.env.DESK_HOLDER_SCAN_BLOCKS || 120_000);
  const youngEnough = pairAge != null && pairAge / msPerBlock < scanBudget;
  const [contract, rt, launchLog, whales] = await Promise.all([
    evm.contractFacts(a, { head }),
    targetWei ? kyber.roundTrip({ tokenAddress: a, quoteAmountWei: targetWei }) : Promise.resolve({ ok: false, error: "no ETH/USD to size the probe" }),
    // The PONS launch log, searched backwards only as far as the scan budget allows.
    youngEnough || pairAge == null ? pons.launchFor(a, { toBlock: head, maxSpans: Math.ceil(scanBudget / evm.LOG_SPAN) }).catch(() => null) : Promise.resolve(null),
    best?.pairAddress ? pons.trades(best.pairAddress, { minUsd: 0 }).catch(() => ({ ok: false, trades: [] })) : Promise.resolve({ ok: false, trades: [] }),
  ]);

  /* ETH/USD, reconciled against the aggregator's mark on the probe just made. */
  const ethUsd = await ethUsdRead({ kyberImplied: rt.ok ? rt.impliedEthUsd : null, now: Date.now() });

  /* STAGE 3 — what the launch was, where the supply is, and whether it can be sold. */
  const decimals = contract.ok ? (contract.decimals ?? 18) : 18;
  const supply = contract.ok ? contract.totalSupply : null;
  /* THE LEDGER NEEDS A TRUE START. An estimated launch block (from the pool's age) let a
     token whose supply moved before the estimate replay a partial ledger and report a
     clean top-10 — fail-open on the one number the seats weight hardest. No launch log,
     no ledger: holders read UNVERIFIED and the screen refuses (review, 2026-09-05). */
  const launchBlock = launchLog?.block ?? null;
  const curve = launchLog?.curve ?? null;

  const [curveState, launchTx, graduation, deployerIsContract, priorLaunches, pairClasses] = await Promise.all([
    curve ? pons.curveState(curve) : Promise.resolve(null),
    launchLog ? pons.launchTxFacts(launchLog.tx, { token: a, curve, supply }) : Promise.resolve(null),
    launchLog ? pons.graduationFor(a, { fromBlock: launchLog.block, toBlock: head }) : Promise.resolve(null),
    launchLog ? evm.isContract(launchLog.creator) : Promise.resolve(null),
    launchLog ? pons.launchLogs({ fromBlock: Math.max(0, head - 3 * evm.LOG_SPAN), toBlock: head, creator: launchLog.creator, maxSpans: 3 }).catch(() => null) : Promise.resolve(null),
    classifyPairTokens([...new Set(px.pairs.map((p) => lower(p.quoteToken?.address)).filter(Boolean))]),
  ]);

  const venue = launchLog ? "pons" : (pons.venueOf(best?.dex)?.venue ?? "unknown");
  const onCurve = launchLog ? graduation?.graduated === false : pons.venueOf(best?.dex).curve;
  /* "graduated" is a fact read from the chain — a PoolGraduated/Initialize log for THIS
     token — never inferred from a DEX label: DexScreener lists a live PONS V2 curve as
     dexId "uniswap" labels ["v4"], so a coin still on its curve would have read as
     graduated whenever its launch log sat outside the scan budget (review, 2026-09-05).
     Without the log the phase is unknown, and the screen refuses unknown. */
  const phase = launchLog ? (graduation?.graduated === true ? "graduated" : graduation?.graduated === false ? "curve" : "unknown")
    : onCurve ? "curve" : "unknown";

  const excluded = [
    ...px.pairs.filter((p) => isAddress(p.pairAddress)).map((p) => ({ address: lower(p.pairAddress), label: `pool:${p.dexId}${p.labels?.[0] ? "-" + p.labels[0] : ""}` })),
    { address: evm.V4_POOL_MANAGER, label: "pool:uniswap-v4-manager" },
    curve ? { address: curve, label: "curve" } : null,
    launchTx?.vault ? { address: launchTx.vault, label: "vault" } : null,
    graduation?.pool?.hooks && graduation.pool.hooks !== ZERO_ADDRESS ? { address: graduation.pool.hooks, label: "pool:hook" } : null,
  ].filter(Boolean);

  const [holders, poolShare, sellSim, buySim, transferSim, mintSim, blacklist, lp, candles, identity] = await Promise.all([
    supply && launchBlock != null
      ? evm.holdersFromLedger(a, { fromBlock: launchBlock, toBlock: head, supply, decimals, exclude: excluded })
      : Promise.resolve({ ok: false, error: supply ? "no launch block — ledger has no start (token older than the scan budget)" : "supply unreadable" }),
    supply ? evm.poolShare(a, supply, excluded) : Promise.resolve({ ok: false, error: "supply unreadable" }),
    rt.ok ? evm.sellSim(a, rt.tokensOut, { route: { ok: true, routeSummary: rt._sellRoute, outAmount: rt.sell.outAmount }, build: kyber.build })
      : Promise.resolve({ ok: false, unverified: true, reason: `no sell route to simulate: ${rt.error}` }),
    rt.ok ? buyProbe(a, rt, targetWei) : Promise.resolve({ ok: false, unverified: true, reason: "no buy route" }),
    rt.ok ? evm.transferSim(a, rt.tokensOut) : evm.transferSim(a, 10n ** BigInt(decimals)),
    mintProbe(a, contract),
    blacklistProbe(a),
    lpFor(best, { onCurve, venue }),
    candlesFor(best?.pairAddress ?? null),
    symbolCollisions(best?.baseSymbol, a),
  ]);

  /* Cost of the round trip in dollars, priced at the gas price read on this tick. */
  const gasUsdRoundTrip = rt.ok && gasPrice != null && ethUsd.value
    ? Number((fromWei(BigInt(rt.gasUnitsRoundTrip ?? 0) * gasPrice) * ethUsd.value).toFixed(4)) : null;

  const vol24 = best?.volume?.h24 ?? null;
  const liq = Number(totalLiquidityUsd.toFixed(2)) || null;
  const txns24 = (best?.txns?.h24?.buys ?? 0) + (best?.txns?.h24?.sells ?? 0);
  const mcap = best?.marketCap ?? best?.fdv ?? null;

  /* THE PINOCCHIO GATE — every load-bearing number cross-checked against an
   * independent source before anyone reasons on it. DexScreener's consensus mark
   * against the aggregator's implied price on the probe; volume against trades. */
  const crosscheck = { verdicts: [], killed: false };
  const xc = (verdict, check, detail) => { crosscheck.verdicts.push({ check, verdict, detail }); if (verdict === "KILLED") crosscheck.killed = true; };
  const kyberUsd = rt.ok && rt.buy.amountOutUsd && rt.tokensOut ? rt.buy.amountOutUsd / (Number(BigInt(rt.tokensOut)) / 10 ** decimals) : null;
  if (kyberUsd && cons.priceUsd > 0) {
    const gapPct = Math.abs(kyberUsd - cons.priceUsd) / cons.priceUsd * 100;
    if (gapPct > 25) xc("KILLED", "price_disputed", `DexScreener consensus $${cons.priceUsd} vs Kyber $${kyberUsd} disagree by ${gapPct.toFixed(0)}% — the mark is unverifiable`);
    else xc("VERIFIED", "price", `two independent sources agree within ${gapPct.toFixed(1)}%`);
  } else xc("FLAG", "price_single_source", "only one price source answered — treat the mark with suspicion");
  if ((vol24 ?? 0) > 10_000 && txns24 === 0) xc("KILLED", "volume_without_trades", `$${Math.round(vol24)} of volume with zero recorded trades is not a market`);
  if (cons.priceSpreadPct > 25) xc("FLAG", "venue_spread", `surviving pools still disagree by ${cons.priceSpreadPct}% — a wobbly mark`);
  const avgTrade = vol24 && txns24 ? vol24 / txns24 : null;
  if (avgTrade != null && avgTrade > 50_000) xc("FLAG", "suspicious_print", `average trade $${Math.round(avgTrade)} — a whale or a wash, and the tape cannot say which`);
  if (ethUsd.ok === false && ethUsd.source === "disputed") xc("KILLED", "eth_usd_disputed", ethUsd.error);

  const approved = (promo.orders ?? []).filter((o) => o.status === "approved");
  const promotion = { boosted: approved.length > 0 || (promo.boosts?.length ?? 0) > 0, paidOrders: approved.length,
    boosts: promo.boosts?.length ?? 0, lastPaidAt: approved.reduce((m, o) => Math.max(m, o.paidAt ?? 0), 0) || null };
  const callouts = whaleFeed({ limit: 200 }).filter((w) => w.mint === a || w.address === a).slice(0, 5);

  const pools = px.pairs.map((p) => {
    const q = lower(p.quoteToken?.address);
    const cls = pairClasses.get(q) ?? { class: "unknown", allowed: false };
    return { dex: p.dexId, version: (p.labels || []).find((l) => /^v[234]$/i.test(l))?.toLowerCase() ?? null,
      address: p.pairAddress, quoteAddress: q, pairToken: q, quoteSymbol: p.quoteToken?.symbol ?? cls.symbol ?? null,
      pairTokenClass: cls.class, pairAllowed: !!cls.allowed, pairTokenReason: cls.reason ?? null, liquidityUsd: p.liquidity?.usd ?? null,
      feeTierBps: null };
  });
  const equityPools = pools.filter((p) => /^equity/.test(p.pairTokenClass));
  const equityLiq = equityPools.reduce((s, p) => s + (p.liquidityUsd || 0), 0);
  const deepest = pools.find((p) => p.address === best?.pairAddress) ?? pools[0];

  const contractFlags = contract.ok ? [...contract.flags] : [];
  if (mintSim.live) contractFlags.push({ flag: "mint_role_live", detail: mintSim.detail });
  if (blacklist.present) contractFlags.push({ flag: "blacklist", detail: blacklist.detail });
  if (transferSim.reverted || (transferSim.ok === false && transferSim.revertReason))
    contractFlags.push({ flag: "transfer_blocked", detail: `a plain transfer does not deliver: ${transferSim.revertReason}` });
  if (contract.ok && contract.hasPausable && !contract.ownershipRenounced) contractFlags.push({ flag: "pausable_live", detail: "paused() exists and a live role can flip it" });

  const sellImpact = rt.ok ? rt.sellImpactPct : null;
  const depth = {
    sellSideUsdWithin1Pct: sellImpact != null && sellImpact > 0 ? Number((cfg.targetSizeUsd * Math.min(1, 1 / sellImpact)).toFixed(0)) : sellImpact === 0 ? cfg.targetSizeUsd : null,
    sellSideUsdWithin5Pct: sellImpact != null && sellImpact > 0 ? Number((cfg.targetSizeUsd * Math.min(1, 5 / sellImpact)).toFixed(0)) : sellImpact === 0 ? cfg.targetSizeUsd : null,
    inRangeLiquidityPct: null,
    basis: sellImpact != null ? `lower bound: the $${cfg.targetSizeUsd} probe's sell leg moved the price ${sellImpact}%; larger sizes are NOT extrapolated (v3/v4 depth is range-dependent)` : "no probe",
  };
  const flow = flowFrom(whales.trades, { volume24: vol24 });
  /* THE TAX, MEASURED NOT READ. Both legs of the probe executed with eth_call against
     live state; what the chain returned against what the aggregator quoted is the fee
     the contract actually takes today. No source, no ABI, no guessing. */
  /* Two rulers, kept apart because they disagree for a reason. `transferFeeBps` is the
     token's own take on a plain transfer (evm.transferSim: balance delta, no aggregator
     in the path) — the honest "tax" number. The route gaps are chain-vs-quote on the
     aggregator's calldata and carry the quote's pool-model error: CASHCAT, a no-fee
     token, read 0 bps at 05:22 and 607 bps at 09:40 on 2026-09-05 while its transfer
     ruler read 0 both times. A hook-level creator fee shows only in the route gap, so
     it is reported, not discarded — as a gap, not a fee. */
  const tax = {
    transferFeeBps: transferSim.ok ? transferSim.transferFeeBps : null,
    buyFeeBps: transferSim.ok ? transferSim.transferFeeBps : null,
    sellFeeBps: transferSim.ok ? transferSim.transferFeeBps : null,
    buyRouteGapBps: buySim.ok ? buySim.effectiveTaxBps : null,
    sellRouteGapBps: sellSim.ok ? sellSim.effectiveTaxBps : null,
    simulated: transferSim.ok === true,
    basis: "buy/sellFeeBps = balanceOf delta on a simulated transfer (token-level); *RouteGapBps = chain-returned amountOut of the aggregator's calldata vs its quote, which includes the quote's own error",
  };
  const exemptPct = launchTx?.exemptShareOfSupplyPct ?? null;

  return {
    ok: true,
    address: a,
    mint: a,                       // legacy alias; every new reader uses `address`
    token: a,
    chainId: cfg.chainId,
    hook,
    symbol: contract.ok && contract.symbol ? contract.symbol : (best?.baseSymbol ?? "?"),
    name: contract.ok && contract.name ? contract.name : (best?.baseName ?? "?"),
    fetchedAt: new Date().toISOString(),
    band: bandForMarketCap(mcap),
    // A cap off the board has no sleeve; the keys still exist so a seat reads null, not undefined.
    hold: holdWindowFor(mcap) ?? { band: null, holdMinMs: null, holdMaxMs: null },
    pair: best,
    pairs: { count: px.pairs.length, totalLiquidityUsd: Number(totalLiquidityUsd.toFixed(2)),
      venues: [...new Set(px.pairs.map((p) => p.dexId))], pools },
    promotion, callouts, marketRegime, crosscheck,
    ethUsd: { value: ethUsd.value, stalenessSec: ethUsd.stalenessSec, source: ethUsd.source, divergencePct: ethUsd.divergencePct ?? null, error: ethUsd.error ?? null, btcUsd: ethUsd.btcUsd ?? null },
    gasPriceWei: gasPrice != null ? gasPrice.toString() : null,
    contract: contract.ok
      ? { ...contract, flags: contractFlags, tax,
          // The contract's `transferFeeBps` row is "the tax paid today" = the measured sell leg.
          transferFeeBps: tax.sellFeeBps,
          // Flat aliases for the contract table's `contract.tax…` rows.
          taxbuyFeeBps: tax.buyFeeBps, taxsellFeeBps: tax.sellFeeBps, taxsimulated: tax.simulated }
      : { error: contract.error, flags: [], verifiedSource: null, tax, taxbuyFeeBps: tax.buyFeeBps, taxsellFeeBps: tax.sellFeeBps, taxsimulated: tax.simulated },
    buySim,
    mintAccount: { flags: contractFlags, error: contract.ok ? null : contract.error },   // legacy readers look here
    sellSim: sellSim.ok ? { ok: true, revertReason: null, effectiveTaxBps: sellSim.effectiveTaxBps, routeGapBps: sellSim.effectiveTaxBps, transferFeeBps: tax.transferFeeBps,
        simulatedOut: sellSim.simulatedOut, quotedOut: sellSim.quotedOut, router: sellSim.router, slot: sellSim.balanceSlot, status: "simulated",
        basis: "effectiveTaxBps is the chain-vs-quote gap on the aggregator's sell calldata (quote error included); transferFeeBps is the token's own take on a plain transfer" }
      : { ok: false, revertReason: sellSim.revertReason ?? null, effectiveTaxBps: null, routeGapBps: null, transferFeeBps: tax.transferFeeBps,
        unverified: !!sellSim.unverified, reason: sellSim.reason ?? sellSim.revertReason ?? null, status: sellSim.unverified ? "unverified" : "reverted" },
    transferSim,
    holders: holders.ok ? holders : { ok: false, error: holders.error,
      top1Pct: null, top10Pct: null, clusteredHolders: null, bundleSuspect: null, midToHead: null, count: null,
      poolShareOfSupplyPct: poolShare.ok ? poolShare.poolShareOfSupplyPct : null, excluded: poolShare.rows ?? [] },
    exitProbe: rt.ok
      ? { targetSizeUsd: cfg.targetSizeUsd, targetSizeWei: targetWei?.toString() ?? null, ...rt, _buyRoute: undefined, _sellRoute: undefined, gasUsdRoundTrip, error: null }
      : { targetSizeUsd: cfg.targetSizeUsd, error: rt.error, gasUsdRoundTrip: null },
    launch: {
      venue, phase, onCurve,
      name: launchLog ? "pons-v2" : (venue !== "unknown" && venue !== "none" ? venue : null),
      launchpad: launchLog ? "pons" : (pons.launchpadOf(best?.dex) ?? null),
      curveProgressPct: null,
      curveProgressReason: curveState ? "the curve proxy reverted on every progress view tried (see pons-live.js CURVE_VIEWS)" : (onCurve ? "no curve address known" : null),
      graduatedAt: graduation?.graduatedAt ?? null,
      graduationPool: graduation?.pool ?? null,
      graduationScanComplete: graduation?.complete ?? null,
      block: launchLog?.block ?? null, tx: launchLog?.tx ?? null, curve, vault: launchTx?.vault ?? null,
      quoteToken: curveState?.quoteToken ?? null,
      quoteTokenClass: curveState?.quoteToken ? (pairClasses.get(curveState.quoteToken)?.class ?? (await classifyPairTokens([curveState.quoteToken])).get(curveState.quoteToken)?.class ?? "unknown") : null,
      exemptShareOfSupplyPct: exemptPct,
      exemptReason: launchTx ? launchTx.exemptReason ?? null : (launchLog ? "launch receipt unavailable" : "not a PONS V2 launch within the scan window"),
      firstBlockBuyers: launchTx?.firstBlockBuyers ?? [],
      curveViews: curveState?.views ?? null,
      /* PLANNED in the contract, null here: the creator-fee views and claim logs have no
         public ABI (every graduation/fee selector guessed on a live curve proxy reverted,
         2026-09-05 — pons-live.js CURVE_VIEWS). A seat reads null as UNVERIFIED. */
      creatorTaxBps: null, maxCreatorTaxBps: null, feeClaimCount: null, feeClaimedEth: null,
      creatorFeeReason: "no public ABI for the PONS V2 creator-fee views or claim events; unread, not zero",
    },
    launchpad: { venue, creatorHandle: null, creator: launchLog?.creator ?? null },
    deployer: launchLog ? {
      ok: true, address: launchLog.creator, isContract: deployerIsContract, kind: deployerIsContract === true ? "contract" : deployerIsContract === false ? "eoa" : "unknown",
      txSender: launchTx?.deployerTx ?? null,
      priorLaunches: priorLaunches?.ok ? Math.max(0, priorLaunches.launches.filter((l) => l.token !== a).length) : null,
      priorLaunchesWindowBlocks: priorLaunches?.ok ? priorLaunches.toBlock - priorLaunches.fromBlock + 1 : null,
      graduated: null, dead: null, sameImplementation: null, fundedBy: null,
      note: "prior launches counted from the factory log over the last ~30k blocks only; graduations, dead pools and the funder need a trace RPC or the explorer index and are null, not zero",
    } : { ok: false, address: null, isContract: null, kind: "unknown", txSender: null, priorLaunches: null, priorLaunchesWindowBlocks: null,
      graduated: null, dead: null, sameImplementation: null, fundedBy: null,
      note: "deployer unknown — no PONS V2 launch log inside the scan window" },
    equityPair: { paired: /^equity/.test(deepest?.pairTokenClass ?? ""), ticker: deepest?.pairTokenClass?.startsWith("equity") ? (deepest.quoteSymbol ?? null) : null,
      shareOfLiquidityPct: totalLiquidityUsd > 0 ? Number((equityLiq / totalLiquidityUsd * 100).toFixed(1)) : 0 },
    identity,
    lp,
    depth,
    candles: { bars: candles.bars, barsCovered: candles.barsCovered, interval: candles.interval, pool: candles.pool, error: candles.error ?? null },
    whales: { ok: whales.ok, trades: (whales.trades ?? []).filter((t) => t.usd >= 500).slice(0, 12), sample: whales.trades?.length ?? 0 },
    derived: {
      totalLiquidityUsd: liq,
      volToLiqRatio: vol24 && liq ? Number((vol24 / liq).toFixed(2)) : null,
      fdvToLiqRatio: best?.fdv && liq ? Number((best.fdv / liq).toFixed(1)) : null,
      buySellRatio24h: best?.txns?.h24?.sells ? Number(((best.txns.h24.buys || 0) / best.txns.h24.sells).toFixed(2)) : null,
      txns24h: txns24,
      avgTradeSizeUsd: vol24 && txns24 ? Number((vol24 / txns24).toFixed(2)) : null,
      gasRoundTripPct: gasUsdRoundTrip != null ? Number((gasUsdRoundTrip / cfg.targetSizeUsd * 100).toFixed(3)) : null,
      markAgeMs: Date.now() - markAt,
      uniqueTraders24h: flow.uniqueTraders, roundTripWalletPct: flow.roundTripWalletPct, sameBlockTradePct: flow.sameBlockTradePct,
      interArrivalCv: flow.interArrivalCv, commonFunderPct: null, customRouterPct: null, flowSample: flow.sample, flowNote: flow.note,
      exemptShareOfSupplyPct: exemptPct,
      // PLANNED: receipts of the pool's last N swaps (status 0x0, no logs = ArbOS void). Unread here.
      voidedTxPct: null,
    },
    // Attached by enrichWithXRead() for coins that clear the screen; absent means absent.
    xRead: null,
  };
}

/** The buy leg executed: the aggregator's calldata with native value from a stand-in. */
async function buyProbe(token, rt, targetWei) {
  const built = await kyber.build(rt._buyRoute, { sender: evm.PROBE_EOA, recipient: evm.PROBE_EOA, slippageBps: 1000 });
  if (!built.ok) return { ok: false, unverified: true, reason: `route build: ${built.error}` };
  const r = await evm.read("eth_call", [{ from: evm.PROBE_EOA, to: built.routerAddress, data: built.data, value: "0x" + targetWei.toString(16), gas: "0x2dc6c0" },
    "latest", { [evm.PROBE_EOA]: { balance: "0x" + (targetWei * 100n).toString(16) } }], { attempts: 2 });
  if (!r.ok) return { ok: false, reverted: true, revertReason: r.error };
  const out = decodeUint(r.data);
  if (out == null) return { ok: false, unverified: true, reason: "router returned nothing measurable" };
  const quoted = BigInt(rt.tokensOut);
  return { ok: true, simulatedOut: out.toString(), quotedOut: quoted.toString(),
    effectiveTaxBps: quoted > 0n ? Number((quoted - out) * 10_000n / quoted) : null, router: lower(built.routerAddress) };
}

/** Can someone mint? mint(address,uint256) simulated from the owner (or anyone). */
/* A revert is a contract's answer; a 429, a timeout or a closed socket is no answer at all.
   Reading the second as the first turned "the node is busy" into "mint reverts" and "no
   blacklist" — safety flags that failed OPEN (review, 2026-09-05). */
const isRevert = (err) => /revert|execution reverted|invalid opcode|out of gas|VM Exception/i.test(String(err ?? ""));
const isTransport = (err) => !isRevert(err);

async function mintProbe(token, contract) {
  const from = contract.ok && contract.owner && contract.owner !== ZERO_ADDRESS ? contract.owner : evm.PROBE_EOA;
  const r = await evm.read("eth_call", [{ from, to: token, data: encodeCall("mint(address,uint256)", [evm.PROBE_EOA, 1n]) }, "latest", { [from]: { balance: "0xde0b6b3a7640000" } }], { attempts: 2 });
  if (!r.ok && isTransport(r.error)) return { live: null, unverified: true, from, detail: `mint probe unreadable: ${r.error}` };
  if (!r.ok) return { live: false, from, detail: `mint(address,uint256) reverts for ${from}` };
  return { live: true, from, detail: `mint(address,uint256) from ${from === evm.PROBE_EOA ? "ANY address" : "the owner " + from} does not revert — supply can be printed` };
}

/** Is there a blacklist? Any of the common view selectors answering a bool. */
async function blacklistProbe(token) {
  const sigs = ["isBlacklisted(address)", "isBlocked(address)", "blacklist(address)", "isBlackListed(address)", "blocklist(address)", "isFrozen(address)"];
  const rs = await evm.readMany(sigs.map((s) => ({ method: "eth_call", params: [{ to: token, data: encodeCall(s, [evm.PROBE_EOA]) }, "latest"] })));
  const hit = rs.findIndex((r) => r.ok && decodeBool(r.data) != null);
  if (hit >= 0) return { present: true, selector: sigs[hit], detail: `${sigs[hit]} answers — addresses can be blocked from transferring` };
  const unreadable = rs.filter((r) => !r.ok && isTransport(r.error)).length;
  if (unreadable === rs.length) return { present: null, unverified: true, detail: `blacklist probe unreadable: ${rs[0]?.error}` };
  return { present: false };
}

/**
 * SCREENER — stage 1, pure code, zero tokens. Deterministic floors from the charter.
 * The point of this stage is that the expensive stages never see garbage.
 */
export function screen(ev) {
  const fails = [];
  const s = cfg.screen;
  const p = ev.pair || {};
  const d = ev.derived || {};
  const check = (cond, code, detail) => { if (cond) fails.push({ code, detail }); };

  const dep = ev.deployer;
  check(dep?.ok && dep.priorLaunches >= 8 && dep.graduated === 0, "serial_deployer",
    dep?.ok ? `deployer shipped ${dep.priorLaunches}+ coins, zero ever graduated` : null);

  const totalLiq = (ev.pairs?.totalLiquidityUsd || null) ?? p.liquidityUsd;
  const fl = floorsFor(p.marketCap ?? p.fdv ?? null);
  check(totalLiq != null && totalLiq < fl.liq, "thin_liquidity", `total liquidity across ${ev.pairs?.count} venues = ${totalLiq} < floor ${fl.liq} for this cap band`);
  const ageFloorH = fl.ageH ?? s.minPairAgeHours;
  check(p.ageHours == null || p.ageHours < ageFloorH, "too_new", `ageHours=${p.ageHours} < floor ${ageFloorH} for this cap band`);
  check((p.volume?.h24 ?? 0) < fl.vol, "no_volume", `volume.h24=${p.volume?.h24} < floor ${fl.vol} for this cap band`);
  check(d.txns24h < fl.txns, "no_participants", `txns24h=${d.txns24h} < floor ${fl.txns} for this cap band`);
  check(d.volToLiqRatio != null && d.volToLiqRatio > s.maxVolToLiqRatio, "wash_suspect", `volume/liquidity=${d.volToLiqRatio} > ceiling ${s.maxVolToLiqRatio}`);
  check(d.fdvToLiqRatio != null && d.fdvToLiqRatio > s.maxFdvToLiqRatio, "fdv_propped", `fdv/liquidity=${d.fdvToLiqRatio} > ceiling ${s.maxFdvToLiqRatio}`);

  const mcap = p.marketCap ?? p.fdv ?? null;
  check(s.maxMarketCapUsd > 0 && mcap != null && mcap > s.maxMarketCapUsd, "too_big",
    `market cap $${Math.round(mcap ?? 0).toLocaleString()} is over the $${Math.round(s.maxMarketCapUsd || 0).toLocaleString()} ceiling — above the board`);
  check(s.minMarketCapUsd > 0 && mcap != null && mcap < s.minMarketCapUsd, "too_small",
    `market cap $${Math.round(mcap ?? 0).toLocaleString()} is under the $${Math.round(s.minMarketCapUsd || 0).toLocaleString()} floor — too little coin to trade`);

  check(ev.exitProbe?.roundTripLossPct != null && ev.exitProbe.roundTripLossPct > cfg.maxRoundTripSlippagePct,
    "cannot_exit", `round-trip loss ${ev.exitProbe.roundTripLossPct}% > ceiling ${cfg.maxRoundTripSlippagePct}% at $${cfg.targetSizeUsd}`);

  for (const c of (ev.crosscheck?.verdicts ?? []).filter((v) => v.verdict === "KILLED")) check(true, c.check, c.detail);

  /* UNVERIFIED IS NOT SAFE. Every check below reads a fact from the chain, and when
   * the read FAILS the check must not silently pass. For safety, "we could not check"
   * never equals "it is fine" — decline and look at the next coin. */
  const c = ev.contract;
  if (!c || c.error) check(true, "unverified_contract", `could not read the contract (${c?.error ?? "no data"}) — proxy, pause and roles are UNKNOWN, not absent`);
  if (!ev.holders?.ok) check(true, "unverified_holders", `could not rebuild holder distribution (${ev.holders?.error ?? "no data"}) — concentration and bundling are UNKNOWN`);
  if (ev.exitProbe?.roundTripLossPct == null) check(true, "unverified_exit", `the round-trip probe did not complete (${ev.exitProbe?.error ?? "no result"}) — whether this can be SOLD is unknown`);
  if (!ev.sellSim?.ok) {
    if (ev.sellSim?.revertReason) check(true, "sellsim_reverted", `a simulated sell of the probe's tokens REVERTED: ${ev.sellSim.revertReason}`);
    else check(true, "unverified_sellsim", `the sell could not be simulated (${ev.sellSim?.reason ?? "no result"}) — an unproven sell is a roach motel until proven otherwise`);
  }
  if (ev.ethUsd && !(ev.ethUsd.value > 0)) check(true, "unverified_eth_usd", `no ETH/USD mark (${ev.ethUsd.error ?? "none"}) — sizes and gas cannot be priced`);

  const flags = (c?.flags ?? ev.mintAccount?.flags ?? []).map((f) => f.flag ?? f);
  const detailOf = (flag) => (c?.flags ?? []).find((f) => f.flag === flag)?.detail ?? null;
  check(String(ev.address ?? ev.mint ?? "").toLowerCase() === cfg.accessToken, "access_token", "this is the desk's own access token — it opens a floor and is never a position");
  check(ev.mintSim?.unverified === true, "unverified_mint", ev.mintSim?.detail ?? "the mint probe could not be read");
  check(ev.blacklist?.unverified === true, "unverified_blacklist", ev.blacklist?.detail ?? "the blacklist probe could not be read");
  check(Number(ev.buySim?.effectiveTaxBps) > 800, "buy_tax", `the buy leg returns ${ev.buySim?.effectiveTaxBps} bps less than quoted — a tax or a hook on the way in`);
  check(flags.includes("equity_token"), "equity", detailOf("equity_token") ?? "a Robinhood Stock Token — this desk is scoped to memecoins only");
  check(flags.includes("unknown_beacon"), "unknown_beacon", detailOf("unknown_beacon"));
  check(flags.includes("mint_role_live"), "live_mint_role", detailOf("mint_role_live") ?? "supply can be printed and sold to you");
  check(flags.includes("paused_now"), "paused", detailOf("paused_now"));
  check(flags.includes("pausable_live"), "live_pause", detailOf("pausable_live") ?? "a live role can halt every transfer, sells included");
  check(flags.includes("blacklist"), "blacklist_present", detailOf("blacklist"));
  check(flags.includes("transfer_blocked"), "transfer_blocked", detailOf("transfer_blocked"));
  check(flags.includes("upgradeable_eoa"), "upgrade_key_eoa", detailOf("upgradeable_eoa"));
  check(flags.includes("upgraded"), "upgraded_recently", detailOf("upgraded"));
  check(ev.sellSim?.ok && ev.sellSim.effectiveTaxBps != null && ev.sellSim.effectiveTaxBps > cfg.maxRoundTripSlippagePct * 100,
    "sell_tax", `the chain kept ${ev.sellSim?.effectiveTaxBps}bps of a simulated sell against the quote — over the ${cfg.maxRoundTripSlippagePct}% ceiling`);
  check(ev.lp?.pullableSharePct != null && ev.lp.pullableSharePct > 20 && ev.lp.kind === "v2_lp_tokens",
    "lp_pullable", `${ev.lp?.pullableSharePct}% of the v2 LP is neither burned nor classified as locked`);
  const unallowed = (ev.pairs?.pools ?? []).filter((q) => !q.pairAllowed);
  check(ev.pair && unallowed.some((q) => q.address === ev.pair.pairAddress), "pair_token_unallowed",
    `the deepest pool quotes against ${unallowed.find((q) => q.address === ev.pair?.pairAddress)?.quoteAddress} (${unallowed.find((q) => q.address === ev.pair?.pairAddress)?.pairTokenClass}) — not an asset this desk holds`);
  check(ev.launch?.onCurve === true, "on_curve", "still on the bonding curve — no two-sided pool exists yet, and the 99%→0% snipe tax applies at launch");
  check(ev.launch?.exemptShareOfSupplyPct != null && ev.launch.exemptShareOfSupplyPct > 20, "insider_float",
    `${ev.launch?.exemptShareOfSupplyPct}% of supply left the curve in the launch transaction itself`);
  check(ev.holders?.ok && ev.holders.top1Pct > 50, "holder_concentration", `largest non-pool account holds ${ev.holders?.top1Pct}% of supply`);

  /* ONE DEFINITION OF THE EVM GATES. risk-rails.js evmGateFailures() is what Risk,
     Compliance and the Red Team zero a size on; the screen runs the same function so
     the free stage and the paid seats cannot disagree about not_graduated,
     graduated_too_recently, pair_token_gate, insider_float, unverified_code or
     live_authority. The rails REPORT an absent field; the screen REFUSES it — for the
     four facts that decide whether the token can be sold at all, "unread" is a kill. */
  const gates = evmGateFailures(ev);
  for (const g of gates.fails) if (!fails.some((f) => f.code === g.code)) fails.push(g);
  const mustHave = { "launch.phase": "unverified_launch_phase", "pairs.pools[].pairTokenClass": "unverified_pair_token",
    "sellSim.ok": "unverified_sellsim", "contract.cloneOf": "unverified_contract" };
  for (const path of gates.unverified) {
    const code = mustHave[path];
    if (code && !fails.some((f) => f.code === code)) fails.push({ code, detail: `${path} is absent from the bundle — refused, not assumed safe` });
  }

  const id = ev.address ?? ev.mint;
  if (p.ageHours != null && p.ageHours < 72 && p.priceUsd) {
    const born = Date.now() - p.ageHours * 3600e3;
    const first = snapshots.firstSince(id, born);
    if (first && Date.now() - first.ts > 30 * 60e3 && first.price > 0) {
      const ratio = p.priceUsd / first.price;
      check(ratio < 0.5, "post_migration_dump", `trading at ${(ratio * 100).toFixed(0)}% of first-sighting price — the graduate dead zone`);
    }
  }
  {
    const held = snapshots.liqOver(id, Date.now() - 24 * 3600e3);
    check(held.observations >= 96 && held.minLiq != null && held.minLiq < fl.liq, "liquidity_did_not_hold",
      `liquidity dipped to $${Math.round(held.minLiq)} inside 24h (floor $${fl.liq})`);
  }
  return { pass: fails.length === 0, fails };
}

/** The @name out of a social link, or null. Never guesses. */
function handleFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?].*)?$/i);
  const name = m?.[1];
  if (!name) return null;
  if (/^(i|intent|search|home|hashtag|explore)$/i.test(name)) return null;
  return "@" + name;
}

/**
 * THE PAID HALF OF THE EVIDENCE — bought only for coins that already cleared safety.
 * Unchanged in shape; the handle seed now comes from DexScreener's socials (the only
 * place a creator's X link is served for a 4663 token) rather than pump.fun.
 */
export async function enrichWithXRead(ev, hook = "") {
  if (hook === "monitor" || !hasGrok()) return ev;
  const tw = (ev.pair?.socials ?? []).find((s) => s?.type === "twitter")?.url ?? null;
  const handle = handleFromUrl(tw);
  if (handle && ev.launchpad) ev.launchpad.creatorHandle = handle;
  const id = ev.address ?? ev.mint;
  const xr = await grokXRead({ symbol: ev.pair?.baseSymbol ?? id.slice(0, 8), mint: id, address: id, hook, handle, lore: null })
    .catch(() => null);
  if (xr?.ok) ev.xRead = { ...xr.read, citations: xr.citations };
  else if (xr) ev.xRead = { error: xr.error };
  if (ev.xRead?.dev_handle) {
    try {
      const { recordDev, reputationFor } = await import("../devrep.js");
      const prior = reputationFor(ev.xRead.dev_handle);
      recordDev({ handle: ev.xRead.dev_handle, serialRugger: ev.xRead.serial_rugger, rugEvidence: ev.xRead.rug_evidence,
        redFlags: ev.xRead.dev_red_flags, deletedHistory: ev.xRead.deleted_history, symbol: ev.pair?.baseSymbol ?? null, mint: id });
      if (prior && prior.verdict !== "unknown")
        ev.xRead.desk_record = { verdict: prior.verdict, evidence: prior.evidence, seen_before: prior.tokens.length, first_seen: prior.first_seen };
    } catch {}
  }
  return ev;
}
