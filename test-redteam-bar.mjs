/** The Red Team's hard verdict must resolve to retained, checkable evidence. */
import { applyRedTeamBar, verifiedFatalAttacks } from "./src/agents/redteam-policy.js";
import { RED_TEAM_FACT_CODES } from "./src/agents/schemas.js";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`); }
};

const evidence = {
  mintAccount: { mintAuthority: "MintAuth111", freezeAuthority: null, flags: ["mint_authority_live"] },
  holders: { top1Pct: 63.4, clusteredHolders: 6 },
  exitProbe: { roundTripLossPct: 2.1 },
  xRead: { citations: ["https://example.com/post"] },
};
const attack = (over = {}) => ({
  target: "forensics",
  attack: "the retained mint authority can inflate supply",
  severity: "fatal",
  evidence: "mintAccount.mintAuthority is MintAuth111",
  fact_code: "live_authority",
  evidence_path: "mintAccount.mintAuthority",
  observed_value: "MintAuth111",
  threshold_or_comparison: "authority is non-null",
  source_url: null,
  verification_status: "verified",
  ...over,
});

console.log("\nA VERIFIED FACT KEEPS THE REFUTATION");
const real = applyRedTeamBar({
  verdict: "refuted", headline: "supply remains controllable", bear_case: "the authority can print",
  attacks: [attack()],
}, evidence);
ok("verified fatal attack is found", real.verifiedFatal.length === 1);
ok("a real refutation remains refuted", real.redteam.verdict === "refuted");
ok("it is not marked downgraded", !real.redteam.downgraded_from);

console.log("\nPROSE CANNOT DRESS ITSELF AS A FACT");
for (const [name, a] of [
  ["generic keyword prose", attack({ fact_code: "other", attack: "liquidity might disappear" })],
  ["missing evidence path", attack({ evidence_path: "holders.doesNotExist" })],
  ["unverified assertion", attack({ verification_status: "unverified" })],
  ["missing observed value", attack({ observed_value: "" })],
  ["non-fatal severity", attack({ severity: "serious" })],
]) {
  const r = applyRedTeamBar({ verdict: "refuted", headline: name, attacks: [a] }, evidence);
  ok(`${name} is downgraded`, r.redteam.verdict === "wounded", r.redteam.downgrade_reason);
  ok(`${name} has no verified fatal`, r.verifiedFatal.length === 0);
}

console.log("\nEXTERNAL SOCIAL CLAIMS REQUIRE A RETAINED HTTPS SOURCE");
const social = attack({
  fact_code: "fake_social_proof",
  evidence_path: "",
  source_url: "https://example.com/post",
  observed_value: "account never published the claimed endorsement",
  threshold_or_comparison: "claimed post absent from the named account",
});
ok("HTTPS evidence can verify an external claim",
  verifiedFatalAttacks({ attacks: [social] }, evidence).length === 1);
ok("a non-retained HTTPS citation cannot",
  verifiedFatalAttacks({ attacks: [{ ...social, source_url: "https://invented.example/not-retained" }] }, evidence).length === 0);
ok("a non-HTTPS citation cannot",
  verifiedFatalAttacks({ attacks: [{ ...social, source_url: "javascript:alert(1)" }] }, evidence).length === 0);

console.log("\nNON-REFUTED VERDICTS AND FINDINGS ARE PRESERVED");
const wounded = applyRedTeamBar({ verdict: "wounded", headline: "keep me", attacks: [] }, evidence);
ok("wounded remains wounded", wounded.redteam.verdict === "wounded");
ok("the original findings remain", wounded.redteam.headline === "keep me");
const survives = applyRedTeamBar({ verdict: "survives", attacks: [] }, evidence);
ok("survives remains survives", survives.redteam.verdict === "survives");

/* THE CHAIN'S OWN RUG VECTORS CAN KILL.
 *
 * Before 2026-09-05 the fact list was Solana's: a refutation on an EOA-held upgrade
 * key, a pullable position NFT, a quote asset the bot cannot hold, unverified bespoke
 * code, voided sells or an exempt list holding the float had no code to land on and was
 * ALWAYS downgraded to wounded. Each of the six now lands on the bundle field the
 * evidence contract names, and each is refused when that field reads clean. */
console.log("\nTHE CHAIN'S OWN RUG VECTORS CAN KILL");
const now = 1_800_000_000_000;
const rug = {
  hold: { holdMaxMs: 30 * 60_000 },
  contract: { isProxy: true, proxyAdmin: { address: "0xadmin", kind: "eoa", delaySec: 0 }, verifiedSource: false, cloneOf: null, flags: [] },
  lp: { kind: "v4_position", pullableSharePct: 100, unlockAt: null, positionNftOwner: "0xowner" },
  pairs: { pools: [{ pairToken: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", pairTokenClass: "equity_unlisted" }] },
  sellSim: { ok: false, revertReason: "TRANSFER_FAILED" },
  launch: { phase: "graduated", graduatedAt: now - 3600e3, exemptShareOfSupplyPct: 41.2, creatorTaxBps: 2000, maxCreatorTaxBps: 2000 },
  derived: { voidedTxPct: 12 },
  exitProbe: { roundTripLossPct: 0.4 },
  xRead: { citations: [] },
};
const clean = {
  ...rug,
  contract: { isProxy: true, proxyAdmin: { address: "0xtl", kind: "timelock", delaySec: 7 * 86400 }, verifiedSource: false, cloneOf: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", flags: [] },
  lp: { kind: "v4_position", pullableSharePct: 0, unlockAt: null, positionNftOwner: "0xponslocker" },
  pairs: { pools: [{ pairToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", pairTokenClass: "weth" }] },
  sellSim: { ok: true, revertReason: null },
  launch: { ...rug.launch, exemptShareOfSupplyPct: 6, creatorTaxBps: 100, maxCreatorTaxBps: 2000 },
  derived: { voidedTxPct: 0 },
};
const evmAttack = (fact_code, evidence_path, observed_value, threshold_or_comparison) =>
  attack({ fact_code, evidence_path, observed_value, threshold_or_comparison, attack: `${fact_code} at ${evidence_path}` });
const cases = [
  ["upgrade_key_live", "contract.proxyAdmin.kind", "eoa", "an EOA holds the upgrade key; a timelock shorter than hold.holdMaxMs would also count"],
  ["lp_unlocked", "lp.pullableSharePct", "100", "> 20% pullable, or unlock inside the hold"],
  ["pair_token_gate", "pairs.pools.0.pairTokenClass", "equity_unlisted", "not native/weth/stable/allowed_equity"],
  ["unverified_code", "contract.verifiedSource", "false", "bespoke, unverified, not a PONS clone, sell not simulated"],
  ["sequencer_exclusion", "sellSim.ok", "false", "sell does not simulate / txs voided"],
  ["insider_float", "launch.exemptShareOfSupplyPct", "41.2", "> the insider ceiling"],
];
for (const [code, path, value, threshold] of cases) {
  ok(`${code} is a code the schema admits`, RED_TEAM_FACT_CODES.includes(code));
  const hit = applyRedTeamBar({ verdict: "refuted", headline: code, attacks: [evmAttack(code, path, value, threshold)] }, rug, { now });
  ok(`${code} on a rug-shaped bundle stays refuted`, hit.redteam.verdict === "refuted", hit.redteam.downgrade_reason || `path ${path}=${value}`);
  const cleanValue = String((path.split(".").reduce((v, k) => v?.[k], clean)));
  const miss = applyRedTeamBar({ verdict: "refuted", headline: code,
    attacks: [evmAttack(code, path, cleanValue, threshold)] }, clean, { now });
  ok(`${code} on a clean bundle is downgraded`, miss.redteam.verdict === "wounded", `${path}=${cleanValue} did not confirm`);
}
// The timelock case in full: protection only when the delay outlasts the hold.
const shortLock = { ...clean, contract: { ...clean.contract, proxyAdmin: { address: "0xtl", kind: "timelock", delaySec: 600 } } };
ok("a ten-minute timelock on a thirty-minute hold is a live key",
  verifiedFatalAttacks({ attacks: [evmAttack("upgrade_key_live", "contract.proxyAdmin.kind", "timelock", "delay < hold")] }, shortLock, { now }).length === 1);
ok("a seven-day timelock is not",
  verifiedFatalAttacks({ attacks: [evmAttack("upgrade_key_live", "contract.proxyAdmin.kind", "timelock", "delay < hold")] }, clean, { now }).length === 0);
// An unlock landing inside the hold is a pullable pool even at 0% pullable today.
const expiring = { ...clean, lp: { ...clean.lp, unlockAt: now + 10 * 60_000 } };
ok("a lock expiring inside the hold confirms lp_unlocked",
  verifiedFatalAttacks({ attacks: [evmAttack("lp_unlocked", "lp.unlockAt", String(now + 10 * 60_000), "unlock before hold ends")] }, expiring, { now }).length === 1);
// Voided transactions confirm sequencer_exclusion even when the sim passes.
const voided = { ...clean, derived: { voidedTxPct: 9 } };
ok("9% voided swaps confirms sequencer_exclusion",
  verifiedFatalAttacks({ attacks: [evmAttack("sequencer_exclusion", "derived.voidedTxPct", "9", ">= 5% of recent swaps voided")] }, voided, { now }).length === 1);
// A live contract flag confirms live_authority on an EVM bundle with no mintAccount.
const flagged = { ...clean, contract: { ...clean.contract, flags: [{ flag: "pausable", detail: "pause() callable by 0xabc" }] } };
ok("a pausable flag confirms live_authority without a mintAccount",
  verifiedFatalAttacks({ attacks: [evmAttack("live_authority", "contract.flags", "pausable", "a pause role is live")] }, flagged, { now }).length === 1);

console.log("\nTHE LAUNCH-FARM BAR IS THIS CHAIN'S BASE RATE, NOT SOLANA'S");
{
  const farmAttack = (n) => evmAttack("deployer_misconduct", "deployer.priorLaunches", String(n), "many launches, none graduated");
  const deployer = (n) => ({ ...clean, deployer: { priorLaunches: n, graduated: 0, dead: n } });
  // 1.55% graduate, so eight-and-none is what 88% of honest eight-time launchers look like.
  ok("eight launches and no graduation is NOT a refutation here",
    verifiedFatalAttacks({ attacks: [farmAttack(8)] }, deployer(8), { now }).length === 0);
  ok("twenty-five launches and no graduation is",
    verifiedFatalAttacks({ attacks: [farmAttack(25)] }, deployer(25), { now }).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
