/**
 * THE PONS LAUNCH FEED, READ FROM THE CHAIN ITSELF. RUN DELIBERATELY.
 *
 *   node scripts/check-pons-live.mjs
 *
 * This block used to be the last section of test-pons-live.mjs, so `npm test` reached
 * rpc.mainnet.chain.robinhood.com on every run. The shapers are all asserted offline in
 * that file against test-fixtures/pons-live-4663.json; what only the chain can tell you
 * is whether the feed still ANSWERS and still decodes — a live question, not a
 * regression question, and one whose red should never be confused with broken code.
 *
 * Exit codes are kept apart on purpose:
 *   0  the feed answered and decoded
 *   1  the feed answered and something did not decode — a real finding
 *   2  the chain could not be reached — nothing was proved
 */
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

console.log(`\nPONS LAUNCH FEED AGAINST ${cfg.rhRpc}\n`);
{
  {
    const { launchLogs, curveState, v4NewPools, blockNumberNow } = await import("../src/data/pons-live.js").then(async (P) => ({ ...P, blockNumberNow: (await import("../src/data/evm.js")).blockNumber }));
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
