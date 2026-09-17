# Arming the Robinhood executor

State as of 2026-09-13. The desk (research) is deployed and running. The executor
(money) is **armable**: `assertLiveReady()` passes — 0 of the 14 live-path thresholds are
void, inherited or assumed. That is the change this file used to be waiting for; what is
left below is the ceremony, not the measurement.

Registering a number is what arms a bot, so every one of them says where it came from
(`executor/live-thresholds.mjs`, provenance + date + method). Read the ones that decide
how much money moves before you type an acknowledgement.

---

## 0. Where the gate stands

```
node -e 'import("./executor/live-thresholds.mjs").then(async () => {
  const t = await import("./executor/thresholds.mjs");
  t.assertLiveReady(); console.log("live-ready");
})'
```

| provenance | count | on the live path? |
|---|---|---|
| `measured` on chain 4663 | 19 | 14 of them are; the other 5 are reference readings |
| `canary` (self-measured by the executor) | 3 | **no**, deliberately |
| `inherited` / `assumed` | 0 | — |

Every threshold the gate looks at is measured. Nothing on the live path is a Solana
number, a guess, or a `null` standing in for one.

The three canaries are `exec.inclusionLatencyMs`, `exec.dropRatePct` and
`exec.nonceReplacementHonoured`. They are facts about what the sequencer does with a
transaction **from this wallet**, so no read-only probe can answer them. They used to be
registered as live-path thresholds, which made a gate that could only open after a send
while guarding sends — the executor refused to arm until they were measured and measuring
them needed an armed executor. They are now off the live path, they start `null` (not 0 —
an unmeasured rate is not a measured absence), and every real send records its own
outcome, so they fill in as the bot trades. `§3` is how to answer them on purpose.

---

## 1. The numbers that decide money, and what they were measured against

| threshold | value | measured |
|---|---|---|
| `size.cheapestClipEth` | 0.0112 ETH | argmin of the all-in cost curve (gas + PONS impact) |
| `size.minClipEth` | 0.004 ETH | smallest clip where two gas legs are under 10% of the position |
| `screen.minLiquidityUsd` | $2,000 | DexScreener sweep of the desk's own board: liquidity p10 $6.6k, p50 $13.4k |
| `screen.minStopDistancePct` | 14% | the executor's entry guard solved at the default clip |
| `exec.slippageBps` | 300 | 5 live pools × 2 clips × 5 tolerances; 150 bps **reverted live** |
| `exec.maxPriceImpactPct` | 10% | rate at the clip vs. rate at 2% of the clip, per leg |
| `exec.maxNetworkFeeWei` | 2e15 | `eth_gasPrice` sampled 118× over 240s (median 0.0844 gwei, p99 0.0884) |
| `swap.roundTripGasUnits` | 660,996 | median of 9 KyberSwap-routed round trips |
| `bands.holdWindows` | 120h | 730 published calls re-traded at fixed brackets, varying only the hold |

`exec.slippageBps` is the one to read twice. It was 150, derived from quote-to-quote
drift (2 bps at p95) — which is not the quantity slippage protects against. A real send
reverted with "Return amount is not enough". Re-measured across five live pools at five
tolerances (50/100/150/300/1000 bps), it is 300, and `src/config.js` now **imports** it from the registry instead of
keeping a second copy. Two copies of one number is precisely how the Solana desk refused
four consecutive live calls on 2026-09-03.

---

## 2. The size decision

Gas here is **flat** — 660,996 units a round trip — so cost as a share of the position is
a U in the clip size, and the cheap end is the *large* end. This inverts Solana, where a
smaller clip was straightforwardly safer.

| clip | ≈ USD | all-in round trip | break-even win rate on −15%/+35% |
|---|---|---|---|
| 0.0004 (the old default) | $1 | **55.1%** | **impossible** — cost exceeds the target |
| 0.004 (`size.minClipEth`) | $10 | 9.2% | 48% |
| **0.0112 (default now)** | $28 | **7.35%** | 45% |
| 0.05 | $125 | 8.7% | 46% |

The default was 0.0004 / 0.0008 / 0.0008 ETH and could not clear the executor's own entry
guard at any stop width the desk publishes — 4 of 4 refused, measured in
`test-fee-gate-split.mjs`. A default that cannot clear its own entry guard is not
caution; it is a bot that can never buy. The defaults are now derived from the registry:

```js
maxEthPerTrade   = size.cheapestClipEth        // 0.0112
dailyEthCap      = size.cheapestClipEth * 10   // 0.112
dailyLossLimitEth= size.cheapestClipEth * 3    // 0.0336
```

Env may only ever **lower** them. Raising needs all three set explicitly plus a typed
sentence naming this wallet and these numbers:

```
MAX_ETH_PER_TRADE=0.02
DAILY_ETH_CAP=0.2
DAILY_LOSS_LIMIT_ETH=0.06
LIVE_CAPS_ACK="I acknowledge WALL-ST-E caps v3 for <YOUR WALLET>: 0.02 ETH per trade, 0.2 ETH per day, 0.06 ETH rolling realized-loss entry brake"
```

The sentence is checked character for character. The hard maxima are **0.1 / 1 / 0.3 ETH**
and moving those is a code change, by design.

---

## 2b. Entry mode: `risk` (default) or `take-every-call`

Ported from the Solana desk, which arrived at it after measuring that its own edge rails
were refusing calls the desk had already approved. In `take-every-call` every published
call is bought at the configured size, and the **edge** rails — R_net, the per-name risk
cap, book heat — become advisory: logged as WARN, reported on the fill, never a refusal.

The **money** rails do not move in either mode. A call with no stop, the rolling
realized-loss brake, the open-position cap, the rolling deploy cap, the spendable balance
and the minimum viable clip still refuse, and every round-trip, impact, custody and fee
rule on the transaction itself is untouched. Conviction scaling is off in this mode
(in `risk` it is floored at `size.minClipEth`, because the desk's median conviction of
31/100 used to scale every median call below the minimum clip and refuse it).

Armed like a cap raise, because it is one:

```
ENTRY_MODE=take-every-call
ENTRY_MODE_ACK="I take every published call on <YOUR WALLET> at 0.0112 ETH"
```

---

## 3. Answering the three canaries on purpose

`executor/live-roundtrip-4663.mjs` is a supervised rehearsal: it sends N 0-value
self-transfers (21,000 gas each, about a thousandth of a cent), times submit → receipt on
both providers, and optionally buys and sells one token through the **same** `EvmExecutor`
the poller uses — same scope guard, ERC-20 hazards, impact cap, calldata floor, `eth_call`
simulation and two-provider receipt.

```
KEY_FILE=./burner.key RH_RPC=… RH_RPC_SECONDARY=… \
LIVE_ROUNDTRIP_ACK=<checksummed burner address> \
TEST_TOKEN=0x… TEST_ETH=0.0112 node executor/live-roundtrip-4663.mjs
```

It writes to a **separate journal** (`.roundtrip-4663.sqlite`), so a supervised poller is
never handed a position it did not decide to take, and it prints pasteable `M(...)` lines
with the transaction hashes as the method.

You do not have to run it. The poller records the same statistics from ordinary trading
and carries them on the heartbeat; a rolling drop rate above 34% over at least 6 sends
pauses **entries only** — a sequencer that is dropping is exactly when an open position
must still be exitable.

---

## 4. One decision you may want to change: how often the desk cycles

The quota, the hold and the book size are one arithmetic. To sustain **B** live calls each
held for **H** while publishing **Q** per cycle, the cycle interval **C** must satisfy
`C >= Q·H/B`. At Q=3, H=120h, B=24 that is **15 hours**, and the desk derives it
(`SUSTAINABLE_CYCLE_MINS`, `src/mandate.js`) rather than using a fixed 12 minutes.

That was a bug fix, not a preference: at a 12-minute cycle the 24-slot book saturates in
**1.6 hours** and then publishes nothing for the next 118, because nothing closes for five
days. But 15 hours means the desk researches roughly twice a day, and you may want it
livelier. The lever is the book size, and it is yours:

| MAX_LIVE_CALLS | derived cycle | calls/day |
|---|---|---|
| 24 (today) | 15h | ~4.8 |
| 60 | 6h | ~12 |
| 120 | 3h | ~24 |

`PENTHOUSE_MAX_LIVE_CALLS` sets it. The bot holds **4** positions whatever this is, so
raising it widens the *published* book for tenants rather than the desk's own risk.
`PENTHOUSE_CYCLE_MINS` still overrides the derivation outright — but setting it faster
than `MAX_LIVE_CALLS ÷ hold` re-creates the saturation, and `cycle:saturated` will say so
in the chronicle when it does.

---

## 4b. The gates that are measuring rather than refusing

Three clauses run on the entry path right now and refuse **nothing**. They record what
they *would* have done into the journal's `gate_observations` table, and a human promotes
them once the numbers say they have earned it. That order is deliberate: a lint that cries
wolf gets switched off, and a gate that starts refusing a chunk of the universe on day one
is how a real check gets disabled for the cases that mattered.

| clause | what it measures | where |
|---|---|---|
| `exit_route_unproven` | the real sell calldata, executed against the real router with the position and allowance handed to your wallet by state override. Not a quote — the sell, run. | `sell-proof.mjs` |
| `hazard_selector_observed` | three blocklist selectors the desk probes and the executor was blind to: `isBlocked`, `blocklist`, `isFrozen` | `erc20-hazards.mjs` |
| `pool_manager_balance` | whether the token has left the curve into a pool that can actually be sold into | `erc20-hazards.mjs` |

Read them back at any time. It costs nothing and touches no key:

```bash
node executor/observations-report.mjs --gate exit_route_unproven --since 7d
```

Each gate prints n, the pass / would_refuse / **unreadable** split, the deciles of what it
measured, and the reasons behind unreadable. **Read the unreadable rate before anything
else.** It is neither a pass nor a refusal — it is the gate failing to measure, and a
clause that cannot read the chain a tenth of the time will fail *closed* a tenth of the
time once promoted. That number decides readiness far more often than the refusal rate.

The report prints `PROMOTABLE` once a gate clears `gates.promotionSampleFloor` (100,
registered ASSUMED — it is the desk's own claim floor, not a measurement of this chain).
That means **the sample is large enough to look at**, not that the clause is right. The
report will never tell you to promote; that decision is yours, and a tool that made it for
you would repeat the mistake the shadow scorecard made when it published a verdict off
five coins.

In the log, an observing gate looks like this, and the entry proceeds:

```
EXIT PROOF WIF: WOULD REFUSE — the sell REVERTED in simulation: execution reverted:
TRANSFER_FROM_FAILED (observe-only; it does not stop this entry)
```

That line on a coin you then lost money on is the single most useful row in the journal.

---

## 5. Order of operations

0. **Top up the Anthropic account.** The desk halts at `desk:out_of_credit` — the API
   answers "credit balance is too low" and `llm.js` throws. It screens coins and ranks
   them for free; the analyst seats cost money.
1. Run the desk and confirm it publishes. The screen used to kill 100% of workups on
   `unverified_holders` because `blockscout.js` is behind a Cloudflare challenge (HTTP
   403); the holder chain is now ledger → GeckoTerminal → Blockscout, and a failure of all
   three only kills the call when the **exit** is also unproven.
2. Fund the burner. Key file 0600, 32 bytes of hex, never in hosted config.
3. `LIVE_TRADING_ACK=<checksummed burner address>`; initialize the journal once with
   `LIVE_STATE_INIT_ACK=<same> INIT_ONLY=1`.
4. Run **paper first** (`EXECUTE=0`). Paper defaults are the live defaults, so a paper run
   rehearses the size the live bot will actually take.
5. Decide the clip (§2) and the entry mode (§2b), and type the sentences.
6. Optionally run the rehearsal (§3).
7. **Let the observing gates collect a sample** (§4b) before trusting them. They cost
   nothing and refuse nothing; `observations-report.mjs` tells you when there is enough to
   read. A `WOULD REFUSE` line on a coin that then lost money is the evidence that earns a
   promotion.
8. `EXECUTE=1`. `assertLiveReady()` runs at boot; if it refuses, its message names the
   number and why — that message is the specification, not this file.
