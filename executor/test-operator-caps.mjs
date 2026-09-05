/** Raised live caps require the current wallet/value-bound policy ceremony — v3, in ETH. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Wallet, getAddress } from "ethers";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-caps-"));
const keyFile = path.join(dir, "burner.key");
const burner = Wallet.createRandom();
fs.writeFileSync(keyFile, burner.privateKey.slice(2) + "\n", { mode: 0o600 });   // no 0x, deliberately
const wallet = getAddress(burner.address);
const poller = path.join(path.dirname(fileURLToPath(import.meta.url)), "poller.mjs");
const base = {
  ...process.env, CC_SECRET: "a".repeat(64), CC_FLOOR: "50", EXECUTE: "1",
  KEY_FILE: keyFile, STATE_DB: path.join(dir, "state.sqlite"), LOCK_FILE: path.join(dir, "state.sqlite.lock"),
  RH_RPC: "https://primary-private-rpc.invalid",
  RH_RPC_SECONDARY: "https://independent-rpc.invalid",
  LIVE_TRADING_ACK: wallet, INIT_ONLY: "1", LIVE_STATE_INIT_ACK: wallet,
};
const run = (extra = {}) => spawnSync(process.execPath, [poller], {
  env: { ...base, ...extra }, encoding: "utf8", timeout: 20_000,
});
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ok   ${name}`); };

/* THE CAPS ARE RAISABLE, WITH CEREMONY. On this chain the reason is sharper than on
 * Solana: gas is FLAT (live-thresholds.mjs), so a ~0.00028 ETH round trip is 70% of the
 * 0.0004 ETH canary and 7% of the 0.004 ETH operator ceiling — the canary can only
 * ever be refused by the executable-cost guard. The canary is still the default; what
 * must stay true is that nothing raises exposure by accident. The v3 wording (ETH, the
 * checksummed address) revokes every SOL-era acknowledgement. */
const ackFor = (t, d, l, acknowledgedWallet = wallet) =>
  `I acknowledge WALL-ST-E caps v3 for ${acknowledgedWallet}: ${t} ETH per trade, ${d} ETH per day, ${l} ETH rolling realized-loss entry brake`;

ok("env alone cannot raise a cap — the ceremony is required", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.04", DAILY_LOSS_LIMIT_ETH: "0.012" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
  assert.match(result.stderr, /I acknowledge WALL-ST-E caps v3/);
});
ok("a partial raise is refused and says why", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALL THREE set explicitly/);
});
ok("a sentence naming different numbers is refused", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.04",
    DAILY_LOSS_LIMIT_ETH: "0.012", LIVE_CAPS_ACK: ackFor("0.003", "0.04", "0.012") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("the revoked SOL-era (v2) acknowledgement is refused", () => {
  const legacy = `I acknowledge WALL-ST-E caps v2 for ${wallet}: 0.05 SOL per trade, 0.5 SOL per day, 0.15 SOL rolling realized-loss entry brake`;
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.04",
    DAILY_LOSS_LIMIT_ETH: "0.012", LIVE_CAPS_ACK: legacy });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("a sentence naming a different wallet is refused", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.04",
    DAILY_LOSS_LIMIT_ETH: "0.012", LIVE_CAPS_ACK: ackFor("0.004", "0.04", "0.012", "0x0000000000000000000000000000000000000001") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
ok("a sentence naming the wallet in lower case is refused — the checksum is part of the name", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.04",
    DAILY_LOSS_LIMIT_ETH: "0.012", LIVE_CAPS_ACK: ackFor("0.004", "0.04", "0.012", wallet.toLowerCase()) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /typed acknowledgement/);
});
for (const [name, values, message] of [
  ["per-trade", ["0.0040001", "0.04", "0.012"], /MAX_ETH_PER_TRADE must be between/],
  ["daily deploy", ["0.004", "0.0400001", "0.012"], /DAILY_ETH_CAP must be between/],
  ["realized-loss brake", ["0.004", "0.04", "0.0120001"], /DAILY_LOSS_LIMIT_ETH must be between/],
]) ok(`${name} cannot exceed its hard maximum`, () => {
  const [trade, daily, loss] = values;
  const result = run({ MAX_ETH_PER_TRADE: trade, DAILY_ETH_CAP: daily,
    DAILY_LOSS_LIMIT_ETH: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
});
ok("over-precise literals cannot round down onto an operator maximum", () => {
  for (const [trade, daily, loss] of [
    ["0.0040000000000000000000001", "0.04", "0.012"],
    ["0.004", "0.0400000000000000000000001", "0.012"],
    ["0.004", "0.04", "0.0120000000000000000000001"],
  ]) {
    const result = run({ MAX_ETH_PER_TRADE: trade, DAILY_ETH_CAP: daily,
      DAILY_LOSS_LIMIT_ETH: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plain decimal with at most 18 fractional digits/);
  }
});
ok("every explicit money cap must meet the live minimum", () => {
  for (const name of ["MAX_ETH_PER_TRADE", "DAILY_ETH_CAP", "DAILY_LOSS_LIMIT_ETH"]) {
    for (const value of ["", "0", "0.0000009", "0.0000009999999999999999999"]) {
      const result = run({ [name]: value });
      assert.notEqual(result.status, 0, `${name}=${JSON.stringify(value)} was accepted`);
      assert.match(result.stderr, value === "0" || value === "0.0000009"
        ? new RegExp(`${name} must be between 0\\.000001`)
        : new RegExp(`${name} must be a plain decimal with at most 18 fractional digits`));
    }
  }
});
ok("live max-open positions must be an integer from one through four", () => {
  for (const value of ["", "0", "1.5", "4.0", "4.0000000000000001", "5"]) {
    const result = run({ MAX_OPEN_POSITIONS: value });
    assert.notEqual(result.status, 0, `MAX_OPEN_POSITIONS=${JSON.stringify(value)} was accepted`);
    assert.match(result.stderr, /MAX_OPEN_POSITIONS must be an integer between 1 and 4/);
  }
});
ok("the daily deploy cap cannot sit below one allowed trade", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.003",
    DAILY_LOSS_LIMIT_ETH: "0.012", LIVE_CAPS_ACK: ackFor("0.004", "0.003", "0.012") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MAX_ETH_PER_TRADE/);
});
ok("daily deployment coherence is exact at one-wei precision", () => {
  const trade = "0.001000000000000001";
  const daily = "0.001000000000000000";
  const loss = "0.001";
  const result = run({ MAX_ETH_PER_TRADE: trade, DAILY_ETH_CAP: daily,
    DAILY_LOSS_LIMIT_ETH: loss, LIVE_CAPS_ACK: ackFor(trade, daily, loss) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /below MAX_ETH_PER_TRADE/);
});
ok("a fully lowered tuple still requires daily deploy to cover one trade", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.0003", DAILY_ETH_CAP: "0.0002",
    DAILY_LOSS_LIMIT_ETH: "0.0003" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAILY_ETH_CAP \(0\.0002\) is below MAX_ETH_PER_TRADE \(0\.0003\)/);
});
ok("a matching v3 acknowledgement raises to the exact supported maxima", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.004", DAILY_ETH_CAP: "0.04",
    DAILY_LOSS_LIMIT_ETH: "0.012", LIVE_CAPS_ACK: ackFor("0.004", "0.04", "0.012") });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPERATOR-RAISED CAPS acknowledged: 0\.004 ETH\/trade, 0\.04 ETH\/day deploy, 0\.012 ETH rolling realized-loss entry brake/);
});
ok("ETH/USD cache age is validated and cannot exceed the feed's heartbeat-plus-slack ceiling", () => {
  for (const value of ["90000001", "not-a-number"]) {
    const result = run({ ETH_USD_CACHE_MAX_AGE_MS: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ETH_USD_CACHE_MAX_AGE_MS must be between 1000 and 90000000/);
  }
});
ok("the drop deadline is bounded: an operator may shorten it, never stretch it into 'wait forever'", () => {
  const result = run({ DEADLINE_BLOCKS: "301" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEADLINE_BLOCKS must be between 50 and 300/);
  assert.equal(run({ DEADLINE_BLOCKS: "100" }).status, 0);
});
ok("lowering a cap remains allowed", () => {
  const result = run({ MAX_ETH_PER_TRADE: "0.0001", DAILY_ETH_CAP: "0.0005",
    DAILY_LOSS_LIMIT_ETH: "0.0005", MAX_OPEN_POSITIONS: "1",
    ETH_USD_CACHE_MAX_AGE_MS: "60000" });
  assert.equal(result.status, 0, result.stderr);
});
ok("the default canary configuration initializes without a network request", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialized journal/);
});

console.log(`\n${pass} versioned live-cap gates passed\n`);
fs.rmSync(dir, { recursive: true, force: true });
