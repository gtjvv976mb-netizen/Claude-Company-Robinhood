# HANDOFF — llm-cache lane

Changes needed in files this lane does not own. Each entry: the file, the exact diff, and why.

## 1. penthouse.js + evaluation.js — import the one cycle budget (desk-loop lane)

`src/lib/llm.js` now exports `CYCLE_BUDGET_USD` (default **8**) and reads it for the pace
floor. It used to read the env var itself with a default of **4** while penthouse.js:47 and
evaluation.js:168 defaulted to 8, so the pace floor (`cycleBudget * 1.25`) was computed
against half the cycle the desk runs. Import it so the three cannot drift again:

```diff
--- src/penthouse.js
-export const CYCLE_BUDGET_USD = Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || 8);
+import { CYCLE_BUDGET_USD } from "./lib/llm.js";   // one budget, read once (llm.js)
+export { CYCLE_BUDGET_USD };                          // keep the existing re-export for callers

--- src/evaluation.js
-      cycleBudgetUsd: Number(process.env.PENTHOUSE_CYCLE_BUDGET_USD || 8),
+      cycleBudgetUsd: CYCLE_BUDGET_USD,               // import { CYCLE_BUDGET_USD } from "./lib/llm.js"
```

llm.js sits below both in the import graph (it imports only bus, config, store,
desk-policy), so neither import creates a cycle.

## 2. evidence.js — tell the X read which launchpad (data lane)

`grokXRead` now takes an optional `venue` and puts it in the volatile tail
(`TOKEN: "X" at 0x… on Robinhood Chain (chain 4663), launched on pons.`). The evidence
contract already defines `evidence.launchpad.venue`. In `enrichWithXRead`:

```diff
--- src/data/evidence.js
-  grokXRead({ symbol: ev.symbol, mint: ev.address ?? ev.mint, hook, handle, lore })
+  grokXRead({ symbol: ev.symbol, mint: ev.address ?? ev.mint, hook, handle, lore,
+              venue: ev.launchpad?.venue && ev.launchpad.venue !== "unknown" ? ev.launchpad.venue : null })
```

The X read's JSON shape gained two fields the seats may want to read:
`audience` ("robinhood_app|eu_stock_tokens|arbitrum_evm|solana_crosspost|mixed|unknown")
and `amplified_by_official` (bool|null). They ride inside `ev.xRead` like every other
field; nothing breaks if no seat reads them. Add them to docs/EVIDENCE-CONTRACT.md under
`xRead.*` if the contract enumerates xRead keys.

## 3. analysts.js — optional `brief` for the narrative shaping call (agents lane)

`askWithWeb` call 2 no longer re-sends the evidence bundle: `compactBrief(prompt)` cuts
the prompt at `=== EVIDENCE BUNDLE ===` and keeps only the header and the bundle's
`xRead` subtree. This works on the CURRENT runNarrative prompt with no change. If the
agents lane restructures that prompt (e.g. moves the bundle into `content` blocks), pass
the compact identity explicitly instead so the derivation is not relied on:

```diff
--- src/agents/analysts.js (runNarrative)
   return askWithWeb({
     seat: "Narrative",
     ...
+    brief: { symbol: ev.symbol, address: ev.address ?? ev.mint,
+             socials: ev.pair?.socials, websites: ev.pair?.websites, hook: ev.hook, xRead: ev.xRead ?? null },
```

## 4. analysts.js — the `content` path is ready (agents lane)

`ask({ ..., content: [ {type:"text", text, cache_control?}, ... ] })` sends the blocks as
the user message verbatim (`prompt` is ignored). Shape is validated in `buildRequest`
(text blocks only; `cache_control` must be `{type:"ephemeral", ttl?:"5m"|"1h"}`), and a
bad shape throws synchronously before any retry. The intended order is bundle first
under a marker, seat charter second, one-line instruction last — test-cache-prefix.mjs
asserts exactly that shape passes through untouched. Note the caching reference's
invalidation table: `output_config.effort` differences are model-specific for the
system tier, so pin ONE effort across the five analysts (config.js:177-183 currently
mixes medium/high) if the shared-bundle cache is to hit across seats.

## 5. config.js — optional `effort.ceo` (config owner)

`ceo.js` now reads `cfg.effort?.ceo || process.env.DESK_EFFORT_CEO || "xhigh"`. Nothing
is required; adding `ceo: "xhigh"` to `cfg.effort` makes the seat configurable in the
same table as the others. Do not lower it without measuring high vs xhigh on the CEO's
APPROVE/DECLINE agreement first.

## 6. penthouse.js trendHandoff — `launchpad: "pump.fun"` (desk-loop lane)

Not a caching matter, noticed while gating the trend scan: `publishCall(rec, {…,
launchpad: "pump.fun" })` at penthouse.js:1226 stamps every trend call with the Solana
launchpad. Should read `ev.launchpad?.venue ?? "unknown"`.

## 7. test-247.mjs — the pace test pinned the deadlock value (owner of test-247)

**This one FAILS in the suite until merged.** test-247.mjs:38 computes the hourly
allowance as `(CAP / 24) * HOURLY_BURST` = $5.00 at CAP=40 and asserts that $5.50 trips
the pace. That only ever passed because llm.js read the cycle budget with the wrong
default (4 → floor $5.00 = the cap, by coincidence). With the budget reconciled to the
$8 penthouse.js actually runs, the floor is $10.00 — which is the point of the floor:
a $5/hour pace under an $8 cycle is the "$5/hour against a $10 cycle" deadlock the
comment at llm.js describes. Measured: the unpatched test fails 2 of 35 under the
default and passes 35/35 with `PENTHOUSE_CYCLE_BUDGET_USD=4`; a patched copy of the
test (scratchpad, absolute imports) with the diff below passes 35/35, printing
"hourly allowance $10.00 … $10.50 of $10.00 this hour".

```diff
--- test-247.mjs
-import { assertDailyBudget, BudgetExhausted, HOURLY_BURST, OPPORTUNISTIC_SHARE } from "./src/lib/llm.js";
+import { assertDailyBudget, BudgetExhausted, HOURLY_BURST, OPPORTUNISTIC_SHARE, CYCLE_BUDGET_USD } from "./src/lib/llm.js";
 ...
-const hourCap = (CAP / 24) * HOURLY_BURST;
+// The pace has a floor of 1.25 cycles (llm.js): a pace tighter than one cycle is a deadlock.
+const hourCap = Math.max((CAP / 24) * HOURLY_BURST, CYCLE_BUDGET_USD * 1.25);
```

## 8. Pre-existing, not mine — test-improvement-migrations.mjs

Fails on `ENOENT executor/erc20-hazards.mjs` (another lane's file, not yet on disk).
Unrelated to this lane; noted so the parent's suite run is not misread.
