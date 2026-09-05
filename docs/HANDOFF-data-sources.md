# HANDOFF — data-sources lane (2026-09-05)

Changes needed in files this lane does not own, each with the exact edit and the reason.
Nothing here is applied; the parent merges. The lane's own deliverables — `src/lib/evm.js`,
`src/data/{evm,pons-live,kyber,eth-usd,evidence,dexscreener,regime}.js`, the ported
`market/ignition/trends/whales/config.js`, the parked `scanner.js` and the two new tests —
are on disk and described in the lane report, not here.

## 1. `src/office.js:1265-1266` — the callout board's source (office lane)

```diff
-            live = await import("./data/pumpfun-live.js");
-            pf = await import("./data/pumpfun.js");
+            live = await import("./data/pons-live.js");   // recentlyTraded(), asCandidate(), trades(pool)
+            pf = await import("./whales.js");             // callouts(address) — GeckoTerminal pool trades ≥ $500
```

Why: both Solana modules are now throwing shims (see §5). `pons-live.js` exports the same
listing names (`newLaunches`, `recentlyTraded`, `padPools`, `asCandidate`, `bandOf`,
`candles`, `momentumFrom`, `momentumFor`) and adds `trades(pool, {minUsd})`; the callout
reader is `src/whales.js callouts(address)`, which returns the trades already shaped
(`wallet, side, usd, at, block, evidenceKind: "indexer_trade_usd"`). The board's
"pumpfun-verified caller" policy has no equivalent on 4663 — GeckoTerminal carries no
identity — so `policy.pumpfunVerifiedRequired` should become `false` with a note, and the
wallet bar (`CALLOUT_MIN_WALLET_USD`) needs `eth_getBalance` on the trader (`src/data/evm.js
read("eth_getBalance", [wallet, "latest"])`) priced through `src/data/eth-usd.js ethUsd()`,
which now exists and answers `{ ok, value, stalenessSec, source }`.

## 2. `src/manifest.js:49` — `DECISION_MANIFEST_FILES` (deploy-repo lane)

```diff
-  "src/data/gmgn.js",
+  "src/data/eth-usd.js",
```

Why: `gmgn.js` is a compatibility shim that throws on every call and is not on any
decision path; `eth-usd.js` IS — every USD figure in the bundle goes through it. The
manifest should hash what decides. `src/data/evm.js` and `src/data/pons-live.js` exist
under the contract's names, so those two entries need no change.

## 3. `src/order.js` and `src/desk.js` — GMGN links (office / agents lanes)

Any `tokenLink()/tradeLink()/links()` from `./data/gmgn.js` now throws. Replace with the
indexer pages that exist for this chain:

```js
const tokenLink = (a) => `https://www.geckoterminal.com/robinhood/tokens/${a}`;
const tradeLink = (a) => `https://dexscreener.com/robinhood/${a}`;
```

The explorer (`https://robinhoodchain.blockscout.com/address/${a}`) is human-facing and may
be linked, never fetched from server code (403 to a non-browser UA, measured 2026-09-05).

## 4. `src/index.js` doctor, `src/perf.js`, `src/passes.js` — Solana RPC names still sent

`src/lib/http.js readRpc` keeps the Solana method names on its allowlist ONLY so these
files degrade to an `{ok:false, error:"method not found"}` line instead of throwing at
boot. Each should move to the EVM reads (`eth_chainId`, `eth_blockNumber`,
`eth_getBalance`, `eth_getTransactionReceipt`), after which `SOLANA_READS` in `http.js`
can be deleted. `passes.js` is covered in HANDOFF-auth-leasing §4 (the 0x tx-hash proof
via `readTransferLog` from `src/treasury-evm.js`).

## 5. The compatibility shims, and when they can go

`src/data/pumpfun.js`, `pumpfun-live.js`, `jupiter.js`, `solana.js`, `gmgn.js` export
their old names and THROW `"… Solana source removed on the Robinhood fork"` on use
(`withRetry`, `momentumFrom` and `bandOf` are re-exported from the live modules because
they are pure). They stay until `grep -rn "data/\(pumpfun\|jupiter\|solana\|gmgn\)" src
test-*.mjs` is empty; today that is `office.js:1265-1266`, `manifest.js:49` and
`test-deploy-names.mjs:177` (which asserts the shims say "removed" — keep that test
pointed at them until they are deleted, then delete the assertion with them).

## 6. `executor/` — two figures the bundle now carries that the executor should read

- `evidence.exitProbe.gasUsdRoundTrip` is priced off the ROUTE's gas (both legs summed
  from Kyber's `routeSummary.gas`) × live `eth_gasPrice` × `ethUsd.value`. The executor's
  `ROUND_TRIP_GAS` constant (661,000, median of 9) is the executor's own ruler and is not
  read here; if the two are to be reconciled, the route figure is per-coin and the
  constant is a floor.
- `evidence.sellSim.transferFeeBps` is the token-level transfer tax from a state-override
  probe (balance delta around `transfer()`, no aggregator in the path). It is the number
  to compare `erc20-hazards.mjs` against; `sellSim.effectiveTaxBps` / `routeGapBps` is
  chain-vs-quote on the aggregator's calldata and INCLUDES the quote's own error
  (CASHCAT, no fee, read 0 bps at 05:22 and 607 bps at 09:40 on 2026-09-05).

## 7. `src/agents/risk-rails.js` — one vocabulary check (agents lane)

`EVM_GATES.killFlags` matches `/…|pausable|…/`, which fires on the bare `pausable` flag
(paused() exists) as well as `pausable_live` (a live role can flip it). The bundle emits
both; GOOGL carries both. If the intent is "a live role", the regex should be
`pausable_live`; if it is "Pausable at all", it is right as written. Left as written.
The contract's `upgradeable_eoa` flag is what the bundle now emits (the earlier draft said
`upgrade_key_eoa`; that name survives only as the SCREEN's kill code).

## 8. `docs/EVIDENCE-CONTRACT.md` rows this lane could not produce (owner)

Null with a stated reason in every bundle, never guessed:
`launch.creatorTaxBps`, `launch.maxCreatorTaxBps`, `launch.feeClaimCount`,
`launch.feeClaimedEth` (every graduation/fee selector guessed on a live V2 curve proxy
reverted), `deployer.graduated`, `deployer.dead`, `deployer.sameImplementation`,
`deployer.fundedBy` (need a trace RPC or the explorer index), `derived.voidedTxPct`,
`derived.commonFunderPct`, `derived.customRouterPct`, `depth.inRangeLiquidityPct`,
`lp.locker/lockedPct/unlockAt/positionNftOwner`, `contract.verifiedSource`,
`contract.feeSettable/maxFeeBps`, `launchpad.creatorHandle` (seeded from DexScreener
socials in `enrichWithXRead`, else null). The PoolGraduated topic0 named in the contract
is not known here; graduation is detected from the PoolManager's Initialize log for the
token instead (`pons-live.js graduationFor`), which is what `launch.graduatedAt` reads.
