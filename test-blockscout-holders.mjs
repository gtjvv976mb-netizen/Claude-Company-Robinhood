/**
 * THE EXPLORER HOLDER PATH — the fix for 673 workups and 673 kills.
 *
 * The RH desk killed every coin it ever studied because holdersFromLedger cannot reach
 * a launch block on a 100ms chain: the budget is 120,000 blocks (~3.4 hours) and the
 * median pool is 425 hours old. `unverified_holders` fired on 24 of 24 sampled workups
 * and $0 of Anthropic spend was ever incurred — no coin reached a seat.
 *
 * The replacement must clear three bars, and each is a test here:
 *   1. It must FAIL CLOSED. An explorer that 403s, times out or returns nothing must
 *      leave the screen refusing, exactly as an unverifiable ledger does.
 *   2. The holder COUNT must be the explorer's, never the page length. A page of 100
 *      would otherwise report a 2,078-holder token as having 100 — a concentration
 *      signal that is wrong in the dangerous direction.
 *   3. It must still catch what it exists to catch: one wallet holding the float.
 *
 * Runs offline against a stubbed fetch; no network, no key.
 *   node test-blockscout-holders.mjs
 */
import assert from "node:assert/strict";

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

const realFetch = globalThis.fetch;
const stub = (routes) => { globalThis.fetch = async (url) => {
  const u = String(url);
  for (const [frag, res] of Object.entries(routes)) {
    if (u.includes(frag)) {
      if (res === "403") return { ok: false, status: 403, json: async () => ({}) };
      if (res === "throw") throw new Error("network down");
      return { ok: true, status: 200, json: async () => res };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
}; };

const { holdersFromExplorer, tokenMeta } = await import("./src/data/blockscout.js");
const TOKEN = "0x8f100e99ddf699320724e37cb866770381d47382";
const SUPPLY = 10n ** 27n;                       // 1e9 tokens at 18dp
const holder = (hash, value, name = null) => ({
  address: { hash, is_contract: !!name, is_verified: !!name, name }, value: String(value),
});

console.log("\n1. FAIL CLOSED — an explorer that cannot answer must not let a coin through");
await ok("a 403 leaves it unverified", async () => {
  stub({ "/holders": "403", "/api/v2/tokens/": "403" });
  const r = await holdersFromExplorer(TOKEN, { supply: SUPPLY });
  assert.equal(r.ok, false);
  assert.match(r.error, /explorer/);
});
await ok("a network failure leaves it unverified", async () => {
  stub({ "/holders": "throw" });
  const r = await holdersFromExplorer(TOKEN, { supply: SUPPLY });
  assert.equal(r.ok, false);
});
await ok("an empty holder list leaves it unverified", async () => {
  stub({ "/holders": { items: [] } });
  const r = await holdersFromExplorer(TOKEN, { supply: SUPPLY });
  assert.equal(r.ok, false);
  assert.match(r.error, /no holders/);
});
await ok("unreadable rows are not silently treated as zero holders passing", async () => {
  stub({ "/holders": { items: [{ address: { hash: "not-an-address" }, value: "x" }] } });
  const r = await holdersFromExplorer(TOKEN, { supply: SUPPLY });
  assert.equal(r.ok, false);
});
await ok("no total supply from the explorer is refused", async () => {
  stub({ ["/api/v2/tokens/" + TOKEN]: { total_supply: null, decimals: "18" } });
  const m = await tokenMeta(TOKEN);
  assert.equal(m.ok, false);
});

console.log("\n2. THE COUNT IS THE EXPLORER'S, NOT THE PAGE LENGTH");
const many = Array.from({ length: 50 }, (_, i) =>
  holder("0x" + String(i + 1).padStart(40, "0"), SUPPLY / 500n));
await ok("a 50-row page on a 2,078-holder token reports 2,078", async () => {
  stub({ "/holders": { items: many }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "2078" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.count, 2078, `page length would have said ${r.sampledHolders}`);
  assert.equal(r.sampledHolders, 50, "and the sample size is reported separately, not hidden");
});
await ok("the sampled depth is disclosed rather than implied to be exhaustive", async () => {
  stub({ "/holders": { items: many }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "2078" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.source, "explorer");
  assert.ok(r.bundleScannedTop > 0, "the bundle scan depth must be stated");
});

console.log("\n2b. A NAME CANNOT HIDE SUPPLY");
/* Excluding a holder removes it from top1Pct, which is the only number
   holder_concentration (>50%) and the red team's holder_control read. The exclusion
   briefly keyed on the explorer's NAME with no verification — and the deployer chooses
   the name. Reproduced: 70% of supply in an unverified "TeamTreasuryVault" came back as
   top1Pct 4%, and the one gate that catches a wallet owning the float saw a rounding
   error. */
await ok("an UNVERIFIED contract named like a vault cannot be excused", async () => {
  stub({ "/holders": { items: [
    holder("0x" + "a".repeat(40), (SUPPLY * 70n) / 100n),   // unverified: helper sets is_verified from `name`
  ].map((h) => ({ ...h, address: { ...h.address, is_contract: true, is_verified: false, name: "TeamTreasuryVault" } })) },
    ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "900" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.top1Pct, 70, "a name must not subtract 70% of supply from the concentration number");
  assert.equal(r.inferredPools, 0, "nothing unverified may be excused");
  assert.ok((r.nameOnlyContracts ?? []).some((c) => /TeamTreasuryVault/.test(c.name)),
    "it must still be REPORTED, so the reader can see it was noticed and not excused");
});
await ok("free-standing 'vault'/'router'/'manager' are not venue words even when verified", async () => {
  stub({ "/holders": { items: [{
    address: { hash: "0x" + "e".repeat(40), is_contract: true, is_verified: true, name: "TreasuryManager" },
    value: String((SUPPLY * 70n) / 100n),
  }] }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "900" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.top1Pct, 70, "verification alone is not enough — the name must name a liquidity venue");
});
await ok("a caller-supplied pool address IS excused, because it has provenance", async () => {
  const pool = "0x" + "f".repeat(40);
  stub({ "/holders": { items: [{
    address: { hash: pool, is_contract: true, is_verified: true, name: "SomePool" },
    value: String((SUPPLY * 70n) / 100n),
  }] }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "900" } });
  const r = await holdersFromExplorer(TOKEN, { exclude: [{ address: pool, label: "pool:dexscreener" }] });
  assert.ok(r.top1Pct < 50, `an address the caller proved is a pool must still be excluded, got ${r.top1Pct}`);
});

console.log("\n3. IT STILL CATCHES WHAT IT EXISTS TO CATCH");
await ok("one wallet holding 60% of the float reads as 60%", async () => {
  stub({ "/holders": { items: [
    holder("0x" + "a".repeat(40), (SUPPLY * 60n) / 100n),
    holder("0x" + "b".repeat(40), (SUPPLY * 5n) / 100n),
  ] }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "900" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.top1Pct, 60, "this is the number the screen kills on at >50%");
});
await ok("a pool is excluded so its float is not read as one whale", async () => {
  const pool = "0x" + "c".repeat(40);
  stub({ "/holders": { items: [
    holder(pool, (SUPPLY * 70n) / 100n, "UniswapV3Pool"),
    holder("0x" + "d".repeat(40), (SUPPLY * 4n) / 100n),
  ] }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "900" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inferredPools, 1, "the explorer's own contract label identifies the pool");
  assert.equal(r.top1Pct, 4, `a pool counted as a holder would have read ${70}%`);
});
await ok("an UNLABELLED contract is NOT assumed to be a pool", async () => {
  stub({ "/holders": { items: [
    holder("0x" + "e".repeat(40), (SUPPLY * 70n) / 100n, "SomeRandomContract"),
    holder("0x" + "f".repeat(40), (SUPPLY * 4n) / 100n),
  ] }, ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "900" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.equal(r.inferredPools, 0, "only pool-shaped names are excluded");
  assert.equal(r.top1Pct, 70, "an unknown contract holding 70% must still read as 70%");
});

globalThis.fetch = realFetch;
console.log("\n5. THE SEATS ARE TOLD WHERE THE DATA CAME FROM");
await ok("the note does NOT claim a complete Transfer ledger", async () => {
  stub({ "/holders": { items: [holder("0x" + "1".repeat(40), SUPPLY / 25n)] },
    ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "2078" } });
  const r = await holdersFromExplorer(TOKEN, {});
  /* shapeHolders stamps "Balances rebuilt from the complete Transfer ledger" on every
     result — true of the path it was written for and FALSE here. That note reaches the
     analyst seats, which read it as provenance: a seat told the ledger was complete will
     treat a clean top-10 as stronger evidence than it is. */
  assert.ok(!/rebuilt from the complete Transfer ledger/.test(r.note), r.note.slice(0, 120));
  assert.match(r.note, /explorer index/);
  assert.match(r.note, /NOT rebuilt from a Transfer ledger/);
});
await ok("...and it states the sample depth and the true holder count", async () => {
  stub({ "/holders": { items: [holder("0x" + "1".repeat(40), SUPPLY / 25n)] },
    ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "2078" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.match(r.note, /top 1 holders of 2078/, r.note.slice(0, 140));
});
await ok("...and warns that a name-only contract was NOT excluded", async () => {
  stub({ "/holders": { items: [holder("0x" + "1".repeat(40), SUPPLY / 25n)] },
    ["/api/v2/tokens/" + TOKEN]: { total_supply: String(SUPPLY), decimals: "18", holders_count: "2078" } });
  const r = await holdersFromExplorer(TOKEN, {});
  assert.match(r.note, /nameOnlyContracts/);
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
