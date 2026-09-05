# Handoff from the deploy-repo lane (2026-09-05, second pass)

Changes needed in files this lane does not own, with the exact diff and the reason.
Each is required for the deployment described in `docs/DEPLOY-ROBINHOOD.md` to be
coherent end to end; none is applied here. Items marked **DONE** were found already
landed by their lane on this pass (line numbers are from the tree as measured today) and
are kept only so the parent can tick them off.

## 1. `executor/install.sh` — the fetch list must equal `EXECUTOR_FILES` (executor lane) — OPEN

`scripts/build-viewer.mjs` publishes this graph to `dist/executor/` (29 files; a pinned
release build wrote exactly 29 today):

```
poller.mjs journal.mjs evm-executor.mjs evm-rpc.mjs evm-swap.mjs approvals.mjs
scope-guard.mjs thresholds.mjs live-thresholds.mjs eth-usd-oracle.mjs erc20-hazards.mjs
balance-verification.mjs entry-quote-guard.mjs exit-trigger.mjs feed-drain.mjs
heartbeat-health.mjs sleep-assertion.mjs monitor.mjs install.sh macos-launchagent.sh
macos-release.sh launchd-runner.mjs executor.mjs README.md strategy.mjs trade-policy.mjs
simulate.mjs package.json package-lock.json
```

**`evm-rpc.mjs` is new relative to the shared contract's list.** An import-closure walk
over the published files (2026-09-05) found it imported by `poller.mjs`,
`evm-executor.mjs`, `eth-usd-oracle.mjs` and `erc20-hazards.mjs`; it is now published,
and `test-deploy-names.mjs` asserts every `./` import of the 14 EVM modules is published
(all 14 pass, 28 edges).

`install.sh` today: line 26 `API="https://claude-company-api.onrender.com"`, line 27
`STATIC="https://claudedotcompany.com"`, and the fetch list at lines 164 and 426 still
names `jupiter.mjs`, `token2022.mjs`, `sol-usd-oracle.mjs`. It must fetch exactly the set
above from `https://robinhood.claudedotcompany.com/executor/` and default `CC_API` to
`https://claude-company-robinhood-api.onrender.com`. A file fetched but not published is a
404 mid-install; a file published but not fetched is a module the poller cannot import.

## 2. `executor/test-install.mjs` — `need` list and default target (executor lane) — OPEN

```diff
-const target = process.argv[2] || "https://claudedotcompany.com";
+const target = process.argv[2] || "https://robinhood.claudedotcompany.com";
-const need = ["poller.mjs", "journal.mjs", "jupiter.mjs", "token2022.mjs", "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "sol-usd-oracle.mjs", "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs", "strategy.mjs", "trade-policy.mjs",
+const need = ["poller.mjs", "journal.mjs", "evm-executor.mjs", "evm-rpc.mjs", "evm-swap.mjs", "approvals.mjs", "scope-guard.mjs", "thresholds.mjs", "live-thresholds.mjs", "eth-usd-oracle.mjs", "erc20-hazards.mjs", "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs", "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs", "strategy.mjs", "trade-policy.mjs",
   "package.json", "package-lock.json", "install.sh", "macos-launchagent.sh", "macos-release.sh", "launchd-runner.mjs"];
```

and the `RUNTIME_FILES=(...)` regex at line 268 must match the new `install.sh` array.

Measured today: `node executor/test-install.mjs .` exits **1** with 8 FAILs —
`poller.mjs imports ./evm-executor.mjs / ./evm-rpc.mjs / ./thresholds.mjs /
./eth-usd-oracle.mjs and it is published`, `journal.mjs imports ./eth-usd-oracle.mjs`,
`entry-quote-guard.mjs imports ./eth-usd-oracle.mjs`, `published manifest pins the signer
dependencies`, `published lock agrees with the pinned manifest`. `scripts/test-all.mjs`
runs this file with `.` on every Render build, so **`npm test` — and therefore the Render
deploy and the Pages build — is red until this lands.** The runbook's post-release check
(`node executor/test-install.mjs <site>`) depends on it too.

## 3. `CC_API` default and the Solana oracle import (executor lane) — PARTLY DONE

- **DONE** `executor/poller.mjs:57` already reads
  `process.env.CC_API || "https://claude-company-robinhood-api.onrender.com"`.
- OPEN `executor/monitor.mjs:569`:
  ```diff
  -    api: String(cfg.CC_API || "https://claude-company-api.onrender.com").replace(/\/$/, ""),
  +    api: String(cfg.CC_API || "https://claude-company-robinhood-api.onrender.com").replace(/\/$/, ""),
  ```
- OPEN `executor/install-secret.sh:20`: `CC_API=https://claude-company-api.onrender.com`
  → the fork's host.
- OPEN **`executor/monitor.mjs:14`** still reads
  `import { independentSolUsdPrice, solanaRpcConnectionConfig } from "./sol-usd-oracle.mjs";`.
  `sol-usd-oracle.mjs` is deliberately NOT published (it is the Solana oracle;
  `test-deploy-names.mjs` refuses it in the list), so the published `monitor.mjs` fails on
  its first import. It needs the ETH equivalent from `eth-usd-oracle.mjs`. This is the one
  edge the closure walk found that this lane cannot close by publishing more files.

Reason for the host: a fork executor polling the Solana desk's feed would get
`cluster: "mainnet-beta"` and (correctly) refuse — but only after a tenant spent an hour
wondering why.

## 4. `src/office.js` — feed contract (office lane) — DONE

`src/office.js:120` returns `{ chain: CHAIN_ID, cluster: \`robinhood-${CHAIN_ID}\`, latest_id, ... }`.
`docs/DEPLOY-ROBINHOOD.md` step (e)(2) prints `chain` and `cluster` and tells the operator
to stop if it sees `mainnet-beta`. Not re-verified against a running office here — the
runbook's curl is the verification.

## 5. `src/office.js` — `/api/lease/config` (auth-leasing lane) — DONE as far as grep shows

`src/office.js:585-590` now answers
`{ ...leasing.config(), floors, hq, pay: leasing.payConfig() }`; the Solana
`treasuryTokenAccount` / `getAccountInfo` / `leasing.MINT` path is gone (grep finds none).
The runbook says `pay: null` is expected until `TREASURY_OWNER_RH` and a real
`CLAUDECO_RH_TOKEN` are set. Measured 2026-09-05 with `CLAUDECO_RH_TOKEN=0x0…0`,
`CLAUDECO_RH_DECIMALS=18`, `TREASURY_OWNER_RH=` (in-process import, no server):
`leasing.payConfig()` → `null`; `leasing.config()` carries `launched`, `ready`, `reason`.
The route itself is exercised only by the runbook's step (e)(1) against the live host.

## 6. `src/manifest.js` `DECISION_MANIFEST_FILES` — DONE

`executor/evm-executor.mjs`, `src/data/evm.js` and `src/data/pons-live.js` now exist on
disk (all 16 checked paths present, 2026-09-05), so `buildDecisionManifest()` no longer
throws and the four suites that record a decision pass here: `test-codex-improvement.mjs`
22/22, `test-improvement-provenance.mjs` 12/12, `test-codex-improvement-checkout.mjs` 4/4,
`test-marketing-build.mjs` exit 0. The rule stands: if a lane renames one of these,
change the entry; never make the manifest tolerant.

## 7. `executor/README.md` — hosts and file names (executor lane) — OPEN

Line 333 still says "Live polling uses `jupiter.mjs` for Jupiter Swap API v2 …". Mentions
of the Solana hosts and of `jupiter.mjs` / `sol-usd-oracle.mjs` in the install and
troubleshooting sections should name the fork's hosts and the EVM files. The file is
published verbatim to `dist/executor/README.md`.

## 8. `token/metadata.json` socials (owner) — no change

The owner said the socials and image are the same as the Solana edition's. The Solana
`metadata.json` carries no social fields either (only `external_url`/`website`), so none
were invented here. If the Solana launch used an off-repo metadata upload with
twitter/telegram fields, add the same to this file before the PONS launch.
