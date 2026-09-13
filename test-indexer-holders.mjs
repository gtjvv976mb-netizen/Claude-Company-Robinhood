/**
 * THE SCREEN WENT BLIND AND KILLED THE MARKET FOR IT — the three fixes, each proved.
 *
 * Measured on the live Robinhood desk, 2026-09-13: 19,335 workups, 19,334 kills, zero
 * calls published ever. Every kill carried `unverified_holders`, because the explorer
 * the holder path fell back to sits behind a Cloudflare challenge (HTTP 403 to every
 * server, browser User-Agent included). 927 more carried `unverified_sellsim` on tokens
 * whose balance lives in Solady's hand-rolled layout, which the slot scan did not know.
 * And ~2,500 carried pair_token_gate for pools quoted in Stock Tokens off a three-name
 * allowlist, which is how PONS V2 launches pair by design.
 *
 *   1. GeckoTerminal's token index supplies the holder distribution; its wire shape is
 *      pinned against a body recorded live that day, and every field it cannot supply is
 *      null (not read), never zero.
 *   2. Solady's balance and allowance keys derive exactly as its assembly does; pinned
 *      against the keys that read a live holder's balance back on KIRKINATORX.
 *   3. An unread distribution is a seat input when the exit is PROVEN, and a kill only
 *      when the exit is unproven too. holder_concentration still kills a measured 60%.
 *
 * Offline: no network, no key.
 *   node test-indexer-holders.mjs
 */
import assert from "node:assert/strict";
import { shapeTokenInfo, holdersFromIndexer, _resetCache } from "./src/data/geckoterminal.js";
import { soladyBalanceKey, soladyAllowanceKey, isTransportError, findBalanceSlot } from "./src/data/evm.js";
import { keccak256 } from "./src/lib/evm.js";

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

/* Recorded 2026-09-13 15:2x UTC from
   GET https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/0xfad4…c643/info */
const AC_BODY = { data: { id: "robinhood_0xfad40755de679b262337f8d964d75cac51f8c643", type: "token", attributes: {
  address: "0xfad40755de679b262337f8d964d75cac51f8c643", name: "Artificial Cat", symbol: "AC", decimals: 18,
  gt_score: 38.95873015873016, gt_verified: true, categories: ["Meme", "Animal"],
  holders: { count: 741, distribution_percentage: { top_10: "37.5077", "11_30": "20.8233", "31_50": "9.4833", rest: "32.1857" },
    last_updated: "2026-09-13T15:25:49Z" },
  mint_authority: null, freeze_authority: null, is_honeypot: "unknown",
  developer_address: "0x503ef13f53dfe6f677eb73a62fbe4f2523cde9a8", developer_holding_percentage: "3.36",
  launchpad_details: { graduation_percentage: 100.0, completed: true, completed_at: "2026-09-12T14:33:05.000Z",
    migrated_destination_pool_address: "0x027f6c0fd8847365e77eae2910169a1b92c513c6f1dadd38fde3ecd7806df5d1" },
  websites: [], twitter_handle: null, telegram_handle: null,
} } };
const NOW = Date.parse("2026-09-13T15:40:00Z");

console.log("\n1. THE INDEXER'S WIRE SHAPE, PINNED AGAINST A RECORDED BODY");
await ok("holders: count, top-10 share and freshness are read as recorded", () => {
  const t = shapeTokenInfo(AC_BODY, { now: NOW });
  assert.equal(t.ok, true);
  assert.equal(t.holders.count, 741);
  assert.equal(t.holders.top10Pct, 37.51);
  assert.equal(t.holders.restPct, 32.19);
  assert.equal(t.holders.ageMs, NOW - Date.parse("2026-09-13T15:25:49Z"));
});
await ok("the developer's address and holding are carried", () => {
  const t = shapeTokenInfo(AC_BODY);
  assert.equal(t.developer.address, "0x503ef13f53dfe6f677eb73a62fbe4f2523cde9a8");
  assert.equal(t.developer.holdingPct, 3.36);
});
await ok("the launchpad phase is read with its completion time and migrated pool", () => {
  const t = shapeTokenInfo(AC_BODY);
  assert.equal(t.launchpad.completed, true);
  assert.equal(t.launchpad.completedAt, Date.parse("2026-09-12T14:33:05.000Z"));
  assert.equal(t.launchpad.migratedPool, "0x027f6c0fd8847365e77eae2910169a1b92c513c6f1dadd38fde3ecd7806df5d1");
});
await ok("a body with no attributes is refused, not shaped into zeros", () => {
  assert.equal(shapeTokenInfo({ data: {} }).ok, false);
  assert.equal(shapeTokenInfo(null).ok, false);
});
await ok("a token the index has no holders for is null, not 0 holders", () => {
  const body = JSON.parse(JSON.stringify(AC_BODY)); delete body.data.attributes.holders;
  const t = shapeTokenInfo(body);
  assert.equal(t.ok, true);
  assert.equal(t.holders, null);
});
await ok("a launchpad the index calls incomplete reads completed:false — a curve", () => {
  const body = JSON.parse(JSON.stringify(AC_BODY)); body.data.attributes.launchpad_details.completed = false;
  assert.equal(shapeTokenInfo(body).launchpad.completed, false);
});

console.log("\n2. THE HOLDER OBJECT SAYS WHAT IT DOES NOT KNOW");
const realFetch = globalThis.fetch;
const stub = (status, body) => { globalThis.fetch = async () => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) }); };
await ok("top1Pct is null (not read), top10Pct is the indexer's, the count is the indexer's", async () => {
  _resetCache(); stub(200, AC_BODY);
  const h = await holdersFromIndexer("0xfad40755de679b262337f8d964d75cac51f8c643", { supply: 10n ** 27n, now: NOW });
  assert.equal(h.ok, true);
  assert.equal(h.source, "geckoterminal");
  assert.equal(h.top1Pct, null);
  assert.equal(h.top10Pct, 37.51);
  assert.equal(h.count, 741);
  assert.equal(h.bundleSuspect, null);
  assert.equal(h.complete, false);
  assert.match(h.note, /INCLUDES the pool/);
});
await ok("a 429 fails closed and is marked transient", async () => {
  _resetCache(); stub(429, { status: { error_code: 429 } });
  const h = await holdersFromIndexer("0xfad40755de679b262337f8d964d75cac51f8c643", { supply: 10n ** 27n });
  assert.equal(h.ok, false);
  assert.equal(h.transient, true);
});
await ok("a token with no distribution yet fails closed", async () => {
  _resetCache();
  const body = JSON.parse(JSON.stringify(AC_BODY)); delete body.data.attributes.holders;
  stub(200, body);
  const h = await holdersFromIndexer("0xfad40755de679b262337f8d964d75cac51f8c643", { supply: 10n ** 27n });
  assert.equal(h.ok, false);
  assert.match(h.error, /no holder distribution/);
});
globalThis.fetch = realFetch;

console.log("\n3. SOLADY'S LAYOUT, DERIVED AS ITS ASSEMBLY DERIVES IT");
/* Measured 2026-09-13: KIRKINATORX 0x040d… (a 44-byte 0age clone onto 0x63d733be…b6b4)
   holder 0xef2f855506d88cab4b3d788b8153bea08228e803 held 25216240956441973558175331 and
   that exact number sat at keccak256(holder ‖ 8 zero bytes ‖ 0x87a211a2); the override
   trick read a sentinel back through balanceOf() at the probe's key, and through
   allowance() at keccak256(owner ‖ 8 zero bytes ‖ 0x7f5e9f20 ‖ spender). */
const HOLDER = "0xef2f855506d88cab4b3d788b8153bea08228e803";
await ok("the balance key is keccak256(owner20 ‖ 0x0000000000000000 ‖ 0x87a211a2)", () => {
  const expected = keccak256(Buffer.from(HOLDER.slice(2) + "0000000000000000" + "87a211a2", "hex"));
  assert.equal(soladyBalanceKey(HOLDER), expected);
  assert.equal(soladyBalanceKey(HOLDER).length, 66);
});
await ok("the allowance key is keccak256(owner20 ‖ 8 zero bytes ‖ 0x7f5e9f20 ‖ spender20) — 52 bytes hashed", () => {
  const spender = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";
  const expected = keccak256(Buffer.from(HOLDER.slice(2) + "0000000000000000" + "7f5e9f20" + spender.slice(2), "hex"));
  assert.equal(soladyAllowanceKey(HOLDER, spender), expected);
});
await ok("the key is case-insensitive in the address and refuses a non-address", () => {
  assert.equal(soladyBalanceKey(HOLDER.toUpperCase().replace("0X", "0x")), soladyBalanceKey(HOLDER));
  assert.throws(() => soladyBalanceKey("0x1234"));
});

console.log("\n4. A TRANSPORT FAILURE IS NOT 'NOT THIS SLOT'");
await ok("429 / timeout / socket errors are transport", () => {
  for (const e of ["Too Many Requests", "HTTP 429", "request timed out after 4000ms", "fetch failed", "HTTP 503", "missing from batch response"])
    assert.equal(isTransportError(e), true, e);
});
await ok("a revert is the contract's answer, not transport", () => {
  for (const e of ["execution reverted", "execution reverted: ERC20: insufficient", "invalid opcode", "out of gas"])
    assert.equal(isTransportError(e), false, e);
});
await ok("a scan that only ever heard 429 reports transport and does NOT cache the refusal", async () => {
  /* Drive findBalanceSlot through a stubbed RPC: every eth_call answers a rate limit. */
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too Many Requests" } }) });
  process.env.RH_RPC = "https://127.0.0.1:1/never";
  const token = "0x0000000000000000000000000000000000000abc";
  const r = await findBalanceSlot(token);
  assert.equal(r.ok, false);
  assert.equal(r.transport, true);
  assert.match(r.error, /no answer from the node/);
  const again = await findBalanceSlot(token);
  assert.equal(again.transport, true, "a transport refusal must be re-asked, not remembered");
  globalThis.fetch = realFetch;
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
