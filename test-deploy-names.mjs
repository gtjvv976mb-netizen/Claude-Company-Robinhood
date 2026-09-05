/**
 * THE FORK DEPLOYS AS ITSELF.
 *
 * When the fork was cut, render.yaml and both workflows were byte-identical to the Solana
 * original (diff exit 0, 2026-09-05). Applying that blueprint would have deployed onto
 * the live Solana service by name, and viewer/CNAME would have made Pages claim the
 * Solana desk's apex. This test pins every deployment name to the shared contract and
 * refuses any regression to the original's hosts, service, disk or Solana env vars.
 *
 * The apex claudedotcompany.com is allowed in exactly two places: the "Two towers"
 * gateway link on the homepage, and the runbook's note explaining why the apex is not
 * ours to bind. Everywhere else, only the robinhood. subdomain may appear.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const SITE = "https://robinhood.claudedotcompany.com";
const API_HOST = "claude-company-robinhood-api.onrender.com";
const SERVICE = "claude-company-robinhood-api";
const DISK = "claude-company-robinhood-data";
const OLD_API_HOST = "claude-company-api.onrender.com";
// the apex, not preceded by "robinhood."
const BARE_APEX = /(?<!robinhood\.)claudedotcompany\.com/g;

const DEPLOY_FILES = [
  "render.yaml",
  ".github/workflows/pages.yml",
  ".github/workflows/codex-improvement.yml",
  "scripts/build-viewer.mjs",
  "services/codex-improvement/run.mjs",
  ".env.example",
  "token/metadata.json",
];

console.log("\nNO DEPLOY FILE NAMES THE SOLANA DESK'S HOSTS, SERVICE, DISK OR ENV");
for (const file of DEPLOY_FILES) {
  const text = read(file);
  const oldHostHits = text.split(OLD_API_HOST).length - 1;
  const apexHits = [...text.matchAll(BARE_APEX)].length;
  const solanaEnv = text.match(/\bSOLANA_RPC\b|\bCLAUDECO_MINT\b|\bCLAUDECO_DECIMALS\b/g) || [];
  ok(`${file}: no ${OLD_API_HOST}`, oldHostHits === 0, `${oldHostHits} hits`);
  ok(`${file}: no bare apex claudedotcompany.com`, apexHits === 0, `${apexHits} hits`);
  ok(`${file}: no SOLANA_RPC / CLAUDECO_MINT / CLAUDECO_DECIMALS`, solanaEnv.length === 0, solanaEnv.join(","));
  ok(`${file}: no Solana service/disk name`,
    !/claude-company-api\b|claude-company-data\b/.test(text.replace(/claude-company-robinhood-(?:api|data)/g, "")));
}

console.log("\nEVERY NAME IS THE CONTRACT'S");
const render = read("render.yaml");
ok("render.yaml service name", render.includes(`name: ${SERVICE}`));
ok("render.yaml disk name", render.includes(`name: ${DISK}`));
ok("render.yaml keeps the disk as the database", /CLAUDE_CO_DB[\s\S]*?\/var\/data\/claude-co\.db/.test(render));
ok("render.yaml RH_RPC defaults to the public RPC",
  /key: RH_RPC\s*\n\s*value: https:\/\/rpc\.mainnet\.chain\.robinhood\.com/.test(render));
ok("render.yaml RH_RPC_SECONDARY is a dashboard value", /key: RH_RPC_SECONDARY\s*\n\s*sync: false/.test(render));
ok("render.yaml CLAUDECO_RH_TOKEN is the live Robinhood-edition token (launched 2026-09-04 on PONS V2, paired to NVDA)",
  /key: CLAUDECO_RH_TOKEN\s*\n\s*value: "0x7039986CaC6C7885b53f10c7492E653055470ab9"/.test(render));
ok("render.yaml CLAUDECO_RH_DECIMALS is 18", /key: CLAUDECO_RH_DECIMALS\s*\n\s*value: "18"/.test(render));
ok("render.yaml TREASURY_OWNER_RH is a dashboard value", /key: TREASURY_OWNER_RH\s*\n\s*sync: false/.test(render));
for (const secret of ["ANTHROPIC_API_KEY", "XAI_API_KEY", "CODEX_REVIEW_TOKEN"]) {
  ok(`render.yaml ${secret} is sync:false with no value`,
    new RegExp(`key: ${secret}\\s*\\n\\s*sync: false`).test(render) &&
    !new RegExp(`key: ${secret}\\s*\\n\\s*value:`).test(render));
}
ok("render.yaml keeps build/start/health",
  render.includes("buildCommand: npm ci && npm ci --prefix executor --ignore-scripts && npm test") &&
  render.includes("startCommand: node src/index.js office") &&
  render.includes("healthCheckPath: /api/lease/config"));
ok("render.yaml leasing prices stay in token units",
  /FLOOR_PRICE_CLAUDECO[\s\S]*?"1000000"/.test(render) && /RUN_PRICE_CLAUDECO[\s\S]*?"250000"/.test(render));
ok("render.yaml carries no TREASURY_OWNER (Solana) key",
  !/key: TREASURY_OWNER\s*$/m.test(render));

const pages = read(".github/workflows/pages.yml");
ok("pages.yml builds with the fork's SITE_URL", pages.includes(`SITE_URL="${SITE}"`));
ok("pages.yml takes API_BASE from a repository variable", pages.includes('API_BASE="${{ vars.API_BASE }}"'));
ok("pages.yml names the fork's API host for the variable", pages.includes(`https://${API_HOST}`));

const codex = read(".github/workflows/codex-improvement.yml");
ok("codex-improvement.yml bundle_url default is the fork's API",
  codex.includes(`default: https://${API_HOST}/api/improvements/review-bundle`));
ok("codex-improvement.yml host allowlist is the fork's API", codex.includes(`CODEX_BUNDLE_HOSTS: ${API_HOST}`));

const worker = read("services/codex-improvement/run.mjs");
ok("run.mjs default bundle URL is the fork's API",
  worker.includes(`const DEFAULT_BUNDLE_URL = "https://${API_HOST}/api/improvements/review-bundle";`));
ok("run.mjs default host allowlist is the fork's API",
  worker.includes(`const DEFAULT_BUNDLE_HOSTS = "${API_HOST}";`) &&
  /process\.env\.CODEX_BUNDLE_HOSTS \|\| DEFAULT_BUNDLE_HOSTS/.test(worker));
ok("run.mjs prompt carries the chain context and the charter-vs-bundle first deliverable",
  /CHAIN CONTEXT/.test(worker) && /chainId 4663/.test(worker) &&
  /FIRST DELIVERABLE, ALWAYS/.test(worker) && /docs\/EVIDENCE-CONTRACT\.md/.test(worker) &&
  /src\/agents\/analysts\.js/.test(worker) && /src\/data\/evidence\.js/.test(worker));

/* viewer/CNAME is deliberately ABSENT until the DNS record exists: with it, Pages redirects
   every visitor to a name that does not resolve (docs/DEPLOY-ROBINHOOD.md (c)). When it
   returns it must carry exactly the fork's host. */
{
  const cname = fs.existsSync("viewer/CNAME") ? read("viewer/CNAME").trim() : null;
  ok("viewer/CNAME is absent until DNS exists, or is exactly the fork's host",
    cname === null || cname === "robinhood.claudedotcompany.com", String(cname));
}

const build = read("scripts/build-viewer.mjs");
ok("build-viewer SITE_URL default is the fork's host",
  build.includes(`process.env.SITE_URL || "${SITE}"`));
const executorList = build.match(/const EXECUTOR_FILES = \[([\s\S]*?)\];/)?.[1] || "";
const executorFiles = [...executorList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
for (const evm of ["evm-executor.mjs", "evm-swap.mjs", "approvals.mjs", "scope-guard.mjs",
  "thresholds.mjs", "live-thresholds.mjs", "eth-usd-oracle.mjs", "erc20-hazards.mjs"]) {
  ok(`build-viewer publishes ${evm}`, executorFiles.includes(evm));
}
// Not in the contract's list, but four published EVM modules import it (closure walk,
// 2026-09-05). The published poller's first import would 404 without it.
ok("build-viewer publishes evm-rpc.mjs, which poller/evm-executor/eth-usd-oracle/erc20-hazards import",
  executorFiles.includes("evm-rpc.mjs"));
// The EVM modules that ARE published must import only published modules. This walks the
// real files, not the list: a Solana import surviving in a published EVM file is an
// install that fails at `node poller.mjs`. monitor.mjs is the executor lane's and still
// imports sol-usd-oracle.mjs (docs/HANDOFF-deploy-repo.md §3); it is checked by
// executor/test-install.mjs, not here, so this lane's test does not go red on their file.
const EVM_GRAPH = ["poller.mjs", "journal.mjs", "evm-executor.mjs", "evm-rpc.mjs", "evm-swap.mjs",
  "approvals.mjs", "scope-guard.mjs", "thresholds.mjs", "live-thresholds.mjs", "eth-usd-oracle.mjs",
  "erc20-hazards.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs"];
for (const file of EVM_GRAPH) {
  const p = path.join(root, "executor", file);
  if (!fs.existsSync(p)) { ok(`executor/${file} exists on disk`, false, "missing"); continue; }
  const deps = [...fs.readFileSync(p, "utf8").matchAll(/from\s+"\.\/([^"]+)"/g)].map((m) => m[1]);
  const unpublished = deps.filter((d) => !executorFiles.includes(d));
  ok(`executor/${file}: every ./import is published (${deps.length} edges)`, unpublished.length === 0,
    `unpublished: ${unpublished.join(", ")}`);
}
for (const sol of ["jupiter.mjs", "sol-usd-oracle.mjs", "token2022.mjs"]) {
  ok(`build-viewer no longer publishes ${sol}`, !executorFiles.includes(sol));
}
ok("build-viewer: a release build refuses a partial installer graph, a preview warns",
  /if \(releaseBuild\) throw new Error\(`\$\{message\}/.test(build) && /console\.warn\(/.test(build));

const index = read("viewer/index.html");
const indexApex = [...index.matchAll(BARE_APEX)].map((m) => index.slice(Math.max(0, m.index - 40), m.index + 40));
ok("viewer/index.html names the apex exactly once, as the Two towers gateway link",
  indexApex.length === 1 && /href="https:\/\/claudedotcompany\.com\/"/.test(index) &&
  /<a href="https:\/\/claudedotcompany\.com\/"[^>]*>Two towers<\/a>\s*<a href="#desk">/.test(index),
  JSON.stringify(indexApex));
ok("viewer/index.html og/twitter images are on the fork's host",
  index.includes(`og:image" content="${SITE}/assets/`) && index.includes(`twitter:image" content="${SITE}/assets/`));
ok("viewer/index.html token section carries the live address and links, not a placeholder or the Solana mint",
  index.includes("0x7039986CaC6C7885b53f10c7492E653055470ab9") && !/PLACEHOLDER/.test(index) && !/not launched/i.test(index) &&
  index.includes("ponsfamily.com/launchpad/0x7039986CaC6C7885b53f10c7492E653055470ab9") &&
  !index.includes("HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump") && !/pump\.fun\/coin/.test(index));

const meta = JSON.parse(read("token/metadata.json"));
ok("token/metadata.json is the Robinhood edition with the live address, pool and pair",
  meta.chain === "robinhood-4663" && meta.chainId === 4663 && meta.decimals === 18 &&
  meta.address === "0x7039986CaC6C7885b53f10c7492E653055470ab9" && /LIVE/.test(meta.addressStatus) && meta.pairToken?.symbol === "NVDA" && meta.launchpad === "pons-v2" &&
  meta.symbol === "CLAUDECO" && meta.name === "Claude Company" &&
  meta.image === `${SITE}/assets/claudeco-512.png`);

ok("package.json is named for the fork", JSON.parse(read("package.json")).name === "claude-company-robinhood");

const env = read(".env.example");
ok(".env.example carries the RH vars", /^RH_RPC=https:\/\/rpc\.mainnet\.chain\.robinhood\.com$/m.test(env) &&
  /^RH_RPC_SECONDARY=$/m.test(env) && /^CLAUDECO_RH_TOKEN=0x7039986CaC6C7885b53f10c7492E653055470ab9$/m.test(env) &&
  /^CLAUDECO_RH_DECIMALS=18$/m.test(env) && /^TREASURY_OWNER_RH=$/m.test(env));

const manifest = read("src/manifest.js");
const manifestList = manifest.match(/DECISION_MANIFEST_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] || "";
const manifestFiles = [...manifestList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
for (const evm of ["executor/evm-swap.mjs", "executor/approvals.mjs", "executor/scope-guard.mjs",
  "executor/thresholds.mjs", "executor/live-thresholds.mjs", "executor/evm-executor.mjs",
  "executor/erc20-hazards.mjs", "src/data/evidence.js", "src/data/evm.js", "src/data/pons-live.js",
  "src/data/kyber.js"]) {
  ok(`decision manifest names ${evm}`, manifestFiles.includes(evm));
}
for (const sol of ["src/data/jupiter.js", "src/data/pumpfun.js", "src/data/solana.js"]) {
  ok(`decision manifest dropped ${sol}`, !manifestFiles.includes(sol));
}

console.log("\nTHE RUNBOOKS EXIST AND CARRY THE CONTRACT'S NAMES");
const runbook = read("docs/DEPLOY-ROBINHOOD.md");
ok("DEPLOY-ROBINHOOD.md names site, API, service, disk and repo",
  runbook.includes(SITE) && runbook.includes(`https://${API_HOST}`) && runbook.includes(SERVICE) &&
  runbook.includes(DISK) && runbook.includes("gtjvv976mb-netizen/Claude-Company-Robinhood") &&
  runbook.includes("git remote add origin git@github.com:gtjvv976mb-netizen/Claude-Company-Robinhood.git"));
ok("DEPLOY-ROBINHOOD.md: the apex appears only in the DNS note and the measured table",
  [...runbook.matchAll(BARE_APEX)].length <= 3 && /Do \*\*not\*\* touch the apex/.test(runbook));
const launch = read("docs/LAUNCH-CHECKLIST.md");
ok("LAUNCH-CHECKLIST.md pairs to native ETH, refuses WETH/equities/Anthropic impersonations, and leaves scope-guard alone",
  /Pair to native ETH/.test(launch) && /WETH is NOT an approved pair token/.test(launch) &&
  /Anthropic/.test(launch) && /exempt list/i.test(launch) && /0\.0005 ETH/.test(launch) &&
  /4\.2 ETH/.test(launch) && /Do not touch `executor\/scope-guard\.mjs`/.test(launch) &&
  /CLAUDECO_RH_TOKEN/.test(launch) && /token\/metadata\.json/.test(launch));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
