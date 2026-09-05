import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

const n = (x, d = 2) => (x == null ? "—" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d }));

/** SCRIBE — writes the trade down so the desk can be graded later. */
export function writeReport(cycle, r) {
  const dir = path.join(ROOT, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cycle}__${r.symbol || "unknown"}__${r.finalDecision || r.outcome}.md`);
  const ev = r.ev || {};
  const L = [];

  L.push(`# ${r.symbol} — ${r.finalDecision || r.outcome}`);
  L.push(`\n\`${r.mint}\``);
  L.push(`\n> **This is research, not an order.** Nothing here has been executed. No key was held.\n`);

  if (r.pm) {
    L.push(`## Decision\n`);
    L.push(`| | |`);
    L.push(`|---|---|`);
    L.push(`| Decision | **${r.finalDecision}** |`);
    L.push(`| Conviction | ${n(r.pm.conviction, 0)} / 100 |`);
    L.push(`| Analyst composite | ${n(r.weighted, 1)} / 100 |`);
    L.push(`| Red team | ${r.redteam?.verdict} |`);
    L.push(`| Size | $${n(r.risk?.position_size_usd)} |`);
    L.push(`| Max loss | $${n(r.risk?.max_loss_usd)} (${n(r.risk?.pct_of_equity_at_risk)}% of book) |`);
    L.push(`| Horizon | ${r.pm.time_horizon} |`);
    L.push(`\n**Thesis.** ${r.pm.thesis}`);
    L.push(`\n**Invalidation.** ${r.pm.invalidation}`);
    L.push(`\n**How the red team was answered.** ${r.pm.how_red_team_was_answered}`);
    if (r.pm.key_disagreement) L.push(`\n**Where the desk disagreed.** ${r.pm.key_disagreement}`);
    if (r.pm.watch_triggers?.length) L.push(`\n**Promote to a proposal if:**\n${r.pm.watch_triggers.map((t) => `- ${t}`).join("\n")}`);
  }

  L.push(`\n## Market\n`);
  L.push(`| Metric | Value |`);
  L.push(`|---|---|`);
  L.push(`| Price | $${ev.pair?.priceUsd ?? "—"} |`);
  L.push(`| Liquidity (all ${ev.pairs?.count ?? "?"} venues) | $${n(ev.pairs?.totalLiquidityUsd)} |`);
  L.push(`| FDV | $${n(ev.pair?.fdv, 0)} |`);
  L.push(`| 24h volume | $${n(ev.pair?.volume?.h24, 0)} |`);
  L.push(`| 24h txns | ${n(ev.derived?.txns24h, 0)} |`);
  L.push(`| Avg trade size | $${n(ev.derived?.avgTradeSizeUsd)} |`);
  L.push(`| Pair age | ${n(ev.pair?.ageHours, 1)} h |`);
  L.push(`| Round-trip cost @ $${ev.exitProbe?.targetSizeUsd} | ${ev.exitProbe?.roundTripLossPct != null ? ev.exitProbe.roundTripLossPct + "%" : "unmeasured — " + (ev.exitProbe?.error ?? "")} |`);
  /* The chain facts, per docs/EVIDENCE-CONTRACT.md `contract.*`. Gas is a FLAT toll on
     this chain, so it is reported in dollars beside the proportional round trip, never
     folded into it. "unread" is printed where the bundle carries no field — an absent
     fact is not a clean one. */
  const c = ev.contract ?? {};
  const unread = (v, f = (x) => x) => (v == null ? "unread" : f(v));
  L.push(`| Gas, round trip | ${unread(ev.exitProbe?.gasUsdRoundTrip, (g) => `$${Number(g).toFixed(2)} (flat)`)} |`);
  L.push(`| ETH/USD | ${unread(ev.ethUsd?.value, (p) => `$${Number(p).toFixed(2)}${ev.ethUsd?.stalenessSec != null ? ` · ${ev.ethUsd.stalenessSec}s old` : ""}`)} |`);
  L.push(`| Launch | ${unread(ev.launch?.phase)}${ev.launchpad?.venue ? ` · ${ev.launchpad.venue}` : ""}${ev.launch?.curveProgressPct != null ? ` · curve ${ev.launch.curveProgressPct}%` : ""} |`);
  L.push(`| Contract | ${unread(c.proxyKind)}${c.isProxy ? ` · impl ${c.implementation ?? "?"} · upgraded ${c.upgradeCount ?? "?"}x` : ""} |`);
  L.push(`| Ownership renounced | ${unread(c.ownershipRenounced, (b) => (b ? "yes" : "NO"))} |`);
  L.push(`| Privileged roles | ${Array.isArray(c.privilegedRoles) ? (c.privilegedRoles.length ? c.privilegedRoles.map((r) => `${r.role}→${r.holder}`).join(", ") : "none") : "unread"} |`);
  L.push(`| Flags | ${Array.isArray(c.flags) ? (c.flags.length ? c.flags.map((f) => f.flag ?? f).join(", ") : "none") : "unread"} |`);
  L.push(`| Verified source | ${unread(c.verifiedSource, (b) => (b ? "yes" : "no — roles UNVERIFIED"))} |`);
  L.push(`| Sell simulation | ${ev.sellSim ? (ev.sellSim.ok ? `ok · effective tax ${ev.sellSim.effectiveTaxBps ?? "?"} bps` : `REVERTED · ${ev.sellSim.revertReason ?? "?"}`) : "unread"} |`);

  if (r.outcome === "killed") {
    L.push(`\n## Killed by ${r.killedBy}\n`);
    L.push(`${r.reason}`);
  }

  if (r.outcome === "screened_out") {
    L.push(`\n## Screened out\n`);
    for (const f of r.fails) L.push(`- **${f.code}** — ${f.detail}`);
  }

  if (r.analysts) {
    L.push(`\n## The analyst book\n`);
    for (const [k, a] of Object.entries(r.analysts)) {
      L.push(`### ${k} — ${n(a.score, 0)}/100 (confidence ${n(a.confidence, 2)})`);
      L.push(`${a.headline}\n`);
      if (a.findings?.length) {
        L.push(`| Claim | Value | Source |`);
        L.push(`|---|---|---|`);
        for (const f of a.findings) L.push(`| ${f.claim} | ${f.value} | \`${f.source}\` |`);
      }
      if (a.risks?.length) L.push(`\n_Risks:_ ${a.risks.join("; ")}`);
      if (a.missing_data?.length) L.push(`\n_Missing data:_ ${a.missing_data.join("; ")}`);
      L.push("");
    }
  }

  if (r.redteam) {
    L.push(`\n## Red team — ${r.redteam.verdict}\n`);
    L.push(`${r.redteam.bear_case}\n`);
    if (r.redteam.attacks?.length) {
      L.push(`| Severity | Target | Attack |`);
      L.push(`|---|---|---|`);
      for (const a of r.redteam.attacks) L.push(`| ${a.severity} | ${a.target} | ${a.attack} |`);
    }
    if (r.redteam.unfalsifiable_claims?.length)
      L.push(`\n**Claims that cannot be checked (weight them at zero):**\n${r.redteam.unfalsifiable_claims.map((c) => `- ${c}`).join("\n")}`);
    L.push(`\n**What would change its mind.** ${r.redteam.what_would_change_my_mind}`);
  }

  if (r.ticket) {
    L.push(`\n## Unsigned ticket\n`);
    L.push(`> Placed by a human, or not at all.\n`);
    L.push(`| Field | Value |`);
    L.push(`|---|---|`);
    L.push(`| Action | ${r.ticket.action} |`);
    L.push(`| Entry | $${r.ticket.entry_zone_low} – $${r.ticket.entry_zone_high} (${r.ticket.entry_style}) |`);
    L.push(`| Max slippage | ${r.ticket.max_slippage_bps} bps |`);
    L.push(`| Route | ${r.ticket.suggested_route} |`);
    L.push(`| Stop | $${r.ticket.stop_price} |`);
    if (r.ticket.slices?.length) {
      L.push(`\n**Scale-in**\n`);
      L.push(`| % of position | Trigger |`);
      L.push(`|---|---|`);
      for (const s of r.ticket.slices) L.push(`| ${s.pct_of_position}% | ${s.trigger} |`);
    }
    if (r.ticket.take_profit?.length) {
      L.push(`\n**Take profit**\n`);
      L.push(`| Price | Sell | Why |`);
      L.push(`|---|---|---|`);
      for (const t of r.ticket.take_profit) L.push(`| $${t.price} | ${t.pct_to_sell}% | ${t.rationale} |`);
    }
    if (r.ticket.execution_warnings?.length)
      L.push(`\n**Warnings**\n${r.ticket.execution_warnings.map((x) => `- ${x}`).join("\n")}`);
  }

  if (r.compliance && (!r.compliance.pass || r.compliance.warnings?.length)) {
    L.push(`\n## Compliance\n`);
    for (const v of r.compliance.violations || []) L.push(`- **VETO — ${v.code}** — ${v.detail}`);
    for (const w of r.compliance.warnings || []) L.push(`- _warning — ${w.code}_ — ${w.detail}`);
  }

  L.push(`\n---\n_Generated by Claude Company ${new Date().toISOString()}. Research only._`);

  fs.writeFileSync(file, L.join("\n"));
  return path.relative(ROOT, file);
}
