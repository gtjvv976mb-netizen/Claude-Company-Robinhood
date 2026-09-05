import { cfg, floorsFor } from "../config.js";
import { RED_TEAM_FACT_CODES } from "./schemas.js";
import { EVM_GATES, contractFlagNames } from "./risk-rails.js";

/* Every code the schema admits except "other", which is prose by definition. */
const FACT_CODES = new Set(RED_TEAM_FACT_CODES.filter((c) => c !== "other"));

/* A LAUNCH FARM ON THIS CHAIN IS A VOLUME, NOT A RATIO. The Solana rule was eight
   launches and zero graduations; here 1.55% of PONS launches graduate (Bitquery,
   2026-08-03..09-03), so eight-and-none is the BASE RATE — 0.9845^8 = 88% of honest
   eight-time launchers show it. What separates a farm is how many it has launched. */
const FARM_LAUNCHES = 20;
/* A share of the pool's recent swaps landing with status 0x0 and no logs (ArbOS 61
   compliance voids) above which the chain is refusing this token's sells. PROVISIONAL —
   no measured drop rate exists for 4663 yet; the number is a placeholder to be replaced
   by a measurement, and it is deliberately not zero because a single voided tx is noise. */
const SEQUENCER_VOID_PCT = 5;

const atPath = (obj, path) => String(path || "").split(".").filter(Boolean)
  .reduce((v, key) => v == null ? undefined : v[key], obj);

const flagNames = (evidence) => (evidence?.mintAccount?.flags || [])
  .map((f) => String(f?.flag ?? f));

function retainedCitation(evidence, sourceUrl) {
  if (!sourceUrl) return false;
  let wanted;
  try { wanted = new URL(sourceUrl); if (wanted.protocol !== "https:") return false; }
  catch { return false; }
  return (evidence?.xRead?.citations || []).some((c) => {
    const raw = typeof c === "string" ? c : c?.url;
    try {
      const got = new URL(raw);
      return got.origin === wanted.origin && got.pathname.replace(/\/$/, "") === wanted.pathname.replace(/\/$/, "");
    } catch { return false; }
  });
}

function observedMatches(actual, claimed) {
  if (actual == null) return false;
  if (typeof actual === "number") {
    const parsed = Number(String(claimed).replace(/[$,%\s]/g, "").replace(/,/g, ""));
    return Number.isFinite(parsed) && Math.abs(parsed - actual) <= Math.max(1e-9, Math.abs(actual) * 0.01);
  }
  if (typeof actual === "boolean") return String(claimed).trim().toLowerCase() === String(actual);
  if (typeof actual === "string") return String(claimed).trim().toLowerCase() === actual.trim().toLowerCase();
  return true; // arrays/objects are checked by the fact-specific predicate below
}

/**
 * The bundle must AGREE with the attack before a refutation may stand. Each predicate
 * reads evidence-contract fields only (docs/EVIDENCE-CONTRACT.md); the EVM cases share
 * their thresholds with the Risk and Compliance gates through EVM_GATES so a fact the
 * red team may kill on is the same fact the rails zero on.
 */
function confirmedByBundle(code, evidence, path, actual, now = Date.now()) {
  const flags = flagNames(evidence);
  const cflags = contractFlagNames(evidence);
  const contract = evidence?.contract ?? {};
  const lp = evidence?.lp ?? {};
  const launch = evidence?.launch ?? {};
  const holdMax = Number(evidence?.hold?.holdMaxMs);
  switch (code) {
    case "live_authority":
      return Boolean(evidence?.mintAccount?.mintAuthority || evidence?.mintAccount?.freezeAuthority ||
        flags.some((f) => /mint_authority_live|freeze_authority_live|permanentDelegate|transferHook/i.test(f)) ||
        cflags.some((f) => EVM_GATES.killFlags.test(f)));
    case "exit_failure":
      return Boolean(evidence?.exitProbe?.error) ||
        Number(evidence?.exitProbe?.roundTripLossPct) > cfg.maxRoundTripSlippagePct ||
        evidence?.sellSim?.ok === false;
    case "holder_control":
      return Number(evidence?.holders?.top1Pct) > 50 || evidence?.holders?.bundleSuspect === true;
    case "wash_trading":
      return Number(evidence?.derived?.volToLiqRatio) > cfg.screen.maxVolToLiqRatio ||
        Number(evidence?.derived?.roundTripWalletPct) > 40 ||
        (evidence?.crosscheck?.verdicts || []).some((v) =>
          v?.verdict === "KILLED" && /volume|wash|trade/i.test(`${v?.check} ${v?.detail}`));
    case "deployer_misconduct":
      return (Number(evidence?.deployer?.priorLaunches) >= FARM_LAUNCHES && Number(evidence?.deployer?.graduated) === 0) ||
        evidence?.xRead?.serial_rugger === true;
    case "liquidity_collapse": {
      const mcap = evidence?.pair?.marketCap ?? evidence?.pair?.fdv ?? null;
      const liq = evidence?.pairs?.totalLiquidityUsd ?? evidence?.pair?.liquidityUsd;
      return Number.isFinite(Number(liq)) && Number(liq) < floorsFor(mcap).liq;
    }
    case "unlock_risk":
      return flags.some((f) => /mint_authority_live|transferFee|permanentDelegate|transferHook/i.test(f)) ||
        (evidence?.mintAccount?.extensions || []).some((x) => /transferFee|permanentDelegate|transferHook/i.test(String(x))) ||
        contract.feeSettable === true;
    /* ---- the chain's own rug vectors ---- */
    case "upgrade_key_live": {
      if (contract.isProxy !== true) return false;
      const kind = String(contract.proxyAdmin?.kind ?? "unknown");
      if (kind === "eoa" || kind === "unknown") return true;
      if (kind === "timelock") {
        const delayMs = Number(contract.proxyAdmin?.delaySec) * 1000;
        return !Number.isFinite(delayMs) || (Number.isFinite(holdMax) && delayMs < holdMax);
      }
      return false; // a multisig is a judgement call, not a checkable kill
    }
    case "lp_unlocked": {
      if (Number(lp.pullableSharePct) > 20) return true;
      const unlockAt = Number(lp.unlockAt);
      return Number.isFinite(unlockAt) && unlockAt > 0 && Number.isFinite(holdMax) && unlockAt < now + holdMax;
    }
    case "pair_token_gate": {
      const cls = evidence?.pairs?.pools?.[0]?.pairTokenClass;
      return cls != null && !EVM_GATES.allowedPairTokenClasses.includes(String(cls));
    }
    case "unverified_code":
      return contract.verifiedSource === false && (contract.cloneOf == null || contract.cloneOf === "") &&
        evidence?.sellSim?.ok !== true;
    case "sequencer_exclusion":
      return evidence?.sellSim?.ok === false ||
        Number(evidence?.derived?.voidedTxPct) >= SEQUENCER_VOID_PCT;
    case "insider_float":
      return Number(launch.exemptShareOfSupplyPct) > EVM_GATES.maxInsiderFloatPct ||
        (Number(launch.creatorTaxBps) > 0 && Number(launch.creatorTaxBps) >= Number(launch.maxCreatorTaxBps) && Number(launch.exemptShareOfSupplyPct) > 0);
    default:
      return false;
  }
}

/** A fatal refutation must identify a retained, checkable fact—not merely a keyword. */
export function verifiedFatalAttacks(redteam, evidence, { now = Date.now() } = {}) {
  return (redteam?.attacks || []).filter((a) => {
    if (a?.severity !== "fatal" || a?.verification_status !== "verified") return false;
    if (!FACT_CODES.has(a?.fact_code)) return false;
    if (!String(a?.observed_value || "").trim() || !String(a?.threshold_or_comparison || "").trim()) return false;
    const path = String(a?.evidence_path || "").trim();
    const actual = path ? atPath(evidence, path) : undefined;
    const bundleFact = path && actual !== undefined && observedMatches(actual, a.observed_value) &&
      confirmedByBundle(a.fact_code, evidence, path, actual, now);
    const externalFact = retainedCitation(evidence, a?.source_url);
    // Social/identity claims are external by nature and require a retained citation.
    if (["fake_social_proof", "false_identity"].includes(a.fact_code)) return externalFact;
    // A citation may corroborate deployer misconduct, but deterministic chain/market
    // claims must match the retained evidence value and the coded threshold.
    return Boolean(bundleFact || (a.fact_code === "deployer_misconduct" && externalFact));
  });
}

export function applyRedTeamBar(redteam, evidence, opts = {}) {
  const out = { ...(redteam || {}), attacks: [...(redteam?.attacks || [])] };
  const fatal = verifiedFatalAttacks(out, evidence, opts);
  if (out.verdict === "refuted" && fatal.length === 0) {
    out.downgraded_from = "refuted";
    out.downgrade_reason =
      "refuted without a structured, verified fatal fact retained in the evidence record";
    out.verdict = "wounded";
  }
  return { redteam: out, verifiedFatal: fatal };
}
