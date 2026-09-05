# WALL-ST-E — the self-hosted executor for Robinhood Chain (4663)

Claude Company's desk publishes calls. This process, running on **your** machine with
**your** key and **your** caps, decides whether to act on them and, in live mode, signs
and sends the transactions itself. The desk never holds a key and cannot reach your
wallet; it publishes a read-only feed that this process polls.

Chain: Robinhood Chain, chainId 4663 (`0x1237`), an Arbitrum Nitro rollup with ~100 ms
blocks, first-come-first-served ordering, priority fees refunded (there is no tip
market), and a sequencer that can silently drop a transaction (no receipt) or void one
(receipt status `0x0`, no logs, gas burned). Every design choice below follows from one
of those facts.

## What you need

| Thing | Why |
|---|---|
| Node ≥ 22.13 and < 25 | `node:sqlite` for the durable journal |
| **One key file**: `burner.key`, 32 bytes of hex, mode 0600 | the only secret; the installer generates it, unfunded, and prints only the checksummed address |
| **Two RPC providers** on different hostnames (`RH_RPC`, `RH_RPC_SECONDARY`), private, HTTPS | every liveness/absence claim needs two independent views; the public `rpc.mainnet.chain.robinhood.com` 429s on batches above ~10 and is refused for live |
| The floor's feed secret (`CC_SECRET`, `CC_FLOOR`) | authenticates the read-only feed; it cannot move funds |
| `ethers` 6.17.0 | the one dependency, pinned exactly; `npm ci --ignore-scripts` |

No aggregator key. KyberSwap's public `routes`/`route/build` endpoints need none, and
the bytes are proven with `eth_call` before they are signed, so there is nothing a key
would authorise that the chain does not already check.

## How a trade happens

1. **Feed.** `GET /api/floor/:n/executor/feed` must answer `{ chain: 4663, cluster:
   "robinhood-4663", … }`. Any other chain is refused on the spot — this is where a
   poller wired to the Solana desk's API is caught.
2. **Swap bytes, proven** (`evm-swap.mjs`). Quote from KyberSwap, build the calldata,
   read the min-out floor OUT OF THE CALLDATA (the build response's `amountOut` field
   is informational and measured identical at 100/300/1000 bps), execute the exact bytes
   with `eth_call`, and refuse unless the chain's measured output clears our floor and
   the gap between them is inside our tolerance. The aggregator never authors the number
   that checks the aggregator.
3. **Scope and hazards.** `scope-guard.mjs` refuses the 203 Robinhood Stock Tokens as
   positions (beacon-slot test plus the `• Robinhood Token` name marker) and allows
   GOOGL/AMZN/NVDA as pair assets only. `erc20-hazards.mjs` executes a real transfer of
   the token in `eth_call` out of an existing holder and refuses a measured
   fee-on-transfer, a pausable or blocklist selector, or an ERC-1967 proxy whose admin is
   a single key. "Could not measure" is refused, never assumed clean.
4. **USD anchor.** `eth-usd-oracle.mjs` reads Chainlink's ETH/USD proxy
   `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` through both providers (8 decimals,
   heartbeat 86,400 s, deviation 0.5 %; verified 2026-09-05 at block 54,714,740: answer
   $2,455.22). Kyber's `amountInUsd` is never used to judge Kyber.
5. **Sign, journal, send** (`evm-executor.mjs`, `journal.mjs`). See the nonce section.
6. **Confirm.** `eth_getTransactionReceipt` on BOTH providers, same block hash, same
   status. Output is the Transfer log to this wallet (buys) or the balance delta across
   the block plus the fee (sells); fee is `gasUsed × effectiveGasPrice`. One provider's
   receipt is an observation, never a fact.

## Nonces, drops and cancels — the part that is different here

On Solana a signed transaction became provably un-landable after ~150 blocks, and that
proof is what let the executor safely sign a replacement. EVM has no expiry: a signed
transaction at nonce N is valid until N is consumed by ANY transaction from the
account, you cannot send N+1 until N lands, and on 4663 "no receipt" is the ordinary
failure. So the journal OWNS the nonce sequence (`meta.next_nonce`) and the machine is:

| From | To | When |
|---|---|---|
| planned | signed | bytes proven at block B; nonce N = max(journal next, `eth_getTransactionCount pending` on BOTH providers) — a disagreement is a hold, never a guess; row journaled (write-ahead) with nonce, hash, raw bytes, `proven_at_block`, `deadline_block = B + DEADLINE_BLOCKS` |
| signed | submitted | `markSubmitted` FIRST, then `eth_sendRawTransaction`; the node's returned hash must equal the journaled hash or the row is quarantined |
| submitted | confirmed / failed | receipt on both: `0x1` confirms, `0x0` is a fee-bearing failure whose nonce is consumed (the next attempt uses a fresh nonce) |
| submitted | expired | no receipt past `deadline_block`, `txCount == N` on both, `eth_getTransactionByHash` null on both: the sequencer dropped it. A **CANCEL** (0-value self-transfer at N, ≥1.25× the original max fee, 21,000 gas) is sent; once ITS receipt is on both providers the dropped bytes can never land and the intent is rebuilt at a fresh quote and the next free nonce. A dropped cancel is resent (same bytes, same hash); after `maxCancelResends` sends the intent is quarantined instead |
| submitted | ambiguous | `txCount > N` on both with none of our hashes landed (something else consumed N); a receipt on one provider only past the deadline; the providers disagree on `txCount`; a mined approval whose allowance reads back short. Manual reconciliation |

Quarantine (`ambiguous`) freezes new exposure but **does not disarm an exit**: a safety
exit may still free its nonce with a cancel once both providers agree the nonce is free.
HARD_STOP blocks everything, cancels included. A `signed` row that was never sent expires
for free past its deadline — nothing can land. Only fee-bearing attempts spend an exit's
retry budget; a drop-and-cancel costs a cancel's gas and proves nothing about the market.

**Approvals are intents.** A sell is `approve(N)` then `swap(N+1)`; a token that refuses
non-zero → non-zero allowances gets `approve(0)` at N, `approve(amount)` at N+1 and the
swap at N+2. Every approval goes through the same machine, is exact (never unbounded),
and the swap is not even built until the allowance has been READ back from the chain.

Whether the sequencer honours same-nonce replacement at all is **unmeasured**
(`exec.nonceReplacementHonoured`, VOID). The cancel path assumes nothing about it.

## The registry gate: the executor will not arm on Solana numbers

`thresholds.mjs` / `live-thresholds.mjs` register every number the executor trades on
with its provenance. In live mode `assertLiveReady()` runs BEFORE any provider is
contacted and refuses to boot while any live-path threshold is `inherited` or
`assumed`. Slippage, price impact and the network-fee ceiling are read from the
registry only — there is no `SLIPPAGE_BPS` env, the launchd allowlist refuses it, and
`test-live-gates.mjs` proves an env value changes nothing. The expected network fee is
the COST MODEL — half the measured 660,996-gas round trip × the gas price both providers
report right now — and is never the gate; gas moved 0.41 → 0.80 gwei between two probe
runs fifteen minutes apart on 2026-09-05, so a constant would be wrong within the hour.

`node probe-measure-4663.mjs --seconds 300` is the read-only measurement campaign: it
prints pasteable `M(date, method)` lines and writes nothing. Three thresholds
(inclusion latency, drop rate, nonce replacement) need a funded burner and a real send
and are outside it.

## Caps, in ETH

| | Canary (default) | Operator ceiling (typed ceremony) |
|---|---|---|
| per trade | 0.0004 ETH | 0.004 ETH |
| rolling 24 h deploy | 0.0008 ETH | 0.04 ETH |
| rolling realized-loss entry brake | 0.0008 ETH | 0.012 ETH |
| open positions | 4 | 4 (frozen) |

These are the ETH translation of the owner's SOL caps at $2,450/ETH and are **marked as
awaiting owner confirmation** in `poller.mjs`. Gas is flat here: one swap leg is
~0.00014 ETH at 0.42 gwei, which is 70 % of the canary and 7 % of the operator ceiling,
so the canary is refused by the executable-cost guard at every stop width and only the
ceiling clears it (`test-fee-gate-split.mjs`). Raising a cap needs all three set and
`LIVE_CAPS_ACK` equal to the v3 sentence naming the checksummed wallet and the numbers;
every SOL-era acknowledgement is revoked. Caps are parsed as wei with BigInt: a literal
one wei over a ceiling is refused, and more than 18 fractional digits is refused rather
than rounded.

## Install

Linux + systemd: `install.sh` (dry run by default; `--live` needs `--rpc-file`,
`--secondary-rpc-file`, `--source-dir` from a detached checkout at the published commit,
and a terminal to retype the checksummed address). macOS: `install-secret.sh` to
scaffold and generate the key, then `macos-launchagent.sh install|load|unload|arm-caps`
(`arm-caps --max-eth --daily-eth-cap --daily-loss-cap`). Published at
`https://robinhood.claudedotcompany.com/executor/`; API
`https://claude-company-robinhood-api.onrender.com`.

Environment (all read by `poller.mjs`; the launchd runner refuses any other name):
`CC_SECRET`, `CC_FLOOR`, `CC_API`, `EXECUTE`, `KEY_FILE`, `STATE_DB`, `LOCK_FILE`,
`PAUSE_ENTRIES_FILE`, `HARD_STOP_FILE`, `RH_RPC`, `RH_RPC_SECONDARY`,
`LIVE_TRADING_ACK` (the checksummed address, byte for byte), `LIVE_STATE_INIT_ACK`,
`INIT_ONLY`, `MAX_ETH_PER_TRADE`, `DAILY_ETH_CAP`, `DAILY_LOSS_LIMIT_ETH`,
`LIVE_CAPS_ACK`, `MAX_OPEN_POSITIONS`, `FEE_RESERVE_ETH`, `ETH_USD_CACHE_MAX_AGE_MS`,
`DEADLINE_BLOCKS` (50..300), `RECEIPT_TIMEOUT_MS`, `POLL_MS`, `READINESS_TIMEOUT_MS`,
`MAX_CALL_AGE_MIN`, `MAX_FUTURE_SKEW_MIN`, `MAX_ENTRY_MARK_AGE_MIN`,
`MAX_ENTRY_DEVIATION_PCT`, `MAX_ENTRY_ROUND_TRIP_LOSS_PCT`, `MAX_ENTRY_QUOTE_DRIFT_PCT`,
`MAX_ENTRY_PREFLIGHT_AGE_MS`, `MAX_EXIT_PRICE_IMPACT_PCT`, `MAX_EXIT_TRIGGER_AGE_MS`,
`MAX_TX_ATTEMPTS`, `MAX_EXIT_TX_ATTEMPTS`, `TRAIL_PCT`, `F_DEFAULT`, `F_NAME_MAX`,
`BOOK_HEAT_MAX`, `MAX_AGE_HOURS`, `EXECUTOR_SOURCE_COMMIT`, `STATE_FILE`,
`WALLSTE_ALLOW_BATTERY_ENTRIES`.

## Verifying a fill

The journal is the record: `tx_attempts` holds the nonce, the hash, the raw bytes and the
block window of every attempt; `intents` holds the fill. To check one against the chain,
ask BOTH providers — a fill this executor calls confirmed had matching receipts on both:

```
curl -s $RH_RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x<hash>"]}'
```

`status: "0x1"` and the Transfer log to your address (buys) is a fill; `"0x0"` is a
voided transaction that burned gas; `null` past the deadline block with your nonce
unchanged is a drop. For a human, `https://robinhoodchain.blockscout.com/tx/<hash>`
works in a browser (it answers 403 to a curl user agent and is never in the hot path).

Monitor: `node monitor.mjs --executor-dir DIR` — read-only; it mirrors the registry gate
and the two-provider oracle read and reports `safeToUnpause`.

## Controls

- `touch PAUSE_ENTRIES` — no new entries; exits and reconciliation continue.
- `touch HARD_STOP` — nothing is sent, not even a cancel; manage the wallet by hand.
- `journal.mjs` is `synchronous=FULL`, WAL, owner-only; a file written by the Solana
  schema migrates forward on open and its rows stay observation-only forever.

## Tests

`node test-evm-execution.mjs` — the whole state machine against a mocked two-provider
chain (every transition above, the drop→cancel→rebuild path, the `txCount > N`
quarantine, approvals, the boot gates, wei parsing). Also `test-journal.mjs` (schema v2 +
the migration fixture), `test-live-gates.mjs`, `test-operator-caps.mjs`,
`test-launchd.mjs`, `test-install.mjs .` (from the repo root), `test-monitor.mjs`,
`test-scope-guard.mjs`, `test-evm-swap.mjs`, `test-approvals.mjs`,
`test-thresholds.mjs`, `test-lessons-lint.mjs`, `test-fee-gate-split.mjs`,
`test-mainnet-wait.mjs`, `test-review-hardening.mjs`. The root `npm test` runs all of
them.
