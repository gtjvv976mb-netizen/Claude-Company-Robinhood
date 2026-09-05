/**
 * THE BUY BUTTON ON ROBINHOOD CHAIN.
 *
 * The Solana floor embedded Jupiter's swap widget (and carried a shadow-root style fix
 * for its 134px button). Robinhood Chain has no drop-in equivalent, so the button hands
 * the visitor to KyberSwap's own site with the pair prefilled — the aggregator the
 * executor already quotes through — and to the pool on DexScreener as the second door.
 * What this pins: no third-party script is loaded by the page for a swap, no Jupiter or
 * GMGN residue remains on the buy path, the links point at the `robinhood` slugs both
 * sites use, and the desk still never touches a transaction.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nTHE SWAP OPENS ON KYBER, WITH THE POOL AS THE SECOND DOOR");
{
  const start = html.indexOf("/* ── buying a call, without ever touching the transaction");
  const swap = html.slice(start, html.indexOf("window.__renderWatchInto = ", start));
  ok("the buy block exists", swap.length > 300, `${swap.length} chars`);
  ok("KyberSwap's robinhood slug is the swap target", /https:\/\/kyberswap\.com\/swap\/robinhood/.test(swap));
  ok("a buy is eth-to-<token>", /eth-to-\$\{mint\}/.test(swap));
  ok("a sell is <token>-to-eth", /\$\{mint\}-to-eth/.test(swap));
  ok("DexScreener's robinhood chainId is the pool link", /https:\/\/dexscreener\.com\/robinhood/.test(swap));
  ok("a blocked popup falls back to the pool rather than doing nothing", /if \(!w\)[\s\S]{0,200}poolLink\(mint\)/.test(swap));
  ok("openSwap is still the one entry point the call cards use", (html.match(/openSwap\(\{/g) || []).length >= 3);
}

console.log("\nNO THIRD-PARTY SWAP CODE RUNS ON THE FLOOR");
{
  ok("no Jupiter plugin script", !/plugin\.jup\.ag/.test(html));
  ok("no Jupiter init or shadow-root trim left behind", !/window\.Jupiter|trimJupiterSwapButton/.test(html));
  ok("no Solana wrapped-SOL mint constant", !/So11111111111111111111111111111111111111112/.test(html));
  ok("no GMGN /sol/ links", !/gmgn\.ai\/sol\//.test(html));
  ok("no Solscan links", !/solscan\.io/.test(html));
  ok("explorer links go to Blockscout", /robinhoodchain\.blockscout\.com\/tx\//.test(html) && /robinhoodchain\.blockscout\.com\/address\//.test(html));
  ok("the DexScreener token lookup is chain-scoped", /api\.dexscreener\.com\/tokens\/v1\/robinhood\//.test(html));
}

console.log("\nTHE PHONE HANDOFF LOOKS FOR AN EVM PROVIDER");
{
  const i = html.indexOf("THE PHONE HANDOFF");
  const block = html.slice(i, i + 1600);
  ok("it checks window.phantom.ethereum / window.ethereum, not window.solana",
    /window\.phantom\?\.ethereum \|\| window\.ethereum/.test(block) && !/window\.solana/.test(block));
  ok("Phantom's universal browse link is kept", /phantom\.app\/ul\/browse/.test(block));
}

console.log("\nTHE DESK STILL NEVER TOUCHES THE TRANSACTION");
{
  const start = html.indexOf("/* ── buying a call, without ever touching the transaction");
  const swap = html.slice(start, html.indexOf("window.__renderWatchInto = ", start));
  ok("nothing here signs, holds a key, or builds a transaction",
    !/(privateKey|secretKey|signTransaction|eth_sendTransaction|Keypair)/.test(swap));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
