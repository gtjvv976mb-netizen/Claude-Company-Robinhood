# HANDOFF — desk-loop lane (2026-09-05)

Changes this lane needs in files it does not own, and the facts other lanes should know
about what it changed. Nothing here is applied; the parent merges. Every item names the
file, the exact edit, and why.

## 1. `src/market.js` PADS + `src/trends.js:84` — the launchpad label (data lane / trends owner)

`market.js launchpad()` collapses every PONS dex id ("pons", "pons-v2", "pons-v2-dex",
"pons-dot-family") to the id `"pons"` and hoodit to `"hood.fun"` (the evidence contract's
`launchpad.venue` vocabulary). The tenant-facing list this lane owns (copy.js `LAUNCHPADS`,
from the shared contract) is `pons-v2, pons (V1), hoodit, pools.trade, bankr, uniswap,
other`, and `PREFERRED_PAD` is `"pons-v2"`. Compared raw, the pad quota matched nothing —
the "pump.fun on a chain with no pump.fun" failure re-created with a different string.

This lane closed it on its side with an alias table, `canonicalLaunchpad()` in
`src/canonical.js`, applied at every comparison and at every write (`openCall`,
`funnel.observe`, `selectAcrossBoard`, `dueForStudy`, `penthouse` universe maps,
`trendHandoff`, copy.js allow-lists). `test-desk-loop-eth.mjs` pins it with
`launchpad(addr, "pons-v2")` — printed `pons` — canonicalising to `pons-v2`.

Requested, so the two vocabularies stop drifting:

```diff
--- src/market.js
-  { id: "pons",         dexes: ["pons", "pons-v2", "pons-v2-dex", "pons-dot-family", "ponsfamily"] },
-  { id: "hood.fun",     dexes: ["hoodit", "hood-fun", "hoodfun"] },
+  { id: "pons-v2",      dexes: ["pons", "pons-v2", "pons-v2-dex", "ponsfamily"] },   // the current factory
+  { id: "pons",         dexes: ["pons-dot-family"] },                                  // V1, WETH-paired V3
+  { id: "hoodit",       dexes: ["hoodit", "hood-fun", "hoodfun"] },
--- src/trends.js
-      buysH1: c.pair.txns?.h1?.buys ?? 0, matchedTerm, launchpad: c.launchpad ?? "pons",
+      buysH1: c.pair.txns?.h1?.buys ?? 0, matchedTerm, launchpad: c.launchpad ?? null,
```

If the data lane prefers to keep `launchpad.venue` as the contract states it, no code
change is needed — the alias table already maps both ways — but `docs/EVIDENCE-CONTRACT.md`
row `launchpad.venue` should then say that `pons` there means the V2 factory and that the
copy-trading id for it is `pons-v2` (canonical.js). Note `trends.js` defaulting a coin
with NO pad to `"pons"` labels a plain Uniswap listing as a curve launch and would arm the
creator-sold tripwire on it; `null` is the honest value.

## 2. `src/data/regime.js` — `solRet25d` can go (data lane)

`penthouse.js majorWeather()` reads `ethRet25d` first and falls back to `solRet25d` with a
"(regime.js still reads Solana — handoff)" tag. regime.js already exports `ethRet25d`
(line 39) and keeps `solRet25d` as a same-number alias (42). Once nothing else prints the
alias, drop it and this lane's fallback branch becomes dead code to remove.

## 3. `src/office.js`, `viewer/office3d.html` — the SOL-named aliases expire next release

copy.js still emits `bankroll_sol / fixed_sol` (settingsFor), `sizeSol` (decide) and
`size_sol` (feedFor, via `COALESCE(size_eth, size_sol)`) as ONE-RELEASE mirrors of the ETH
numbers. office.js no longer reads them (auth-leasing HANDOFF §2), but the viewer does:
`office3d.html` 4135/4147/7481/7520-7521 read `c.size_sol` and print "SOL", 7839/7843 bind
the settings form to `bankroll_sol` / `fixed_sol`, and 9613/9730 read `walletSolUsd` and
print "of SOL". Every one of those numbers is ETH now. Retarget the viewer to `size_eth`,
`bankroll_eth`, `fixed_eth`, `walletEthUsd`, and change the printed unit; then tell this
lane and the mirrors (copy.js `ethView` note, callouts.js `walletSolUsd`,
`evidenceBackedPumpfunCallouts`) are deleted in one commit. office.js:45 and :1345/:1402
import and pass the Pumpfun-named export and `walletSolUsd`; the neutral names are
`evidenceBackedCallouts` and `walletEthUsd`, same functions, same numbers.

## 4. `src/office.js:1265-1266` — the callout board still imports pump.fun readers (office owner)

`await import("./data/pumpfun-live.js")` / `("./data/pumpfun.js")` inside a try: on this
chain the try fails and the board reports `callout-source-unavailable-on-eip155:4663`
(auth-leasing HANDOFF §6). That is the honest state; note that `callouts.js` now expects
`user`/`wallet` as 0x addresses and receipts as 0x tx hashes (Blockscout links), so a
future 4663 callout source must speak those shapes. `src/manifest.js:49,74` still list
`src/data/gmgn.js` and `src/scanner.js` in the decision manifest — parked Solana files
the desk no longer imports (order.js dropped gmgn; treasury-evm.js replaced scanner).

## 5. `src/executor-dashboard.js:132,140` — `bankrollSol` / `fixedSol` hold ETH

office.js:216-222 feeds the dashboard `bankrollSol: raw.bankroll_eth`, `fixedSol:
raw.fixed_eth` under the executor lane's key names. The VALUES are ETH. When the executor
renames its heartbeat caps (auth-leasing HANDOFF §3), rename these in the same commit.

## 6. New call-row columns the feed may want to carry (office owner)

`calls.gas_usd_at_call` and `calls.eth_usd_at_call` (calls.js, written by
`penthouse.publishCall` from `exitProbe.gasUsdRoundTrip` / `ethUsd.value`) are on every
call published after this change and ride through `copy.feedFor`. `decide()` sizes the
executable floor from them (`minExecutableEth`: gas ≤ 5% of the clip; $8 round trip at
$2,450 → 0.0653 ETH, printed in test-copy-read-compat.mjs). If `executorFeedPayload`
selects fields explicitly, add both so an executor can show WHY a small clip was refused.

## 7. `test-copy-risk-cap.mjs` (agents lane) — passes unchanged, 14/14

Run 2026-09-05 after the ETH rename: exit 0, 14 passed. `saveSettings` accepts both
`bankrollSol`/`fixedSol` and `bankrollEth`/`fixedEth` for this release and `decide()`
returns `sizeEth` with a `sizeSol` alias, so the test's old names still bind. When it is
rewritten to the ETH names, the aliases can go (item 3).

## 8. Unverified on this lane's side

- The house seed 0.05 / 0.016 ETH and `DEFAULT_BANKROLL_ETH` 0.4 are currency
  translations of the owner's SOL instructions at $2,450/ETH — AWAITING OWNER CONFIRMATION
  (marked in copy.js).
- `PREFERRED_PAD` share of the free-screen survivors on 4663 is UNMEASURED (categories.js
  says so); the Solana 41%/53% figures are historical.
- `order.buildUnsignedSwap` (Kyber routes → route/build) was not exercised against the
  live aggregator: DESK_PREPARE_TX is off and no probe was run. Shape follows
  `src/data/kyber.js`; UNVERIFIED end to end.
- `perf.scanFills` (eth_getLogs Transfer filter, receipt reads) and `passes.grantPass`
  (receipt + block timestamp) were tested only through their pure readers (`readFill`,
  `transfersIn`, `tokenDeltas`) on synthetic receipts; no live RPC call was made.
