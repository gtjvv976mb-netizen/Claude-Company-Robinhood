/* THE ROUND TRIP, IN ETH, NOT IN THE AGGREGATOR'S USD MARKS.
 *
 * The first rehearsal reported "-2.8% lost buying", i.e. more dollars out than in. That
 * is not free money, it is two price feeds disagreeing: the aggregator prices ETH and
 * the memecoin from different sources, so a USD-vs-USD comparison measures the gap
 * between those feeds and not the cost of trading. The port research hit the same
 * artifact and called it out.
 *
 * The honest measure is units-consistent: quote ETH -> token, take the EXACT output,
 * quote it straight back, and compare ETH against ETH. Everything below is read-only. */
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const BASE = "https://aggregator-api.kyberswap.com/robinhood/api/v1/routes";
const HDR = { "x-client-id": "claude-co-rehearsal" };
const FROM = "0x000000000000000000000000000000000000dEaD";

const quote = async (tokenIn, tokenOut, amountIn) => {
  const qs = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString(),
    to: FROM, gasInclude: "true" });
  const r = await fetch(`${BASE}?${qs}`, { headers: HDR, signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  if (!j?.data?.routeSummary) throw new Error(j?.message || `no route (${r.status})`);
  return j.data.routeSummary;
};

const TOKENS = {
  CASHCAT: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
  PONS:    "0x39dBED3a2bd333467115dE45665cC57F813C4571",
  AI:      "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18",
};
const CLIPS = [10n ** 16n, 5n * 10n ** 16n, 2n * 10n ** 17n];   // 0.01, 0.05, 0.2 ETH

console.log("round trip measured in ETH — buy, then sell the exact output back\n");
console.log("token     clip ETH   out                     back ETH      round trip   gas both legs");
const results = [];
for (const [sym, addr] of Object.entries(TOKENS)) {
  for (const clip of CLIPS) {
    try {
      const buy = await quote(NATIVE, addr, clip);
      const sell = await quote(addr, NATIVE, BigInt(buy.amountOut));
      const back = BigInt(sell.amountOut);
      const lossPct = Number((clip - back) * 1000000n / clip) / 10000;
      const gas = Number(buy.gas) + Number(sell.gas);
      console.log(`${sym.padEnd(9)} ${(Number(clip)/1e18).toFixed(2).padStart(8)}   ` +
        `${buy.amountOut.slice(0,18).padEnd(22)} ${(Number(back)/1e18).toFixed(6).padStart(10)}   ` +
        `${lossPct.toFixed(3).padStart(8)}%   ${gas.toLocaleString().padStart(9)}`);
      results.push({ sym, clipEth: Number(clip)/1e18, lossPct, gas });
    } catch (e) {
      console.log(`${sym.padEnd(9)} ${(Number(clip)/1e18).toFixed(2).padStart(8)}   ${e.message.slice(0,58)}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}
if (results.length) {
  const sorted = [...results].sort((a,b) => a.lossPct - b.lossPct);
  const med = sorted[Math.floor(sorted.length/2)];
  console.log(`\n${results.length} round trips. best ${sorted[0].lossPct.toFixed(3)}% (${sorted[0].sym} @ ${sorted[0].clipEth} ETH), ` +
    `median ${med.lossPct.toFixed(3)}%, worst ${sorted.at(-1).lossPct.toFixed(3)}% (${sorted.at(-1).sym} @ ${sorted.at(-1).clipEth} ETH)`);
  const medGas = [...results].sort((a,b)=>a.gas-b.gas)[Math.floor(results.length/2)].gas;
  console.log(`median gas for a full round trip: ${medGas.toLocaleString()} units`);
}
