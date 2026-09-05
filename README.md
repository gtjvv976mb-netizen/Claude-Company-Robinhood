# Claude Company for Robinhood

The second tower. A fifty-floor building where every floor is one automated research
desk for **Robinhood Chain** (chainId 4663) memecoins — the PONS launches that graduate,
not the ones that are launching. The first tower, the Solana original at
https://claudedotcompany.com, is the same company on the same charter; this one trades a
different chain, from its own site, its own API and its own database.

Its core decision path has fourteen seats including the CEO; the standing Regime and
Review seats bring the permanent team to sixteen. Floor 50 is the headquarters.
Floors 1–49 are tenancies paid once in the Robinhood edition of $CLAUDECO — **which is not
launched yet**; see `docs/LAUNCH-CHECKLIST.md`.

**The hosted desk is research and paper accounting only.** It never receives a private
key, never signs a wallet transaction, and produces an unsigned order slip. This
repository also contains WALL-ST-E, an isolated polling executor that runs on the user's
own host. It defaults to paper mode; an explicitly armed, supervised live canary can sign
from a dedicated local burner only after the durable journal, two-RPC coherence,
freshness, gas, slippage, risk and **threshold-provenance** gates pass.

---

## Two towers

| | Solana original | Robinhood edition (this repo) |
|---|---|---|
| Site | https://claudedotcompany.com | https://robinhood.claudedotcompany.com |
| API | claude-company-api.onrender.com | claude-company-robinhood-api.onrender.com |
| Render disk (the database) | claude-company-data | claude-company-robinhood-data |
| GitHub | the original repository | gtjvv976mb-netizen/Claude-Company-Robinhood |
| Chain | Solana mainnet-beta | Robinhood Chain 4663 (Arbitrum Nitro, ~100 ms blocks, FCFS) |
| Universe | pump.fun graduates | PONS V2 graduates (V1 for WETH-paired history) |
| Swap layer | Jupiter | KyberSwap aggregator over Uniswap V4/V3 |
| Access token | $CLAUDECO, SPL, `HRkk…pump` | $CLAUDECO, ERC-20, **not launched** (all-zero placeholder) |
| Feed contract | `cluster: "mainnet-beta"` | `{ chain: 4663, cluster: "robinhood-4663" }`; sizes in `bankroll_eth` / `fixed_eth` |
| RPC env | `SOLANA_RPC` | `RH_RPC`, `RH_RPC_SECONDARY` |

The two deployments share nothing at runtime: separate Render service and disk, separate
Pages site and CNAME, separate `CODEX_REVIEW_TOKEN`, separate model keys for cost
attribution. The homepage's first nav item, **Two towers**, is the only place this site
links the apex, and `test-deploy-names.mjs` keeps it that way — the fork's `render.yaml`
and workflows were byte-identical to the original's when it was cut (2026-09-05), which
would have deployed onto the Solana desk's service by name.

## What differs on this chain, and why the desk is built the way it is

- **Selection, not sniping.** PONS V2's opening tax is 99% of a buy at block 0 decaying to
  zero over five seconds, with up to 32 creator-named exempt addresses; block-0 is for
  insiders by design, and there is no priority-fee auction to buy ordering. 207,893
  launches in a month, 1.55% graduate, half of those inside four minutes (Bitquery,
  Sep 2026). The edge, if any, is choosing among graduates.
- **Costs are flat, not proportional.** A KyberSwap round trip measured ~661k gas for
  both legs on 2026-09-04 — about $0.54 at any size. That inverts Solana's sizing
  logic, so every inherited number is registered `inherited` in
  `executor/live-thresholds.mjs` and `assertLiveReady()` refuses to arm the executor
  until each is re-measured here.
- **An equity may be a pair asset, never a position.** 203 Robinhood Stock Tokens are
  283-byte beacon proxies on one beacon, pausable, with a blocklist.
  `executor/scope-guard.mjs` refuses them as targets and allows GOOGL/AMZN/NVDA only as
  the medium of exchange for a memecoin trade. The access token is not a position either.
- **A transaction can vanish.** The sequencer may drop a tx with no receipt; ArbOS 61
  compliance filtering can void one (status `0x0`, no logs, gas burned). Gas is read per
  ticket, never cached — `eth_gasPrice` moved 0.02 → 0.7 gwei in two weeks.
- **No explorer on the hot path.** Blockscout is human-facing (403 to a curl UA).
  Evidence comes from the RPC, GeckoTerminal (`robinhood`), DexScreener (`robinhood`) and
  Kyber; the shape every seat expects is `docs/EVIDENCE-CONTRACT.md`.

## The seats

Deterministic stages are plain code. Judgment stages are Claude. They alternate on purpose:
code narrows the field cheaply, the model only reasons about what survived.

| Stage | Seat | Kind | The one question it answers |
|---|---|---|---|
| 0 | **Scout** | code + model | What deserves attention *today*, and why now? |
| 1 | **Screener** | code | Does this clear the floor at all? *(kills most candidates, costs nothing)* |
| 2 | **Forensics** | model | Can this token be used against a holder, by design? (proxies, pausability, exempt lists) |
| 3 | **Liquidity** | model | Can I get out, at size, at a price I'd accept — and into WHAT pair asset? |
| 4 | **Flow** | model | Is the demand real, or manufactured? |
| 5 | **Narrative** | model + web | Is there a story, is it true, and am I early? |
| 6 | **Technical** | model | Is this a location worth entering? |
| 7 | **Red Team** | model | *Why does this trade lose money?* |
| 8 | **Risk** | model + code | Choose a tier and thesis stop; code derives size and loss. |
| 9 | **PM** | model | Propose, watch, or pass — on what thesis? |
| 10 | **Execution** | model | The unsigned ticket: route, slicing, stop, targets. |
| 11 | **Compliance** | code | Does this break a house rule? *(veto, not advice)* |
| 12 | **CEO** | model | Do I trust this desk, on this trade, today? |
| 13 | **Scribe** | code | Write it down so the desk can be graded later. |

**Regime** computes the ETH/BTC weather; **Review** grades each closed call. Codex is a
separate, read-only **Improvement Engineer** (`docs/CODEX_IMPROVEMENT.md`), never a seat.

## Deploying

The whole thing, in order and with the exact commands, is **`docs/DEPLOY-ROBINHOOD.md`**:
create the GitHub repo, Pages via Actions with the `API_BASE` variable, the `robinhood`
CNAME, the Render Blueprint from `render.yaml` with its `sync: false` secrets, then the
first-boot checks. The short version:

- **Site**: static, built by `.github/workflows/pages.yml` on every push to `main` with
  `SITE_URL=https://robinhood.claudedotcompany.com` and `API_BASE` from the repository
  variable. `viewer/CNAME` binds the subdomain.
- **API**: `render.yaml` — service `claude-company-robinhood-api`, disk
  `claude-company-robinhood-data` mounted at `/var/data` (that disk IS the database),
  `npm test` gates every revision, health at `/api/lease/config`.
- **Token**: `docs/LAUNCH-CHECKLIST.md`. Until it runs, `CLAUDECO_RH_TOKEN` is the
  all-zero placeholder and leasing stays closed.

Local equivalents:

```bash
npm run build                                          # local preview; executor copy buttons disabled
EXECUTOR_COMMIT="$(git rev-parse HEAD)" npm run build  # pinned release build from a clean commit
npm test                                               # the isolated suite Render runs before starting
```

A local preview warns loudly if an executor file is missing from the installer graph; a
pinned release build refuses to publish one.

## Running it

```bash
cp .env.example .env     # set ANTHROPIC_API_KEY; RH_RPC defaults to the public RPC
npm run doctor
npm run one -- 0x<token address> --office
npm run desk -- --office
```

| Command | What it does |
|---|---|
| `npm run doctor` | Config, RPC reachability, journal stats |
| `npm run one -- <address>` | Full workup on one token |
| `npm run desk` | Scout the feeds, work up the shortlist |
| `npm run watch -- 30` | Same, every 30 minutes, with the floor open |
| `npm run ledger` | Every proposal the desk has made |
| `npm run improvement:bundle` | Print a local, content-addressed aggregate review bundle |
| `npm test` | The isolated regression suite that gates Render deploys |
| `node src/index.js office` | Serve the site, the tower and the floors |
| `npm run build` | Bundle standalone pages into `dist/` with three.js inlined |

Add `--office` to open the floor at **http://localhost:4949**. Append `?demo=1` to watch a
scripted shift without spending anything.

## What a tenant rents

A floor has two paths. House calls are copied to it at no model cost when they clear that
floor's deterministic mandate. A tenant can also dispatch a metered full-team workup
against an address; if it clears the same publication gauntlet it can publish a call to
that floor only. A lease includes `FREE_RUNS_WITH_LEASE` runs; further runs cost
`RUN_PRICE_CLAUDECO` from the same credit balance. Prices are in whole tokens, never
dollars: a USD peg read off a thin market is trivially manipulated.

## Known limits

- **Nothing here has an edge until you have graded it.** Read the first weeks of the
  journal as a backtest you are watching forward.
- **Every inherited threshold is void.** The executor will not arm while any live-path
  number is `inherited` or `assumed`; that refusal is the mechanism, not a bug.
- **Holder data is a log replay**, not an endpoint: ERC-20 `Transfer` logs from the pool's
  creation block on an RPC that 429s on batches. Coverage is reported, not estimated.
- **The live executor is an experimental local canary, not evidence of an edge.**

## The charter

`DESK.md` is the firm's constitution, and it is injected verbatim into every agent's system
prompt — so the rules bind the agents in-band, not just the reader.
