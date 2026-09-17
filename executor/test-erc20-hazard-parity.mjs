/**
 * THE COPY THAT SPENDS THE MONEY MUST NOT KNOW LESS THAN THE COPY THAT ADVISES.
 *
 * Two places in this repo ask "can someone freeze this wallet's exit?", by two different
 * mechanisms, and they had drifted apart in the dangerous direction:
 *
 *   · src/data/evidence.js blacklistProbe() eth_calls six signatures and decodes a bool.
 *     It is the DESK's check. Its verdict goes into a ticket a human reads.
 *   · executor/erc20-hazards.mjs scanSelectors() scans runtime bytecode for PUSH4
 *     patterns. It is the EXECUTOR's check, it runs on the money path, and its verdict
 *     decides whether a buy is signed.
 *
 * The overlap was three. The executor — the one that signs — was blind to
 * isBlocked(address), blocklist(address) and isFrozen(address), each a distinct mechanism
 * for freezing this wallet's exit AFTER the buy has landed, which is the one failure a
 * bot cannot trade its way out of.
 *
 * ── WHY SUPERSET AND NOT IDENTITY ───────────────────────────────────────────────────
 *
 * Asserting the two lists are EQUAL would be red on day one and would be wrong to fix:
 * they are different mechanisms with different reach. A bytecode scan sees a selector the
 * contract implements whether or not it answers; an eth_call sees a selector that answers
 * for one probe address. Each can legitimately carry entries the other cannot. So the
 * rule is one-directional and is the one that matters for money: EXECUTOR ⊇ DESK. The
 * executor may know more. It may never know less.
 *
 * Every deliberate divergence is named below with its reason, so "we meant that" is a
 * tested claim rather than a comment.
 *
 * This file reads src/data/evidence.js AS TEXT and never imports it — executor/ is a
 * standalone installed package that does not import ../src, which erc20-hazards.mjs
 * already respects by mirroring rather than importing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { id as keccakId } from "ethers";
import { HAZARD_SELECTORS, HAZARD_SELECTORS_OBSERVED, scanSelectors } from "./erc20-hazards.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const here = path.dirname(new URL(import.meta.url).pathname);
const evidenceSrc = fs.readFileSync(path.join(here, "..", "src", "data", "evidence.js"), "utf8");

/** The desk's list, lifted out of its source rather than restated here. */
function deskBlocklistSignatures(src) {
  const at = src.indexOf("async function blacklistProbe");
  assert.ok(at > 0, "blacklistProbe moved — this test must be repointed, not deleted");
  const line = src.slice(at, at + 1200).match(/const sigs = \[([^\]]+)\]/);
  assert.ok(line, "could not read blacklistProbe's sigs array");
  return line[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Every signature the executor scans for, enforced or observed. */
const executorBlocklist = [
  ...Object.values(HAZARD_SELECTORS.blocklist),
  ...Object.values(HAZARD_SELECTORS_OBSERVED.blocklist),
];

/**
 * DELIBERATE DIVERGENCES, each with the reason it is not a bug. A new entry here is a
 * decision someone has to write down; an unexplained gap is a red test.
 */
const KNOWN_DIVERGENCES = Object.freeze({
  "setBlacklist(address,bool)":
    "executor-only, and UNPROBEABLE by the desk: evidence.js encodeCall(sig, [PROBE_EOA]) " +
    "passes one argument, so a two-argument setter cannot be eth_called that way. A " +
    "bytecode scan sees it regardless, which is why the executor gets it and the desk " +
    "does not.",
  "blacklisted(address)":
    "executor-only. The desk probes isBlacklisted/isBlackListed; the bare past-participle " +
    "form is a real variant in the wild and costs nothing to scan for.",
  "_isBlacklisted(address)":
    "executor-only. An underscore-private view that some tokens still expose publicly; " +
    "again free to scan, not worth an eth_call round trip for the desk.",
});

console.log("\nTHE EXECUTOR KNOWS EVERYTHING THE DESK KNOWS");
{
  const desk = deskBlocklistSignatures(evidenceSrc);
  ok("the desk's probe list was read out of its own source", desk.length >= 6, desk.join(", "));
  const missing = desk.filter((sig) => !executorBlocklist.includes(sig));
  ok("the executor scans for every signature the desk probes", missing.length === 0,
    missing.length ? `MISSING: ${missing.join(", ")}` : `${desk.length} signatures, all covered`);

  /* The three this commit added, named so the test says what it is protecting. */
  for (const sig of ["isBlocked(address)", "blocklist(address)", "isFrozen(address)"])
    ok(`...including ${sig}, which it was blind to`, executorBlocklist.includes(sig));
}

console.log("\nEVERY DIVERGENCE IS DELIBERATE AND WRITTEN DOWN");
{
  const desk = deskBlocklistSignatures(evidenceSrc);
  const executorOnly = executorBlocklist.filter((sig) => !desk.includes(sig));
  for (const sig of executorOnly)
    ok(`${sig} is a named divergence`, KNOWN_DIVERGENCES[sig] != null,
      KNOWN_DIVERGENCES[sig] ? KNOWN_DIVERGENCES[sig].slice(0, 60) + "…" : "UNEXPLAINED");
  ok("...and no divergence is recorded that no longer exists",
    Object.keys(KNOWN_DIVERGENCES).every((sig) => executorOnly.includes(sig)),
    Object.keys(KNOWN_DIVERGENCES).filter((s) => !executorOnly.includes(s)).join(", ") || "none stale");
  ok("every reason is a sentence, not a shrug",
    Object.values(KNOWN_DIVERGENCES).every((why) => why.length > 60));
}

console.log("\nEVERY SELECTOR IS THE KECCAK OF THE SIGNATURE BESIDE IT");
{
  /* A typo'd hex is a scan that silently never matches — the worst kind of safety code,
     because it reports clean forever. Recompute all nine rather than trusting the table. */
  let checked = 0, wrong = [];
  for (const table of [...Object.values(HAZARD_SELECTORS), ...Object.values(HAZARD_SELECTORS_OBSERVED)]) {
    for (const [selector, signature] of Object.entries(table)) {
      checked++;
      const real = keccakId(signature).slice(0, 10);
      if (real !== selector) wrong.push(`${signature}: table ${selector}, keccak ${real}`);
    }
  }
  ok(`all ${checked} selectors recompute from their signatures`, wrong.length === 0, wrong.join("; "));
  ok("...and there are no duplicate selectors across the two tables",
    new Set([...Object.keys(HAZARD_SELECTORS.blocklist), ...Object.keys(HAZARD_SELECTORS_OBSERVED.blocklist)]).size
      === Object.keys(HAZARD_SELECTORS.blocklist).length + Object.keys(HAZARD_SELECTORS_OBSERVED.blocklist).length);
}

console.log("\nTHE NEW THREE ARE OBSERVED, NOT ENFORCED");
{
  /* The distinction is the whole reason they could be added at all: widening a bytecode
     scan by half with no population pass is how a real hazard check gets switched off. */
  const codeFor = (sel) => "0x6080604052" + "63" + sel.slice(2) + "14610040";
  const enforced = scanSelectors(codeFor("0xfe575a87"));     // isBlacklisted, enforced
  ok("an enforced selector lands in the blocklist group",
    enforced.blocklist.includes("isBlacklisted(address)") && enforced.observed.length === 0);

  for (const [sel, sig] of Object.entries(HAZARD_SELECTORS_OBSERVED.blocklist)) {
    const hit = scanSelectors(codeFor(sel));
    ok(`${sig} is found`, hit.observed.includes(sig));
    ok(`...and does NOT enter the enforcing group`, hit.blocklist.length === 0);
  }

  const clean = scanSelectors("0x6080604052600080fd");
  ok("a clean contract hits nothing", clean.blocklist.length === 0 && clean.observed.length === 0 && clean.pausable.length === 0);

  /* And the refusal branch must not read `observed` — that is the promotion, and it has
     not happened. This is the assertion that stops a well-meaning edit from arming three
     unmeasured selectors on the money path. */
  const hazardSrc = fs.readFileSync(path.join(here, "erc20-hazards.mjs"), "utf8");
  const refusalRegion = hazardSrc.slice(hazardSrc.indexOf("const selectors = scanSelectors"),
    hazardSrc.indexOf("An upgradeable token behind a single key"));
  ok("no refusal branch reads the observed group",
    !/selectors\.observed\.length/.test(refusalRegion),
    "they are promoted by a human reading observations-report.mjs, never by an edit here");
  ok("the verdict carries them out for the caller to record",
    /observedSelectors: selectors\.observed/.test(hazardSrc));
  ok("...on a refused verdict too, so a coin refused for another reason still counts",
    (hazardSrc.match(/observedSelectors: selectors\.observed/g) || []).length >= 3);
}

console.log("\nTHE SEPARATION THIS FILE HAS TO RESPECT");
{
  const hazardSrc = fs.readFileSync(path.join(here, "erc20-hazards.mjs"), "utf8");
  ok("erc20-hazards.mjs still imports nothing from ../src", !/from "\.\.\/src/.test(hazardSrc));
  const self = fs.readFileSync(new URL(import.meta.url), "utf8");
  ok("...and this test reads the desk's source as TEXT rather than importing it",
    /readFileSync\(path\.join\(here, "\.\.", "src"/.test(self) && !/from "\.\.\/src/.test(self));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
