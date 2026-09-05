import { cfg } from "../config.js";

/* null/""/undefined are ABSENT, never 0: Number(null) is 0, and 0 read as "graduated at
   the epoch" or "0% insiders" passed both gates silently (review, 2026-09-05). */
const finite = (v) => (v == null || v === "" || typeof v === "boolean") ? null
  : (Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const envNum = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};

/**
 * THE DETERMINISTIC GATES THIS CHAIN NEEDS, read from the evidence contract only.
 *
 * Every one of these is a fact about how Robinhood Chain takes money, not an opinion,
 * so it is checked by code in three places — Risk's mechanical zero, Compliance's veto,
 * and the Red Team's confirmedByBundle — from ONE definition, so the three can never
 * disagree about what "graduated" or "an allowed pair" means.
 *
 *   phase        the token must have LEFT the bonding curve. On a curve there is no
 *                pool: the curve is the only exit, readyToGraduate() closes buys, and
 *                the desk's Kyber probe cannot even price it. Never "curve".
 *   age          minutes-to-hours AFTER PoolGraduated, never inside the launch's first
 *                5 s (PONS V2's 99%->0% snipe tax; block-0 is the exempt list's by
 *                construction). The floor below is PROVISIONAL: 10 minutes is a
 *                placeholder for a dead-zone measurement on 4663 that has not been made
 *                (Solana's was 73% of graduates below 0.4x inside 20 minutes).
 *   pair token   the quote asset must be one the bot can hold — native/WETH, a stable,
 *                or an equity on executor/scope-guard.mjs's allowlist. A meme quoted in an
 *                unlisted equity or an obscure ERC-20 cannot be exited at all.
 *   insider      the exempt list's share of supply. VLAD's early holders held ~70% and
 *                left with 650-690 ETH behind locked liquidity; the ceiling below is a
 *                PROVISIONAL 20% awaiting a measured distribution of exempt shares.
 *   code         the bytecode must be a recognised PONS clone (contract.cloneOf) OR the
 *                sell must simulate (sellSim.ok). Bespoke, unverified code that has not
 *                been shown to sell is the "vanishing token" shape.
 *   flags        contract.flags the screen already kills on; re-read here so Risk zeroes
 *                the size even if a flag arrives after the screen ran.
 *
 * Fields are read ONLY from docs/EVIDENCE-CONTRACT.md paths. A field that is ABSENT is
 * reported in `unverified` rather than failed: the free screen (evidence.js) is the
 * fail-closed gate on unreadable facts, and these rails re-check what it produced.
 */
/* The environment may only TIGHTEN a safety gate. A DESK_MIN_GRADUATION_AGE_SEC of 0 or a
   DESK_MAX_INSIDER_FLOAT_PCT of 100 would remove the only post-graduation age gate and the
   insider ceiling from a config line nobody reviews; the shipped numbers are the loosest
   this code will run (review, 2026-09-05). Both remain PROVISIONAL pending a 4663 measurement. */
const GRADUATION_AGE_FLOOR_SEC = 600;
const INSIDER_FLOAT_CEILING_PCT = 20;
export const EVM_GATES = Object.freeze({
  minGraduationAgeSec: Math.max(GRADUATION_AGE_FLOOR_SEC, envNum("DESK_MIN_GRADUATION_AGE_SEC", GRADUATION_AGE_FLOOR_SEC)),
  maxInsiderFloatPct: Math.min(INSIDER_FLOAT_CEILING_PCT, envNum("DESK_MAX_INSIDER_FLOAT_PCT", INSIDER_FLOAT_CEILING_PCT)),
  allowedPairTokenClasses: Object.freeze(["native", "weth", "stable", "allowed_equity"]),
  /* live_authority is about ROLES a key still holds — mint, pause, blacklist, upgrade,
     freeze. equity_token, unknown_beacon, paused_now and transfer_blocked are killed by
     the screen under their own codes (evidence.js) and are deliberately NOT repeated
     here: one fact, one code. `pausable` matches the producer's "pausable" and
     "pausable_live" (src/data/evm.js, evidence.js). */
  killFlags: /mint_role_live|pausable|blacklist|upgradeable_eoa|fee_over_ceiling|honeypot|freeze/i,
});

/** contract.flags as names, tolerating both {flag, detail} rows and bare strings. */
export const contractFlagNames = (ev) => (ev?.contract?.flags || []).map((f) => String(f?.flag ?? f));

/**
 * Run the EVM gates against a bundle. Returns { fails: [{code, detail}], unverified: [path] }.
 * Pure and exported so the three callers and the tests read one truth.
 */
export function evmGateFailures(ev, { now = Date.now(), gates = EVM_GATES } = {}) {
  const fails = [];
  const unverified = [];
  const fail = (code, detail) => fails.push({ code, detail });

  const launch = ev?.launch;
  if (!launch || launch.phase == null) unverified.push("launch.phase");
  else if (launch.phase !== "graduated")
    fail("not_graduated", `launch.phase is "${launch.phase}" — the desk trades graduated pools only, never the curve`);

  if (launch?.phase === "graduated") {
    const gradAt = finite(launch.graduatedAt);
    if (gradAt == null) unverified.push("launch.graduatedAt");
    else {
      const ageSec = (now - gradAt) / 1000;
      if (ageSec < gates.minGraduationAgeSec)
        fail("graduated_too_recently", `pool graduated ${ageSec.toFixed(0)}s ago; the floor is ${gates.minGraduationAgeSec}s`);
    }
  }

  const pools = ev?.pairs?.pools;
  if (!Array.isArray(pools) || !pools.length) unverified.push("pairs.pools[].pairTokenClass");
  else {
    const cls = pools[0]?.pairTokenClass;
    if (cls == null) unverified.push("pairs.pools[].pairTokenClass");
    else if (!gates.allowedPairTokenClasses.includes(String(cls)))
      fail("pair_token_gate", `deepest pool is quoted in ${pools[0]?.pairToken ?? "an unknown asset"} (${cls}) — ` +
        `the bot may hold only ${gates.allowedPairTokenClasses.join("/")} as a pair asset`);
  }

  if (launch && launch.exemptShareOfSupplyPct !== undefined) {
    const share = finite(launch.exemptShareOfSupplyPct);
    if (share == null) unverified.push("launch.exemptShareOfSupplyPct");
    else if (share > gates.maxInsiderFloatPct)
      fail("insider_float", `the launch's exempt wallets hold ${share}% of supply, above the ${gates.maxInsiderFloatPct}% ceiling — the desk would be their exit liquidity`);
  } else unverified.push("launch.exemptShareOfSupplyPct");

  const contract = ev?.contract;
  if (!contract) unverified.push("contract.cloneOf");
  else {
    const known = contract.cloneOf != null && contract.cloneOf !== "";
    const sellOk = ev?.sellSim?.ok === true;
    if (!known && ev?.sellSim == null) unverified.push("sellSim.ok");
    else if (!known && !sellOk && contract.verifiedSource !== true)
      fail("unverified_code", `bytecode is not a recognised PONS clone (contract.cloneOf null), source is not verified, ` +
        `and the sell did not simulate (sellSim.ok ${String(ev?.sellSim?.ok)}${ev?.sellSim?.revertReason ? `: ${ev.sellSim.revertReason}` : ""})`);
    const live = contractFlagNames(ev).filter((f) => gates.killFlags.test(f));
    if (live.length) fail("live_authority", `contract.flags carries ${live.join(", ")}`);
  }

  return { fails, unverified };
}

/**
 * THE STOP DISTANCE THIS COIN MUST CLEAR, reproducing the executor's own guard so the
 * Risk seat is told the number compliance will actually check it against.
 *
 * Ported from MAIN's stopFloorForCoin (decision.js there) and given the term this chain
 * adds: gas. The pool's round trip is proportional; the two swaps of gas are a FIXED
 * toll — measured $0.54 a round trip on 2026-09-04 (executor/live-thresholds.mjs), which
 * is 4.31% of a 0.005 ETH clip and 0.04% of a 0.5 ETH one — so the floor depends on the
 * size the position is actually given, and a conviction-shrunk position needs a WIDER
 * stop, not a narrower one. `positionUsd` defaults to the probe size; compliance passes
 * the size Risk authorised.
 *
 * The executor mirrors (slippage bps, fee share of stop) are read from cfg when the
 * config carries them and fall back to the Solana desk's 300 bps / 0.25 otherwise — the
 * fork's config does not define them yet (see docs/HANDOFF-agents.md). Falls back to
 * the flat cfg.minStopDistancePct when the round trip was not measured.
 */
export function stopFloorDetail(ev, config = cfg, { positionUsd = null } = {}) {
  const flat = Number(config?.minStopDistancePct) || 0;
  const rtPct = Number(ev?.exitProbe?.roundTripLossPct);
  const sizeUsd = Number(positionUsd) > 0 ? Number(positionUsd) : (Number(config?.targetSizeUsd) || 0);
  const gasUsd = Math.max(0, finite(ev?.exitProbe?.gasUsdRoundTrip) ?? 0);
  const gasPct = sizeUsd > 0 ? (gasUsd / sizeUsd) * 100 : 0;
  const slippageBps = Number(config?.executorSlippageBps) || 300;
  const haircut = (1 - slippageBps / 10_000) ** 2;
  const share = Number(config?.executorMaxFeeShareOfStop) || 0.25;
  if (!Number.isFinite(rtPct)) {
    return { floorPct: flat, measured: false, rtPct: NaN, gasUsd, gasPct, sizeUsd,
      slippagePct: (1 - haircut) * 100, feePct: share * flat };
  }
  /* Fees are capped at a share of the stop, so the floor is the stop distance that
     satisfies  (1-rt)*haircut - share*stop > 1-stop  — solved directly below, with
     fees charged on the EFFECTIVE stop (d plus the round-trip friction), exactly as the
     executor sizes it:
       (1-rt)*h - share*(d + rt)  >  1 - d
       =>  d * (1 - share)  >  1 - (1-rt)*h + share*rt
       =>  d  >  (1 - (1-rt)*h + share*rt) / (1 - share)
     where rt is the pool's loss PLUS gas as a share of the position. The measurement
     replaces the flat fallback rather than being maxed against it. */
  const rt = Math.max(0, rtPct) / 100 + gasPct / 100;
  const reach = (1 - rt) * haircut;
  const floorPct = (((1 - reach) + share * rt) / (1 - share)) * 100;
  return { floorPct, measured: true, rtPct, gasUsd, gasPct, sizeUsd,
    slippagePct: (1 - haircut) * 100, feePct: share * (floorPct + rt * 100) };
}

/** The floor alone, in percent below entry. */
export function stopFloorForCoin(ev, config = cfg, opts = {}) {
  return stopFloorDetail(ev, config, opts).floorPct;
}

/** Retained book heat, reserving a full idea budget for pre-migration live calls. */
export function retainedBookRiskUsd(calls, config = cfg) {
  const legacyReserve = config.equityUsd * (config.maxRiskPct / 100);
  return (calls || []).reduce((sum, call) => sum +
    (call?.desk_risk_usd == null
      ? legacyReserve
      : Math.max(0, finite(call.desk_risk_usd) ?? 0)), 0);
}

/**
 * Convert the Risk seat's judgement into deterministic arithmetic.
 *
 * The model chooses the thesis invalidation and may recommend being smaller. Code
 * decides whether zero is mechanically required, derives loss-at-stop, and enforces
 * the exact size that was actually exit-probed. This prevents prose mistakes from
 * creating either an empty book or an oversized one.
 */
export function enforceRiskRails({ risk, ev, redteam, openRiskUsd = 0, config = cfg, now = Date.now() }) {
  const out = { ...(risk || {}) };
  const notes = [];
  const px = finite(ev?.pair?.priceUsd);
  const stop = finite(out.stop_price);
  const rt = finite(ev?.exitProbe?.roundTripLossPct);
  const rtCost = rt == null ? null : Math.max(0, rt);
  const maxRisk = config.equityUsd * (config.maxRiskPct / 100);

  /* The Solana-shaped authority read stays for any bundle that still carries a
     mintAccount; the EVM read is contract.flags and the gates above. On an EVM bundle
     mintAccount is absent, so before this the mechanical zero for a live authority
     could never fire — it read a field this chain does not have. */
  const authorityLive = Boolean(
    ev?.mintAccount?.mintAuthority || ev?.mintAccount?.freezeAuthority ||
    (ev?.mintAccount?.flags || []).some((f) =>
      /mint_authority_live|freeze_authority_live|permanent_delegate|transfer_hook/i.test(String(f)))
  );
  const exitFails = rt == null || rt > config.maxRoundTripSlippagePct || Boolean(ev?.exitProbe?.error);
  const evm = evmGateFailures(ev, { now });

  if (exitFails || authorityLive || evm.fails.length) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    out.liquidity_adjusted = true;
    if (exitFails) notes.push(`mechanical zero: exit probe was unavailable or exceeded ${config.maxRoundTripSlippagePct}%`);
    if (authorityLive) notes.push("mechanical zero: live token authority");
    for (const f of evm.fails) notes.push(`mechanical zero: ${f.code} — ${f.detail}`);
    return finish(out, notes);
  }

  if (!(px > 0) || !(stop > 0) || stop >= px) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    notes.push("mechanical zero: no valid stop below the current price");
    return finish(out, notes);
  }

  const stopFrac = (px - stop) / px;
  /* Include the measured round-trip cost in loss-at-stop — the pool's, and the gas.
     A stop is not filled at a frictionless midpoint, especially in the exact drawdown
     in which it matters, and on this chain the gas is a FIXED toll that does not shrink
     with the position: measured $0.54 a round trip, 4.31% of a 0.005 ETH clip and 0.04%
     of a 0.5 ETH one (executor/live-thresholds.mjs). It is added below once the size is
     known, because it is a share of THAT size. */
  const gasUsd = Math.max(0, finite(ev?.exitProbe?.gasUsdRoundTrip) ?? 0);
  const lossFracExGas = stopFrac + (rtCost / 100);
  const redMultiplier = redteam?.verdict === "refuted" ? 0.25
    : redteam?.verdict === "wounded" ? 0.5 : 1;
  const tierMultiplier = ({ minimal: 0.10, quarter: 0.25, half: 0.50, full: 1 })[out.risk_tier] ?? 0.10;
  const confidenceMultiplier = clamp(finite(out.confidence) ?? 0.5, 0.25, 1);
  const liquidityMultiplier = rtCost > 4 ? 0.5 : rtCost > 2 ? 0.75 : 1;
  const maxBookRisk = config.equityUsd * ((config.maxBookRiskPct ?? 4) / 100);
  const remainingBookRisk = Math.max(0, maxBookRisk - Math.max(0, finite(openRiskUsd) ?? 0));
  const riskBudget = Math.min(
    maxRisk * tierMultiplier * redMultiplier * confidenceMultiplier * liquidityMultiplier,
    remainingBookRisk,
  );
  if (!(riskBudget > 0)) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    notes.push(`book heat exhausted: $${Number(openRiskUsd).toFixed(2)} already at risk`);
    return finish(out, notes);
  }
  /* size * lossFracExGas + gasUsd = riskBudget  =>  size = (riskBudget - gasUsd) / lossFracExGas.
     A budget the gas alone would exhaust is a position that cannot be opened. */
  const arithmeticSize = (riskBudget - gasUsd) / lossFracExGas;
  if (!(arithmeticSize > 0)) {
    out.position_size_usd = 0;
    out.max_loss_usd = 0;
    out.pct_of_equity_at_risk = 0;
    notes.push(`mechanical zero: the $${gasUsd.toFixed(2)} round-trip gas exhausts a $${riskBudget.toFixed(2)} loss budget`);
    return finish(out, notes);
  }
  let size = arithmeticSize;

  // The desk measured a round trip at targetSizeUsd. It has no evidence that a larger
  // order can leave at the assumed stop, so targetSizeUsd is an absolute size ceiling.
  const sizeCeiling = Math.min(config.equityUsd, config.targetSizeUsd);
  if (size > sizeCeiling) {
    size = sizeCeiling;
    out.liquidity_adjusted = true;
    notes.push(`size capped to the $${sizeCeiling} exit-probe notional`);
  }
  if (liquidityMultiplier < 1) {
    out.liquidity_adjusted = true;
    notes.push(`risk reduced for measured ${rtCost}% round-trip cost`);
  }
  if (gasUsd > 0) notes.push(`$${gasUsd.toFixed(2)} of fixed round-trip gas counted in loss-at-stop`);
  if (evm.unverified.length) notes.push(`EVM gates unverified (absent from the bundle): ${evm.unverified.join(", ")}`);
  notes.push(`${out.risk_tier || "minimal"} tier converted to a $${riskBudget.toFixed(2)} cost-adjusted loss budget`);

  out.position_size_usd = Number(Math.max(0, size).toFixed(2));
  out.max_loss_usd = Number((out.position_size_usd * lossFracExGas + gasUsd).toFixed(2));
  out.pct_of_equity_at_risk = Number(((out.max_loss_usd / config.equityUsd) * 100).toFixed(4));
  return finish(out, notes);
}

/** CEO may cut Risk's number, never enlarge it or revive a zero-sized trade. */
export function enforceCeoRails({ ceo, risk }) {
  const out = { ...(ceo || {}) };
  const riskSize = Math.max(0, finite(risk?.position_size_usd) ?? 0);
  const asked = Math.max(0, finite(out.order_size_usd) ?? 0);
  const final = out.ruling === "DECLINE" ? 0 : Math.min(asked, riskSize);
  const emptyApproval = out.ruling === "APPROVE" && !(final > 0);
  if (emptyApproval) out.ruling = "HOLD";
  if (final !== asked) {
    const note = out.ruling === "DECLINE"
      ? "declines carry zero size"
      : `CEO size capped to Risk's $${riskSize} authorization`;
    out.size_change_reason = [out.size_change_reason, note].filter(Boolean).join("; ");
    out.rail_notes = [note];
  } else out.rail_notes = [];
  if (emptyApproval) {
    const note = "an approval with zero authorized size was converted to HOLD";
    out.size_change_reason = [out.size_change_reason, note].filter(Boolean).join("; ");
    out.rail_notes.push(note);
  }
  out.order_size_usd = Number(final.toFixed(2));
  return out;
}

function finish(out, notes) {
  out.rail_notes = notes;
  if (notes.length) {
    const prior = String(out.portfolio_notes || "").trim();
    out.portfolio_notes = [prior, `Deterministic rails: ${notes.join("; ")}.`]
      .filter(Boolean).join(" ");
  }
  return out;
}
