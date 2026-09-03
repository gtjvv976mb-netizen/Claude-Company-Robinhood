# The evidence bundle the seats now require

Written by the seat rewrite of 2026-09-04. Every field below is CITED BY A CHARTER, so a
bundle that does not carry it teaches that seat to hallucinate. Phase 1 builds to this list.

| field | seats | what it is |
|---|---|---|
| `candles.bars` | technical | array of OHLCV bars built from pool swap events, newest last: {t, o, h, l, c, volUsd}. This is the whole point of the port for this seat; without it t |
| `candles.barsCovered` | technical | how many bars contain real trades. Guards the failure where a padded/forward-filled series poses as a tape and the seat reads structure off flat bars. |
| `candles.interval` | technical | the bar size actually used (e.g. "1m", "15s"). 100ms blocks make sub-minute bars meaningful; the seat must know which it got rather than assume. |
| `contract.flags` | forensics | same {flag, detail} shape the old mintAccount.flags had, so screen() reads one convention: mint_role_live, pausable, blacklist, fee_over_ceiling, upgr |
| `contract.implementation` | forensics, liquidity | the address currently holding the logic, so a swap is detectable at all. |
| `contract.isProxy` | forensics, liquidity, narrative | whether the token delegates its logic to another contract (ERC-1967 implementation slot 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d38 |
| `contract.lastUpgradeAt` | forensics, narrative | ms epoch of the most recent Upgraded event, or null. A token upgraded after the story started is a different token from the one that was researched. |
| `contract.ownershipRenounced` | forensics, narrative | owner() is the zero address (screen-side entry requirement; the seat is told not to re-check it, but the screen needs it). |
| `contract.privilegedRoles` | forensics | array of {role, holder, canDo} for AccessControl/Ownable roles that survive renouncement: mint, pause, blacklist, setFee, exempt-from-fee, gate-pair. |
| `contract.proxyAdmin` | forensics, liquidity | who can call the upgrade, plus what kind of account it is: {address, kind: 'eoa'|'multisig'|'timelock'|'unknown', delaySec} — the seat is told to comp |
| `contract.proxyKind` | liquidity, narrative | 'erc1967_implementation' | 'erc1967_beacon' | 'none' | 'unreadable'. Read from slot 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc |
| `contract.taxbuyFeeBps` | liquidity | — |
| `contract.taxsellFeeBps` | liquidity | — |
| `contract.taxsimulated` | liquidity | — |
| `contract.transferFeeBps and contract.feeSettable / contract.maxFeeBps` | forensics | the tax paid today, and whether a role can raise it later. |
| `contract.upgradeCount` | forensics | how many times the implementation has been swapped. |
| `contract.verifiedSource` | forensics | whether the explorer has verified source; false must make the seat mark roles UNVERIFIED rather than clean. |
| `depth.inRangeLiquidityPct` | liquidity | — |
| `depth.sellSideUsdWithin1Pct` | liquidity | — |
| `depth.sellSideUsdWithin5Pct` | liquidity | — |
| `derived.commonFunderPct` | flow | — |
| `derived.customRouterPct` | flow | — |
| `derived.gasRoundTripPct` | technical | two swaps' gas (~227,860 each at the live gwei, priced through ETH/USD) as a percent of cfg.targetSizeUsd. The fixed toll a move must clear; there is  |
| `derived.interArrivalCv` | flow | — |
| `derived.markAgeMs` | technical | milliseconds between the price mark being observed and the bundle being assembled. FCFS sequencer ordering means the seat's precision is bounded by st |
| `derived.roundTripWalletPct` | flow | — |
| `derived.sameBlockTradePct` | flow | — |
| `derived.uniqueTraders24h` | flow | — |
| `ethUsd.stalenessSec` | liquidity | — |
| `ethUsd.value` | liquidity | — |
| `evidence.address` | forensics, narrative | the ERC-20 contract address on chain 4663. Replaces evidence.mint, which the prompt no longer names; the seat anchors every citation to it. |
| `evidence.equityPair.paired` | narrative | boolean, does the token's deepest pool quote against a tokenized equity (detected by the beacon-slot test in executor/scope-guard.mjs, not by symbol). |
| `evidence.equityPair.shareOfLiquidityPct` | narrative | how much of the token's total depth sits in equity-quoted pools. |
| `evidence.equityPair.ticker` | narrative | the underlying ticker, e.g. 'NVDA'. This is what makes the story checkable against a real calendar. |
| `evidence.launchpad.creatorHandle` | narrative | the creator's X handle from launchpad metadata, replacing the pump.fun twitter link that currently seeds enrichWithXRead(). Without it the X read has  |
| `evidence.launchpad.venue` | narrative | 'pons' | 'hood.fun' | 'pools.trade' | 'none' | 'unknown'. Replaces the mint.endsWith('pump') test in gather(). |
| `exitProbe.gasUsdRoundTrip` | liquidity | — |
| `holders.excluded` | forensics | array of {address, label, pctOfSupply} for the pair, curve, router and locker addresses removed before percentages; replaces holders.poolsExcluded/exc |
| `identity.collidingContracts` | narrative | the colliding addresses, so the seat can say which one a search result actually belongs to. |
| `identity.resolvedBy` | liquidity | — |
| `identity.symbolCollisions` | forensics, liquidity, narrative | boolean, true when another live contract on 4663 carries this token's symbol (USDG and STONKS each have two). |
| `launch.curveProgressPct` | technical | percent of the bonding curve sold; null once graduated. On a curve this replaces the chart entirely. |
| `launch.firstBlockBuyers` | flow | — |
| `launch.graduatedAt` | technical | epoch ms of graduation, null while on curve. Needed so the seat can segment bars either side of the discontinuity; referenced by the prompt's graduati |
| `launch.name` | liquidity | — |
| `launch.onCurve` | liquidity | — |
| `launch.phase` | flow, technical | "curve" | "graduated" | "unknown": whether the token is still on a PONS / hood.fun / pools.trade bonding curve or has graduated to a Uniswap pool. |
| `lp.burnedPct` | forensics, liquidity | share of LP tokens sent to 0xdead. |
| `lp.kind` | liquidity | — |
| `lp.lockedPct` | forensics, liquidity | share held by a recognised locker contract. |
| `lp.locker` | liquidity | — |
| `lp.lockerAddress` | forensics | which locker, so 'locked' can be distinguished from 'sitting in an EOA'. |
| `lp.positionNftOwner` | forensics, liquidity | for a Uniswap v3/v4 position, the NFT owner who can withdraw the range. |
| `lp.pullableSharePct` | forensics | the share of pool liquidity that could be withdrawn today; the seat's 20% threshold reads this. |
| `lp.unlockAt` | forensics, liquidity | when that lock expires, comparable against hold.holdMaxMs. |
| `pairs.pools[].feeTierBps` | liquidity | — |
| `pairs.pools[].version` | liquidity | — |
| `sellSim` | forensics | {ok, revertReason, effectiveTaxBps}: a simulated sell against live state, not a quote. Consumed by the screen, not cited in the prompt, but the prompt |
| `token` | technical | the ERC-20 contract address. Renames the Solana bundle's `mint`; load-bearing here because symbol collisions (USDG, STONKS) make ticker-resolved serie |
