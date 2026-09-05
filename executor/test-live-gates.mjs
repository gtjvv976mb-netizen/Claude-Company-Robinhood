/**
 * THE LIVE BOOT GATES, SPAWNED: what EXECUTE=1 refuses before it touches a provider.
 *
 * Every case runs the real poller.mjs with INIT_ONLY=1 so the process exits at the
 * journal-binding step, before the registry gate and before any RPC; a refusal is a
 * non-zero exit with the reason on stderr. The last case drops INIT_ONLY to prove that
 * the next thing a full live boot meets is the thresholds registry, not a provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Wallet, getAddress } from "ethers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-gates-"));
const keyFile = path.join(dir, "burner.key");
const stateDb = path.join(dir, "state.sqlite");
const burner = Wallet.createRandom();
fs.writeFileSync(keyFile, burner.privateKey + "\n", { mode: 0o600 });
const wallet = getAddress(burner.address);
const poller = path.join(path.dirname(fileURLToPath(import.meta.url)), "poller.mjs");
const base = {
  ...process.env,
  CC_SECRET: "a".repeat(64), CC_FLOOR: "50", EXECUTE: "1",
  KEY_FILE: keyFile, STATE_DB: stateDb, LOCK_FILE: `${stateDb}.lock`,
  RH_RPC: "https://primary-private-rpc.invalid",
  RH_RPC_SECONDARY: "https://independent-rpc.invalid",
  LIVE_TRADING_ACK: wallet, INIT_ONLY: "1",
};
const run = (extra = {}) => spawnSync(process.execPath, [poller], {
  env: { ...base, ...extra }, encoding: "utf8", timeout: 20_000,
});
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ok   ${name}`); };

ok("a state database cannot be split across a different process lock", () => {
  const result = run({ LOCK_FILE: path.join(dir, "different.lock") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical STATE_DB lock/);
});

ok("wrong address acknowledgement rejects live mode before network", () => {
  const result = run({ LIVE_TRADING_ACK: "wrong" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIVE_TRADING_ACK must exactly equal/);
});

ok("a lower-cased address acknowledgement is refused: the checksummed form, byte for byte", () => {
  const result = run({ LIVE_TRADING_ACK: wallet.toLowerCase() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIVE_TRADING_ACK must exactly equal/);
});

ok("group-readable key rejects live mode", () => {
  fs.chmodSync(keyFile, 0o644);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permissions must be 0600/);
  fs.chmodSync(keyFile, 0o600);
});

ok("a Solana JSON keypair in the key file is refused, not misread", () => {
  const solanaFile = path.join(dir, "burner.json");
  fs.writeFileSync(solanaFile, JSON.stringify(Array.from({ length: 64 }, (_, i) => i)), { mode: 0o600 });
  const result = run({ KEY_FILE: solanaFile });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /32-byte hex private key/);
});

ok("missing, public, or same-provider secondary RPC rejects live mode", () => {
  for (const [secondary, pattern] of [
    ["", /explicit independent RH_RPC_SECONDARY/],
    ["https://rpc.mainnet.chain.robinhood.com", /rate-limited public Robinhood Chain RPC/],
    ["https://primary-private-rpc.invalid/backup", /independent provider hostname/],
  ]) {
    const result = run({ RH_RPC_SECONDARY: secondary });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  }
});

ok("the public RPC is rejected in the primary lane too", () => {
  const result = run({ RH_RPC: "https://rpc.mainnet.chain.robinhood.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rate-limited public Robinhood Chain RPC/);
});

ok("live deployment and transaction ceilings cannot be raised by environment", () => {
  for (const [name, value] of [
    ["MAX_ETH_PER_TRADE", "0.0004001"],
    ["DAILY_ETH_CAP", "0.0008001"],
    ["DAILY_LOSS_LIMIT_ETH", "0.0008001"],
    ["MAX_OPEN_POSITIONS", "5"],
    ["MAX_EXIT_PRICE_IMPACT_PCT", "50.01"],
    ["MAX_ENTRY_ROUND_TRIP_LOSS_PCT", "12.01"],
    ["MAX_TX_ATTEMPTS", "4"],
    ["MAX_EXIT_TX_ATTEMPTS", "13"],
    ["DEADLINE_BLOCKS", "301"],
    ["ETH_USD_CACHE_MAX_AGE_MS", "90000001"],
  ]) {
    const result = run({ [name]: value, LIVE_STATE_INIT_ACK: wallet });
    assert.notEqual(result.status, 0, `${name} unexpectedly bypassed its live ceiling`);
    /* The three MONEY caps are raisable through the typed acknowledgement (see
     * test-operator-caps.mjs), so raising one by env alone refuses EARLIER — naming
     * the ceremony rather than the range. The invariant this test guards is unchanged
     * and is what is asserted: env alone can never bypass a live ceiling. */
    const MONEY = ["MAX_ETH_PER_TRADE", "DAILY_ETH_CAP", "DAILY_LOSS_LIMIT_ETH"];
    assert.match(result.stderr, MONEY.includes(name)
      ? /ALL THREE set explicitly|typed acknowledgement/
      : name === "MAX_OPEN_POSITIONS"
        ? /MAX_OPEN_POSITIONS must be an integer between 1 and 4/
      : new RegExp(`${name} must be between`));
  }
});

ok("slippage, impact and the fee gate have NO environment door at all", () => {
  // These used to be env-bounded ceilings on Solana. Here they come from the thresholds
  // registry with provenance; an env value is neither honoured nor even mentioned.
  const result = run({ SLIPPAGE_BPS: "1", MAX_PRICE_IMPACT_PCT: "99", MAX_NETWORK_FEE_WEI: "1", LIVE_STATE_INIT_ACK: wallet });
  assert.equal(result.status, 0, result.stderr);
  const src = fs.readFileSync(poller, "utf8");
  assert.ok(!/process\.env\.(?:SLIPPAGE_BPS|MAX_PRICE_IMPACT_PCT|MAX_NETWORK_FEE)/.test(src));
  assert.ok(/registryValue\("exec\.slippageBps"/.test(src) && /registryValue\("exec\.maxPriceImpactPct"/.test(src) &&
    /registryValue\("exec\.maxNetworkFeeWei"/.test(src), "the poller reads them from the registry");
});

ok("different API-key paths on one RPC provider are not independent", () => {
  const result = run({ RH_RPC: "https://same-rpc.invalid/key-a", RH_RPC_SECONDARY: "https://same-rpc.invalid/key-b" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /independent provider hostname/);
});

ok("a plain-HTTP API is refused in live mode even on loopback", () => {
  const result = run({ CC_API: "http://127.0.0.1:8787" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live execution requires an HTTPS CC_API/);
});

ok("missing live journal requires a one-time wallet-bound init acknowledgement", () => {
  fs.rmSync(stateDb, { force: true });
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live journal is missing/);
});

ok("wallet-bound INIT_ONLY creates state without touching an RPC", () => {
  const result = run({ LIVE_STATE_INIT_ACK: wallet });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(stateDb));
  assert.match(result.stdout, /initialized journal/);
  assert.match(result.stdout, /chain 4663/);
});

ok("a full live boot meets the thresholds registry next — before any provider, and it refuses while anything is VOID", () => {
  const result = run({ INIT_ONLY: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not measured on this chain/);
  assert.match(result.stderr, /exec\.slippageBps/);
  assert.match(result.stderr, /exec\.inclusionLatencyMs/);
  assert.doesNotMatch(result.stdout, /RPC unreachable/);
});

ok("journal cannot silently rebind to a replacement wallet", () => {
  const replacement = Wallet.createRandom();
  fs.writeFileSync(keyFile, replacement.privateKey + "\n", { mode: 0o600 });
  const result = run({ LIVE_TRADING_ACK: getAddress(replacement.address) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /journal belongs to wallet/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} live startup gates passed\n`);
