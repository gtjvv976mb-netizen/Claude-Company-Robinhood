# Deploying Claude Company for Robinhood

The runbook, in order. Every name here is from the shared contract; if a step's name
differs from what you see in a dashboard, stop and reconcile before continuing — the
Solana desk's service, disk and apex domain are one typo away.

| Thing | Name |
|---|---|
| Site | `https://robinhood.claudedotcompany.com` |
| API | `https://claude-company-robinhood-api.onrender.com` |
| Render service | `claude-company-robinhood-api` |
| Render disk (= the database) | `claude-company-robinhood-data`, mounted at `/var/data` |
| GitHub repository | `gtjvv976mb-netizen/Claude-Company-Robinhood` |
| Chain | Robinhood Chain, chainId 4663 (`0x1237`) |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |

Measured on 2026-09-05 while writing this: the public RPC answered `eth_chainId` →
`0x1237`, `eth_gasPrice` → `0x1838fd20` (406,715,680 wei ≈ 0.41 gwei), `eth_blockNumber`
→ 54,567,929; the apex `claudedotcompany.com` resolves to `185.199.108.153`,
`185.199.109.153`, `185.199.110.153`, `185.199.111.153` (GitHub Pages); the `robinhood`
subdomain has **no** record yet (`dig +short CNAME` empty); the API host returns HTTP 404
(no such Render service yet); the Solana desk's API returns 200 on `/api/lease/config`.

Nothing in this document pushes, creates or applies anything by itself. Each step is done
by you in a browser or a terminal you control.

---

> **Status, 2026-09-05 09:20 Manila — done from this machine via the GitHub API (token from the
> keychain, used in-process):** (a) the repository exists at
> https://github.com/gtjvv976mb-netizen/Claude-Company-Robinhood (public, `origin` set on the
> fork); (b) Pages is enabled with source = GitHub Actions and the repo variable `API_BASE` is
> set to `https://claude-company-robinhood-api.onrender.com`. The site will answer at
> https://gtjvv976mb-netizen.github.io/Claude-Company-Robinhood/ after the first push.
> **Still the owner's:** the Actions secrets in (b), the DNS record in (c) — and `viewer/CNAME`
> must stay OUT of the tree until that record exists, or Pages redirects to a name that does not
> resolve — and every step of (d) Render, which has no API credential here.

## (a) Create the GitHub repository

**Done 2026-09-05** (see the status block above). The repository exists and the fork's `origin`
points at it. What to verify, in a terminal at the fork root:

```bash
git remote -v
```

should print `origin  git@github.com:gtjvv976mb-netizen/Claude-Company-Robinhood.git` twice. If it
prints nothing, add it:

```bash
git remote add origin git@github.com:gtjvv976mb-netizen/Claude-Company-Robinhood.git
```

The first push is the parent session's, after the suite is green — never from a red tree, because
the Pages workflow runs `npm test` before it publishes.

## (b) GitHub Pages, the `API_BASE` variable and the Actions secrets

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** (Not "Deploy
   from a branch"; `.github/workflows/pages.yml` uploads `dist/` itself.)
2. **Settings → Secrets and variables → Actions → Variables → New repository variable**
   - `API_BASE` = `https://claude-company-robinhood-api.onrender.com` (no trailing slash)

   The build stamps this into every page as `window.__API_BASE__`; without it the static
   site talks to itself and every floor falls back to the scripted demo shift.
3. **Secrets → New repository secret** — for the manually dispatched Codex review only;
   the Pages build needs none:
   - `OPENAI_API_KEY` — project-scoped, used only by the isolated worker.
   - `CODEX_REVIEW_TOKEN` — a fresh high-entropy value. It must equal the one you will set
     in Render in step (d) and must **differ** from the Solana desk's: it is a bearer for
     this fork's own bundle.
   - `CODEX_ARTIFACT_KEY` — a separate random passphrase of at least 32 characters.

   Generate them locally without echoing them into the shell history, e.g.
   `openssl rand -base64 48 | pbcopy`, and paste into the GitHub form. Never commit them
   or put them in `.env.example`.
4. Push (or **Actions → Deploy site → Run workflow**). The `build` job runs `npm test`
   first; a red suite publishes nothing. The `deploy` job's summary shows the Pages URL.
   Until (c) is done the site is at `https://gtjvv976mb-netizen.github.io/Claude-Company-Robinhood/`
   — with the CNAME present Pages will already be trying to bind the custom domain and
   will show a DNS warning until the record exists.

## (c) DNS

> `viewer/CNAME` is deliberately NOT in the tree. Add it back (one line: `robinhood.claudedotcompany.com`)
> in the same commit that follows the DNS record going live; before that, a CNAME makes Pages redirect
> every visitor to a name that does not resolve.

At the DNS provider for `claudedotcompany.com` add **one** record:

| Type | Name | Value | TTL |
|---|---|---|---|
| `CNAME` | `robinhood` | `gtjvv976mb-netizen.github.io.` | 300 |

Do **not** touch the apex. It already points at the Pages IPs above for the Solana desk,
and a second Pages site cannot claim it; that is why this edition lives on a subdomain and
why `viewer/CNAME` says `robinhood.claudedotcompany.com`, not the apex.

Then in **Settings → Pages → Custom domain** enter `robinhood.claudedotcompany.com`,
wait for the DNS check, and tick **Enforce HTTPS** once the certificate is issued
(minutes to an hour). Verify from a terminal:

```bash
dig +short CNAME robinhood.claudedotcompany.com     # gtjvv976mb-netizen.github.io.
curl -sI https://robinhood.claudedotcompany.com/ | head -1   # HTTP/2 200
curl -s https://robinhood.claudedotcompany.com/ | grep -o '<meta name="cc-build"[^>]*>'
```

The `cc-build` stamp is the answer to "am I seeing the new version" — compare it with the
workflow run's time.

## (d) Render

1. **Render dashboard → New → Blueprint → connect `gtjvv976mb-netizen/Claude-Company-Robinhood`
   → branch `main` → Apply.** Render reads `render.yaml`: service
   `claude-company-robinhood-api` on the `starter` plan (a persistent disk needs it),
   region `oregon`, disk `claude-company-robinhood-data` 1 GB at `/var/data`.
2. The disk **is** the database. `CLAUDE_CO_DB=/var/data/claude-co.db` is set in the
   blueprint; ownership (floors, leases, credits) lives in that SQLite file and survives
   redeploys only because the disk does. A different disk name from the Solana desk's is
   what makes this a separate database — never rename it to match.
3. Set the `sync: false` values in **Environment** (the blueprint declares them but
   carries no value):
   - `TREASURY_OWNER_RH` — your **public** EVM address that receives $CLAUDECO for
     floors. Leasing stays closed until it is set. Never a private key.
   - `ANTHROPIC_API_KEY` — a separate key from the Solana desk's, for cost attribution.
   - `XAI_API_KEY` — optional; enables the alternate Grok PM brain.
   - `RH_RPC_SECONDARY` — optional paid provider URL; the public RPC 429s on batches
     over ~10 requests and is left as `RH_RPC`'s default.
   - `CODEX_REVIEW_TOKEN` — the same value as the GitHub secret from (b).
4. `CLAUDECO_RH_TOKEN` stays `0x0000000000000000000000000000000000000000` and
   `CLAUDECO_RH_DECIMALS` stays `18` until `docs/LAUNCH-CHECKLIST.md` has run.
5. Deploy. The build runs `npm ci && npm ci --prefix executor --ignore-scripts && npm test`;
   a failing test never replaces the live process. Render sets `RENDER_GIT_COMMIT`, which
   is what `/api/improvements/status` reports as `sourceCommit`.

## (e) First-boot verification

Every check prints the value it is judged on. Run them from your machine.

```bash
API=https://claude-company-robinhood-api.onrender.com

# 1. The health route Render polls. Expect 200 and floors: 50.
curl -s -o /tmp/lease.json -w 'lease/config HTTP %{http_code}\n' "$API/api/lease/config"
node -e 'const j=require("/tmp/lease.json");console.log("floors",j.floors,"hq",j.hq,"pay",j.pay)'

# 2. The feed contract. Needs a floor's executor secret (Floor 50 → WALL-ST-E tab →
#    Setup shows it to the owner). The poller asserts chain === 4663 before it trades.
curl -s -H "authorization: Bearer $CC_SECRET" "$API/api/floor/50/executor/feed?after=0" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("chain",j.chain,"cluster",j.cluster,"latest_id",j.latest_id)})'
#    expect: chain 4663 cluster robinhood-4663

# 3. The seats can actually work (an HTTP 200 does not prove model credit).
curl -s "$API/api/heartbeat" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("status",j.status,"blocked",j.blocked)})'

# 4. Codex review readiness: bundleAuthConfigured true, sourceCommit = the 40-char SHA
#    Render deployed (Dashboard → Events). The worker refuses any other commit.
curl -s "$API/api/improvements/status"

# 5. The site talks to this API, not to itself.
curl -s https://robinhood.claudedotcompany.com/ | grep -o 'window.__API_BASE__=[^;]*'
#    expect: window.__API_BASE__="https://claude-company-robinhood-api.onrender.com"
```

If (1) is 200 but `pay` is `null`, leasing is closed — expected until `TREASURY_OWNER_RH`
and a real `CLAUDECO_RH_TOKEN` are set. If (2) prints `cluster mainnet-beta`, the office
lane's feed change is not deployed: stop, the executor will refuse the feed.

## (f) Prewarm and cache notes

- **Pages is a CDN; the first request after a deploy is cold.** Fetch the three heavy
  pages once so the next visitor is not the one waiting: 
  `for p in index.html tower.html floor.html; do curl -s -o /dev/null -w "$p %{http_code} %{size_download}B %{time_total}s\n" https://robinhood.claudedotcompany.com/$p; done`.
  A byte count near zero means an asset was not built — a file on disk is not a file on
  the web.
- **The executor installer is served from the site**
  (`https://robinhood.claudedotcompany.com/executor/install.sh`). Check it after every
  release: `node executor/test-install.mjs https://robinhood.claudedotcompany.com` walks
  the published module graph and fails on a 404. A local build warns if a file is missing
  from the graph; a pinned release build (`EXECUTOR_COMMIT` / CI) refuses to publish it.
- **Render starter does not sleep**, so there is no cold start to prewarm; the first
  `/api/lease/config` after boot is slower only because it builds the leasing config.
- **Link previews cache aggressively.** `og:image` is absolute on the `robinhood` host;
  after changing the banner, re-scrape with the X card validator rather than waiting.
- **Codex review**: dispatch **Actions → Codex improvement review** only after
  `/api/improvements/status` shows the exact commit the workflow will check out; a
  deployment race fails closed.

## What this runbook does not do

It does not create the repository, push, apply the blueprint, or edit DNS — you do. It
does not launch the token — that is `docs/LAUNCH-CHECKLIST.md`. And it never asks for a
private key, a seed phrase, or a Render/GitHub token in a file.
