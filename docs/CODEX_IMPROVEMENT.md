# Codex Improvement Engineer

**Robinhood edition.** The worker reviews THIS fork's API —
`https://claude-company-robinhood-api.onrender.com/api/improvements/review-bundle`, the
workflow's default `bundle_url` and its `CODEX_BUNDLE_HOSTS` allowlist — with this fork's
own `CODEX_REVIEW_TOKEN`, which must differ from the Solana desk's (it is a bearer for
this bundle). The bundle is bound to this checkout's decision manifest, which names the
EVM surface (`executor/evm-swap.mjs`, `approvals.mjs`, `scope-guard.mjs`,
`thresholds.mjs`, `live-thresholds.mjs`, `evm-executor.mjs`, `erc20-hazards.mjs`,
`src/data/evm.js`, `pons-live.js`, `kyber.js`) instead of the Solana adapters, and it
carries a `thresholds` section — every number the executor trades on with its
provenance (`measured` / `inherited` / `assumed`) and date — so the reviewer can see
which numbers are still void on this chain and propose the measurement. The prompt also
fixes the first deliverable of every review: the charter-vs-bundle cross-check (every
evidence key cited in `src/agents/*.js` against `gather()` and
`docs/EVIDENCE-CONTRACT.md`), which changes no policy and is therefore exempt from the
behaviour-change gate.

Codex is an advisory improvement service outside Claude Company's trading pipeline. It
is not a trading seat. Its only output is a review artifact proposing improvements to
tests, evaluation, observability, workflow, security, cost, or—only after the evidence
gate is met—decision prompts and policy.

The service cannot trade, sign, send, size, rank, publish, edit, patch, commit, push,
merge, or deploy. It never runs inside the hosted trading process. Its GitHub Actions
worker is manual and CI-only, has read-only repository permission, uses a read-only Codex
sandbox with approval and agent networking disabled, and produces proposals for human
review. There is no supported local worker mode. Ordinary pull request review, the full
test suite, and an explicit merge remain mandatory; no proposal is auto-applied.

The live API exposes only a coarse public status. Its aggregate review bundle requires a
dedicated read-only bearer token. The bundle excludes tenant rows, raw workups, market
text, credentials, sessions, executor configuration, and unattributed legacy data. A
content digest binds the bundle to its exact source commit, decision manifest, test
manifest, policy version, and evaluation version.

## Activation and provenance

Set a dedicated high-entropy `CODEX_REVIEW_TOKEN` in Render and set the GitHub Actions
secret `CODEX_REVIEW_TOKEN` to exactly the same value. GitHub Actions also requires a
project-scoped `OPENAI_API_KEY` and a separate random `CODEX_ARTIFACT_KEY` of at least 32
characters. These credentials must not be reused as wallet, session, executor, or trading
secrets.

After Render deploys, inspect the public `/api/improvements/status` response. Reviews are
ready only when `bundleAuthConfigured` is `true` and `sourceCommit` equals the exact
40-character commit SHA selected by the workflow. The full
`/api/improvements/review-bundle` is not public and requires the matching bearer token.
On a manual dispatch, the worker verifies the authenticated, digest-bound bundle's source
commit against its checked-out `GITHUB_SHA`, as well as the content digest and exact decision and test
manifests. A deployment race, stale bundle, dirty checkout, or mismatch fails closed.

## Artifact handling

The workflow uploads only the GPG-encrypted
`codex-improvement-review.tar.gz.gpg` artifact, with seven-day retention. Download and
decrypt it as follows:

```bash
read -rs CODEX_ARTIFACT_KEY
printf '%s' "$CODEX_ARTIFACT_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --output codex-improvement-review.tar.gz \
  --decrypt codex-improvement-review.tar.gz.gpg
unset CODEX_ARTIFACT_KEY
mkdir codex-improvement-review
tar -xzf codex-improvement-review.tar.gz -C codex-improvement-review
```

Keep the key outside the repository. Rotate it periodically and immediately after
suspected exposure. Retain an old key securely only while a still-needed artifact remains
inside its seven-day retention window. Decrypting the artifact reveals recommendations,
not an executable patch or approval; implementation, testing, review, and deployment stay
human-controlled.

Decision-policy targets are blocked until the current house evidence has at least 100
distinct assets that were actually published, with current-version 24-hour observations
and at least 80% resolved-mark coverage. CEO-approved research that never reached the
call sheet and calls without an attributed decision link do not count. This gate is
derived by the worker; a model cannot opt out of it by labeling a proposal differently.
