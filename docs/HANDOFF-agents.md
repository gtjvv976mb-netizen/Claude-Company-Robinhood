# HANDOFF — agents lane (2026-09-05)

Changes the agents lane needs in files it does not own. Each item: the file, the exact
change, and why. Nothing here is applied; the parent merges.

## 1. `src/lib/llm.js` — the `content` contract, and where standing orders go

The five analyst seats now call:

```js
ask({ seat, model, effort: ANALYST_EFFORT, schema, system: ANALYST_CONTRACT,
      content: [ { type:"text", text: bundle, cache_control:{type:"ephemeral"} },
                 { type:"text", text: "=== YOUR SEAT ===\n" + charter },
                 { type:"text", text: xReadBlock },      // forensics, narrative only
                 { type:"text", text: instruction } ],
      prompt: content.map(b => b.text).join("\n\n") })  // fallback for an ask() without `content`
```

- `ask()` must send `content` verbatim as the user message when given (prompt ignored).
  Until it does, the `prompt` fallback keeps the seats working and only the cache is lost.
- `askWithWeb()` must accept the same `content`/`system` shape: the NARRATIVE seat goes
  through it (`ANALYSTS.narrative.web === true`). Its shaping call should re-send the
  brief WITHOUT the bundle block (the map's own recommendation, llm.js:526-534).
- **Standing orders fork the cache prefix.** `ask()` applies `withPolicy(seat, system)` to
  the system block. With one shared `ANALYST_CONTRACT` as `system`, a seat that has
  standing orders gets a different system tier from the other four, and the bundle block
  behind it can no longer be a cache hit for that seat. Proposed: when `content` is
  given, append the seat's orders to the block whose text starts with `=== YOUR SEAT ===`
  (desk-policy.js exports `policyFor(seat)`; `withPolicy(seat, text)` works on any string)
  and leave `system` untouched. Until then the cost is only the cache, only for seats
  with orders (none exist on the fork today).
- `SHARED_RULES` still says "Solana" and "PUMP.FUN"; the seat charters now contradict it.
  The map's replacement text (llm.js:322, 337, 353-355) is the fix.

## 2. `src/config.js` — the executor mirrors the stop floor reads

`risk-rails.js stopFloorDetail()` reads `cfg.executorSlippageBps` (fallback 300) and
`cfg.executorMaxFeeShareOfStop` (fallback 0.25). MAIN carries both (MAIN config.js:118-122);
the fork does not. Add, verbatim from MAIN, next to `minStopDistancePct`:

```js
    executorSlippageBps: num("EXECUTOR_SLIPPAGE_BPS", 300),
    executorMaxFeeShareOfStop: Number(process.env.EXECUTOR_MAX_FEE_SHARE_OF_STOP || 0.25),
```

and retarget the `minStopDistancePct` comment: the 12% was 5.91% slippage + ~2% fee +
1.25% a side of pump.fun; on 4663 the derived floor replaces it whenever the round trip
was measured, and the flat number is the unmeasured fallback only. Also document the two
new env names read by `risk-rails.js EVM_GATES` in `render.yaml`:
`DESK_MIN_GRADUATION_AGE_SEC` (default 600) and `DESK_MAX_INSIDER_FLOAT_PCT` (default 20).
Both defaults are PROVISIONAL — no measurement on 4663 yet — and are marked so in code.

## 3. `src/data/evidence.js` — build to the contract, and fail closed on the gates

`docs/EVIDENCE-CONTRACT.md` is now complete (95 rows, each with a producing source) and
`test-charter-fields.mjs` holds the charters to it. Beyond producing the rows:

- `screen()` must KILL (fail closed, like `unverified_mint` today) when any of these is
  absent: `launch.phase`, `pairs.pools[].pairTokenClass`, `sellSim`, `contract` — and
  must kill on the same facts `risk-rails.js evmGateFailures()` zeroes: `not_graduated`,
  `graduated_too_recently`, `pair_token_gate`, `insider_float`, `unverified_code`,
  `live_authority`. Import `evmGateFailures` from `src/agents/risk-rails.js` rather than
  re-deriving, so the screen, Risk, Compliance and the Red Team read one definition.
  Compliance WARNS (`evm_gates_unverified`) on absent fields; the screen is the place that
  refuses them.
- `enrichWithXRead()` may keep attaching `ev.xRead`; the analyst prompts strip it from
  the bundle block themselves. Its seed must come from `launchpad.creatorHandle`, not
  `ev.deployer.coin.twitter` (pump.fun).
- `ev.address` must be set (the seats cite it); `ev.mint` may stay as an alias.

## 4. `src/lib/grok.js` — the X read is told the wrong chain

The X READ block tells forensics and narrative it is "Grok's first-party read of X" of a
Robinhood Chain token; `grokXRead` still says "Search X for the Solana token". Apply the
map's retarget (grok.js:179, 186-188, +audience bullet after :201): search by contract
address and launchpad link, never the bare cashtag when the name is a ticker, and report
who the audience is (Robinhood users / EU stock-token holders / Arbitrum crowd / Solana
cross-posters).

## 5. `src/agents/ceo.js`, `src/agents/codex-tutor.js` — framing sentences

- ceo.js:58 → "the CEO of Claude Company, a small research firm trading memecoins on
  Robinhood Chain"; ceo.js:104 prints `ev.mint` → `ev.address ?? ev.mint`.
- codex-tutor.js:171 → "the coach of a Robinhood Chain research desk". The tutor also
  calls `ask()` with no `model` (map item): add
  `model: process.env.DESK_MODEL_TUTOR || "claude-opus-5", effort: "medium"`.

## 6. `src/conviction.js` — a future whale roster (not built; the term is at zero)

`CONVICTION_WEIGHTS.whaleCap` is 0 and `missing` says "no whale roster on this chain
yet". To turn the term back on, a source must write `verified_callouts` with the same
columns from something MEASURED on 4663. The candidate: an on-chain proven-address
roster — addresses whose PONS curve buys (CurveBuy logs on the V2 factory's launch
proxies) preceded graduation and a held-above-open outcome, scored by the same
`HIT_MULTIPLE`/`MIN_CALLS_FOR_RECORD` rules, with `wallet_sol_usd` renamed or repurposed
as ETH-USD. Raise the cap only when that roster has a graded sample; Bitquery's
flat-distribution finding (top 10 wallets = 0.9% of gains) says it may never earn 54.

## 7. `test-copy-risk-cap.mjs` (owned by this lane) after the office lane's ETH rename

If `bankroll_sol/fixed_sol` become `bankroll_eth/fixed_eth` (contract: ETH decimal
strings), that test needs `saveSettings(50, { bankrollEth: 10, fixedEth: 2 })`,
`fixedEth: "auto"`, and `offered.sizeEth` in place of the `Sol` names, and the "0.05 SOL"
expectation becomes the ETH translation of $50/$10,000 × 10 ETH = 0.05 ETH (same
number). Left untouched here because the rename is not on disk yet; UNVERIFIED.

## 8. `test-xread-order.mjs` — no change needed

The literals it pins (`const xRead = enrichWithXRead(ev, hook);`,
`xRead.then(() => runAnalyst("forensics", ev))`, `xRead.then(() => runNarrative(ev))`)
are preserved in `src/desk.js`; the X read is separated from the bundle inside
`analysts.js` rather than by changing the call.

## 9. `executor/` — the feed's red-team codes and the ticket warning

`RED_TEAM_FACT_CODES` in `src/agents/schemas.js` gained six codes; anything in the
executor that switches on `fact_code` should treat unknown codes as "wounded", never
throw. Tickets now always carry a no-receipt warning in `execution_warnings`
(compliance warns when absent); the poller's journal should record the three send
outcomes distinctly — dropped (no receipt), voided (status 0x0, no logs), landed.
