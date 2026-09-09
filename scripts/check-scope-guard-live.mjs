/**
 * THE SCOPE GUARD, RE-CHECKED AGAINST THE CHAIN ITSELF. RUN DELIBERATELY.
 *
 * executor/test-scope-guard.mjs used to end with this section, so `npm test` made twenty
 * JSON-RPC round trips and an RPC hiccup read as a code regression: the AAPL assertion
 * wanted kind === "stock_token" and a timed-out read returns "unreadable", which is the
 * guard behaving CORRECTLY. Observed failing intermittently in the adversarial review of
 * 2026-09-09; 150 iterations of the suite could not finish in ten minutes because every
 * one of them went to the network.
 *
 * So the test now runs the same table against RECORDED answers in
 * test-fixtures/scope-guard-4663.json — the repo's own convention, the same one
 * test-pons-live.mjs uses — and this script is the deliberate re-verification:
 *
 *   node scripts/check-scope-guard-live.mjs            read the chain, compare to the fixture
 *   node scripts/check-scope-guard-live.mjs --record   re-record the fixture from the chain
 *
 * The two failures are kept apart on purpose, because they mean opposite things:
 *   exit 1  the chain disagrees with the guard — a real finding, look at it
 *   exit 2  the chain could not be reached — the check did not run, nothing was proved
 * That distinction is the whole reason this file exists. The old inline version could
 * only report both as "test failed".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToken, classifyFromName, decodeAbiString,
  SELECTOR_NAME, ERC1967_BEACON_SLOT } from "../executor/scope-guard.mjs";
import { cfg } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(root, "test-fixtures", "scope-guard-4663.json");
const RPC = cfg.rhRpc;   // RH_RPC, defaulting to the public Robinhood Chain endpoint
const TIMEOUT_MS = Number(process.env.SCOPE_GUARD_TIMEOUT_MS || 12_000);
const record = process.argv.includes("--record");

/* THE AUTHORED TABLE — the expectation, not the measurement. `group` says what the guard
 * MUST conclude; the recorded words are only how the chain says it. Measured 2026-09-04:
 * five equities behind one beacon, four tradeable tokens behind none. 2026-09-05: SPCX —
 * a PRIVATE company, tokenized anyway — and AI_CLONE, a 44-byte EIP-1167 clone whose name
 * carries no marker. Adding a row here is a deliberate act; re-record afterwards. */
const TOKENS = [
  { sym: "SPY", group: "equity", kind: "stock_token", address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" },
  { sym: "NVDA", group: "equity", kind: "stock_token", address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
  { sym: "AAPL", group: "equity", kind: "stock_token", address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { sym: "TSLA", group: "equity", kind: "stock_token", address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
  { sym: "SPCX", group: "equity", kind: "stock_token", address: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
    equityByName: true },
  { sym: "CASHCAT", group: "tradeable", kind: "plain", address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4" },
  { sym: "PONS", group: "tradeable", kind: "plain", address: "0x39dBED3a2bd333467115dE45665cC57F813C4571" },
  { sym: "WETH", group: "tradeable", kind: "plain", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
  { sym: "AI_CLONE", group: "tradeable", kind: "plain", address: "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
    equityByName: false },
];

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const readStorage = (address, slot) => rpc("eth_getStorageAt", [address, slot, "latest"]);
const readName = (address) => rpc("eth_call", [{ to: address, data: SELECTOR_NAME }, "latest"]);

/* REACHABILITY IS NOT AN ASSERTION. Prove the transport works before judging anything,
 * so a dead network exits 2 with an explanation instead of printing nine refusals. */
try {
  const chainId = await rpc("eth_chainId", []);
  if (chainId !== "0x1237")
    console.log(`  ..   ${RPC} answered chainId ${chainId}, expected 0x1237 (Robinhood Chain 4663)`);
} catch (e) {
  console.error(`\nCOULD NOT REACH ${RPC}: ${e.message}`);
  console.error("Nothing was checked. This is a network result, not a code result.\n");
  process.exit(2);
}

console.log(`\nSCOPE GUARD AGAINST ${RPC}\n`);
let fail = 0;
const ok = (n, c, d = "") => { c ? console.log(`  ok   ${n}${d ? "  — " + d : ""}`)
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const recorded = { recordedAt: new Date().toISOString(), chainId: "0x1237",
  sources: { rpc: RPC, methods: ["eth_getStorageAt", `eth_call ${SELECTOR_NAME} (name())`] },
  beaconSlot: ERC1967_BEACON_SLOT, tokens: {} };

const prior = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) : null;

for (const t of TOKENS) {
  let word, nameReturn;
  try {
    word = await readStorage(t.address, ERC1967_BEACON_SLOT);
    nameReturn = await readName(t.address);
  } catch (e) {
    console.error(`\nREAD FAILED for ${t.sym} (${t.address}): ${e.message}`);
    console.error("The check did not complete. This is a network result, not a code result.\n");
    process.exit(2);
  }
  /* `kind` and `group` are AUTHORED above and only carried here. The recording says how
     the chain answers; it must never be the thing that decides what the answer should be. */
  recorded.tokens[t.sym] = { address: t.address, group: t.group, kind: t.kind,
    ...(t.equityByName === undefined ? {} : { equityByName: t.equityByName }),
    beaconSlotWord: word, nameReturn };

  const v = await classifyToken(t.address, readStorage, readName);
  if (t.group === "equity")
    ok(`${t.sym} is refused as a Stock Token`,
      v.tradeable === false && v.kind === t.kind, `${v.kind} ${v.beacon ?? ""}`.trim());
  else
    ok(`${t.sym} is tradeable`, v.tradeable === true && v.kind === t.kind,
      `${v.kind} name=${JSON.stringify(v.name)}`);

  if (t.equityByName !== undefined) {
    const decoded = decodeAbiString(nameReturn);
    ok(`${t.sym} ${t.equityByName ? "names itself a Robinhood Token" : "carries no Robinhood Token marker"}`,
      classifyFromName(decoded).equityByName === t.equityByName, JSON.stringify(decoded));
  }

  /* DRIFT IS A FINDING, NOT A FAILURE. A token upgraded behind a new beacon is exactly
     what this script is for; it must be seen and re-recorded on purpose, so it is
     reported loudly and does not by itself set the exit code. */
  const was = prior?.tokens?.[t.sym];
  if (was && was.beaconSlotWord !== word)
    console.log(`  ..   DRIFT ${t.sym} beacon word ${was.beaconSlotWord} -> ${word} (re-record with --record)`);
  if (was && was.nameReturn !== nameReturn)
    console.log(`  ..   DRIFT ${t.sym} name() return changed (re-record with --record)`);
}

if (record) {
  fs.writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + "\n");
  console.log(`\n  recorded ${Object.keys(recorded.tokens).length} tokens to ${path.relative(root, FIXTURE)}`);
} else if (prior) {
  const missing = TOKENS.filter((t) => !prior.tokens?.[t.sym]).map((t) => t.sym);
  ok("every token in this table is in the fixture the tests read",
    missing.length === 0, missing.join(", ") || `${Object.keys(prior.tokens).length} recorded`);
}

console.log(fail ? `\n${fail} live check${fail === 1 ? "" : "s"} FAILED — the chain disagrees with the guard\n`
                 : "\nthe chain agrees with the guard\n");
process.exit(fail ? 1 : 0);
