import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256 } from "./canonical.js";

/** Explicit behavior surface. This module has no config/.env side effects so the
 * isolated reviewer can recompute membership from its trusted checkout.
 *
 * ROBINHOOD EDITION. The Solana data adapters (jupiter, pumpfun, solana) are gone from
 * this list and the EVM surface is in: the swap layer, the standing approvals, the
 * scope guard that refuses equities as positions, the threshold registry that refuses
 * to arm on an inherited number, the EVM executor and its ERC-20 hazard checks, and the
 * evm/pons-live/kyber adapters that replace the Solana ones. Without these the fork's
 * real decision policy would be invisible to the "changesDecisionPolicy" gate: a
 * proposal could retarget executor/scope-guard.mjs and be labelled non-policy.
 *
 * A missing entry throws (digestManifestFiles below) rather than being skipped. That is
 * deliberate: a decision file that vanished is the one thing this manifest exists to
 * notice, and `npm test` — which gates every Render deploy — fails loudly on it. */
export const DECISION_MANIFEST_FILES = Object.freeze([
  "DESK.md",
  "package.json",
  "package-lock.json",
  "executor/approvals.mjs",
  "executor/erc20-hazards.mjs",
  "executor/evm-executor.mjs",
  "executor/evm-swap.mjs",
  "executor/live-thresholds.mjs",
  "executor/scope-guard.mjs",
  "executor/thresholds.mjs",
  "executor/trade-policy.mjs",
  "src/agents/analysts.js",
  "src/agents/ceo.js",
  "src/agents/compliance.js",
  "src/agents/composite.js",
  "src/agents/decision.js",
  "src/agents/redteam-policy.js",
  "src/agents/review.js",
  "src/agents/risk-rails.js",
  "src/agents/schemas.js",
  "src/alerts.js",
  "src/canonical.js",
  "src/calls.js",
  "src/categories.js",
  "src/config.js",
  "src/copy.js",
  "src/data/dexscreener.js",
  "src/data/evidence.js",
  "src/data/evm.js",
  "src/data/gmgn.js",
  "src/data/kyber.js",
  "src/data/pons-live.js",
  "src/data/regime.js",
  "src/data/snapshots.js",
  "src/desk.js",
  "src/devrep.js",
  "src/evaluation.js",
  "src/execution-gates.js",
  "src/funnel.js",
  "src/identity.js",
  "src/leasing.js",
  "src/lib/base58.js",
  "src/lib/bus.js",
  "src/lib/grok.js",
  "src/lib/http.js",
  "src/lib/llm.js",
  "src/lib/store.js",
  "src/mandate.js",
  "src/manifest.js",
  "src/market.js",
  "src/order.js",
  "src/penthouse.js",
  "src/provenance.js",
  "src/report.js",
  "src/scanner.js",
  "src/shadow.js",
  "src/trends.js",
  "src/tower.js",
  "src/watchlist.js",
  "src/whales.js",
]);

export function discoveredTestFiles(root) {
  const rootTests = fs.readdirSync(root).filter((name) => /^test-.*\.mjs$/.test(name));
  const executorTests = fs.readdirSync(path.join(root, "executor"))
    .filter((name) => /^test-.*\.mjs$/.test(name))
    .map((name) => path.posix.join("executor", name));
  return [...rootTests, ...executorTests];
}

export function digestManifestFiles(root, files) {
  const realRoot = fs.realpathSync(root);
  const entries = [...files].sort().map((relativePath) => {
    const absolutePath = path.resolve(root, relativePath);
    const insideRoot = absolutePath.startsWith(`${root}${path.sep}`);
    // A missing entry used to surface as a bare ENOENT from lstat, which named the path
    // but not the reason. The manifest is the reason: say so.
    let stat = null, realPath = "";
    try {
      stat = insideRoot ? fs.lstatSync(absolutePath) : null;
      realPath = insideRoot ? fs.realpathSync(absolutePath) : "";
    } catch {
      throw new Error(`unsafe or missing manifest file: ${relativePath} (named in DECISION_MANIFEST_FILES or discovered as a test, but not present in this checkout)`);
    }
    const realInsideRoot = realPath.startsWith(`${realRoot}${path.sep}`);
    if (!insideRoot || !realInsideRoot || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`unsafe or missing manifest file: ${relativePath}`);
    }
    return { path: relativePath, sha256: sha256(fs.readFileSync(absolutePath)) };
  });
  return { files: entries, hash: sha256(canonicalJson(entries)) };
}

export const buildDecisionManifest = (root) => ({
  schemaVersion: "decision-manifest.v1",
  ...digestManifestFiles(root, DECISION_MANIFEST_FILES),
});

export const buildTestManifest = (root) => ({
  schemaVersion: "test-manifest.v1",
  ...digestManifestFiles(root, ["scripts/test-all.mjs", ...discoveredTestFiles(root)]),
});
