import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { emit } from "./lib/bus.js";
import { canonicalAddress, isEvmAddress } from "./canonical.js";

/* THE VENUE, per the shared contract. Chain 4663, Kyber's aggregator for routing, the
 * native sentinel Kyber uses for ETH, and the three human-facing pages a slip links to.
 * Blockscout is HUMAN-facing only — it answers 403 to a curl user-agent and 200 to a
 * browser, and it is never in the hot path (market brief, 2026-09-05). */
export const CHAIN_ID = 4663;
export const KYBER_API = process.env.KYBER_API || "https://aggregator-api.kyberswap.com/robinhood/api/v1";
export const KYBER_CLIENT_ID = process.env.KYBER_CLIENT_ID || "claude-company-robinhood";
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** The pages a human opens to check a coin before signing anything. */
export function orderLinks(address, pool = null) {
  const addr = canonicalAddress(address);
  const p = pool ? canonicalAddress(pool) : null;
  return {
    blockscout: `https://robinhoodchain.blockscout.com/token/${addr}`,
    dexscreener: p ? `https://dexscreener.com/robinhood/${p}` : `https://dexscreener.com/search?q=${addr}`,
    geckoterminal: p ? `https://www.geckoterminal.com/robinhood/pools/${p}` : null,
  };
}

/* THE LEG THE TRADE IS QUOTED IN. A PONS V2 launch chooses its pair token from the
 * factory's approvedPairTokens(address) — WETH or USDG today (USDG has 6 decimals) —
 * and a V1 launch is always WETH-paired. The slip names that leg, because "buy X" on
 * this chain is really "sell WETH for X" or "sell USDG for X", and the wallet shows
 * the human exactly that. Read from the bundle; never guessed from the symbol. */
export function pairLegOf(ev) {
  const pool = ev?.pairs?.pools?.[0] ?? null;
  const addr = pool?.pairToken ?? pool?.quoteToken ?? ev?.pair?.quoteToken?.address ?? ev?.launch?.pairToken ?? null;
  const sym = pool?.pairSymbol ?? pool?.quoteSymbol ?? ev?.pair?.quoteToken?.symbol ?? ev?.launch?.pairSymbol ?? null;
  if (!isEvmAddress(addr) && !sym) return null;
  const a = isEvmAddress(addr) ? canonicalAddress(addr) : null;
  const symbol = sym ?? (a === WETH.toLowerCase() ? "WETH" : a === USDG.toLowerCase() ? "USDG" : "?");
  /* Decimals follow the ASSET, not a default: a symbol-only USDG leg sized in 18 decimals
     asked for a $2.45 billion spend on a $6 order (review, 2026-09-05). */
  const decimals = a === USDG.toLowerCase() || /^USDG$/i.test(symbol) ? 6 : 18;
  return { address: a, symbol, decimals };
}

/** One line describing the Kyber route the exit probe (or the build below) saw. */
export function routeSummary(ev, built = null) {
  const route = built?.route ?? ev?.exitProbe?.route ?? ev?.kyber?.route ?? null;
  if (!route) return "Kyber route: not quoted in this bundle";
  const hops = Array.isArray(route) ? route : Array.isArray(route.hops) ? route.hops : null;
  if (hops?.length) {
    return "Kyber route: " + hops.map((h) => `${h.exchange ?? h.dex ?? "?"}${h.pool ? ` ${String(h.pool).slice(0, 10)}…` : ""}`).join(" → ");
  }
  return `Kyber route: ${typeof route === "string" ? route : JSON.stringify(route).slice(0, 160)}`;
}

/**
 * Builds a REAL, executable swap calldata — and stops one step short of sending it.
 *
 * Requires DESK_WALLET_ADDRESS: a PUBLIC address only. This desk has no code path that
 * reads, stores, requests or accepts a private key or seed phrase, and none should
 * ever be added.
 *
 * ─── READ THIS BEFORE ENABLING IT ───────────────────────────────────────────────
 * "The server never holds a key" is true here and is NOT the property that matters.
 * The privilege that matters is choosing WHAT THE KEY SIGNS. Prepared calldata hands
 * that privilege to this process in full: if the desk, its host, its RPC or the
 * aggregator were compromised, it could compose a call that drains the wallet, and
 * you would approve it during a routine action without reading it.
 *
 * So this path is OFF unless DESK_PREPARE_TX=1 is set deliberately, and the order slip
 * always prints the decoded terms next to it. The explorer/DEX links are the safe
 * default: there you build the trade in an interface you trust, and nothing this desk
 * composed is ever put in front of your signature.
 *
 * Kyber's two-step API: GET routes for a quote, POST route/build for calldata. Both
 * are read-only HTTP; neither touches the chain. Gas is read from the quote itself
 * (gasUsd) — never cached, because eth_gasPrice moved 0.02 -> 0.7 gwei in two weeks.
 * ────────────────────────────────────────────────────────────────────────────────
 */
export async function buildUnsignedSwap({ token, usd, ethUsd = null, slippageBps = 150, pairLeg = null }) {
  if (process.env.DESK_PREPARE_TX !== "1") {
    return { ok: false, error: "disabled — set DESK_PREPARE_TX=1 only if you will read every transaction before signing" };
  }
  const sender = process.env.DESK_WALLET_ADDRESS;
  if (!isEvmAddress(sender)) return { ok: false, error: "DESK_WALLET_ADDRESS not set (public 0x address only)" };
  if (!isEvmAddress(token)) return { ok: false, error: "token is not a 0x address" };

  try {
    // Size in the pair leg. USDG is a dollar with 6 decimals; ETH needs a live ETH/USD.
    const leg = pairLeg ?? { address: USDG.toLowerCase(), symbol: "USDG", decimals: 6 };
    if (!leg.address) return { ok: false, error: `pair leg ${leg.symbol} has no address — cannot size an order against it` };
    let amountIn;
    if (leg.decimals === 6) amountIn = BigInt(Math.round(usd * 1e6));
    else {
      const px = Number(ethUsd);
      if (!(px > 0)) return { ok: false, error: "ETH/USD unavailable — cannot size an ETH-leg order" };
      amountIn = BigInt(Math.round((usd / px) * 1e18));
    }
    const tokenIn = leg.address ?? USDG.toLowerCase();
    const headers = { "x-client-id": KYBER_CLIENT_ID, "content-type": "application/json" };
    const qr = await fetch(`${KYBER_API}/routes?tokenIn=${tokenIn}&tokenOut=${canonicalAddress(token)}&amountIn=${amountIn}`,
      { headers });
    if (!qr.ok) return { ok: false, error: `quote HTTP ${qr.status}` };
    const quote = await qr.json();
    const summary = quote?.data?.routeSummary;
    if (!summary) return { ok: false, error: quote?.message || "no route" };

    const br = await fetch(`${KYBER_API}/route/build`, {
      method: "POST", headers,
      body: JSON.stringify({ routeSummary: summary, sender, recipient: sender,
        slippageTolerance: slippageBps, source: KYBER_CLIENT_ID }),
    });
    if (!br.ok) return { ok: false, error: `route-build HTTP ${br.status}` };
    const built = await br.json();
    const d = built?.data;
    if (!d?.data || !d?.routerAddress) return { ok: false, error: built?.message || "no calldata returned" };

    return {
      ok: true,
      unsignedCall: { chainId: CHAIN_ID, to: d.routerAddress, data: d.data,
        value: tokenIn.toLowerCase() === NATIVE_ETH.toLowerCase() ? amountIn.toString() : "0" },
      signed: false,
      submitted: false,
      wallet: sender,
      pairLeg: leg,
      amountIn: amountIn.toString(),
      expectedOut: d.amountOut ?? summary.amountOut ?? null,
      amountInUsd: summary.amountInUsd ?? null,
      amountOutUsd: summary.amountOutUsd ?? null,
      gasUsd: summary.gasUsd ?? null,
      gasPriceWei: summary.gasPrice ?? null,
      route: summary.route ?? null,
      note: "UNSIGNED. This desk cannot and will not sign or submit it.",
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * THE ORDER SLIP — what actually comes out from under the CEO's door.
 * A human reads this, opens the explorer/DEX link, and signs. Nothing else executes.
 */
export async function writeOrderSlip(cycle, { ev, ceo, pm, risk, ticket }) {
  const address = canonicalAddress(ev.address ?? ev.token ?? ev.mint);
  const pool = ev.pair?.pairAddress ?? ev.pairs?.pools?.[0]?.address ?? null;
  const links = orderLinks(address, pool);
  const leg = pairLegOf(ev);
  const size = ceo.order_size_usd ?? risk?.position_size_usd ?? 0;

  let tx = { ok: false, error: "not requested" };
  if (ceo.ruling === "APPROVE" && size > 0 && process.env.DESK_WALLET_ADDRESS && process.env.DESK_PREPARE_TX === "1") {
    emit("order:building", { mint: address, symbol: ev.symbol });
    tx = await buildUnsignedSwap({ token: address, usd: size, ethUsd: ev.ethUsd?.value ?? null,
      slippageBps: ticket?.max_slippage_bps ?? 150, pairLeg: leg });
  }

  const dir = path.join(ROOT, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cycle}__ORDER__${ev.symbol}__${ceo.ruling}.md`);

  const L = [];
  L.push(`# Order slip — ${ev.symbol} · ${ceo.ruling}`);
  L.push(`\n\`${address}\` · chain ${CHAIN_ID}\n`);
  L.push(`> **Unsigned. Nothing has been executed.** Claude Company cannot sign or send.`);
  L.push(`> To act on this, open a link below and place it yourself.\n`);
  L.push(`## The CEO's ruling\n`);
  L.push(`**${ceo.one_line}**\n`);
  L.push(`${ceo.reasoning}\n`);
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| Ruling | **${ceo.ruling}** |`);
  L.push(`| Size | $${size}${ceo.size_change_reason ? ` _(changed: ${ceo.size_change_reason})_` : ""} |`);
  L.push(`| PM conviction | ${pm?.conviction ?? "—"}/100 |`);
  L.push(`| Stop | $${ticket?.stop_price ?? "—"} |`);
  L.push(`| Max slippage | ${ticket?.max_slippage_bps ?? "—"} bps |`);
  L.push(`| Pair leg | ${leg ? `${leg.symbol}${leg.address ? ` \`${leg.address}\`` : ""}` : "unknown — the bundle named no pair token"} |`);
  L.push(`| ${routeSummary(ev, tx.ok ? tx : null).split(":")[0]} | ${routeSummary(ev, tx.ok ? tx : null).split(": ").slice(1).join(": ")} |`);
  L.push(`| Gas, round trip | ${ev.exitProbe?.gasUsdRoundTrip != null ? `$${Number(ev.exitProbe.gasUsdRoundTrip).toFixed(2)}` : "unmeasured"} (flat — read live, never cached) |`);
  L.push(`| CEO confidence | ${ceo.confidence} |`);

  if (ceo.conditions?.length) L.push(`\n**Conditions**\n${ceo.conditions.map((c) => `- ${c}`).join("\n")}`);
  if (ceo.questions_for_the_desk?.length)
    L.push(`\n**Back to the desk**\n${ceo.questions_for_the_desk.map((q) => `- ${q}`).join("\n")}`);

  L.push(`\n## Place it\n`);
  L.push(`- **Blockscout (token):** ${links.blockscout}`);
  L.push(`- DexScreener: ${links.dexscreener}`);
  L.push(`- GeckoTerminal: ${links.geckoterminal ?? "— (no pool address in the bundle)"}`);
  L.push(`\nBlockscout sits behind a browser challenge, so this desk never reads it server-side and does not try.`);
  L.push(`Open the link in your own browser, where your wallet lives.`);

  if (tx.ok) {
    L.push(`\n## Prepared calldata (unsigned)\n`);
    L.push(`Built against KyberSwap for wallet \`${tx.wallet}\`. Signed: **no**. Submitted: **no**.\n`);
    L.push(`| Field | Value |`);
    L.push(`|---|---|`);
    L.push(`| Router (to) | \`${tx.unsignedCall.to}\` |`);
    L.push(`| Pays | ${tx.amountIn} base units of ${tx.pairLeg.symbol} (${tx.amountInUsd != null ? `$${tx.amountInUsd}` : "—"}) |`);
    L.push(`| Expected out | ${tx.expectedOut ?? "—"} (raw units) |`);
    L.push(`| Gas (this leg) | ${tx.gasUsd != null ? `$${tx.gasUsd}` : "—"} at ${tx.gasPriceWei ?? "?"} wei |`);
    L.push(`| ${routeSummary(null, tx).split(":")[0]} | ${routeSummary(null, tx).split(": ").slice(1).join(": ")} |`);
    L.push(`\n> **Do not sign this without reading it.** This desk composed it. Holding no key is`);
    L.push(`> not the same as being safe: whoever chooses what your key signs holds the real`);
    L.push(`> privilege, and for this calldata that is this process. Check in your wallet that it`);
    L.push(`> spends **${size} ${tx.pairLeg.symbol}-worth** and nothing else, that the token received is \`${address}\`,`);
    L.push(`> and that no other approval or transfer is touched. If anything differs, do not approve it.`);
    L.push(`\n<details><summary>Calldata — verify, then sign in your own wallet</summary>\n\n\`\`\`\nto:    ${tx.unsignedCall.to}\nvalue: ${tx.unsignedCall.value}\ndata:  ${tx.unsignedCall.data}\n\`\`\`\n</details>`);
  } else if (ceo.ruling === "APPROVE") {
    L.push(`\n_No calldata was prepared: ${tx.error}._`);
  }

  L.push(`\n---\n_Claude Company · ${new Date().toISOString()} · research and order preparation only._`);
  fs.writeFileSync(file, L.join("\n"));

  const rel = path.relative(ROOT, file);
  emit("order:slip", { mint: address, symbol: ev.symbol, ruling: ceo.ruling, size, file: rel,
    blockscout: links.blockscout, dexscreener: links.dexscreener });
  return { file: rel, links, tx, size, pairLeg: leg };
}
