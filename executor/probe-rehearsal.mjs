/* A NO-SIGN EXECUTION REHEARSAL ON ROBINHOOD CHAIN.
 * Quote a real buy, get real calldata, simulate it against the live chain, and price the
 * round trip. Nothing is signed, no key is touched, no funds move. This is the EVM
 * equivalent of WALL-ST-E's readiness probe, and its job is to answer one question:
 * could this desk actually execute here, today? */
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const CHAIN = 4663;
// A wallet that holds nothing — we only need an address shape to quote against.
const FROM = "0x000000000000000000000000000000000000dEaD";

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

const IN = 10n ** 16n;               // 0.01 ETH
console.log(`rehearsing a ${Number(IN) / 1e18} ETH buy of CASHCAT on chain ${CHAIN}\n`);

// ── 1. the aggregator: does it quote us, keyless? ──────────────────────────
const qs = new URLSearchParams({ tokenIn: NATIVE, tokenOut: CASHCAT,
  amountIn: IN.toString(), to: FROM, saveGas: "false", gasInclude: "true" });
let route = null;
try {
  const r = await fetch(`https://aggregator-api.kyberswap.com/robinhood/api/v1/routes?${qs}`,
    { signal: AbortSignal.timeout(20_000), headers: { "x-client-id": "claude-co-rehearsal" } });
  const j = await r.json();
  route = j?.data?.routeSummary ?? null;
  console.log(`1. QUOTE      ${r.status} ${route ? "ok" : "no route"}`);
  if (route) {
    console.log(`   in        ${(Number(route.amountIn) / 1e18).toFixed(6)} ETH  ($${Number(route.amountInUsd).toFixed(2)})`);
    console.log(`   out       ${route.amountOut} CASHCAT  ($${Number(route.amountOutUsd).toFixed(2)})`);
    console.log(`   gas est   ${route.gas} units  ($${Number(route.gasUsd).toFixed(4)})`);
    const slip = (1 - Number(route.amountOutUsd) / Number(route.amountInUsd)) * 100;
    console.log(`   one leg   ${slip.toFixed(3)}% of value lost buying`);
  }
} catch (e) { console.log(`1. QUOTE      FAILED: ${e.message}`); }

// ── 2. build: does it hand us executable calldata? ─────────────────────────
let built = null;
if (route) {
  try {
    const r = await fetch("https://aggregator-api.kyberswap.com/robinhood/api/v1/route/build",
      { method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/json", "x-client-id": "claude-co-rehearsal" },
        body: JSON.stringify({ routeSummary: route, sender: FROM, recipient: FROM,
          slippageTolerance: 100 }) });
    const j = await r.json();
    built = j?.data ?? null;
    console.log(`\n2. BUILD      ${r.status} ${built?.data ? "ok" : "no calldata"}`);
    if (built?.data) {
      console.log(`   router    ${built.routerAddress}`);
      console.log(`   calldata  ${built.data.length} chars (${(built.data.length - 2) / 2} bytes)`);
      console.log(`   minOut    ${built.amountOut} after 1% tolerance`);
    }
  } catch (e) { console.log(`\n2. BUILD      FAILED: ${e.message}`); }
}

// ── 3. simulate: would the chain accept it? ────────────────────────────────
if (built?.data) {
  try {
    const code = await rpc("eth_getCode", [built.routerAddress, "latest"]);
    console.log(`\n3. SIMULATE   router has ${(code.length - 2) / 2} bytes of code on chain`);
    // A dead address holds no ETH, so state-override it enough to pay for the swap.
    const gas = await rpc("eth_call", [
      { from: FROM, to: built.routerAddress, data: built.data, value: "0x" + IN.toString(16) },
      "latest",
      { [FROM]: { balance: "0x" + (IN * 100n).toString(16) } },
    ]).then(() => "accepted").catch((e) => `reverted: ${e.message.slice(0, 90)}`);
    console.log(`   eth_call  ${gas}`);
  } catch (e) { console.log(`\n3. SIMULATE   FAILED: ${e.message}`); }
}

// ── 4. what it costs to be here at all ─────────────────────────────────────
const [gp, bn] = await Promise.all([rpc("eth_gasPrice", []), rpc("eth_blockNumber", [])]);
const gwei = parseInt(gp, 16) / 1e9;
const gasUnits = route ? Number(route.gas) : 227_860;
console.log(`\n4. COST       block ${parseInt(bn, 16).toLocaleString()}, gas ${gwei.toFixed(3)} gwei`);
console.log(`   a swap    ${gasUnits.toLocaleString()} gas = ${(gasUnits * gwei / 1e9).toFixed(8)} ETH`);
