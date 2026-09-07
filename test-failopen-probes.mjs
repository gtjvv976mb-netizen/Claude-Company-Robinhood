/**
 * TWO HONEYPOT PROBES THAT COULD NEVER FIRE.
 *
 * evidence.js checks `ev.mintSim?.unverified === true` and `ev.blacklist?.unverified
 * === true` — but neither key was on the bundle, so both read undefined and NEITHER
 * CHECK COULD EVER FIRE. The probes themselves work; only their unverified state was
 * missing.
 *
 * The failure mode is the dangerous one. contractFlags is pushed on `mintSim.live` and
 * `blacklist.present`, and on an RPC 429, a timeout or a closed socket both return NULL
 * with unverified:true — so no flag was pushed and the coin was screened as though the
 * mint role and the blacklist had been CHECKED AND FOUND ABSENT. "The probe could not
 * run" silently became "the probe says no", which is precisely the fail-open the
 * 2026-09-05 review closed for the neighbouring flags.
 *
 *   CLAUDE_CO_DB=/tmp/x.db node test-failopen-probes.mjs
 */
import assert from "node:assert/strict";
import { screen } from "./src/data/evidence.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
};

const A = "0x8f100e99ddf699320724e37cb866770381d47382";
/* A coin clean in every OTHER respect, so anything that fires below is the probe under
   test and not an unrelated rail. */
const clean = {
  ok: true, address: A, mint: A, token: A,
  pair: { priceUsd: 1, liquidityUsd: 9e6, marketCap: 5e5, ageHours: 500,
    volume: { h24: 9e6 }, txns: { h24: { buys: 500, sells: 500 } } },
  pairs: { count: 1, totalLiquidityUsd: 9e6, pools: [{ pairTokenClass: "native" }] },
  contract: { ok: true, flags: [] }, holders: { ok: true, top1Pct: 4, top10Pct: 25 },
  launch: { phase: "amm" }, sellSim: { ok: true }, exitProbe: { roundTripLossPct: 1 },
};
const codes = (over) => screen({ ...clean, ...over }).fails.map((f) => f.code);
const verified = { mintSim: { live: false, unverified: false }, blacklist: { present: false, unverified: false } };

console.log("\nAN UNREADABLE PROBE MUST REFUSE, NOT PASS");
ok("an unverified mint probe fires unverified_mint", () =>
  assert.ok(codes({ ...verified, mintSim: { live: null, unverified: true, detail: "rpc 429" } })
    .includes("unverified_mint")));
ok("an unverified blacklist probe fires unverified_blacklist", () =>
  assert.ok(codes({ ...verified, blacklist: { present: null, unverified: true, detail: "timeout" } })
    .includes("unverified_blacklist")));
ok("both unreadable fires both", () => {
  const c = codes({ mintSim: { live: null, unverified: true }, blacklist: { present: null, unverified: true } });
  assert.ok(c.includes("unverified_mint") && c.includes("unverified_blacklist"));
});
ok("a bundle MISSING the probes entirely still refuses", () => {
  /* The original bug's exact shape: the key is absent, so `?.unverified` is undefined.
     Absent must never read as verified-clean. */
  const c = codes({ mintSim: undefined, blacklist: undefined });
  assert.ok(c.includes("unverified_mint"), "an absent mint probe must refuse");
  assert.ok(c.includes("unverified_blacklist"), "an absent blacklist probe must refuse");
});

console.log("\nA PROBE THAT RAN AND SAID 'NO' MUST STILL PASS");
ok("verified-clean probes raise neither flag", () => {
  const c = codes(verified);
  assert.ok(!c.includes("unverified_mint"), c.join(", "));
  assert.ok(!c.includes("unverified_blacklist"), c.join(", "));
});
ok("a live mint role is still a kill, not merely unverified", () => {
  const c = codes({ ...verified, contract: { ok: true, flags: [{ flag: "mint_role_live", detail: "x" }] } });
  assert.ok(c.includes("live_mint_role") || c.includes("mint_role_live"), c.join(", "));
});
ok("a present blacklist is still a kill", () => {
  const c = codes({ ...verified, contract: { ok: true, flags: [{ flag: "blacklist", detail: "x" }] } });
  assert.ok(c.includes("blacklist_present"), c.join(", "));
});

console.log("\nTHE BUNDLE CARRIES WHAT THE SCREEN READS");
import fs from "node:fs";
const ev = fs.readFileSync(new URL("src/data/evidence.js", import.meta.url), "utf8");
ok("mintSim and blacklist are returned on the bundle", () =>
  assert.match(ev, /^\s*mintSim, blacklist,$/m,
    "the screen reads ev.mintSim / ev.blacklist; if they are not returned the checks are dead"));
ok("the predicate treats ABSENT as unverified, not as clean", () => {
  /* `?.unverified === true` is false both when the probe passed and when the probe is
     not there at all. That ambiguity is the whole bug, so the test pins the disambiguated
     form rather than the old one. */
  assert.match(ev, /ev\.mintSim == null \|\| ev\.mintSim\.unverified === true, "unverified_mint"/);
  assert.match(ev, /ev\.blacklist == null \|\| ev\.blacklist\.unverified === true, "unverified_blacklist"/);
  assert.ok(!/check\(ev\.mintSim\?\.unverified === true/.test(ev),
    "the optional-chain form fails open on an absent probe");
});

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
