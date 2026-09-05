/**
 * A POOL IS NOT A HOLDER.
 *
 * On the Solana desk, getTokenLargestAccounts returned TOKEN ACCOUNT addresses and the
 * exclusion compared them to an OWNER authority — two things that can never be equal —
 * so for its whole life the pool was counted as a holder and nothing was ever excluded.
 * Measured live while fixing it: a graduated coin read 62.6% and 26.8% for its top two
 * "holders", both pools, and every coin still on its curve read the curve itself as one
 * holder of 40-99% of supply. Concentration is a safety input — the forensics seat
 * treats a dominant holder as a rug signature — so that was a manufactured rug
 * signature on the whole population, and it would have hidden a real one as well.
 *
 * On chain 4663 holders are rebuilt from the Transfer ledger (src/data/evm.js) and the
 * pool, curve, router, vault and burn addresses are removed BY LABEL, so the seat sees
 * what was taken out. The invariant this file guards is the same one: the pool is not
 * a holder, what was excluded is reported rather than dropped, and a ledger the desk
 * could not read completely is UNVERIFIED rather than a number. The data lane's own
 * test (test-evm-evidence.mjs) covers shapeHolders' arithmetic; this one drives the two
 * live shapes that exposed the Solana bug through the EVM reader, and the wiring.
 */
import fs from "node:fs";
import { shapeHolders, holdersFromLedger } from "./src/data/evm.js";
import { DEAD_ADDRESS } from "./src/lib/evm.js";   // the address constants live in the leaf module

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const addr = (b) => "0x" + b.toString(16).padStart(2, "0").repeat(20);
const SUPPLY = 1_000_000_000n * 10n ** 18n;          // 1e9 tokens at 18 decimals
const share = (pct) => SUPPLY * BigInt(Math.round(pct * 100)) / 10_000n;

console.log("\nTHE TWO LIVE SHAPES THAT EXPOSED THE BUG, THROUGH THE EVM READER");
{
  /* An on-curve coin: the curve holds 40.52%, the largest real wallet 8.1%. */
  const curve = addr(0xc1), whale = addr(0x01), crowd = [addr(0x02), addr(0x03), addr(0x04)];
  const bal = new Map([[curve, share(40.52)], [whale, share(8.1)], ...crowd.map((a, i) => [a, share(3 - i)])]);
  const h = shapeHolders(bal, { supply: SUPPLY, exclude: [{ address: curve, label: "curve:pons-v2" }] });
  ok("the curve is not the top holder", h.ok && h.top1Pct === 8.1, `top1 ${h.top1Pct}% (was 40.52% when the curve counted)`);
  ok("...and what was excluded is reported, not silently dropped",
    h.excluded.length === 1 && h.excluded[0].label === "curve:pons-v2" && h.excluded[0].pctOfSupply === 40.52,
    JSON.stringify(h.excluded));
  ok("the pool share is stated beside the holder figures", h.poolShareOfSupplyPct === 40.52, `${h.poolShareOfSupplyPct}%`);

  /* A graduate: two pools at 62.58% and 26.76%, then real wallets. */
  const p1 = addr(0xa1), p2 = addr(0xa2);
  const g = shapeHolders(new Map([[p1, share(62.58)], [p2, share(26.76)], [whale, share(4)], [crowd[0], share(1)], [DEAD_ADDRESS, share(2)]]),
    { supply: SUPPLY, exclude: [{ address: p1, label: "pool:uniswap-v4" }, { address: p2, label: "pool:uniswap-v3" }] });
  ok("a graduate no longer reads two pools as 89% concentration", g.ok && g.top1Pct === 4 && g.top10Pct === 5,
    `top1 ${g.top1Pct}%, top10 ${g.top10Pct}% (both pools were 89.34% together)`);
  ok("both pools are named in the exclusion list", g.poolsExcluded === 3 && g.excluded.filter((e) => /pool/.test(e.label)).length === 2);
  ok("a burn is excluded by its own label and counted as burned", g.burnedPct === 2, `${g.burnedPct}%`);
  /* MIXED CASE ON THE EXCLUSION SIDE. The balances map is lowercase (topics decode that
     way); an exclusion list a caller assembled from an explorer is not. */
  const mixed = shapeHolders(new Map([[p1, share(60)], [whale, share(5)]]), { supply: SUPPLY,
    exclude: [{ address: "0x" + "A1".repeat(20), label: "pool:uniswap-v4" }] });
  ok("an exclusion spelled in EIP-55 still matches its lowercase balance", mixed.top1Pct === 5, `top1 ${mixed.top1Pct}%`);
}

console.log("\nA LEDGER THE DESK COULD NOT READ IS UNVERIFIED, NOT A NUMBER");
{
  // No network: toBlock is supplied, so the budget check answers before any RPC.
  const over = await holdersFromLedger(addr(0x55), { fromBlock: 0, toBlock: 200_000, supply: SUPPLY, budgetBlocks: 120_000 });
  ok("a span over the scan budget refuses with UNVERIFIED in the reason",
    over.ok === false && /UNVERIFIED/.test(over.error) && over.complete === false, over.error);
  const noStart = await holdersFromLedger(addr(0x55), { fromBlock: null, supply: SUPPLY });
  ok("no launch block means no ledger, and says so", noStart.ok === false && /no launch block/.test(noStart.error), noStart.error);
}

console.log("\nTHE WIRING — gather() hands the reader its exclusions and the screen refuses the unverified");
{
  const ev = fs.readFileSync(new URL("./src/data/evidence.js", import.meta.url), "utf8");
  ok("gather() rebuilds holders from the ledger with an exclusion list",
    /evm\.holdersFromLedger\([^)]*exclude: excluded/.test(ev));
  ok("an unreadable ledger reaches the bundle as ok:false with the pool share kept separately",
    /holders: holders\.ok \? holders : \{ ok: false, error: holders\.error/.test(ev));
  ok("the screen refuses a bundle whose holders could not be rebuilt", /"unverified_holders"/.test(ev));
  ok("the screen reads top1 against NON-POOL accounts", /largest non-pool account holds/.test(ev));
  ok("nothing imports the removed Solana holders module",
    !/from "\.\/data\/solana\.js"/.test(ev) && !/from "\.\/solana\.js"/.test(ev));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
