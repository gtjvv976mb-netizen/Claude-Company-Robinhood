# HANDOFF — auth-leasing lane (2026-09-05)

Changes needed in files this lane does not own. Each is an exact edit and the reason.
Everything below is a consequence of the door, the ledger and the feed now speaking
eip155:4663; nothing here is optional for the fork to boot cleanly.

## 1. src/index.js — the scanner import (BLOCKS boot once scanner.js is removed)

```diff
-import { startScanner } from "./scanner.js";
+import { startScanner } from "./treasury-evm.js";
```
and the boot log line at ~433:
```diff
-      startScanner();          // watches the treasury for $CLAUDECO; no-ops until TREASURY_OWNER is set
+      startScanner();          // watches the treasury's ERC-20 Transfer logs on 4663; no-ops until TREASURY_OWNER_RH is set
```
Why: `src/scanner.js` is the Solana scanner (getSignaturesForAddress + pre/post token
balances). The data lane parked it. The EVM scanner — eth_getLogs on
Transfer(from, to=treasury) — lives in `src/treasury-evm.js`, which this lane owns, and is
the only writer of `credits` rows now. Both export `startScanner`/`stopScanner`/`scanOnce`.

## 2. src/copy.js — LANDED by its owner while this lane ran

copy.js now carries `bankroll_eth` / `fixed_eth` / `size_eth`, `MIN_EXECUTABLE_ETH`
(0.01) and the 0.05 / 0.016 ETH house seed. This lane re-pointed its SQL (office.js
feed + status, alerts.js) and its tests to those names on 2026-09-05, so nothing is
owed here. One note for that owner: `settingsFor()` still returns `bankroll_sol` /
`fixed_sol` ALIASES (copy.js ~287); office.js no longer reads them and they can go.

## 3. executor lane — the heartbeat rename is half-landed (BLOCKS live caps on the dashboard)

Both readers this lane owns (`office.js sanitizeExecutorHealth`, `src/executor-dashboard.js`)
now read the ETH wire names the poller EMITS (`executor/poller.mjs sendHeartbeat`, read
2026-09-05): `caps.{maxEthPerTrade, dailyEthCap, dailyLossLimitEth, maxOpenPositions}`,
`executionReadiness.{route: "eth-usdg", amountWei: <decimal string>}`, `held[].eth`; the
ceilings are the poller's `OPERATOR_MAX` (0.004 / 0.04 / 0.012 ETH) and the canary its
`LIVE_LIMITS` (0.0004 / 0.0008 / 0.0008), pinned to the poller source by
test-executor-dashboard.mjs. The Solana names are NOT aliases: a heartbeat under them
sanitises to `caps: null`, `route: null`, `amountWei: "0"` and degrades — measured in
test-executor-heartbeat.mjs (`solana-named heartbeat → caps=null route=null state=degraded`).

Two files in `executor/` still speak the old names and will therefore null the caps
BEFORE they leave the bot:

```diff
--- executor/heartbeat-health.mjs (~52-60, ~75-80)
-    maxSolPerTrade: boundedCap(caps.maxSolPerTrade, 0.05),
-    dailySolCap: boundedCap(caps.dailySolCap, 0.5),
-    dailyLossLimitSol: boundedCap(caps.dailyLossLimitSol, 0.15),
+    maxEthPerTrade: boundedCap(caps.maxEthPerTrade, 0.004),
+    dailyEthCap: boundedCap(caps.dailyEthCap, 0.04),
+    dailyLossLimitEth: boundedCap(caps.dailyLossLimitEth, 0.012),
 ...
-    publicCaps.dailySolCap >= publicCaps.maxSolPerTrade;
+    publicCaps.dailyEthCap >= publicCaps.maxEthPerTrade;
 ...
-      route: executionReadiness.route === "wsol-usdc" ? "wsol-usdc" : null,
+      route: executionReadiness.route === "eth-usdg" ? "eth-usdg" : null,
-      amountLamports: Number.isSafeInteger(Number(executionReadiness.amountLamports)) && ... ? ... : 0,
+      amountWei: /^[1-9][0-9]{0,30}$/.test(String(executionReadiness.amountWei)) &&
+        BigInt(executionReadiness.amountWei) <= 4000000000000000n ? String(executionReadiness.amountWei) : "0",
--- executor/monitor.mjs (~397)
-        else if (readiness.route !== "wsol-usdc" || readiness.providers !== 2)
+        else if (readiness.route !== "eth-usdg" || readiness.providers !== 2)
```
Why: `sendHeartbeat` builds `caps = { maxEthPerTrade: CFG.maxSolPerTrade, ... }` and passes
`executionReadiness.amountWei`, but `executorHeartbeatHealth` reads `caps.maxSolPerTrade`
(undefined → `boundedCap` null → `capsValid` false → `caps: null` on the wire) and maps any
route that is not `"wsol-usdc"` to null. So today a live 4663 poller reports NO caps and NO
route regardless of what the office accepts, and the dashboard shows
`active-caps-unavailable`. The identity the dashboard checks is
`BigInt(amountWei) === round(maxEthPerTrade * 1e6) * 1e12` — the poller's own `ethToWei`
rounding, reproduced in `src/executor-dashboard.js ethToWei`.

Also: `src/executor-dashboard.js` uses `EXECUTOR_GAS_HEADROOM_ETH_PLACEHOLDER = 0.001`
for the display-only "required for readiness" threshold. It is a placeholder, not a
measurement; replace it with the executor's own reserve once the heartbeat carries one.

The installer copy in viewer/office3d.html (~7981, ~9374-9380: `--max-sol 0.005
--daily-cap 0.01 --daily-loss-cap 0.01`, `--jupiter-key-file`) follows
`executor/install.sh`, which still takes `--max-sol`; it was left alone and
test-dashboard-ui.mjs still asserts it. When install.sh renames its flags, that copy and
the assertion change together.

## 4. src/passes.js — guest passes still verify a Solana transaction

`grantPass` takes a base58 signature (`/^[1-9A-HJ-NP-Za-km-z]{80,90}$/`) and reads
`getTransaction` via `cfg.rpc` (Solana). On 4663 a pass payment is an ERC-20 Transfer to
the TENANT's wallet; the proof should be an `0x` tx hash checked with
`eth_getTransactionReceipt` (status 0x1) and the Transfer log decoded with
`readTransferLog` from `src/treasury-evm.js` (pass `{ token, treasury: lease.wallet }`).
The route `/api/floor/:n/pass` in office.js is unchanged and will keep answering
"that does not look like a transaction signature" for any 0x hash until this lands.

## 5. src/config.js and render.yaml — env names

- `cfg.rpc` is `SOLANA_RPC || api.mainnet-beta.solana.com`. This lane reads `RH_RPC` /
  `RH_RPC_SECONDARY` directly in `src/treasury-evm.js` and no longer touches `cfg.rpc`;
  the data lane's `src/lib/evm.js` should become the single place these are read, and
  the RPC helpers in `treasury-evm.js` (`evmRpc`, `ethCall`, `erc20BalanceOf`,
  `walletEthBalance(s)`, the ABI word helpers) can move there when it exists — this lane
  will re-import from it.
- render.yaml envVars: replace `CLAUDECO_MINT` / `CLAUDECO_DECIMALS` / `TREASURY_OWNER` /
  `SOLANA_RPC` with `CLAUDECO_RH_TOKEN` (value `0x0000000000000000000000000000000000000000`
  until launch) / `CLAUDECO_RH_DECIMALS` (`"18"`) / `TREASURY_OWNER_RH` (sync: false) /
  `RH_RPC` (sync: false) / `HQ_OWNER_WALLET_RH` (sync: false). Service name
  `claude-company-robinhood-api`, disk `claude-company-robinhood-data`. Optional:
  `TREASURY_SCAN_FROM_BLOCK` for a treasury configured after payments were made.
- `healthCheckPath: /api/lease/config` still works: it now returns
  `{ chainId: 4663, token, decimals, treasury, launched, ready, reason, pay }`.

## 6. src/data/eth-usd.js — the stub this lane calls

`office.js` (callouts board) does `const m = await import("./data/eth-usd.js"); m.ethUsd()`
inside a try and accepts either a number or `{ usd }`. Until it exists the board reports
`eth-usd-price-unavailable` and nothing passes the wallet bar, which is the honest
failure. The callout SOURCE (pump.fun readers) is also imported inside a try and a
missing module yields an empty board with `source: callout-source-unavailable-on-eip155:4663`.

## 7. viewer/office3d.html — parts outside this lane's wallet/buy paths

Left as they were, on purpose (not this lane's to redesign):
- the bot-balance reads at ~7214/7240 POST `getBalance` to `/api/bot/rpc`, which is
  already a 410 tombstone; the board therefore shows "WALLET UNREADABLE". The live
  balance is on `/api/floor/:n/executor/status` → `wallet.balanceEth/balanceWei`.
  test-dashboard-ui.mjs (this lane) still asserts the old text and passes; it should be
  re-pointed when the dashboard view moves to the status route.
- installer copy at ~7975 / ~9432 ("two private HTTPS Solana RPC URLs", "Jupiter API key")
  follows executor/install.sh flags, which the executor lane owns.
- the "sixteen agents" rail copy in tower.html is retargeted; index.html is the parent's.

## 8. The credits table on a database carried over from Solana

`credits` is now keyed `UNIQUE(signature, log_index)`; a carried-over database keeps its
inline `UNIQUE(signature, dest_account)` (SQLite cannot drop an inline constraint) and
gets `log_index` via ensureColumn. On such a database a second Transfer to the treasury
inside ONE transaction would be refused as a duplicate. The Robinhood service is a fresh
disk, so this does not apply to it; it is written down so nobody rediscovers it.
