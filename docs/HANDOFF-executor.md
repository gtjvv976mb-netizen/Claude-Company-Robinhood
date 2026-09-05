# HANDOFF — executor lane (2026-09-05)

Changes needed in files this lane does not own. Each: the file, the exact edit, the reason.
Nothing here is applied.

## 1. `scripts/build-viewer.mjs` `EXECUTOR_FILES` — add `evm-rpc.mjs` (deploy-repo lane)

```diff
 const EXECUTOR_FILES = [
-  "poller.mjs", "journal.mjs", "evm-executor.mjs", "evm-swap.mjs", "approvals.mjs", "scope-guard.mjs",
+  "poller.mjs", "journal.mjs", "evm-executor.mjs", "evm-rpc.mjs", "evm-swap.mjs", "approvals.mjs", "scope-guard.mjs",
```

Why: `evm-rpc.mjs` is the JSON-RPC transport every EVM module imports (`evm-executor.mjs`,
`evm-swap.mjs`'s callers, `erc20-hazards.mjs`, `eth-usd-oracle.mjs`, `monitor.mjs`,
`poller.mjs`). It is in `launchd-runner.mjs RUNTIME_FILES`, `heartbeat-health.mjs
TRADING_RUNTIME_FILES`, `install.sh RUNTIME_FILES` and `test-install.mjs need` (all four
held equal by test-install and test-launchd), so a release build that omits it publishes
a module graph the poller cannot import. `executor.mjs` (still in the list) is now a
dependency-free dry-run reference and imports nothing from the graph.

## 2. `src/office.js sanitizeExecutorHealth` + `src/executor-dashboard.js` — the rename landed (auth-leasing lane asked to be told)

The heartbeat now sends, verbatim from `poller.mjs sendHeartbeat`:

```json
"caps": { "maxEthPerTrade": 0.0004, "dailyEthCap": 0.0008, "dailyLossLimitEth": 0.0008, "maxOpenPositions": 4 },
"executionReadiness": { "ready": true, "lastSuccessAt": 0, "observedAt": 0, "route": "weth-usdg", "providers": 2, "amountWei": "400000000000000" },
"chain": 4663, "wallet": "0x…checksummed…", "held": [{ "mint": "0x…", "eth": 0.0004, "openedAt": 0 }]
```

- `route` is exactly `"weth-usdg"` (already accepted by the sanitizer).
- `amountWei` is a DECIMAL STRING of wei (up to 4e15 for the operator ceiling; past
  `Number.isSafeInteger` territory for anything larger). The dashboard's
  readiness-covers-cap identity becomes
  `readiness.amountWei === (BigInt(Math.round(caps.maxEthPerTrade * 1e6)) * 10n ** 12n).toString()`
  (micro-ETH precision, the poller's `ethToWei`). The old `amountLamports` bound
  `1..50_000_000` has no meaning here.
- Caps bounds for the sanitizer, from `poller.mjs`: `maxEthPerTrade` 0.000001..0.004,
  `dailyEthCap` ≥ `maxEthPerTrade` and ≤ 0.04, `dailyLossLimitEth` ≤ 0.012,
  `maxOpenPositions` 1..4. `EXECUTOR_OPERATOR_MAXIMA` in executor-dashboard.js should
  become `{ maxEthPerTrade: 0.004, dailyEthCap: 0.04, dailyLossLimitEth: 0.012 }`.
- `EXECUTOR_GAS_HEADROOM_ETH_PLACEHOLDER = 0.001`: the executor's own reserve is
  `EXECUTION_READINESS_RESERVE_WEI = 1e15` (0.001 ETH) PLUS the registry fee ceiling
  `exec.maxNetworkFeeWei` (VOID today); the heartbeat does not carry the sum. Keep the
  placeholder until the fee ceiling is measured, then it is `0.001 + maxNetworkFeeWei/1e18`.
- `held[].eth` replaces `held[].sol`; `chain: 4663` is new.

## 3. `src/executor-dashboard.js` / `viewer/office3d.html` installer copy (auth-leasing noted it)

The installer flags are now `--max-eth`, `--daily-cap`, `--daily-loss-cap`, `--rpc-file`,
`--secondary-rpc-file`; there is no Jupiter key. The burner is `burner.key` (32-byte hex,
0600), not `burner.json`. Copy that says "two private HTTPS Solana RPC URLs" or
"Jupiter API key" should say "two private HTTPS Robinhood Chain (4663) RPC providers on
different hostnames; the public rpc.mainnet.chain.robinhood.com is refused for live".

## 4. `render.yaml` / `.env.example` — no executor variable lives on Render

The executor runs on the tenant's machine. Its env names, for the docs that list them:
`RH_RPC`, `RH_RPC_SECONDARY`, `KEY_FILE`, `LIVE_TRADING_ACK` (checksummed address),
`MAX_ETH_PER_TRADE`, `DAILY_ETH_CAP`, `DAILY_LOSS_LIMIT_ETH`, `LIVE_CAPS_ACK` (v3
sentence), `FEE_RESERVE_ETH`, `ETH_USD_CACHE_MAX_AGE_MS`, `DEADLINE_BLOCKS`,
`RECEIPT_TIMEOUT_MS`, `CC_API` (default `https://claude-company-robinhood-api.onrender.com`).
`SLIPPAGE_BPS`, `MAX_PRICE_IMPACT_PCT` and any network-fee env are GONE on purpose: the
launchd allowlist refuses them and the poller reads those numbers from the thresholds
registry only.

## 5. `src/data/eth-usd.js` (auth-leasing's stub) — the executor's oracle is reusable

`executor/eth-usd-oracle.mjs independentEthUsdPrice([rpcA, rpcB])` reads the Chainlink
ETH/USD proxy `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` (aggregator
`0x6091e64eb7138eef066a80fd3a0d7427b91f2721`, 8 decimals, heartbeat 86,400s, deviation
0.5%) through two providers with a freshness/divergence policy, and
`describeEthUsdFeed(providers)` prints answer/decimals/updatedAt. Verified 2026-09-05 at
block 54,714,740: answer 245,522,190,000 ($2,455.22), updatedAt 1788535814. The office
may import it (it depends only on `executor/evm-rpc.mjs`) rather than write a second reader.

## 6. Owner-facing: the live thresholds are still VOID, and three need a funded burner

`assertLiveReady()` refuses EXECUTE=1 (test-live-gates proves it) until
`screen.minLiquidityUsd`, `screen.minStopDistancePct`, `exec.slippageBps`,
`exec.maxPriceImpactPct`, `bands.floors`, `bands.holdWindows`, `exec.maxNetworkFeeWei`,
`exec.inclusionLatencyMs`, `exec.dropRatePct`, `exec.nonceReplacementHonoured` are
`measured`. `executor/probe-measure-4663.mjs` produces pasteable `M(date, method)` lines
for the first group (its 2026-09-05 outputs are in the executor lane report); the last
three require a real send from a funded burner and are outside a read-only lane.
