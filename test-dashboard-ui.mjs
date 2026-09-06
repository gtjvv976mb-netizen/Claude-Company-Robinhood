import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const html = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");

const destinations = [...html.matchAll(
  /<button class="dtab"[^>]*data-destination="([^"]+)"[^>]*>([^<]+)/g,
)].map((match) => [match[1], match[2].trim()]);
assert.deepEqual(destinations, [
  ["overview", "Overview"],
  ["calls", "Calls"],
  ["wallste", "WALL-ST-E"],
  ["team", "Team"],
  ["callouts", "Callouts"],
  ["activity", "Activity"],
  ["performance", "Performance"],
  ["settings", "Settings"],
], "the redesigned HUD exposes eight purposeful destinations in order");
assert.match(html, /id="primary-nav" role="tablist"/);
assert.equal((html.match(/data-destination=/g) || []).length, 8);
assert.doesNotMatch(html.slice(html.indexOf('id="primary-nav"'), html.indexOf("</div>", html.indexOf('id="primary-nav"'))), />Whales</,
  "Whales is no longer a visible destination");

assert.match(html, /call_api\("\/api\/candidates\/board"\)/);
assert.match(html, /const CANDIDATE_BANDS = \[[\s\S]*?"very_high"/);
assert.match(html, /for \(let index = 0; index < 5; index\+\+\)/,
  "every canonical cap tier renders five explicit slots");
assert.match(html, /NOT REVIEWED · NOT APPROVED · NOT EXECUTABLE/);

assert.match(html, /call_api\("\/api\/callouts"\)/);
assert.match(html, /Array\.isArray\(coin\.callouts\)/);
const calloutsDashboard = html.slice(
  html.indexOf("async function loadCalloutsDashboard"), html.indexOf("async function loadSettingsDashboard"));
assert.doesNotMatch(
  calloutsDashboard,
  /coin\.chatter|body\.chatter/,
  "the Callouts destination never renders unmatched chatter",
);
/* THE RENDERER READS THE PAYLOAD THE SERVER SENDS.
 * The server moved to the owner's rule — pump.fun's gold check plus a wallet holding
 * $1,000 of SOL — and this kept filtering on evidence.inflows, a field that no longer
 * exists, so a tab carrying five coins of real data rendered as empty. These assertions
 * are shaped so that a contract change on either side breaks the test rather than the
 * tab. */
assert.match(calloutsDashboard, /callout\?\.verified === true/,
  "the gold check is required in the view as well as the server");
assert.match(calloutsDashboard, /Number\(callout\?\.walletSolUsd\)/,
  "the view reads the wallet balance the server actually sends");
assert.doesNotMatch(calloutsDashboard, /evidence\?\.inflows|row\.inflows|matchedCurrentValueUsd|recent_pool_token_inflow_current_value/,
  "no field from the retired inflow-matching contract is read");
assert.match(calloutsDashboard, /coverage\.succeeded/);
assert.match(calloutsDashboard, /purchase consideration proven/);
assert.match(calloutsDashboard, /it is not a claim that they bought this coin/,
  "the tab says what the number is, and what it is not");
assert.match(calloutsDashboard, /coinsWithCallouts/,
  "an empty result distinguishes 'no callouts anywhere' from 'none cleared the bar'");
assert.doesNotMatch(calloutsDashboard, /recent_large_onchain_buy|buy receipt|matched buys/,
  "a wallet balance is never mislabeled as a purchase");

assert.match(html, /\/executor\/status/);
assert.match(html, /Owner-only local activation · five deliberate steps/);
assert.match(html, /__CLAUDE_COMPANY_SOURCE_COMMIT__/);
assert.match(html, /Fund the burner last/);
assert.match(html, /cannot start, stop, steer, sign for, or fund it/);
assert.match(html, /Active local cap policy · self-reported/);
assert.match(html, /rolling realized-loss entry brake/);
assert.match(html, /The realized-loss value is an entry brake, not a guaranteed loss ceiling/);
assert.match(html, /--daily-loss-cap 0\.01/);
assert.match(html, /--max-sol 0\.05 --daily-cap 0\.5 --daily-loss-cap 0\.15/);
assert.match(html, /fresh v2 wallet-and-values acknowledgement/);
assert.match(html, /const dashEth = \(value\) =>[\s\S]*?toFixed\(9\)/,
  "sub-milli-ETH caps and readiness probes retain enough precision to never render as zero");
assert.doesNotMatch(html, /Active trade cap[\s\S]{0,160}toFixed\(3\)|amountWei[\s\S]{0,180}toFixed\(3\)/,
  "active cap and readiness sizing do not use lossy three-decimal ETH formatting");
assert.doesNotMatch(html, /First live release · hard ceilings|status\.releaseCaps|24h loss[^\n]*hard stop/,
  "the dashboard must not present defaults or a realized-loss brake as guaranteed hard loss ceilings");
assert.match(html, /function legacyBurnerRecoveryCard\(\)/);
/* The WALL-ST-E view reads the dashboard payload under its ETH names (executor-dashboard.js);
   a leftover Solana field read renders "—" for a live value, silently. */
for (const stale of ["maxSolPerTrade", "rolling24hDeploySol", "rolling24hRealizedLossBrakeSol",
  "balanceSol", "requiredForReadinessSol", "amountLamports", "dashSol("]) {
  assert.ok(!html.includes(stale), `office3d still reads the Solana dashboard field ${stale}`);
}
for (const live of ["activeCaps.maxEthPerTrade", "wallet.balanceEth", "wallet.requiredForReadinessEth",
  "readiness.amountWei", "caps.rolling24hDeployEth", "defaults.rolling24hRealizedLossBrakeEth"]) {
  assert.ok(html.includes(live), `office3d does not read the dashboard field ${live}`);
}
assert.match(html, /Copy the legacy burner's secret key/);
assert.match(html, /wallsteFiltersDirty/);
assert.match(html, /!wallstePanel\?\.hidden[\s\S]*?loadWallsteDashboard\(\{ background: true \}\)/,
  "an open WALL-ST-E destination refreshes without overwriting active filter edits");
assert.match(html, /background && \(wallsteFiltersDirty \|\| editingAfterFetch\)/,
  "an in-flight background status refresh yields if editing begins before its response arrives");
assert.match(html, /background && \(wallsteFiltersDirty \|\| editingAfterFetch\)[\s\S]*?dashReady\(el\);[\s\S]*?return;/,
  "a yielded background refresh clears aria-busy before returning");
assert.match(html, /callsOpen && dashboardSubview\.calls === "candidates"[\s\S]*?loadCandidateBoard\(\)/,
  "the open pre-decision candidate board refreshes across new desk cycles");
assert.match(html, /dashMetric\("Settled P&L", feedPrivate \? "PRIVATE"/,
  "private floor performance is not converted into a false zero");
/* OWNER DECISION (2026-09-02): the rail must not cover half the screen. The 700px,
 * 85%-tall fixed frame measured 55% x 81% of a 1280x720 viewport and force-opened at
 * boot, mostly to show a headline and one sentence. The invariant is now bounded and
 * content-sized: no wider than 480px, height follows content under a viewport cap,
 * and nothing opens it by itself. A pixel value is not the property worth pinning;
 * these three are. */
{
  const railWidth = html.match(/\.rail\{[\s\S]*?width:min\((\d+)px, calc\(100% - 28px\)\)/);
  assert.ok(railWidth && Number(railWidth[1]) <= 480,
    `the desktop rail stays a compact side panel (<=480px), got ${railWidth?.[1] ?? "none"}`);
  assert.match(html, /\.rail\{[\s\S]*?height:auto;[\s\S]*?max-height:min\((\d+)vh, calc\(100% - 82px\)\)/,
    "the rail sizes to its content and caps below the viewport, scrolling inside");
  const railCap = Number(html.match(/\.rail\{[\s\S]*?max-height:min\((\d+)vh/)?.[1]);
  assert.ok(railCap <= 75, `the rail's height cap stays under 75vh, got ${railCap}`);
  assert.doesNotMatch(html, /queueMicrotask\(\(\) => window\.showDashboard\?\.\("overview", \{ force: true \}\)\)/,
    "nothing force-opens the rail at boot; the dock is the resting state");
}
/* ── OWNER DECISION (2026-09-06): ALERTS DO NOT COVER THE ROOM ────────────────
 * Unacked exits stacked as full-width banners from the top of the stage down —
 * five of them measured 34.2% of a 1280x720 viewport and hid the back wall, the
 * run board and half the desks. They are a tab now, and these are the three
 * properties that make that true rather than the pixel values around them. */
{
  assert.match(html, /\.alertbar\.open\{display:flex\}/,
    "the stack draws only when the tab is open");
  assert.doesNotMatch(html, /\.alertbar\.on\{display:flex\}/,
    "...and never merely because alerts exist");
  assert.match(html, /\.alertbar\{[^}]*left:14px;right:auto/,
    "it hangs off the left edge instead of spanning the room");
  const navBlock = html.slice(html.indexOf('id="alert-nav"'), html.indexOf('id="primary-nav"'));
  assert.doesNotMatch(navBlock, /data-destination|role="tab"/,
    "the alert tab is a disclosure button and must never join the eight-destination tablist");
  assert.match(navBlock, /class="dtab"/, "...while being the same object visually");
  assert.match(html, /\.dtab\[aria-selected="true"\],\.dtab\[aria-expanded="true"\]\{/,
    "an opened alert tab is highlighted the way a selected destination is");
  assert.doesNotMatch(html, /\.dtab \.cnt\{/,
    "no count chip in the line box: it made this tab 3px taller than every tab beside it");
}

assert.match(html, /@media \(max-width:760px\)[\s\S]*?\.dock\{left:8px; right:8px; top:auto; bottom:8px/,
  "mobile navigation becomes a reachable bottom dock");
assert.ok(
  html.lastIndexOf("@media (max-width:760px)") > html.indexOf(".dock{\n  position:absolute"),
  "the mobile dock override must follow the desktop dock rule so top:auto wins the cascade",
);
assert.match(html, /\.pulse\{display:flex; left:8px; right:8px; bottom:62px/,
  "the mobile live pulse sits above the bottom tab dock instead of underneath it");
assert.match(html, /\.dossier\{[\s\S]*?z-index:12/,
  "call dossiers opened from the dashboard remain above the rail and dock");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
assert.deepEqual(duplicates, [], "dashboard markup has no duplicate IDs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-company-dashboard-"));
try {
  const modules = [...html.matchAll(/<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(modules.length, 3, "the floor keeps its three deliberate module scopes");
  for (const [index, match] of modules.entries()) {
    const file = path.join(temporary, `module-${index + 1}.mjs`);
    fs.writeFileSync(file, match[1]);
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr || `dashboard module ${index + 1} did not parse`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

/* ── WHAT A TENANT IS TOLD ABOUT THE DESK ───────────────────────────────────
 * The heartbeat's own vocabulary — RUNNING / PAUSED / BLOCKED / DEGRADED — and its
 * reasons name the house's API keys, its daily budget, its provider balance and its
 * build failures. None of that is a tenant's business, and none of it is something a
 * tenant could act on; it reads as instability. The desk says only whether it is
 * working, and the HQ floor gets the rest. The redaction is at the source: the reason
 * is not sent, not merely unrendered. */
{
  const office = fs.readFileSync(new URL("./src/office.js", import.meta.url), "utf8");
  assert.match(office, /const hqViewer = Boolean\(me && holdsFloor\(tower\.HQ_FLOOR\)\)/,
    "the heartbeat decides detail by HQ ownership");
  assert.match(office, /state: hqViewer \? state : publicState/, "a tenant is sent the collapsed state");
  assert.match(office, /reason: hqViewer \? reason : null/, "a tenant is sent no reason at all");
  for (const [field, re] of [
    ["houseDeliveries", /houseDeliveries: !hqViewer \? \[\]/],
    ["providerCredit", /providerCredit: hqViewer \? \{/],
    ["seatFailures6h", /seatFailures6h: !hqViewer \? \[\]/],
  ]) assert.match(office, re, `${field} is withheld from tenants`);

  const view = fs.readFileSync(new URL("./viewer/office3d.html", import.meta.url), "utf8");
  assert.match(view, /body\.state === "RUNNING" \|\| body\.state === "ACTIVE"/,
    "the pulse pill treats ACTIVE as running");
  assert.ok(!/pulse\.state !== "RUNNING"\) \? String\(pulse\.reason\)/.test(view),
    "the Overview metric no longer manufactures an explanation");

  /* A pane's title is optional now: the tab that opened it is highlighted, so a heading
     repeating it is chrome. Titles that carry an error or a permission wall stay. */
  assert.match(view, /if \(title\) words\.appendChild\(dashNode\("h3", "", title\)\)/,
    "dashLead may render no title");
  for (const restated of ['dashLead("Published calls",', 'dashLead("Verified Pump.fun whales",',
    'dashLead("Settings", "Open a floor'])
    assert.ok(!view.includes(restated), `a pane no longer restates its tab: ${restated}`);
  for (const kept of ['"Settings are owner-only"', '"WALL-ST-E is owner-only"', '"Callouts unavailable"'])
    assert.ok(view.includes(kept), `a title that says something the tab does not is kept: ${kept}`);
}

/* ── GROX MULDER'S BOARD SHOWS WHAT THE FLOOR HOLDS ────────────────────────────
 * It used to draw every call OFFERED to the floor, which is the team's paper book — a
 * wall of positions nobody owns. A call reaches his board only once the bot took it, and
 * the two price columns are market caps, because a memecoin price is a string of zeros
 * that tells a reader nothing while the cap is the number people trade on
 * (owner, 2026-09-03). */
{
  const view = html;
  assert.match(view, /const held = open\.filter\(\(c\) => c\.taken === true\)/,
    "only taken positions reach the board");
  assert.match(view, /grokBook\.positions = held\.map/,
    "...and the board is built from those, not from every offer");
  assert.match(view, /x\.fillText\("ENTRY MC"/, "the entry column is a market cap");
  assert.match(view, /x\.fillText\("TARGET MC"/, "the second column is the target, not the mark");
  assert.ok(!/x\.fillText\("MARK", \d+, 100\)/.test(view), "the MARK column is gone");
  assert.match(view, /entryCap: capAtCall, targetCap: capOf\(target\)/,
    "both columns carry caps derived from the call's own cap at entry");
  assert.match(view, /capAtCall \* \(px \/ entry\)/,
    "a target cap is the entry cap scaled by the price ratio — supply is constant");
  assert.match(view, /const fmtCap = /, "caps are formatted as $9.3K / $412K / $5.1M");
  assert.ok(!/p\.mark != null \? fmtPx\(p\.mark\)/.test(view),
    "the board no longer prints a decimal mark");
  // P&L still needs the live mark, which is why it is still carried on the row.
  assert.match(view, /pnlPct: \(entry && mark\) \? \(\(mark - entry\) \/ entry\) \* 100 : null/,
    "P&L is still computed from the live mark");
}

/* ── THE BOT'S BALANCE IS ON HIS WALL ──────────────────────────────────────────
 * The board showed positions without ever showing the money behind them: the balance
 * was fetched by the funding panel and kept there. One owner now holds it, both surfaces
 * read it, and the states a person needs to tell apart stay apart — empty is not the
 * same as unreadable, and a stale read says so. */
{
  const view = html;
  assert.match(view, /async function refreshBotBalance/, "one owner for the live balance");
  assert.match(view, /method: "getBalance", params: \[wallet\]/,
    "read through the existing read-only relay, not a new signing path");
  assert.match(view, /setInterval\(\(\) => \{ refreshBotBalance\(\)/,
    "it refreshes on its own rather than only when a panel is open");
  assert.match(view, /Date\.now\(\) - botBalanceAt < 20_000/, "and is throttled");
  assert.match(view, /Number\.isFinite\(Number\(lamports\)\)\n?\s*\? \{ wallet, sol: Number\(lamports\) \/ 1e9/,
    "a readable balance is a number");
  assert.match(view, /: \{ wallet, sol: null, at: Date\.now\(\), ok: false \}/,
    "an unreadable one is null, never zero — those are different things to tell someone about their money");
  assert.match(view, /x\.fillText\(text, W - 26, 38\)/, "the header carries it beside his title");
  assert.match(view, /\["BOT WALLET"/, "and the flat-book panel carries it as a row");
  assert.match(view, /"WALLET UNREADABLE"/, "unreadable is said out loud");
  assert.match(view, /cannot trade/, "an empty wallet says what that means");
  assert.match(view, /Date\.now\(\) - bb\.at > 90_000/, "a stale read is labelled stale");
}

console.log("dashboard HUD, candidate separation, WALL-ST-E boundary, and Callouts contract pass");
