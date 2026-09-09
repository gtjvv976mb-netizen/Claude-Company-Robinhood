/**
 * THE EVIDENCE GATHERER, RUN AGAINST THE REAL CHAIN. RUN DELIBERATELY.
 *
 *   node scripts/check-evm-evidence-live.mjs
 *
 * This block used to be the last section of test-evm-evidence.mjs, where it was the most
 * expensive thing in `npm test` by a wide margin: 20.8 seconds and 50 requests to six
 * different hosts — rpc.mainnet.chain.robinhood.com, api.dexscreener.com,
 * api.coingecko.com, aggregator-api.kyberswap.com, api.geckoterminal.com and
 * robinhoodchain.blockscout.com. Four of those are third parties whose rate limits have
 * nothing to do with whether this repo's code is correct, and a 429 from any of them
 * turned a green suite red.
 *
 * Every ruler and every kill is asserted offline in that file, against gather() output
 * recorded in test-fixtures/gather-*-4663.json. What only the live chain can tell you is
 * whether gather() still COMPLETES against the sources as they are today, and whether the
 * transfer ruler still reads what it read when it was calibrated. That is a live
 * question, and this is where it is asked.
 *
 * Exit codes are kept apart on purpose:
 *   0  the live bundle gathered and every assertion held
 *   1  something the chain says disagrees with the code — a real finding
 *   2  the chain could not be reached — nothing was proved
 */
import { TRANSFER_PROBE_CODE } from "../src/lib/evm.js";
import { screen } from "../src/data/evidence.js";
import { cfg } from "../src/config.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/* REACHABILITY IS NOT AN ASSERTION. Prove the transport before judging anything, so a
   dead network exits 2 with an explanation rather than printing a wall of red. */
{
  let live = false, why = "chainId was not 0x1237";
  try {
    const r = await fetch(cfg.rhRpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(6000) });
    live = (await r.json())?.result === "0x1237";
  } catch (e) { why = e.message; }
  if (!live) {
    console.error(`\nCOULD NOT REACH ${cfg.rhRpc}: ${why}`);
    console.error("Nothing was checked. This is a network result, not a code result.\n");
    process.exit(2);
  }
}

console.log(`\nLIVE EVIDENCE AGAINST ${cfg.rhRpc}\n`);
{
  {
    const { gather } = await import("../src/data/evidence.js");
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
      const E = await import("../src/data/evm.js");
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
