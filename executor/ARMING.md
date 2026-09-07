# Arming the Robinhood executor

State as of 2026-09-07. The desk (research) is deployed and running. The executor
(money) is **not armed and cannot arm**: `assertLiveReady()` refuses on 10 thresholds
that still carry Solana measurements. This file is the shortest honest path from here
to a real trade, and what each step actually costs you.

Nothing here has been done on your behalf. Registering a number is what arms a bot, and
this codebase deliberately routes that through a human who has read how it was measured
(see the header of `probe-measure-4663.mjs`). These are staged, not applied.

---

## 1. What is measured and ready to paste

Both lines below are measured on chain 4663 this session. Paste into
`executor/live-thresholds.mjs`, replacing the `INHERITED` entry of the same name.

### `bands.holdWindows` — MEASURED

```js
export const HOLD_WINDOWS = defineThreshold("bands.holdWindows", 120,
  { ...M("2026-09-07", "two independent measurements on RH prices. (1) median best move " +
    "within a window: 1.14% at 30m, 1.85% at 1h, 4.21% at 6h, 6.32% at 3d, 12.96% at 7d, " +
    "against an all-in round trip of 7.35% at the cheapest clip and 9.16% at the operator cap. " +
    "(2) the same 41 days traded, bracket fixed at -25%/+1.6x, varying only the hold, over 730 " +
    "published calls: 1h -14.71%, 6h -12.43%, 24h -7.36%, 72h -2.31%, 120h +2.19%, 240h +8.85%. " +
    "Monotonic; the sign flips between 72h and 120h, so 120h is the shortest window that is not " +
    "measurably loss-making"),
    unit: "h", live: true,
    note: "already applied in src/bands.js and executor/trade-policy.mjs; this registers it. " +
      "Longer holds measured better still, but 41 days holds only ~8 non-overlapping 120h " +
      "periods, so that extra confidence is the same weeks counted twice and is not claimed." });
```

### `screen.minLiquidityUsd` — MEASURED, but read the caveat

18 quoted round trips across six PONS pools, 2026-09-07, at a 0.005 ETH clip:

| pool liquidity | round trip (impact only) |
|---|---|
| < $10k | 2.66% – 5.97% |
| $10k – $100k | 4.06% – 6.15% |
| > $100k | ~0% – 0.33% (inside the 0.9% noise floor) |

The break is sharp at **$100k**. Below it, impact alone eats a third of a 15% stop
before gas; above it, impact is unmeasurable against quote noise.

```js
export const MIN_LIQUIDITY_USD = defineThreshold("screen.minLiquidityUsd", 100_000,
  { ...M("2026-09-07", "18 KyberSwap-quoted round trips across 6 pons-v2-dex pools at " +
    "0.005/0.05/0.5 ETH: sub-$100k pools cost 4.06-6.15% impact at a 0.005 ETH clip, pools " +
    "above $100k cost ~0-0.33%, which is inside the 0.9% quote-noise floor"),
    unit: "USD", live: true,
    note: "SIX POOLS IS A SMALL SAMPLE and the tiers disagree internally (PORT read ~0% where " +
      "STOCKKIT read 6.1% at the same clip). The break at $100k is clear; the exact number is not." });
```

---

## 2. What one 24-hour read will close

`exec.maxNetworkFeeWei` needs a gas *distribution*, not a spot reading. A 24-hour probe
was started 2026-09-07 05:13 UTC and writes to the session scratchpad
(`gas-24h.log`). It signs nothing. When it finishes it prints a pasteable `M(...)` line
with the median and p99 gas price. Read the tail of that file and paste the line.

---

## 3. What genuinely needs a funded canary — you, not me

Four thresholds cannot be measured without sending real transactions:

- `exec.inclusionLatencyMs`
- `exec.dropRatePct`
- `exec.nonceReplacementHonoured`
- `exec.maxPriceImpactPct` (needs `eth_call` at 1x/2x/4x from a funded sender)

These are the reason the bot cannot self-certify. They want a handful of small real
sends from the burner, observed.

---

## 4. The size decision, and why the canary cannot work

Gas on this chain is **flat** — 660,996 units per round trip, about 0.00022 ETH — so
cost as a share of the position is a U in the clip size:

| clip | ≈ USD | all-in round trip | break-even win rate on -15%/+35% |
|---|---|---|---|
| 0.0004 (canary default) | $2 | **55.1%** | **impossible** — cost exceeds the target |
| 0.004 (operator max) | $18 | 9.2% | 48% |
| 0.0112 (**cheapest**) | $50 | **7.35%** | 45% |
| 0.05 | $225 | 8.7% | 46% |

**The canary cannot trade profitably at any hit rate.** That is arithmetic, not
pessimism: a 55% round trip cannot be recovered by a 35% target. The desk's measured
win rate is 50%.

### Two independent derivations agree the floor is ~0.01 ETH

This is not one model's opinion. Two different pieces of the desk, reasoning from
different premises, land on the same boundary:

| source | reasoning | answer |
|---|---|---|
| `src/copy.js` `MIN_EXECUTABLE_ETH` | gas must be ≤5% of the position (desk policy), at measured round-trip gas | **0.01 ETH** |
| the measured cost curve | clip that minimises gas **+** measured PONS impact | **0.0112 ETH** |
| the operator cap today | — | **0.004 ETH** |

At 0.004 ETH gas is **5.11%** of the position — already over the desk's own 5% policy
ceiling, which is why the tenant copy lane refuses to execute at that size. The two lanes
currently disagree, and the copy lane is the one that is right.

To raise the caps, all three must be set explicitly and `LIVE_CAPS_ACK` must match
exactly. For the cheapest clip:

```
MAX_ETH_PER_TRADE=0.0112
DAILY_ETH_CAP=0.112
DAILY_LOSS_LIMIT_ETH=0.0336
LIVE_CAPS_ACK="I acknowledge WALL-ST-E caps v3 for <YOUR WALLET>: 0.0112 ETH per trade, 0.112 ETH per day, 0.0336 ETH rolling realized-loss entry brake"
```

Substitute your wallet address. The sentence is checked character for character.
`fixedSol` now tracks this cap, so raising it actually raises the traded size — before
2026-09-07 it did not, and a raised cap still traded 0.0016 ETH.

---

## 5. Order of operations

1. Paste the two measured thresholds (§1).
2. Paste the gas line when the 24h probe finishes (§2).
3. Decide the clip and do the caps ceremony (§4).
4. Run the funded canary for the four send-dependent thresholds (§3).
5. `assertLiveReady()` will then either pass or name exactly what is still missing.

Step 5 is the gate. If it refuses, it tells you which number and why — that message is
the specification, not this file.
