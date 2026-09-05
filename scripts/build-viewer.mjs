// Produce self-contained pages: the published artifact CSP forbids any external fetch,
// so three.js is inlined rather than served from /vendor.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inlineThree } from "./inline-three.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const VIEWER = path.join(ROOT, "viewer");
const OUT = path.join(ROOT, "dist");

const IMPORT_LINE = /^import \* as THREE from "\/vendor\/three\/three\.module\.js";.*$/m;
const executorCommitInput = String(process.env.EXECUTOR_COMMIT || process.env.GITHUB_SHA || "").trim();
const releaseBuild = Boolean(executorCommitInput);
if (releaseBuild && !/^[0-9a-f]{40}$/i.test(executorCommitInput)) {
  throw new Error("EXECUTOR_COMMIT (or CI GITHUB_SHA) must identify the exact 40-character build commit");
}
if (!releaseBuild && (process.env.CI || process.env.GITHUB_ACTIONS)) {
  throw new Error("release builds require EXECUTOR_COMMIT or GITHUB_SHA");
}
// A local preview remains buildable without pretending its uncommitted executor
// graph belongs to HEAD. The viewer detects this non-SHA sentinel, disables both
// copy buttons, and displays a deliberately non-runnable instruction instead.
const EXECUTOR_COMMIT = releaseBuild
  ? executorCommitInput.toLowerCase()
  : "LOCAL_PREVIEW_NOT_INSTALLABLE";

// Source pages use the dev server's routes. The static build has no server, so every
// route becomes a plain relative link — which also keeps the site working when GitHub
// Pages hosts it under a /claude-tower/ subpath.
const PAGES = [
  { src: "index.html",    out: "index.html" },
  { src: "tower.html",    out: "tower.html" },
  { src: "office3d.html", out: "floor.html" },
  { src: "buy.html",      out: "buy.html" },
  { src: "404.html",      out: "404.html" },
];
const ASSETS = [
  "claudeco-512.png", "claudeco-256.png", "claudeco-64.png",
  "banner-1500x500.png", "banner-1200x630.png",
  "codex-turntable-cover.png", "codex-turntable.gif", "codex-turntable.mp4",
  "grox-mulder-front.png",
];
const PUBLIC_FONTS = ["Archivo-Bold.ttf", "InstrumentSerif-Regular.ttf"];
// Publish only the finished article artifacts. README files, render templates,
// source-only hero imagery and generator scripts stay out of the static site.
const MARKETING_ARTICLES = [
  {
    source: "wall-st-e-article",
    slug: "wall-st-e",
    files: [
      "article.md",
      "wall-st-e-article-cover.png", "wall-st-e-article-cover-16x9.png",
      "01-custody-boundary.png", "02-two-ways-to-trade.png",
      "03-install-rehearse-arm-fund.png", "04-entry-gauntlet.png",
      "05-position-policy.png", "06-local-brakes.png",
    ],
  },
  {
    source: "claude-grok-codex-article",
    slug: "claude-grok-codex",
    files: [
      "article.md", "claude-grok-codex-header.png",
      "01-three-bounded-jobs.png", "02-integration-loop.png",
    ],
  },
  {
    source: "mission-vision-article",
    slug: "mission-vision",
    files: [
      "article.md", "mission-vision-header.png",
      "01-mission-in-practice.png", "02-vision-shift.png",
    ],
  },
];
// The Robinhood edition's own host. The Solana desk owns the apex; this build must never
// stamp that domain into og:image or the CNAME, or Pages would try to claim it.
const SITE_URL = (process.env.SITE_URL || "https://robinhood.claudedotcompany.com").replace(/\/$/, "");
// Where the API lives. Empty means "same origin", which is right for local dev and wrong
// for a static host — Pages cannot run the scanner or the database.
const API_BASE = (process.env.API_BASE || "").replace(/\/$/, "");
const SOURCE_COMMIT = /^[0-9a-f]{40}$/i.test(String(
  process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || process.env.RENDER_GIT_COMMIT || "",
)) ? String(process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || process.env.RENDER_GIT_COMMIT).toLowerCase()
  : "<PUBLISHED_COMMIT_SHA>";

const { source: THREE_SRC, exportCount } = inlineThree();
const THREE_REV = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "three", "package.json"), "utf8")
).version;



fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const a of ASSETS) {
  const src = path.join(ROOT, "token", a);
  if (!fs.existsSync(src)) throw new Error(`missing public asset: ${a}`);
  fs.copyFileSync(src, path.join(OUT, "assets", a));
}
fs.copyFileSync(path.join(ROOT, "token", "claudeco-64.png"), path.join(OUT, "assets", "favicon.png"));

const publicFontsDir = path.join(OUT, "assets", "fonts");
fs.mkdirSync(publicFontsDir, { recursive: true });
for (const font of PUBLIC_FONTS) {
  const src = path.join(ROOT, "token", "fonts", font);
  if (!fs.existsSync(src)) throw new Error(`missing public font: ${font}`);
  fs.copyFileSync(src, path.join(publicFontsDir, font));
}

// Every article is available at both /articles/<slug>/ and the explicit
// /articles/<slug>/x-paste.html path used by the publishing checklist.
const articlesOut = path.join(OUT, "articles");
fs.rmSync(articlesOut, { recursive: true, force: true });
for (const article of MARKETING_ARTICLES) {
  const sourceDir = path.join(ROOT, "marketing", article.source);
  const articleOut = path.join(articlesOut, article.slug);
  const pasteSource = path.join(sourceDir, "x-paste.html");
  if (!fs.existsSync(pasteSource)) {
    throw new Error(`missing article page: ${article.source}/x-paste.html`);
  }
  fs.mkdirSync(articleOut, { recursive: true });
  const articleHtml = fs.readFileSync(pasteSource, "utf8")
    .replaceAll("../../token/fonts/", "../../assets/fonts/");
  fs.writeFileSync(path.join(articleOut, "index.html"), articleHtml);
  fs.writeFileSync(path.join(articleOut, "x-paste.html"), articleHtml);
  for (const file of article.files) {
    const src = path.join(sourceDir, file);
    if (!fs.existsSync(src)) throw new Error(`missing article artifact: ${article.source}/${file}`);
    fs.copyFileSync(src, path.join(articleOut, file));
  }
}

const marketingOut = path.join(OUT, "marketing");
const marketingIndex = path.join(ROOT, "marketing", "index.html");
if (!fs.existsSync(marketingIndex)) throw new Error("missing public marketing index");
fs.rmSync(marketingOut, { recursive: true, force: true });
fs.mkdirSync(marketingOut, { recursive: true });
fs.copyFileSync(marketingIndex, path.join(marketingOut, "index.html"));

// The self-hosted executor, served static so the one-command install resolves.
// This is the EVM graph (Robinhood Chain): evm-executor/evm-swap/approvals/scope-guard/
// thresholds and the ETH-USD oracle replace jupiter/sol-usd-oracle. The list must agree
// with executor/install.sh's fetch list and executor/test-install.mjs's `need` list —
// a file missing from here is a file the one-command install cannot resolve.
// evm-rpc.mjs is not in the shared contract's list but is imported by poller.mjs,
// evm-executor.mjs, eth-usd-oracle.mjs and erc20-hazards.mjs (import-closure walk over this
// list, 2026-09-05: those four were the only unpublished EVM edges); without it the
// installed poller fails on its first import.
fs.mkdirSync(path.join(OUT, "executor"), { recursive: true });
const EXECUTOR_FILES = [
  "poller.mjs", "journal.mjs", "evm-executor.mjs", "evm-rpc.mjs", "evm-swap.mjs", "approvals.mjs", "scope-guard.mjs",
  "thresholds.mjs", "live-thresholds.mjs", "eth-usd-oracle.mjs", "erc20-hazards.mjs",
  "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs",
  "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs", "install.sh", "macos-launchagent.sh",
  "macos-release.sh", "launchd-runner.mjs", "executor.mjs",
  "README.md", "strategy.mjs", "trade-policy.mjs", "simulate.mjs",
  "package.json", "package-lock.json",
];
const missingExecutorFiles = [];
for (const f of EXECUTOR_FILES) {
  const src = path.join(ROOT, "executor", f);
  if (!fs.existsSync(src)) { missingExecutorFiles.push(f); continue; }
  fs.copyFileSync(src, path.join(OUT, "executor", f));
}
if (missingExecutorFiles.length) {
  // A pinned release build (EXECUTOR_COMMIT / CI) publishes the installer's fetch list,
  // so a hole in it is a broken install for every user: hard error. A local preview is
  // already non-installable (the sentinel above disables the copy buttons), so there it
  // is a warning loud enough to read — the EVM files were being written in parallel
  // when this list was cut (2026-09-05) and a preview must still build meanwhile.
  const message = `missing executor artifact${missingExecutorFiles.length === 1 ? "" : "s"}: ${missingExecutorFiles.join(", ")}`;
  if (releaseBuild) throw new Error(`${message} — a release build cannot publish a partial installer graph`);
  console.warn(`\n!! WARNING (local preview only) ${message}\n!! The published installer would be broken; a release build refuses this.\n`);
}

// GitHub Pages reads dist/CNAME to bind the custom domain.
const cnameSrc = path.join(VIEWER, "CNAME");
if (fs.existsSync(cnameSrc)) fs.copyFileSync(cnameSrc, path.join(OUT, "CNAME"));

const built = [];

for (const { src: name, out } of PAGES) {
  const src = path.join(VIEWER, name);
  if (!fs.existsSync(src)) continue;
  let html = fs.readFileSync(src, "utf8");
  /* A release installer pin is the exact reviewed build commit. CI supplies github.sha;
     local release builds must supply EXECUTOR_COMMIT explicitly. Ordinary local builds
     get a non-installable preview sentinel, never a stale or inferred SHA. */
  html = html.replaceAll("__CLAUDE_COMPANY_SOURCE_COMMIT__", EXECUTOR_COMMIT);
  const srcClosers = (html.match(/<\/script/gi) || []).length;

  if (IMPORT_LINE.test(html)) {
    // A replacer FUNCTION, not a string: three's source contains `$'`-style sequences,
    // and String.replace would treat those as substitution patterns and splice the rest
    // of the document back in. That produced a 2x-duplicated, unparseable page.
    const block = `/* ── three.js ${THREE_REV}, inlined (MIT licence) ── */\n${THREE_SRC}\n/* ── end three.js ── */`;
    html = html.replace(IMPORT_LINE, () => block);
  }

  // Any `</script` inside the inlined module would close the element early. Assert the
  // output has no more terminators than the source did — the `$'`-in-replacement bug
  // spliced the whole document back in and doubled them, and this catches that class.
  const closers = (html.match(/<\/script/gi) || []).length;
  if (closers !== srcClosers) {
    throw new Error(`${name}: source had ${srcClosers} </script> but output has ${closers} — inlining corrupted the page`);
  }
  // A visible build stamp, so "am I seeing the new version?" is answerable by
  // anyone in two seconds: view-source or the console, no guessing about caches.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  html = html.replace(/<style>/, () =>
    `<meta name="cc-build" content="${stamp}">\n<script>console.log("Claude Company build ${stamp}")</script>\n<style>`);

  if (API_BASE) {
    html = html.replace(/<style>/, () =>
      `<script>window.__API_BASE__=${JSON.stringify(API_BASE)};</script>\n<style>`);
  }

  // the dev server's routes become relative links
  html = html.replace(/<link rel="icon"[^>]*>/, '<link rel="icon" href="assets/favicon.png" type="image/png">');
  html = html.replace(/href="\/tower"/g, 'href="tower.html"');
  html = html.replace(/href="\/floor\/(\d+)"/g, (_, n) => `href="floor.html?floor=${n}"`);
  html = html.replace(/href="\/"(?=[ >])/g, 'href="index.html"');
  html = html.replace(/\/floor\/\$\{f\.n\}/g, "floor.html?floor=${f.n}");   // keep the floor number
  html = html.replace(/\/buy\?floor=\$\{f\.n\}/g, "buy.html?floor=${f.n}");
  // link previews need an absolute image URL; relative is a harmless fallback
  if (SITE_URL) html = html.replace(/content="assets\//g, `content="${SITE_URL}/assets/`);

  // The published-artifact origin has no assets/ directory and its CSP forbids fetching
  // one, so an artifact build carries its images inline.
  if (process.env.INLINE_ASSETS === "1") {
    html = html.replace(/src="assets\/([\w.-]+\.png)"/g, (_, file) => {
      const b64 = fs.readFileSync(path.join(ROOT, "token", file)).toString("base64");
      return `src="data:image/png;base64,${b64}"`;
    });
  }

  // Standalone pages have no server, so the app routes have to point somewhere real.
  // Supply published URLs via env; otherwise the links are left as-is.
  const TOWER = process.env.ARTIFACT_TOWER_URL;
  const FLOOR = process.env.ARTIFACT_FLOOR_URL;
  if (TOWER) html = html.replace(/href="\/tower"/g, () => `href="${TOWER}" target="_blank" rel="noopener"`);
  if (FLOOR) html = html.replace(/href="\/floor\/50"/g, () => `href="${FLOOR}" target="_blank" rel="noopener"`);

  const outPath = path.join(OUT, out);
  fs.writeFileSync(outPath, html);
  built.push({ name: out, bytes: html.length, inlined: !html.includes("/vendor/three/") });
}

console.log(`three namespace entries: ${exportCount}`);
for (const b of built) console.log(`${b.name.padEnd(16)} ${(b.bytes / 1024).toFixed(0).padStart(6)} KB  inlined=${b.inlined}`);
