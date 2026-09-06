import assert from "node:assert/strict";
import fs from "node:fs";
import { independentEthUsdPrice, ETH_USD_FEED_AGGREGATOR } from "./eth-usd-oracle.mjs";

/* ── A ROUTINE CHAINLINK ROTATION MUST NOT READ LIKE AN ATTACK ────────────────
 * The feed is read through the proxy and the underlying aggregator is pinned.
 * The file's own note says why: "Chainlink rotates the aggregator behind it" and
 * "the aggregator is asserted so a proxy pointed somewhere else refuses". Both
 * halves are true at once — the pin is worth keeping, AND it fires on a routine
 * upgrade. The message is the only thing that tells an operator which of the two
 * they are looking at, and this feed is the denominator for every USD-priced
 * stop, so getting that wrong is expensive at exactly the wrong moment. */
const SEL = { decimals: "0x313ce567", aggregator: "0x245a7bfc", latestRoundData: "0xfeaf968c" };
const word = (v) => v.toString(16).padStart(64, "0");
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const ROTATED = "0x" + "cd".repeat(20);

/* Two DISTINCT function instances: both() refuses providers[0] === providers[1]. */
const makeProvider = (aggregator) => async (method, params = []) => {
  if (method !== "eth_call") throw new Error(`unexpected ${method}`);
  const data = String(params[0]?.data || "");
  if (data.startsWith(SEL.decimals)) return "0x" + word(8n);
  if (data.startsWith(SEL.aggregator)) return "0x" + addrWord(aggregator);
  if (data.startsWith(SEL.latestRoundData)) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return "0x" + [1n, 245_500_000_000n, now, now, 1n].map(word).join("");
  }
  throw new Error(`unexpected selector ${data.slice(0, 10)}`);
};
const pair = (aggregator) => [makeProvider(aggregator), makeProvider(aggregator)];

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`PASS  ${name}`); };

await ok("the pinned aggregator still reads a price — the check is not just refusing everything", async () => {
  const out = await independentEthUsdPrice(pair(ETH_USD_FEED_AGGREGATOR));
  assert.ok(out.price > 0, `expected a usable price, got ${JSON.stringify(out).slice(0, 140)}`);
});

await ok("a rotated aggregator is refused — the pin still does its job", async () => {
  await assert.rejects(() => independentEthUsdPrice(pair(ROTATED)),
    (e) => /routes to aggregator/.test(e.message));
});

await ok("...and says a rotation is ROUTINE rather than implying a compromise", async () => {
  const err = await independentEthUsdPrice(pair(ROTATED)).catch((e) => e);
  assert.match(err.message, /ROUTINE/, "an operator must not read an upgrade as an attack");
  assert.match(err.message, /update the pin/, "and must be told the remedy");
  assert.match(err.message, /no denominator/, "and what it costs while unfixed");
});

await ok("...carrying the addresses as data, so a monitor need not scrape prose", async () => {
  const err = await independentEthUsdPrice(pair(ROTATED)).catch((e) => e);
  assert.equal(err.oracleRotation, true);
  assert.equal(err.observedAggregator, ROTATED.toLowerCase());
  assert.equal(String(err.pinnedAggregator).toLowerCase(), ETH_USD_FEED_AGGREGATOR.toLowerCase());
  assert.equal(err.failureClass, "oracle",
    "classified so the exit fuse treats it as a fact about Chainlink, not about a pool");
});

await ok("the boot rehearsal proves the feed, not only the route", () => {
  const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
  const i = poller.indexOf("THE EXITS' DENOMINATOR IS PART OF BEING READY");
  assert.ok(i > 0, "the readiness block must prove the denominator");
  const block = poller.slice(i, i + 1200);
  assert.match(block, /independentEthUsdPrice\(providers\)/,
    "a rehearsal that skips the feed discovers a rotation at 3am instead of at boot");
  assert.match(block, /every USD-priced stop depends on is unusable/,
    "and the failure must name what broke");
  assert.match(block, /probeExecutionReadiness/, "without dropping what it already proved");
});

console.log(`\n${n} ETH/USD rotation checks passed`);
