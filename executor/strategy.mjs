/**
 * THE RISK ENGINE — pure decision logic for the Claude Company executor.
 *
 * Deliberately free of network, wallet and clock: every input is passed in and
 * every output is a plain intent ({action, reason, ...}). That is what makes it
 * simulatable — simulate.mjs runs this exact code over tens of thousands of
 * synthetic price paths, so the numbers you see are produced by the same
 * function shared with the server and executor, not by a separate toy model.
 *
 * WHAT THIS BUYS YOU, and it is the whole point:
 *   The desk publishes an entry and, later, an exit. Between those two messages
 *   the naive bot is naked — if the desk's monitor is slow, or your box was
 *   asleep, or the token rugs in ninety seconds, nothing protects the position.
 *   This engine watches the mark every poll and acts on its own:
 *
 *     STOP        — cut at the desk's stop. Non-negotiable, checked every tick.
 *     BREAKEVEN   — at 1.35x the stop lifts to entry.
 *     TRAIL       — at 1.5x a 25% trail starts ratcheting behind the high.
 *     TARGET      — the authored target or the configured multiple closes in full;
 *                   policy v2 has no partial-exit state.
 *     DESK EXIT   — the desk's own exit always wins and sells everything: it
 *                   knows things the price alone does not (creator sold, LP
 *                   pulled, thesis dead).
 *
 *   Plus the two portfolio brakes that decide whether a bot survives a bad week:
 *     DAILY LOSS LIMIT and MAX CONCURRENT POSITIONS.
 *
 * None of this manufactures an edge — the edge is the quality of the desk's
 * calls. This engine exists so a real edge is not destroyed by one bad night,
 * and so a bad streak cannot compound into a blown account.
 */
import { POLICY_DEFAULTS, POLICY_VERSION, pricePolicy } from "./trade-policy.mjs";

export { POLICY_VERSION };

/* HOW THE BOT DECIDES WHETHER TO BUY A PUBLISHED CALL.
 *
 *   risk             every rail below decides; a bracket whose R_net is not positive at
 *                    the measured cost is refused ("costs eat the target").
 *   take-every-call  ported from the Solana desk (60d6920, 2026-09-13): every published
 *                    call is bought at the operator's fixed size and the EDGE rails —
 *                    R_net, the per-name risk cap, book heat — become advisory, logged as
 *                    WARN and never a refusal. The MONEY rails are unchanged in every
 *                    mode: a call with no stop, the rolling realized-loss brake, the open
 *                    position cap, the rolling deploy cap, the spendable balance and the
 *                    minimum viable size still refuse, and the executor's own round-trip
 *                    and impact ceilings are never advisory. Armed by ENTRY_MODE plus a
 *                    typed sentence naming the wallet and the size (poller.mjs). */
export const ENTRY_MODES = Object.freeze(["risk", "take-every-call"]);

/**
 * THE FEE FLOOR IS DERIVED, NEVER DIALED.
 *
 * Gas is FLAT on this chain, so two legs of it cost the same whatever the position is
 * worth — which makes the fee share of the RISKED DISTANCE the thing that decides whether
 * a bracket is worth opening at all. Solve it rather than pick it: the smallest clip at
 * which two fee legs stay under `maxFeeShareOfStop` of what the stop puts at risk is
 *
 *     2 * feeReserve  <=  share * stopFrac * clip        =>   clip >= 2*fee / (share*stopFrac)
 *
 * so the floor moves on its own when gas moves or the stop tightens, and nobody has to
 * remember to edit it. src/agents/risk-rails.js stopFloorDetail() solves the desk's
 * PUBLISHED stop floor from the same share, so the two halves cannot disagree.
 *
 * ── IT FEEDS A REFUSAL AND NOTHING ELSE ─────────────────────────────────────────────
 *
 * This deliberately does NOT go into `minSolPerTrade`, and the reason is the whole care
 * in this function. On the Solana desk the equivalent number has exactly one consumer,
 * because that fork deleted conviction sizing. This fork KEPT it, and minSolPerTrade has
 * a second job here: the conviction FLOOR (`want = Math.max(scaled, min(want, minSol))`).
 * Routing a live gas reading into that key routes it into a SIZE-UP path — a median
 * conviction call against a 14% stop would go 0.004 to 0.0058 ETH at 0.309 gwei and to
 * the full clip at 0.7 gwei, which is 2.9x more capital at risk BECAUSE THE NETWORK GOT
 * EXPENSIVE, with the reason string cheerfully reporting both. No rail may ever make a
 * position larger. Its own key, read in exactly two places, both refusals.
 *
 * ── TWO CLAMPS THAT ARE LOAD-BEARING ────────────────────────────────────────────────
 *
 * A zero fee reserve returns 0, never 1: poller.mjs sets networkFeeReserveSol to 0 when
 * EXECUTE is off, and a 1 would put the floor at the entry price on every paper position.
 * And a stop of 95% or wider throws rather than returning a vast floor — at that width
 * the arithmetic is no longer describing a trade, and a silent refusal of everything is
 * the failure this repo keeps re-learning.
 */
export function feeFloorFor({ feeReserveSol, effectiveStopFrac, maxFeeShareOfStop }) {
  const fee = Number(feeReserveSol), share = Number(maxFeeShareOfStop);
  if (!(fee > 0) || !(share > 0)) return 0;
  const stop = Number(effectiveStopFrac);
  if (!(stop > 0) || stop >= 0.95)
    throw new Error(`fee floor needs a stop distance in (0, 0.95), got ${effectiveStopFrac}`);
  return (2 * fee) / (share * stop);
}

export const DEFAULTS = {
  entryMode: "risk",
  /* Solved per call by feeFloorFor() and passed in; 0 means "not supplied", never
     "no floor is needed". It is its OWN key because minSolPerTrade also floors
     conviction sizing, and a gas reading must never reach a size-up path. */
  feeFloorSolPerTrade: 0,
  maxSolPerTrade: 0.05,      // hard ceiling; Kelly may size well under it
  dailySolCap: 0.5,          // total SOL deployed per rolling day
  dailyLossLimitSol: 0.15,   // realized losses that stop new entries for the day
  maxOpenPositions: 4,

  /* ── SIZING: risk-at-stop, not notional ──────────────────────────────────
     Adopted from the GROKSTREET operating thesis. f is the fraction of equity
     lost IF THE STOP HITS — never the amount deployed. Every rail here exists
     because raw Kelly on a short sample is a drawdown machine: at a 77% claimed
     hit rate and R=1.25, full Kelly wants 59% of equity on one stop.

       R_net = (target - costs) / (stop + costs)
       W_min = 1 / (1 + R_net)          — below this, the trade is -EV, skip it
       f*    = W - (1 - W) / R_net
       f     = clip(kappa * f*, 0, fNameMax), or fDefault while n < nMin  */
  costPct: 0.06,             // round-trip: slippage both ways, spread, priority fee
  kappa: 0.5,                // half-Kelly. Full Kelly is a coin-flip away from ruin

  /* THESE TWO ARE DELIBERATELY LOOSER THAN THE THESIS PRESCRIBES, and the reason
     is arithmetic, not courage. Priority fees are a FIXED ~0.0004 SOL per round
     trip, so on a small wallet a textbook 0.75% risk produces a position the fees
     eat: at 0.32 SOL equity that is 0.0063 SOL of position and 6.3% in fees.
     Raising the risk fraction is the only lever that makes a small book tradeable
     at all — it buys the closed sample the engine needs before Kelly is even
     allowed to fire. It is a real loosening of the rails: 2% of equity per name
     rather than 0.75%. Dial back toward 0.0075 as equity grows, or set
     F_DEFAULT / F_NAME_MAX in the environment. */
  fNameMax: 0.025,           // most equity one name may risk at its stop
  fDefault: 0.02,            // what to risk while the sample is too small to trust
  nMin: 12,                  // closed trades before an estimated W is usable at all
  bookHeatMax: 0.08,         // sum of f across open positions — correlated names share it
  maxAgeHours: POLICY_DEFAULTS.maxAgeHours,
  // Kept as a compatibility field for old env/config files. Snipe-v2 never emits
  // sell_part: the authored target and configured multiple both close in full.
  scaleOutPct: 0,
  trailPct: POLICY_DEFAULTS.trailPct,
  honorDeskTarget: POLICY_DEFAULTS.honorDeskTarget,
  stopBufferPct: 0,          // widen the desk's stop by this much (0 = obey exactly)
  /* SNIPE-HOLD-SELL: take the whole position at this multiple of entry. 2 = sell at a
   * double. Checked before the trail arms, so a trail can never intercept the double
   * first. Set to 0 to disable and ride the trail instead. */
  takeProfitX: POLICY_DEFAULTS.takeProfitX,
  /* THE FIXED FUND: the operator's per-trade CEILING (0 = size by Kelly/flat risk).
   * It bounds how much is ever bet on one call; the risk rails below may size UNDER
   * it, and Kelly's skip verdicts still decide whether to bet at all. */
  fixedSol: 0.02,
  /* THE SMALLEST SHARE OF THE CEILING THE TEAM'S CONFIDENCE CAN REDUCE A TRADE TO.
   * Live conviction runs 20-51 out of 100, so an unfloored scale would put almost
   * every trade at a fifth of size and the fees would eat the book. */
  convictionFloor: 0.35,
  /* The smallest position worth opening at all: below this the round trip is mostly
   * fees, so the trade is refused rather than sized into noise. */
  minSolPerTrade: 0.005,
};

/** Should we take this entry at all, and at what size? */
export function planEntry({ call, cfg = DEFAULTS, state }) {
  const c = { ...DEFAULTS, ...cfg };
  if (state.openCount >= c.maxOpenPositions)
    return { action: "skip", reason: `already holding ${state.openCount} of max ${c.maxOpenPositions}` };
  if (state.realizedTodaySol <= -Math.abs(c.dailyLossLimitSol))
    return { action: "skip", reason: `rolling 24h realized-loss entry brake hit (${state.realizedTodaySol.toFixed(3)} SOL)` };

  // A call with no stop cannot be risk-managed; refuse it rather than hold
  // something with no floor under it.
  if (call.stop == null || !(Number(call.stop) > 0))
    return { action: "skip", reason: "call has no stop — refusing an unmanageable position" };

  // ── the bracket, as fractions of entry ──
  const entry = Number(call.entry_ref) > 0 ? Number(call.entry_ref) : 1;
  const stopFrac = (entry - Number(call.stop)) / entry;
  const targetFrac = call.target != null ? (Number(call.target) - entry) / entry : null;
  if (!(stopFrac > 0)) return { action: "skip", reason: "stop is at or above entry" };
  const observedFriction = Math.max(0, Number(c.measuredRoundTripLossPct) || 0) / 100;
  const effectiveStopFrac = Math.min(1, stopFrac + observedFriction);

  // ── R_net, with costs on BOTH sides. A bracket that looks like 1.25R gross is
  //    often under 1.0 once the round trip is paid for. ──
  /* COST FOLLOWS THE CLIP, because on a flat-gas chain it must.
   *
   * costPct was a single number priced at the per-trade CAP. But conviction scales the
   * clip down by as much as convictionFloor (0.35), and gas is FLAT — so a low-conviction
   * trade takes a 0.0014 ETH position whose real round trip is 18.64% while the +EV gate
   * below was told 9.16%. A nine-point understatement, in the direction that makes a
   * losing bracket look profitable, which is the direction this whole cost path exists to
   * stop being wrong in.
   *
   * `costPctFor(clipEth)` is supplied by the operator's config (poller.mjs derives it from
   * the measured PONS curve). When it is absent — every desk-side and test caller — the
   * flat costPct is used exactly as before, so nothing that does not opt in changes. */
  const convictionForCost = Number(call.conviction);
  const scaleForCost = Number.isFinite(convictionForCost) && convictionForCost > 0
    ? Math.max(c.convictionFloor, Math.min(1, convictionForCost / 100)) : 1;
  const expectedClip = Math.min(c.fixedSol > 0 ? c.fixedSol : Infinity, c.maxSolPerTrade) * scaleForCost;
  const cost = typeof c.costPctFor === "function" && Number.isFinite(expectedClip) && expectedClip > 0
    ? c.costPctFor(expectedClip)
    : c.costPct;
  const rNet = targetFrac != null ? (targetFrac - cost) / (stopFrac + cost) : null;
  const takeEveryCall = c.entryMode === "take-every-call";
  const advisories = [];
  if (rNet != null && !(rNet > 0)) {
    if (!takeEveryCall) return { action: "skip", reason: `costs eat the target: R_net ${rNet.toFixed(2)}` };
    advisories.push(`costs eat the target: R_net ${rNet.toFixed(2)} — bought anyway (take-every-call)`);
  }

  // ── the break-even hit rate this bracket demands ──
  const wMin = rNet != null ? 1 / (1 + rNet) : null;
  const n = (state.wins ?? 0) + (state.losses ?? 0);
  const W = n > 0 ? (state.wins ?? 0) / n : null;

  // ── Kelly, then the rails. Below nMin closed trades an estimated W is noise,
  //    so we ignore it entirely and risk a small constant instead. ──
  let f, why;
  if (n < c.nMin || W == null || rNet == null) {
    f = c.fDefault;
    why = `small sample (n=${n}) — flat ${(f * 100).toFixed(2)}% risk`;
  } else if (W <= wMin) {
    if (!takeEveryCall) return { action: "skip",
      reason: `hit rate ${(W * 100).toFixed(0)}% is under the ${(wMin * 100).toFixed(0)}% this bracket needs` };
    advisories.push(`hit rate ${(W * 100).toFixed(0)}% is under the ${(wMin * 100).toFixed(0)}% this bracket needs — bought anyway (take-every-call)`);
    f = c.fDefault;
    why = `take-every-call: flat ${(f * 100).toFixed(2)}% risk`;
  } else {
    const fStar = W - (1 - W) / rNet;
    f = Math.max(0, Math.min(c.kappa * fStar, c.fNameMax));
    why = `half-Kelly ${(f * 100).toFixed(2)}% (W ${(W * 100).toFixed(0)}%, R_net ${rNet.toFixed(2)})`;
  }

  // ── translate risk into position size, then obey the flat caps ──
  const equity = state.equitySol ?? c.dailySolCap;
  if (!Number.isFinite(Number(equity)) || Number(equity) <= 0)
    return { action: "skip", reason: "equity is unavailable for risk sizing" };
  const feeReserve = Math.max(0, Number(c.networkFeeReserveSol) || 0);
  const heat = state.bookHeat ?? 0;

  /* THE TEAM'S OWN CONFIDENCE, PRICED INTO THE SIZE.
   *
   * Every call already carries the desk's conviction out of 100, and the bot had never
   * once read it — the feed sends it, and nothing here looked. The owner's rule is
   * "more risk, less size", and the team's uncertainty IS risk, so a call the desk is
   * lukewarm about gets a smaller position than one it argues for.
   *
   * Floored deliberately. Live conviction runs 20 to 51 out of 100, so an unfloored
   * scale would put nearly every trade at a fifth of size, where the round trip is
   * mostly fees. A call with no conviction stated is not scaled at all — the desk's
   * silence is not evidence, and the rails below still bound it. */
  const conviction = Number(call.conviction);
  /* NOT IN TAKE-EVERY-CALL. The operator's acknowledgement there is literally "I take
     every published call at N ETH", and a desk-authored number that quietly makes it
     0.35N contradicts the sentence they typed. It is also the shape the Solana desk
     removed outright — "a remote party who can set the size to a fraction can silence
     this bot as surely as one who can set it to ten times" — so in the mode where the
     operator has fixed the size, the desk's confidence ranks calls and does not size
     them. In risk mode it sizes as before, floored below. */
  const convictionScale = takeEveryCall ? 1
    : Number.isFinite(conviction) && conviction > 0
      ? Math.max(c.convictionFloor, Math.min(1, conviction / 100))
      : 1;

  /* THE CEILING, then the rails. `fixedSol` is what the OPERATOR permits on one trade,
   * not an instruction to bet exactly that: the risk rails may size under it and never
   * over it. Kelly's own skip verdicts above still decide WHETHER to bet. */
  let want = (f * equity) / effectiveStopFrac;
  if (c.fixedSol > 0) { want = c.fixedSol; why = `operator ceiling ${c.fixedSol} SOL`; }
  want = Math.min(want, c.maxSolPerTrade);
  if (call.size_sol != null) want = Math.min(want, Number(call.size_sol));
  /* CONVICTION MAY NOT SHRINK A CLIP INTO ITS OWN GAS.
   *
   * On Solana, scaling a position down by the desk's conviction cost proportionally less
   * to trade. Here gas is a FLAT toll, so the cost curve is a U and shrinking moves the
   * clip toward the expensive end: the desk's MEDIAN conviction is 31 of 100, which
   * scales to the 0.35 floor, and 0.35 of the 0.0112 ETH default clip is 0.0039 —
   * under the measured minimum, so every median-conviction call refused with "the sized
   * position rounds to nothing". A scaler that silently deletes the median call is not
   * expressing less confidence, it is not trading.
   *
   * So conviction still sizes down, and it stops at the smallest clip that is not mostly
   * gas. Below that there is no smaller position worth taking — there is only the
   * refusal below, which is the honest answer when even the minimum does not fit. */
  if (convictionScale < 1) {
    const scaled = want * convictionScale;
    const floor = Math.min(want, Number(c.minSolPerTrade) > 0 ? Number(c.minSolPerTrade) : 0);
    want = Math.max(scaled, floor);
    why += `; conviction ${conviction}/100 sizes to ${((want / (c.fixedSol > 0 ? c.fixedSol : want)) * 100).toFixed(0)}%` +
      (scaled < floor ? ` (held at the ${floor} minimum clip: below it the round trip is mostly gas)` : "");
  }

  /* SIZE DOWN TO EACH RAIL RATHER THAN REFUSING THE CALL.
   *
   * Every one of these was a `return skip`, so a fixed size one basis point over the
   * per-name risk cap threw the whole trade away instead of buying slightly less —
   * measured in the live log as "SKIP NATIX: actual stop risk 3.22% exceeds per-name
   * cap 2.50%", which is a trade the bot could have taken at 78% of the size. Refusing
   * on size is only correct when NO size fits, and that is the one case still refused
   * below. Clamping is strictly the safer direction: every rail here can only make the
   * position smaller, never larger, and the operator's ceiling is applied above. */
  let boundBy = null;
  const bind = (limitSol, label) => {
    if (Number.isFinite(limitSol) && limitSol < want) { want = limitSol; boundBy = label; }
  };
  /* The EDGE rails. In take-every-call they are advisory: the operator chose the size
     and the desk chose the call, so the per-name and book-heat caps report the breach
     rather than shrink the trade. The MONEY rails after them bind in every mode. */
  const fNameMax = takeEveryCall ? 1 : c.fNameMax;
  const bookHeatMax = takeEveryCall ? 1 : c.bookHeatMax;
  if (takeEveryCall) {
    const perName = (c.fNameMax * equity - 2 * feeReserve) / effectiveStopFrac;
    if (Number.isFinite(perName) && perName < want)
      advisories.push(`per-name risk cap ${(c.fNameMax * 100).toFixed(2)}% would have sized this to ${Math.max(0, perName).toFixed(4)}`);
    if (heat + (want * effectiveStopFrac + 2 * feeReserve) / Number(equity) > c.bookHeatMax)
      advisories.push(`book heat would exceed ${(c.bookHeatMax * 100).toFixed(0)}%`);
  }
  // Per-name stop risk: want * stopFrac + both fees <= fNameMax * equity.
  bind((fNameMax * equity - 2 * feeReserve) / effectiveStopFrac, `per-name risk cap ${(fNameMax * 100).toFixed(2)}%`);
  // Aggregate book heat, on the room this call actually has left.
  bind(((bookHeatMax - heat) * equity - 2 * feeReserve) / effectiveStopFrac,
    `book heat (${(heat * 100).toFixed(1)}% of ${(bookHeatMax * 100).toFixed(0)}% used)`);
  bind(c.dailySolCap - state.deployedTodaySol - feeReserve,
    `rolling 24h deploy cap (${state.deployedTodaySol.toFixed(3)}/${c.dailySolCap} SOL)`);
  if (state.spendableSol != null) bind(state.spendableSol - feeReserve, "spendable balance after the fee reserve");

  /* The floor is the configured minimum, not a hard-coded 0.0005. That literal was a
     SOL-scale number (about a dollar); the Robinhood Chain executor sizes in ETH where
     the canary cap is 0.0004, and a floor above the cap made every entry "round to
     nothing" (measured 2026-09-05). Callers that pass nothing keep the old floor. */
  const staticFloor = Number(c.minSolPerTrade) > 0 ? Number(c.minSolPerTrade) : 0.0005;
  /* THE DERIVED FLOOR ONLY EVER RAISES THE BAR TO ENTRY. It is solved from the gas
     reading and the stop, so when the network is expensive or the stop is tight the
     smallest worthwhile clip is larger — and the honest response to a clip under it is
     to REFUSE, never to size up to meet it. */
  const feeFloor = Number(c.feeFloorSolPerTrade) > 0 ? Number(c.feeFloorSolPerTrade) : 0;
  const minSize = Math.max(staticFloor, feeFloor);
  const gasIsWhy = feeFloor > staticFloor;
  if (!(want >= minSize))
    return { action: "skip",
      reason: boundBy
        ? `${boundBy} leaves ${Math.max(0, want).toFixed(4)} SOL, under the ${minSize} SOL minimum`
        /* NAME THE FLOOR AND THE NUMBER THAT MISSED IT. "Rounds to nothing" was true of a
           size that really was ~0, and misleading for one that is simply under the
           measured minimum clip — the reader goes looking for a zero that is not there.
           And when GAS is what raised the floor, say so: a floor that moved because the
           network got expensive is otherwise a mysterious refusal rather than a
           diagnosable one. */
        : gasIsWhy
          ? `the sized position is ${Math.max(0, want).toFixed(6)}, under the ${minSize.toFixed(6)} floor ` +
            `two gas legs derive at this stop — the flat toll would eat more than its share of the risked distance`
          : `the sized position is ${Math.max(0, want).toFixed(6)}, under the ${minSize} minimum clip — ` +
            "below that the round trip is mostly the flat gas toll" };

  const actualF = (want * effectiveStopFrac + 2 * feeReserve) / Number(equity);
  if (!Number.isFinite(actualF) || actualF < 0)
    return { action: "skip", reason: "actual risk fraction is invalid" };
  /* The rails above already bound this, so a breach here would mean the arithmetic
     disagrees with itself. Refuse rather than trust it. */
  if (actualF > fNameMax + 1e-9)
    return { action: "skip", reason: `actual stop risk ${(actualF * 100).toFixed(2)}% exceeds per-name cap ${(fNameMax * 100).toFixed(2)}%` };
  if (heat + actualF > bookHeatMax + 1e-9)
    return { action: "skip", reason: `book heat ${(heat * 100).toFixed(1)}% + ${(actualF * 100).toFixed(1)}% exceeds ${(bookHeatMax * 100).toFixed(0)}%` };

  return { action: "buy", sol: want, f: actualF, estimatedF: f, rNet, wMin,
    convictionScale, boundBy, advisories, entryMode: takeEveryCall ? "take-every-call" : "risk",
    reason: `${why}${boundBy ? `; sized down by ${boundBy}` : ""}; actual stop risk ${(actualF * 100).toFixed(2)}%` +
      (advisories.length ? `; advisory: ${advisories.join("; ")}` : "") };
}

/** Fresh position record, created after a fill. */
export function openPosition({ call, sol, fillPrice, cfg = DEFAULTS }) {
  const c = { ...DEFAULTS, ...cfg };
  const stop = Number(call.stop) * (1 - c.stopBufferPct);
  return {
    mint: call.mint, symbol: call.symbol,
    entry: fillPrice, sol, qty: sol / fillPrice,
    stop, initialStop: stop,
    target: call.target != null ? Number(call.target) : null,
    high: fillPrice, scaled: false, openedAt: call.ts ?? 0,
    openedAtMs: call.openedAtMs ?? Date.now(),
    /* THE BAND'S CLOCK, carried from the call. Null on a legacy call or an unreadable
       market cap, in which case the bot's own configured age exit governs, as before. */
    holdBand: call.hold_band ?? call.holdBand ?? null,
    holdMaxMs: Number(call.hold_max_ms ?? call.holdMaxMs) > 0
      ? Number(call.hold_max_ms ?? call.holdMaxMs) : null,
    riskF: null,
  };
}

/**
 * The per-tick decision for ONE open position. `mark` is the current price;
 * `deskExit` is set when the desk has published an exit for this call.
 * Returns {action: hold|sell, fraction, reason}.
 */
export function stepPosition({ pos, mark, deskExit = null, cfg = DEFAULTS, nowMs = Date.now() }) {
  const d = pricePolicy({ position: pos, mark, deskExit, nowMs, config: cfg });
  // Preserve the existing API while ensuring both server and executor use the exact
  // same pure policy. Mutation is limited to an accepted policy state transition.
  Object.assign(pos, d.position);
  return { action: d.action, fraction: d.fraction, reason: d.reason,
    policyVersion: d.policyVersion };
}

export const freshState = (now = 0) => ({
  // These compatibility names are rolling 24-hour values derived from the durable
  // risk_events ledger. They are never reset at a day boundary.
  dayStart: now, deployedTodaySol: 0, realizedTodaySol: 0,
  openCount: 0, spendableSol: null,
  // the sizing inputs: the closed sample, the equity Kelly is a fraction OF,
  // and how much risk the open book is already carrying
  wins: 0, losses: 0, equitySol: null, bookHeat: 0,
});
