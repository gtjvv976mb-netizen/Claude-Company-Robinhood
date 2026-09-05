# The evidence bundle the seats require

Written by the seat rewrite of 2026-09-04 and completed on 2026-09-05. Every field below
is CITED BY A CHARTER (src/agents/*.js) or by DESK.md, so a bundle that does not carry it
teaches that seat to hallucinate. The data lane builds `gather()` to this list; the
agents lane cites nothing that is not on it; `test-charter-fields.mjs` greps every
`a.b.c` path out of the charters and fails on a path with no row here.

Conventions. `evidence.` is the bundle root and is omitted from row names except where a
charter says it. `pairs.pools[]` rows are per pool, deepest first. Every row names the
source that PRODUCES it; a source marked *planned* is the data lane's target, not a
running read — a seat is told to say UNVERIFIED when the field is null, never to guess.
Percentages are of supply unless the name says otherwise; times are epoch milliseconds.

| field | seats | what it is | produced by |
|---|---|---|---|
| `address` | all (as `evidence.address`) | the ERC-20 contract address on chain 4663, lower-case. Replaces `evidence.mint`; the seat anchors every citation to it. | gather() from the feed's base_token id |
| `token` | technical | the same address, under the name the tape is keyed to. Load-bearing because symbol collisions (USDG, STONKS) make ticker-resolved series wrong. | gather() |
| `symbol` | all | the ERC-20 symbol(), for display only — never an identity. | eth_call symbol() 0x95d89b41 (src/data/evm.js) |
| `band` | all, PM, risk | the market-cap sleeve (nano … very_high). | src/bands.js bandForMarketCap(pair.marketCap ?? pair.fdv) |
| `hold.holdMaxMs` | forensics, red team, risk | the sleeve's hold window; a position is SOLD when it expires. Compared against timelock delays and LP unlocks. | src/bands.js holdWindowFor |
| `hold.holdMinMs` | risk | the sleeve's minimum hold. | src/bands.js holdWindowFor |
| `pair.priceUsd` | technical, execution, compliance | the deepest pool's mark in USD. | DexScreener token-pairs/v1/robinhood (src/data/dexscreener.js), USD via ethUsd |
| `pair.priceChange` | technical, PM | {m5, h1, h6, h24} percent moves of the deepest pool. | DexScreener pair priceChange |
| `pair.pairCreatedAt` | forensics | when the deepest pool was created; an upgrade after it is the decisive forensics fact. | DexScreener pairCreatedAt, or the Uniswap V4 Initialize block time (planned) |
| `pair.marketCap` / `pair.fdv` | all | USD market cap / fully diluted value (supply is fixed at 1e9 on PONS so they agree). | DexScreener |
| `pair.liquidityUsd` | liquidity | the deepest pool's reported liquidity in USD — NOT depth (see `depth.*`). | DexScreener liquidity.usd |
| `pair.ageHours` | scout, best pick | hours since pairCreatedAt. | gather() |
| `pair.socials` / `pair.websites` | narrative | links from the listing's own metadata. | DexScreener token-profiles |
| `pairs.totalLiquidityUsd` | liquidity, red team | USD liquidity summed over every pool of this address. | DexScreener token-pairs, filtered chainId robinhood |
| `pairs.pools[].version` | liquidity | 'v2' \| 'v3' \| 'v4' \| 'curve' — decides whether reported liquidity is depth. | DexScreener dexId / GeckoTerminal dex id (uniswap-v4, pons-v2, …) |
| `pairs.pools[].feeTierBps` | liquidity | the pool's fee tier; a PONS pool is 100 bps a side. | Uniswap V4 Initialize event `fee` field / GeckoTerminal |
| `pairs.pools[].pairToken` | liquidity, execution, best pick | the quote asset's address — what a sell is paid in. | DexScreener quoteToken / V4 Initialize currency0/currency1 |
| `pairs.pools[].pairTokenClass` | liquidity, compliance, risk, red team | 'native' \| 'weth' \| 'stable' \| 'allowed_equity' \| 'equity_unlisted' \| 'other'. Anything but the first four is a KILL: the bot cannot hold it. | executor/scope-guard.mjs classification lifted into src/data/evm.js: native sentinel/WETH 0x0Bd7…AD73 → weth/native; USDG 0x5fc5…d168 → stable; ALLOWED_PAIR_EQUITIES → allowed_equity; other beacon proxy on 0xe10b…1b00 or "• Robinhood Token" name → equity_unlisted; else other |
| `equityPair.paired` | narrative, best pick | true when the deepest pool's pairTokenClass is an equity (allowed or not). | derived from pairs.pools[0].pairTokenClass |
| `equityPair.ticker` | narrative, best pick | the underlying ticker, e.g. 'NVDA' — what makes the story checkable against a calendar. | executor/scope-guard.mjs ALLOWED_PAIR_EQUITIES name, else the registry https://api.robinhood.com/rhj/assets |
| `equityPair.shareOfLiquidityPct` | narrative | how much of the token's total depth sits in equity-quoted pools. | derived from pairs.pools[] |
| `launchpad.venue` | narrative, scout, best pick | 'pons' \| 'pons-v1' \| 'hood.fun' \| 'pools.trade' \| 'none' \| 'unknown'. | GeckoTerminal relationships.dex id, or the factory that emitted the launch event |
| `launchpad.creatorHandle` | narrative | the creator's X handle from the launch metadata, seeding enrichWithXRead(). | PONS TokenLaunched metadata URI (planned); null when absent |
| `launch.phase` | flow, technical, liquidity, compliance, risk | 'curve' \| 'graduated' \| 'unknown'. The desk trades 'graduated' ONLY. | PONS V2 factory PoolGraduated log (topic0 from docs.ponsfamily.com/v2) or readyToGraduate()/sellableTokens() on the curve proxy; V1 via its own graduation event |
| `launch.graduatedAt` | technical, liquidity, flow, compliance, risk | epoch ms of PoolGraduated, null while on the curve. Age since it is a deterministic gate (EVM_GATES.minGraduationAgeSec). | block timestamp of the PoolGraduated log |
| `launch.curveProgressPct` | technical | percent of the curve sold; null once graduated. | curve proxy getReserves()/sellableTokens() |
| `launch.firstBlockBuyers` | flow | array of {address, pctOfSupply} that bought in the launch block — on V2, the exempt list by construction. | CurveBuy logs in the TokenLaunched block |
| `launch.exemptShareOfSupplyPct` | forensics, flow, compliance, risk, red team, best pick | share of supply held NOW by the launch's tax-exempt addresses (launcher, fee recipient, up to 32 named). The insider-float gate reads it. | exempt list from the launchToken calldata of the TokenLaunched tx; balanceOf() each / totalSupply() |
| `launch.creatorTaxBps` | forensics, red team, best pick | the creator's per-trade tax today. | curve/hook view on the launch proxy (docs.ponsfamily.com/v2 "creator fee"); planned |
| `launch.maxCreatorTaxBps` | forensics, red team, best pick | the ceiling the creator may set; tax AT the ceiling over an exempt list is the fee-farm shape (VLAD, 2026-07). | maxCreatorTaxBps() on the launch proxy; planned |
| `launch.feeClaimCount` | forensics, best pick | how many times the creator has claimed fees since launch. | creator-fee-claim logs on the curve/hook (planned) |
| `launch.feeClaimedEth` | forensics | total ETH the creator has claimed. | same logs, summed |
| `contract.cloneOf` | forensics, narrative, compliance, risk, red team, best pick | the implementation address when the bytecode is a 44-byte EIP-1167 clone of a known PONS V1/V2 template; null for bespoke code. A clone cannot be upgraded and has no ERC-1967 slot. | eth_getCode size 44 + the 0x363d3d373d3d3d363d73…5af43d82803e903d91602b57fd5bf3 pattern; target compared with the template addresses measured 2026-09-05 (executor/scope-guard.mjs) |
| `contract.verifiedSource` | forensics, narrative, compliance, red team, best pick | whether an explorer holds verified source; false must make the seat mark roles UNVERIFIED rather than clean. | Blockscout API (robinhoodchain.blockscout.com, browser UA, NOT in the hot path); defaults false |
| `contract.isProxy` | forensics, liquidity, narrative, red team | whether the token delegates through an ERC-1967 implementation slot. | eth_getStorageAt slot 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc |
| `contract.proxyKind` | liquidity, narrative | 'erc1967_implementation' \| 'erc1967_beacon' \| 'eip1167_clone' \| 'none' \| 'unreadable'. | the implementation slot, the beacon slot 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50, and the clone pattern |
| `contract.implementation` | forensics, liquidity | the address currently holding the logic. | the slot above, or the clone target |
| `contract.proxyAdmin` | forensics, red team | {address, kind: 'eoa'\|'multisig'\|'timelock'\|'unknown', delaySec}. An EOA is one key from a rug; a timelock counts only past hold.holdMaxMs. | admin slot 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103; eth_getCode on it (empty → eoa); getMinDelay() 0xf27a0c92 → timelock |
| `contract.upgradeCount` | forensics | how many times the implementation has been swapped. | Upgraded logs topic0 0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b since pair.pairCreatedAt |
| `contract.lastUpgradeAt` | forensics, narrative | epoch ms of the most recent Upgraded event, or null. | same logs, last block timestamp |
| `contract.ownershipRenounced` | narrative, screen | owner() is the zero address (entry requirement). | eth_call owner() 0x8da5cb5b; revert → 'no Ownable' |
| `contract.privilegedRoles` | forensics | array of {role, holder, canDo} for roles that survive renouncement: mint, pause, blacklist, setFee, exempt-from-fee, gate-pair. | hasRole()/known selectors against the implementation; planned; [] with `contract.verifiedSource` false means UNVERIFIED |
| `contract.flags` | forensics, screen, risk, red team | {flag, detail} rows the screen kills on: mint_role_live, pausable, blacklist, fee_over_ceiling, upgradeable_eoa, honeypot. | src/data/evm.js contract reads + sellSim |
| `contract.transferFeeBps` | forensics | the tax paid today. | sellSim effectiveTaxBps |
| `contract.feeSettable` / `contract.maxFeeBps` | forensics, red team | whether a role can raise the tax later, and to what. | privilegedRoles setFee + maxFee view; planned |
| `contract.taxbuyFeeBps` / `contract.taxsellFeeBps` / `contract.taxsimulated` | liquidity | the measured buy and sell taxes, and whether they came from a simulation rather than a view. | sellSim / buy simulation (executor/evm-swap.mjs simulateExact lifted into src) |
| `sellSim` | forensics, screen, compliance, risk, red team | {ok, revertReason, effectiveTaxBps, status}: a simulated sell of the probe's tokens against live state. `sellSim.ok` false is the vanishing-token shape and confirms exit_failure / sequencer_exclusion. | eth_call of built Kyber sell calldata (executor/evm-swap.mjs prepareSwap + simulateExact) |
| `lp.kind` | liquidity | 'v2_lp_tokens' \| 'v3_position' \| 'v4_position' \| 'curve' \| 'unknown'. | pool version |
| `lp.burnedPct` | forensics, liquidity | share of LP tokens sent to 0xdead. | balanceOf(0xdead) on the LP token (v2 only) |
| `lp.lockedPct` | forensics, liquidity | share held by a recognised locker contract. | balanceOf(locker) / totalSupply of the LP token, or position NFT owner ∈ lockers |
| `lp.locker` | forensics, liquidity | the recognised locker's name ('pons-locker', …) or null. A PONS V2 graduate's full-range position sits in the PONS locker permanently. | PositionManager ownerOf(positionId) matched against known locker addresses (planned) |
| `lp.lockerAddress` | forensics | which locker, so 'locked' can be distinguished from 'sitting in an EOA'. | same |
| `lp.positionNftOwner` | forensics, liquidity | for a V3/V4 position, the NFT owner who can withdraw the range. | ownerOf on the position manager |
| `lp.pullableSharePct` | forensics, red team | the share of pool liquidity that could be withdrawn today; the 20% threshold reads it. | 100 − burnedPct − lockedPct (v2) or 100 when the position owner is not a locker |
| `lp.unlockAt` | forensics, liquidity, red team | when the lock expires (epoch ms), comparable against hold.holdMaxMs; null for permanent. | locker's unlock view; planned |
| `depth.inRangeLiquidityPct` | liquidity | share of the pool's liquidity whose range contains the current tick. | V3/V4 tick bitmap read (planned) |
| `depth.sellSideUsdWithin1Pct` | liquidity | USD that can be sold within 1% of spot. | Kyber routes at increasing sizes, or tick math (planned) |
| `depth.sellSideUsdWithin5Pct` | liquidity | USD that can be sold within 5% of spot — compared against the desk's position. | same |
| `exitProbe.roundTripLossPct` | all decision seats | quote-in/quote-out loss of a buy at cfg.targetSizeUsd sold straight back, POOL cost only. Null kills (`unverified_exit`). | KyberSwap aggregator routes (aggregator-api.kyberswap.com/robinhood, x-client-id), ETH-vs-ETH as executor/probe-roundtrip.mjs measures it |
| `exitProbe.gasUsdRoundTrip` | liquidity, risk, execution, compliance, best pick | the FIXED toll: both legs' route gas × eth_gasPrice (read per probe, never cached) × ethUsd.value. Measured $0.54 on 2026-09-04. | Kyber routeSummary.gas × eth_gasPrice × ethUsd.value |
| `exitProbe.buyImpactPct` / `exitProbe.sellImpactPct` | liquidity | price impact of each leg; sell ≫ buy in a symmetric pool is a tax. | Kyber route amountInUsd/amountOutUsd per leg |
| `exitProbe.hops` | liquidity | number of pools on the sell route. | Kyber route length |
| `exitProbe.error` | risk, red team | why the probe did not complete, or null. | probe |
| `ethUsd.value` | liquidity, exitProbe | ETH/USD used for every USD figure in the bundle. | CoinGecko simple/price, cross-checked against Kyber amountInUsd/amountIn on the probe's own request (reject if >2% apart); Chainlink ETH/USD on 4663 once its latestRoundData is verified |
| `ethUsd.stalenessSec` | liquidity | age of that mark when the bundle was assembled. | cache age |
| `holders.ok` | forensics, screen | whether the holder read completed. Null/false kills (`unverified_holders`). | src/data/evm.js Transfer-log replay from pair.pairCreatedAt |
| `holders.top1Pct` / `holders.top10Pct` | forensics, red team, best pick | largest and ten-largest non-excluded holders' share of supply. The median PONS graduate's top-10 is ~80%. | same, after `holders.excluded` |
| `holders.clusteredHolders` | forensics, best pick | count of top addresses within 8% of each other — the split-bundle signature. | same |
| `holders.bundleSuspect` | forensics, red team, best pick | true at four clustered holders. | same |
| `holders.midToHead` | forensics, best pick | addresses 3-8 measured against the top two; near zero is hollow. | same |
| `holders.excluded` | forensics | array of {address, label, pctOfSupply} removed before percentages: pair, curve, router, locker, 0xdead. | same |
| `holders.poolShareOfSupplyPct` | forensics | how much of supply the pool itself held before exclusion — on a fresh V2 graduate, the reserved allocation. | balanceOf(pool) / totalSupply |
| `deployer.address` | forensics | the EOA that called the factory. | TokenLaunched log (V1 topic0 0xdb51ea9a…4235a on 0xA5aA…1feB; V2 topic0 0x308c390e…ba980 on 0x7eD5…EC7e) |
| `deployer.priorLaunches` | forensics, red team, best pick | launches by that EOA across PONS V1 and V2, from the factories' own logs. | eth_getLogs on both factories filtered by creator (≤10k-block spans) |
| `deployer.graduated` | forensics, red team, best pick | how many of those reached a pool. | PoolGraduated logs for those tokens |
| `deployer.dead` | forensics | how many of those pools hold under $5k today. | GeckoTerminal reserve_in_usd per pool |
| `deployer.sameImplementation` | forensics | how many share this token's `contract.cloneOf`. | cloneOf equality |
| `deployer.fundedBy` | forensics | the address that first gassed the deployer EOA — the identity that persists across fresh wallets. | first inbound ETH transfer; needs a trace RPC or the explorer index (browser UA) — null when unavailable, never guessed |
| `identity.symbolCollisions` | forensics, liquidity, narrative | true when another live contract on 4663 carries this symbol (USDG and STONKS each have two). | DexScreener search?q=SYMBOL filtered chainId robinhood |
| `identity.collidingContracts` | narrative | the colliding addresses. | same |
| `identity.resolvedBy` | liquidity | 'address' \| 'symbol' — how the pools were matched; anything but 'address' stops the seat. | gather() |
| `derived.uniqueTraders24h` | flow | distinct addresses that traded in 24h. | GeckoTerminal pool trades + swap logs (tx_from_address) |
| `derived.txns24h` | flow | trade count in 24h. | DexScreener txns.h24 |
| `derived.roundTripWalletPct` | flow, red team | share of 24h volume from addresses that both bought and sold in the window — wash trading measured. | same trades |
| `derived.commonFunderPct` | flow | share of active addresses funded by one funder. | needs deployer.fundedBy-style tracing per trader; planned, null until then |
| `derived.customRouterPct` | flow | swaps not routed through UniversalRouter or KyberSwap. | swap tx `to` address vs known routers |
| `derived.interArrivalCv` | flow | coefficient of variation of gaps between trades; ~0 is a loop. | trade timestamps |
| `derived.sameBlockTradePct` | flow | share of trades that share a block with another trade of this token. | trade block numbers |
| `derived.volToLiqRatio` | flow, red team | 24h volume / liquidity. | DexScreener |
| `derived.avgTradeSizeUsd` | flow | mean trade size; the chain's median trade is $48. | volume / txns |
| `derived.buySellRatio24h` | flow | buys / sells over 24h. | DexScreener txns.h24 |
| `derived.gasRoundTripPct` | technical | the round trip's gas (~661,000 measured, ROUND_TRIP_GAS in executor/live-thresholds.mjs, at the live gwei, priced through ETH/USD) as a percent of cfg.targetSizeUsd. | exitProbe.gasUsdRoundTrip / cfg.targetSizeUsd |
| `derived.markAgeMs` | technical | ms between the price mark being observed and the bundle being assembled; FCFS ordering bounds the seat's precision by it. | gather() timestamps |
| `derived.voidedTxPct` | red team | share of the pool's last N swaps that landed with status 0x0 and no logs — ArbOS 61 compliance voids. Confirms sequencer_exclusion at ≥5% (provisional). | eth_getTransactionReceipt on recent swap txs; planned |
| `candles.bars` | technical | OHLCV bars, OLDEST FIRST: {t, o, h, l, c, volUsd}. | GeckoTerminal /pools/{pool}/ohlcv/minute (returned newest-first; reversed) |
| `candles.barsCovered` | technical | how many bars contain real trades — guards a padded series posing as a tape. | same |
| `candles.interval` | technical | the bar size actually used ("1m", "15s"). | same |
| `promotion` | flow, narrative | {paid, lastPaidAt, orders[]} — whether the token bought reach. | DexScreener orders/v1/robinhood/{address} |
| `callouts` | flow | recorded large buys on this token from the pool's own trade log. | GeckoTerminal trades?trade_volume_in_usd_greater_than=500 (src/whales.js) |
| `xRead.*` | forensics, narrative (as a separate block), red team, PM, best pick | Grok's first-party read of X: dev_handle, dev_account_age, dev_followers, dev_looks_real, dev_prior_tokens, dev_posted_ca, dev_engaging_now, dev_red_flags, paid_promotion_signs, serial_rugger, rug_evidence, deleted_history, desk_record, story_is_true, truth_note, significance, trend_name, trend_stage, seasonal_hook, season_window, live_event, event_still_unfolding, emerging_trends, early_or_late, mentions_level, velocity, verdict, distinct_voices, lore_origin, paid_or_botted_signs, summary, citations, and from the 2026-09-05 retarget: audience ('robinhood_app' \| 'eu_stock_tokens' \| 'arbitrum_evm' \| 'solana_crosspost' \| 'mixed' \| 'unknown') and amplified_by_official (bool \| null). Absent means absent. | src/lib/grok.js grokXRead via enrichWithXRead(); desk_record from src/devrep.js |
| `crosscheck.verdicts` | red team | the deterministic cross-checks and their KILLED/PASSED verdicts. | gather() |
