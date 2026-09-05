import { sweep, classify, CATEGORY_RISK, launchpad } from "./market.js";
import { gather, screen } from "./data/evidence.js";
import { workup } from "./desk.js";
import { openCall, liveCalls, liveCallFor, evaluateExit, closeCall, noteEvent } from "./calls.js";
import { broadcast } from "./copy.js";
import { announceExit } from "./alerts.js";
import { listFloors, HQ_FLOOR } from "./tower.js";
import { emit, runFor, runForEvidence } from "./lib/bus.js";
import db from "./lib/store.js";
import { spend, OutOfCredit, spendSince, CYCLE_BUDGET_USD } from "./lib/llm.js";
import { callouts, whaleScore } from "./whales.js";
import { canonicalAddress, canonicalLaunchpad } from "./canonical.js";
import { recordWhaleCallout } from "./identity.js";
import { regime } from "./data/regime.js";
import { cfg, floorsFor } from "./config.js";
import * as store from "./lib/store.js";
import * as shadow from "./shadow.js";
import { buildBoard, selectAcrossBoard, CAP_BANDS, COIN_TYPES, PREFERRED_PAD } from "./categories.js";
import { recordCandidateBoard } from "./candidate-board.js";
import * as funnel from "./funnel.js";
import * as ds from "./data/dexscreener.js";
import { eligibility, contenderScore, pickOne, bookState, SEQUENTIAL, MAX_LIVE_CALLS } from "./mandate.js";
import { runBestPick } from "./agents/decision.js";
import { linkPublishedCall } from "./evaluation.js";

/**
 * THE PENTHOUSE CYCLE — the house team's working day.
 *
 *   sweep (free) → classify (free) → screen (free) → rank (free) → work up the best few
 *   → open calls on what the CEO approves → broadcast to every leased floor (free)
 *
 * Only the workup costs money, which is why everything above it is arithmetic. A cycle
 * looks at ~190 coins and pays for ~3.
 */

/* AGGRESSION, PART ONE: MORE SHOTS ON GOAL.
 * Three coins a cycle at 32 cycles a day is 96 looks — and on a market where a coin
 * worth trading appears every half hour, that is a narrow net. Eight per cycle on a
 * faster clock roughly quadruples the looks. The daily money cap still governs the
 * total, so this widens the net without removing the brake. */
export const WORKUPS_PER_CYCLE = Number(process.env.PENTHOUSE_WORKUPS || 8);
/** Hard ceiling per cycle. Without it one bad night empties the account. */
/* $10 was more than the hourly pace allowed ($40/24 x 3 = $5), so every cycle was cut
 * off mid-hunt and none could complete. Four fits inside the pace with room to spare,
 * and at the measured $0.126 a workup it still buys ~32 of them — a shortlist of three
 * plus a deep mandate hunt. Smaller cycles running often beat large ones that die.
 * The number itself lives in llm.js, where the pace brake reads it: two copies with two
 * defaults (this file said 8, llm.js said 4) let the profile disagree with the brake. */
export { CYCLE_BUDGET_USD };

/* THE CHAIN'S CLOCK. Chain 4663 seals a block every ~100 ms: measured 100.6 ms over
 * 10,000 blocks on 2026-09-04 (executor/live-thresholds.mjs BLOCK_MS) and 0.102 s over
 * 60 consecutive blocks the same evening (market brief). Every clock on this desk is
 * kept in milliseconds — the hold windows in bands.js are user-tuned and are NOT
 * re-derived — but it is stated in blocks wherever a decision compares two clocks, so
 * "how many chances does this call get" is read in the unit the chain moves in. Solana
 * ran at ~400 ms with a fee auction; here a 30-minute nano hold is 18,000 blocks of
 * first-come-first-served ordering, and a ten-minute monitor pass is 6,000 of them. */
export const BLOCK_MS = Number(process.env.RH_BLOCK_MS || 100);
export const blocksFor = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) / BLOCK_MS : null);
export const TOP_N = Number(process.env.PENTHOUSE_TOP_N || 5);
/* How many candidates the board shortlists per cell — the owner's "at least 5 per
 * category". Shortlisting is free; only what selectAcrossBoard picks gets paid for. */
export const PER_CELL = Number(process.env.PENTHOUSE_PER_CELL || 5);

/**
 * The cheap ranking that decides who gets the expensive seats.
 *
 * The trap here is ranking by recent price change, which just buys the top of every
 * pump. What separates "about to run" from "already ran" is the shape of the move: a
 * coin up 35% in the last hour has already run, and the desk would be the exit
 * liquidity. So a big h1 move is penalised, while sustained h6 strength on rising
 * volume is rewarded.
 */
/* THE DOCTRINE. 99% of memecoins dump inside a day; the desk's whole business
 * is the other 1%, which comes in exactly two shapes:
 *   Job 1 — NEW coins whose ignition is real: true lore, real X attention,
 *           honest holders, unpaid reach, a chart not already vertical.
 *   Job 2 — OLD coins with the strongest revival: re-igniting on an emerging
 *           trend, notable people posting, fresh notable buying on an aged tape.
 * Everything below scores toward one of those two shapes; everything the seats
 * do afterwards is deciding whether the shape is genuine. */
export function rank(c) {
  const p = c.pair;
  if (!p) return { score: 0, why: ["no pair data"] };
  const why = [];
  let s = 0;

  /* THE BONDING-CURVE PENALTY IS GONE, because the fact it rested on is false.
   *
   * It read: "no AMM depth for the exit probe to measure, so it fails cannot_exit at the
   * screen anyway." That is a checkable claim, and checking it is what the desk is
   * supposed to do. Four on-curve coins the screen had killed as unexitable were probed
   * through Jupiter at $75: 4.53%, 5.49%, 5.58%, 3.70% round trip, against an 8%
   * ceiling. Every one exitable. Jupiter routes bonding curves; the ASSUMPTION that it
   * does not was doing the work, and no measurement ever backed it.
   *
   * What -30 actually did: of 58 micro-cap coins on a live sweep, 38 scored zero or
   * below and ALL 38 were on-curve. Since a zero score means the coin is never even
   * observed, the desk was deleting the pre-graduation pump.fun segment — the earliest,
   * smallest, highest-upside coins it was explicitly pointed at — one line above the
   * funnel, invisibly, and it read as prudence. Sixteen coins that had PASSED the safety
   * screen were discarded here anyway.
   *
   * Being early on the curve is the target state for this desk, not a defect. It is left
   * NEUTRAL rather than made a bonus: the exit probe still has to measure it, and
   * unverified_exit and cannot_exit still refuse it if the measurement fails or comes
   * back too wide. Safety is unchanged; only a false premise was removed. */

  const liqKnown = p.liquidityUsd != null || p.liquidity?.usd != null;

  const liq = p.liquidityUsd ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const h1 = p.priceChange?.h1 ?? 0;
  const h6 = p.priceChange?.h6 ?? 0;
  const h24 = p.priceChange?.h24 ?? 0;
  const age = p.ageHours ?? 0;

  /* DEPTH: ENOUGH TO EXIT, AND NO CREDIT FOR MORE.
   *
   * This paid +15 over $75k and another +10 over $400k, so a big book out-scored a
   * small one by 25 points before its story was read — and with the aged-survivor
   * bonus below, up to +39 on size alone. That is how a memecoin desk ends up
   * surfacing coins you would hold rather than trade.
   *
   * Those numbers were calibrated for a desk placing $500 clips out of a $10,000
   * book. The executor sizes at about $3.40, capped near $10, and the exit probe now
   * prices $200. At that size a $50,000 pool and a $500,000 pool are the same pool:
   * both round-trip under a tenth of a percent. Depth past "can I get out" buys
   * nothing and costs the whole thesis, because upside lives in the small caps.
   *
   * So depth is now a THRESHOLD, not a ladder — one modest bonus for clearing the bar
   * the executor actually needs, and a penalty once a coin is too heavy to re-rate. */
  if (liq > 40_000) { s += 12; why.push("deep enough to exit at the size we trade"); }
  const mcap = p.marketCap ?? p.fdv ?? null;
  if (mcap != null) {
    if (mcap < 2_000_000) { s += 10; why.push(`\$${(mcap / 1e6).toFixed(2)}m cap — real room to re-rate`); }
    else if (mcap > 8_000_000) { s -= 12; why.push(`\$${(mcap / 1e6).toFixed(1)}m cap — needs millions of fresh money to move`); }
  }

  /* Turnover relative to depth: real interest, but wash above a point.
   *
   * When depth is UNREADABLE this ratio silently evaluated to 0 and the coin missed the
   * bonus entirely — a second, quieter penalty on the same segment the line above was
   * deleting, and one that looked like a neutral calculation rather than a judgement.
   * A coin whose pool cannot be read is still either being traded or not, so it is
   * scored on the tape it does have: real volume and real participants. */
  const volToLiq = liq > 0 ? vol24 / liq : 0;
  if (liqKnown) {
    if (volToLiq > 1 && volToLiq < 15) { s += 15; why.push("healthy turnover"); }
    if (volToLiq >= 15) { s -= 10; why.push("turnover implausible for the depth"); }
  } else {
    const buys24 = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
    if (vol24 > 25_000 && buys24 > 300) { s += 15; why.push(`real tape without a readable pool — $${Math.round(vol24 / 1000)}k over ${buys24} trades`); }
    else if (vol24 > 8_000 && buys24 > 100) { s += 8; why.push("a working tape, pool unreadable"); }
  }

  // The key discriminator.
  if (h1 > 25) { s -= 25; why.push(`already ran ${h1.toFixed(0)}% this hour`); }
  else if (h1 > 8) { s -= 8; why.push("extended on the hour"); }
  else if (h1 > -3 && h6 > 5) { s += 20; why.push("holding gains rather than spiking"); }
  if (h6 > 10 && h24 > 0 && h1 < 10) { s += 12; why.push("sustained over six hours"); }
  if (h24 < -35) { s -= 15; why.push("falling knife"); }

  // Age: old enough to have a tape, young enough to still move.
  if (age > 24 && age < 24 * 21) { s += 12; why.push("has a tape but is still young"); }

  /* THE SNIPER PATH. The profitable memecoin bots of this cycle are not fast —
   * they are EARLY: first hours of a coin whose attention is real. "Too new to
   * read" was costing us every one of those, so youth stops being a penalty when
   * the coin shows genuine ignition: buyers accelerating hour over hour, socials
   * that exist, and a price that is moving without having already blown off.
   * Youth without ignition keeps the old penalty — new and dead is just new. */
  const buysH1 = c.pair?.txns?.h1?.buys ?? 0;
  const buysH6 = c.pair?.txns?.h6?.buys ?? 0;
  const buyAccel = buysH6 > 0 ? buysH1 / (buysH6 / 6) : 0;
  const hasSocials = (c.pair?.socials?.length ?? 0) > 0;
  if (age >= 1.5 && age < 48) {
    if (buyAccel >= 2 && buysH1 >= 30 && hasSocials && h1 > 0 && h1 <= 25) {
      s += 30; why.push(`ignition: ${buysH1} buys this hour, ${buyAccel.toFixed(1)}x the 6h pace, socials live`);
      if (buyAccel >= 4 && h6 > 15) { s += 10; why.push("attention compounding, not spiking"); }
    } else {
      s -= 15; why.push("young without ignition");
    }
  } else if (age < 1.5 && !c.momentum) {
    /* Only for a coin the desk cannot see the tape of. The ignition lane exists to make
       this judgement from minute candles instead, and penalising its finds for being
       young would discard the entire population it was built to find. */
    s -= 20; why.push("too new even for the sniper path");
  }

  /* THE REVIVAL PATH — the desk's second job. Of the coins that matter, some are
   * new and igniting; the rest are OLD coins coming back: dumped, flatlined, and
   * now re-igniting on a real trend — or never having left their highs at all.
   * The signature is the same ignition read on an aged tape: buyers accelerating
   * hard against their own recent pace, on a coin old enough to have died once. */
  /* Revival now means the SURVIVOR cohort: only ~4.6% of launchpad coins live
   * past 90 days, and a "revival" younger than that is usually an abandoned
   * mint sharing a ticker. The 2-13-week middle ground belongs to no lane —
   * by the doctrine's own math it is where the bodies are. */
  if (age >= 24 * 90) {
    if (buyAccel >= 3 && buysH1 >= 40 && h1 > 0 && h1 <= 25) {
      s += 25; why.push(`revival: ${buysH1} buys this hour on a ${Math.round(age / 24)}d-old coin, ${buyAccel.toFixed(1)}x its pace`);
      if (h6 > 10 && h24 > 0) { s += 8; why.push("the comeback is holding, not spiking"); }
    }
  }
  // The ranker could reward youth and nothing else, so a coin that had actually survived
  // scored worse than one that had not been tested. Durability is evidence too.
  // Durability is evidence, but it was gated on a $750k book — which made this a
  // third size bonus wearing an age label, and only big coins could ever earn it.
  // Survival is the claim being rewarded, so gate it on survival.
  if (age > 24 * 90 && liq > 40_000) { s += 14; why.push("survived long enough to have a base rate"); }
  if (age > 24 * 365) { s += 6; why.push("more than a year old"); }

  const txns = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  if (txns > 500) { s += 8; why.push("actively traded"); }

  /* Who is behind the tape. The 655,770-token pump.fun study's strongest
   * graduation predictor was FEW LARGE HUMAN BUYS — real conviction arrives in
   * size, while a thousand dust swaps is a bot choir. Average trade size is
   * volume the desk already has, read a second way. */
  const avgTrade = txns > 0 ? vol24 / txns : 0;
  if (txns >= 200 && avgTrade >= 150) { s += 8; why.push(`real size behind the tape ($${Math.round(avgTrade)}/trade)`); }
  if (txns >= 2000 && avgTrade < 15) { s -= 10; why.push(`dust swarm ($${Math.round(avgTrade)}/trade over ${txns} trades)`); }

  return { score: Math.round(s), why };
}

/** Categories with a survivable base rate, as opposed to a launchpad lottery ticket. */
const SUBSTANTIVE = new Set(["established", "utility", "infra", "defi", "ai"]);

/* THE CHAIN FACTS THE EXIT WATCHES, read from the bundle the evidence contract names.
 * `contract.flags` carries the same {flag, detail} shape the Solana bundle's
 * mintAccount.flags had (docs/EVIDENCE-CONTRACT.md), so one reader serves both until
 * the data lane's gather() lands; a bundle that carries neither is UNREADABLE, and an
 * unreadable read must never be mistaken for "no flags" — that is how a pre-existing
 * control gets reported as "appeared" and fires a spurious exit. */
export function contractFlags(ev) {
  const src = ev?.contract ?? ev?.mintAccount ?? null;
  if (!src || src.error) return { flags: [], readable: false };
  return { flags: (src.flags ?? []).map((f) => f?.flag ?? f), readable: true };
}

/** The weather line, in the major this chain is quoted in. */
const majorWeather = (wx) => {
  const eth = wx?.ethRet25d, sol = wx?.solRet25d;
  const major = eth != null ? `ETH ${eth}%` : sol != null ? `SOL ${sol}% (regime.js still reads Solana — handoff)` : "major unknown";
  return `${major} / BTC ${wx?.btcRet25d ?? "?"}%`;
};

/**
 * Pick who gets the expensive seats.
 *
 * Ranking on score alone sent three memecoins to the desk every cycle, and the red team
 * refuted all of them — correctly, because "most tokens of this profile go to zero" is
 * true and nothing about an 80-hour-old coin overcomes it. A verdict that is structurally
 * guaranteed carries no information. So at least one slot is reserved for a coin with a
 * real base rate behind it, and the refusal starts meaning something.
 */
/**
 * WOULD THE FREE SCREEN KILL THIS BEFORE A SEAT EVER SAW IT?
 *
 * The cycle gets THREE workup slots and was choosing them purely on rank — while
 * rank() rewards depth and momentum, and the screen kills on thresholds rank knows
 * nothing about. So the desk kept spending its whole allowance on coins that died at
 * the first free gate: eight consecutive cycles studied 1-3 coins each and produced
 * ZERO eligible candidates, every time.
 *
 * That is not a strictness problem, it is a selection problem — the slots were being
 * filled with coins the desk was always going to refuse. The fresh lane has pre-filtered
 * like this since its first champion died of thin_liquidity; the cycle never learned.
 *
 * Only the checks answerable from pair data already in hand. Anything needing an RPC
 * read or a Jupiter probe still belongs inside the workup, where it is measured
 * properly rather than guessed at here.
 */
export function wouldSurviveScreen(c) {
  const p = c.pair || {};
  const s = cfg.screen;
  const liq = p.liquidityUsd ?? 0;
  const vol = p.volume?.h24 ?? 0;
  const tx = (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0);
  /* A COIN FOUR MINUTES OLD HAS NO 24-HOUR HISTORY, AND WILL NOT HAVE ONE IN TIME.
   *
   * Judging it on daily aggregates refuses it for a fact about the calendar rather than
   * about the coin. When the ignition lane has attached a minute tape, that tape is the
   * evidence of a real market instead — and it is a HARDER test per unit time, not a
   * softer one: five minutes must carry a fifth of what the band asks of a whole day.
   * Only a coin still inside its band's hunt window may be judged this way; an old coin
   * with no daily volume is an old coin nobody is trading. */
  /* A TAPE THAT DESCRIBES THE PAST IS NOT A TAPE. vol5mUsd used to sum the last five
     candles regardless of when they printed, and pump.fun emits a candle only for a
     minute that traded — so five rows spanning forty-four hours of trickle read as a
     busy five minutes and let the coin past the volume floor it was built to fail.
     Both guards are now on the reading itself: the window has to be live, and the tape
     has to cover the window it claims. */
  const rawTape = c.momentum || null;
  const tapeIsLive = rawTape != null &&
    (rawTape.stalenessMins == null || rawTape.stalenessMins <= 5) &&
    (rawTape.coverageMins ?? 0) >= 5;
  const tape = tapeIsLive ? rawTape : null;
  const tapeVol = tape?.vol5mUsd ?? 0;
  const mcap = p.marketCap ?? p.fdv ?? null;
  const age = p.ageHours ?? 0;
  /* Floors scaled to the coin's own size — see BAND_FLOORS. A flat floor was passing 2
   * of 60 micro-caps and made "5 per category" impossible in the band this desk is for.
   * The measured exit probe downstream is unchanged and still absolute. */
  const fl = floorsFor(mcap);

  /* UNKNOWN LIQUIDITY IS NOT THIN LIQUIDITY, and conflating them was excluding an
   * entire class of coin.
   *
   * Measured on a live sweep of 300: 119 coins carry no liquidity figure at all. They
   * were read as $0 and killed as "thin", and they are not thin — samples showed
   * $26k-$239k of 24h volume across 519-6,184 transactions. A coin with that tape has a
   * market; the free feed simply does not report a pool for it, which is what happens
   * with pre-graduation coins whose trading is on a bonding curve rather than an AMM.
   * Since that is most of pump.fun's early market, the desk was systematically refusing
   * the earliest and smallest segment it exists to hunt: the micro band passed 2 of 60.
   *
   * THE PROXY IS NOT THE TEST. Pool depth is a cheap stand-in for the only question that
   * matters — can this position be got out of — and the desk MEASURES that directly with
   * a Jupiter round-trip at probe size. Four of these "thin" coins were probed: 4.53%,
   * 5.49%, 5.58%, 3.70% round-trip against an 8% ceiling. Every one exitable.
   *
   * So an unreadable pool defers to that measurement instead of pre-empting it, and only
   * when the tape independently shows a real market. A pool figure that IS readable and
   * IS below the floor still kills here, exactly as before. Nothing downstream moves:
   * unverified_exit still refuses a coin whose round trip cannot be measured, and
   * cannot_exit still refuses one that measures worse than the ceiling. This trades a
   * proxy that is wrong for a whole class of coin against a direct measurement — which
   * is a strengthening of the safety argument, not a loosening of it. */
  const liqUnknown = p.liquidityUsd == null && p.liquidity?.usd == null;
  if (!liqUnknown && liq < fl.liq) return "thin_liquidity";
  const tapeCarries = tape != null && tapeVol >= Math.max(300, fl.vol / 5);
  if (vol < fl.vol && !tapeCarries) return "no_volume";
  // The tape is a volume record, not a trade count, so a tape-judged coin has already
  // answered the participation question with the only evidence it owns.
  if (tx < fl.txns && !tapeCarries) return "no_participants";
  /* An unreadable pool has to clear a HIGHER bar of real trading before the desk will
     spend anything measuring it — the tape is the only evidence of a market it has.
     A graduated pump.fun coin arrives here every time: its bonding curve is drained
     into an AMM pool that this feed cannot see, so the minute tape answers, at double
     the bar a readable pool would have had to clear. */
  const tapeCarriesDouble = tape != null && tapeVol >= Math.max(600, (fl.vol * 2) / 5);
  if (liqUnknown && (vol < fl.vol * 2 || tx < fl.txns * 2) && !tapeCarriesDouble)
    return "thin_liquidity";
  if (age < (fl.ageH ?? s.minPairAgeHours)) return "too_new";
  if (s.maxMarketCapUsd > 0 && mcap != null && mcap > s.maxMarketCapUsd) return "too_big";
  if (s.minMarketCapUsd > 0 && mcap != null && mcap < s.minMarketCapUsd) return "too_small";
  if (liq > 0 && vol / liq > s.maxVolToLiqRatio) return "wash_suspect";
  if (liq > 0 && mcap != null && mcap / liq > s.maxFdvToLiqRatio) return "fdv_propped";
  /* THE PHASE GATE, at the free screen. A coin the sweep KNOWS is still on its curve is
   * held at `watch` (recordScreen's kill path) and never bought a workup: on 4663 the
   * edge is selection among graduates, not sniping the curve (block-0 is a 99% tax and
   * there is no auction to buy ordering). Read last, so a dead-tape curve coin is still
   * reported as no_volume — the kill that would hold it whatever its phase. An absent
   * phase passes here and is judged on the paid bundle's launch.phase in mandate.js. */
  if (launchPhaseOf(c) != null && launchPhaseOf(c) !== "graduated") return "on_curve";
  return null;
}

/** A sweep row with one spelling of its address and one name for its pad. The sweep
 *  says "pons" for a PONS V2 coin and the desk's constants say "pons-v2"; compared raw,
 *  every pad-keyed decision (quota, tripwire, tenant allow-list) missed on the string. */
export const canonicalCandidate = (c) =>
  (c?.mint ? { ...c, mint: canonicalAddress(c.mint), launchpad: canonicalLaunchpad(c.launchpad) } : c);

/** The launch phase the sweep attached to a candidate, or null when it said nothing.
 *  Vocabulary per docs/EVIDENCE-CONTRACT.md launch.phase: "curve" | "graduated" | "unknown". */
export function launchPhaseOf(c) {
  const p = c?.launch?.phase ?? c?.phase ?? null;
  if (p != null) return String(p);
  if (c?.onCurve === true) return "curve";
  return null;
}

export function selectShortlist(scored, workups) {
  /* Spend the slots on coins that can actually reach a seat. If the filter would empty
   * the list entirely the desk falls back to the ranked order — a cycle that studies a
   * doomed coin still learns something, whereas a cycle that studies nothing cannot. */
  const viable = scored.filter((c) => wouldSurviveScreen(c) === null);
  const pool = viable.length ? viable : scored;
  if (viable.length < scored.length)
    emit("cycle:prefiltered", { considered: scored.length, viable: viable.length,
      note: "coins the free screen would kill were dropped before paying for a workup" });

  const substantive = pool.filter((c) => SUBSTANTIVE.has(c.category));
  const speculative = pool.filter((c) => !SUBSTANTIVE.has(c.category));
  const reserved = Math.min(substantive.length, Math.max(1, Math.floor(workups / 2)));

  const picked = substantive.slice(0, reserved);
  for (const c of speculative) {
    if (picked.length >= workups) break;
    picked.push(c);
  }
  for (const c of substantive.slice(reserved)) {         // backfill if speculation ran dry
    if (picked.length >= workups) break;
    picked.push(c);
  }
  return picked.sort((a, b) => b.score - a.score);
}

/**
 * ADVANCE THE FUNNEL WITHOUT SPENDING A CENT.
 *
 * Sweep, rank, observe, expire, screen — every stage here is arithmetic against data
 * the desk already fetches, and not one model is called. That is what makes it safe to
 * run while a position is open, and while the daily money brake is on: the two states
 * in which the old desk did nothing at all and arrived at the next opportunity cold.
 *
 * It returns the shape of the pipe, because the drop-off between stages is how you tell
 * "the market offered nothing" from "the desk is strangling itself" — two failures that
 * look identical from outside and cost a full day to separate by hand once already.
 */
/**
 * THE IGNITION LANE'S CONTRIBUTION TO THE UNIVERSE.
 *
 * The keyword sweep returns coins a search engine thinks are relevant, whose median age
 * measured twenty-five days. This adds the coins the launchpad is trading RIGHT NOW,
 * with a minute tape attached so the screen can judge a four-minute-old coin on
 * evidence rather than on the absence of a 24-hour history. It is free and it calls
 * no model. Curve depth is priced in ETH (ethUsd), the chain's gas and quote token.
 *
 * It degrades to nothing: if the launchpad feed is unreachable the desk runs on the
 * sweep alone, exactly as it did before.
 */
export async function ignitionUniverse({ ethUsd = null, tapes = 40 } = {}) {
  try {
    const { ignitionSweep } = await import("./ignition.js");
    const r = await ignitionSweep({ ethUsd, tapes });
    // Only coins whose tape says something is happening. A negative score is a coin
    // going the wrong way on real volume, and the desk has no reason to look at it.
    return r.ranked.filter((c) => c.ignition.score > 0);
  } catch (e) {
    emit("ignition:unavailable", { note: String(e?.message || e) });
    return [];
  }
}

export async function warmFunnel() {
  const [swept, igniting] = await Promise.all([sweep(), ignitionUniverse()]);
  /* Ignition first so its richer row — the one carrying the minute tape — wins the
     dedupe against the same coin arriving from the keyword sweep. */
  const merged = new Map();
  for (const raw of [...igniting, ...swept]) {
    if (!raw?.mint) continue;
    // One spelling, or the dedupe is a fiction; one pad name, or the quota is.
    const c = { ...raw, mint: canonicalAddress(raw.mint), launchpad: canonicalLaunchpad(raw.launchpad) };
    if (!merged.has(c.mint)) merged.set(c.mint, c);
  }
  const universe = [...merged.values()];
  const scored = [];
  for (const c of universe) {
    if (liveCallFor(c.mint)) continue;
    const r = rank(c);
    if (r.score <= 0) continue;
    scored.push({ ...c, category: classify(c).category, score: r.score });
  }
  funnel.observe(scored);
  const expired = funnel.decay();

  const bySweep = new Map(scored.map((c) => [c.mint, c]));
  let passed = 0, held = 0;
  for (const row of funnel.dueForScreen(400)) {
    const c = bySweep.get(row.mint);
    if (!c) continue;
    if (funnel.recordScreen(row.mint, wouldSurviveScreen(c)) !== "held") passed++; else held++;
  }

  const shape = funnel.census();
  emit("funnel:warmed", {
    swept: universe.length, igniting: igniting.length, ranked: scored.length,
    screenPassed: passed, screenHeld: held,
    watch: shape.watch, screened: shape.screened, studied: shape.studied, ready: shape.ready,
    expired,
    note: "free — the screen narrows the market whether or not the desk can trade right now",
  });
  return { swept: universe.length, screenPassed: passed, screenHeld: held,
           screened: shape.screened, ready: shape.ready, expired };
}

export async function runPenthouseCycle({
  workups = WORKUPS_PER_CYCLE,
  topN = TOP_N,
  // The full-book branch still refreshes the free funnel. Keeping that boundary
  // injectable lets the regression prove sequencing without making CI depend on
  // DexScreener latency; production callers retain the real warmFunnel default.
  warmFunnelFn = warmFunnel,
} = {}) {
  const cycle = new Date().toISOString().replace(/[:.]/g, "-");

  /* ONE TRADE AT A TIME. The mandate is "one cycle, one trade, run to completion" —
   * so while a call is live the desk does not go shopping. This sits above every
   * paid stage deliberately: the sequencing rule and the money brake are the same
   * lever here, and a cycle that cannot publish must not be allowed to spend. */
  const book = bookState();
  if (book.full) {
    /* HOLDING IS NOT A REASON TO STOP LOOKING.
     *
     * This branch used to return here, which meant that through a twelve-hour hold the
     * desk did no research at all — and then, the instant the position closed, began a
     * cold sweep and needed four minutes to reach a decision. The single most valuable
     * moment in the desk's day was the one it was least prepared for.
     *
     * So the FREE half of the funnel keeps running while a position works: sweep, rank,
     * observe, expire, screen. Not a compromise — it costs nothing, no model is
     * involved, and it is most of the narrowing. When the slot opens there is a
     * standing pool of coins that have already passed a current safety screen, instead
     * of an empty table.
     *
     * The PAID half still does not run. The sequencing rule is a rule about money, and
     * a workup bought now is a verdict that will likely have expired before there is
     * anywhere to put it. */
    const warmed = await warmFunnelFn().catch((e) => ({ error: String(e?.message || e) }));
    emit("cycle:holding", { cycle, live: book.live,
      symbol: book.holding?.symbol, mint: book.holding?.mint,
      heldHours: book.holding ? Number(((Date.now() - book.holding.opened_at) / 3.6e6).toFixed(1)) : null,
      warmed,
      note: "a call is still working — but the free screen keeps narrowing, so the next slot opens onto a warm bench" });
    return { cycle, skipped: "position_open", live: book.live, opened: 0, workedUp: 0, warmed,
      holding: book.holding ? { id: book.holding.id, symbol: book.holding.symbol, mint: book.holding.mint,
        openedAt: book.holding.opened_at } : null, costUsd: 0 };
  }

  const startSpend = spend.usd;
  emit("cycle:start", { cycle, desk: "penthouse" });

  // MURDOCK reads the weather once per cycle. Risk-off (the gas major and BTC both
  // negative over ~25d) grounds the ESTABLISHED sleeve — the one whose returns
  // ride the majors — per the TSMOM veto. Unknown weather never grounds anyone.
  // ETH is the major on an ETH-quoted chain; ethRet25d is the data lane's field and
  // solRet25d the one regime.js still exports until it moves (handoff).
  const wx = await regime();
  emit("seat:verdict", { seat: "Regime", detail: `${wx.regime} · ${majorWeather(wx)} (25d)` });

  // 1-3. Everything free: sweep, classify, screen.
  const universe = (await sweep()).map(canonicalCandidate);
  const scored = [];
  const repeats = [];
  for (const c of universe) {
    if (!c?.mint) continue;
    if (liveCallFor(c.mint)) continue;                 // already holding a call on this one
    const cat = classify(c);
    const r = rank(c);
    if (r.score <= 0) continue;
    const row = { ...c, category: cat.category, categoryWhy: cat.why, score: r.score, rankWhy: r.why };
    /* DO NOT RE-BUY AN ANSWER THE DESK ALREADY HAS.
     *
     * The hunt lane and the fresh lane have both guarded against this for a while; the
     * main cycle never did, and it is the lane with only three slots to spend. The
     * result is in the record: of the last twenty coins the red team judged, DOGE-1
     * appears FIVE times and four others appear twice — roughly half the desk's most
     * expensive seat spent re-answering questions it had already answered.
     *
     * A high-ranked coin stays high-ranked, so without this the cycle picks the same
     * few names every 45 minutes and never reaches the rest of the market. */
    /* A REPEAT IS ONLY A REPEAT IF NOTHING HAS CHANGED.
     *
     * The guard skips anything judged in the last six hours, which was right when the
     * desk studied three coins every 45 minutes. It now studies eight every twenty —
     * 576 a day against a universe of about 296 — so it exhausts the fresh market in
     * roughly half an hour and then has nothing to look at. That is exactly what
     * studied=0 was: not refusals, an empty pool.
     *
     * But a coin whose price has moved 25% in an hour is not the same question it was.
     * Something happened to it, and the answer the desk wrote down before that is
     * about a different situation. So a material move re-opens the question, while a
     * coin sitting still stays closed — which keeps the fix that stopped DOGE-1 being
     * re-judged five times. */
    const moved = Math.abs(c.pair?.priceChange?.h1 ?? 0) >= 25;
    if (store.recentlyJudged(c.mint) && !moved) { repeats.push(row); continue; }
    if (moved && store.recentlyJudged(c.mint)) row.rankWhy = [...row.rankWhy, "re-opened: moved 25%+ since the desk last looked"];
    scored.push(row);
  }
  // ...unless the whole market is recently judged, in which case a stale look beats no
  // look at all. Ranked order still applies; the repeats simply queue behind fresh work.
  /* TOP UP RATHER THAN IDLE. This only fired when scored was COMPLETELY empty, so a
   * cycle with two fresh coins and eight slots studied two and wasted six. The desk
   * would rather re-examine a coin it has seen than end the cycle with nothing. */
  if (scored.length < workups && repeats.length) {
    const need = workups - scored.length;
    emit("cycle:topped_up", { fresh: scored.length, adding: Math.min(need, repeats.length),
      note: "not enough unseen coins to fill the cycle — re-examining the best already looked at" });
    scored.push(...repeats.slice(0, need));
  } else if (repeats.length) {
    emit("cycle:skipped_repeats", { skipped: repeats.length, fresh: scored.length,
      note: "coins judged in the last 6h were not re-bought" });
  }
  scored.sort((a, b) => b.score - a.score);

  // Whale flow is checked only on the coins already in contention. It costs ~25 RPC
  // reads per coin, so running it over all 345 would be wasteful; running it over the
  // top handful is what changes a decision.
  /* A TIME BUDGET, BECAUSE THIS IS WHERE CYCLES GO TO DIE.
   *
   * Measured, not guessed: 61 cycles started and only 40 finished — 21 began and never
   * came back, with no cycle:end for 1.7 hours while starts kept firing. The event
   * ordering placed the hang exactly here. `cycle:skipped_repeats` (emitted just above)
   * fired seconds ago; `cycle:prefiltered` (emitted just below) had not fired in half
   * an hour. The cycle was alive and stuck between the two.
   *
   * The cause is arithmetic: callouts() costs ~25 RPC reads per coin and this loops
   * over nine of them SEQUENTIALLY. That is ~225 calls against a public endpoint, with
   * no ceiling on how long they may take — and the coins now reaching this loop are
   * obscure micro-caps, which are the slowest of all to read.
   *
   * Whale flow is a RANKING NUDGE. It adjusts a score; it decides nothing. Letting an
   * optional signal hold the entire desk hostage inverts its importance, so it now
   * runs until it is done or until the budget expires, and the cycle continues with
   * whatever it managed to gather. */
  const whaleDeadline = Date.now() + Number(process.env.PENTHOUSE_WHALE_BUDGET_MS || 45_000);
  let whalesRead = 0, whalesSkipped = 0;
  for (const c of scored.slice(0, Math.max(8, workups * 3))) {
    if (Date.now() > whaleDeadline) { whalesSkipped++; continue; }
    try {
      const w = await callouts(c.mint, { scan: 24, deadline: whaleDeadline });
      whalesRead++;
      if (!w.ok) continue;
      const ws = whaleScore(w);
      c.whales = w;
      c.score += ws.score;
      c.rankWhy = [...c.rankWhy, ...ws.why];
      if (ws.why.length) {
        emit("whales", { mint: c.mint, symbol: c.pair?.baseSymbol,
          netUsd: w.netUsd, buyers: w.uniqueBuyers, sellers: w.uniqueSellers, delta: ws.score });
        recordWhaleCallout({ mint: c.mint, symbol: c.pair?.baseSymbol, launchpad: c.launchpad,
          netUsd: w.netUsd, buyers: w.uniqueBuyers, sellers: w.uniqueSellers, delta: ws.score });
      }
    } catch {}
  }
  if (whalesSkipped)
    emit("cycle:whales_timeboxed", { read: whalesRead, skipped: whalesSkipped,
      note: "whale flow is a ranking nudge, not a gate — the cycle moved on rather than stall" });
  scored.sort((a, b) => b.score - a.score);

  /* THE BOARD. Sort the whole market into cap band x coin type, shortlist the best few
   * in each cell, then spend the paid seats ACROSS the grid rather than down whichever
   * drawer the sweep happened to fill.
   *
   * The old shortlist took the top N by score, which meant a cycle could spend every
   * workup inside one band and learn nothing about the rest of the market — and an
   * empty cell would never even be noticed. Here an empty cell is a finding: "nothing
   * legitimate under $100k this hour" is worth knowing and used to be invisible. */
  const board = buildBoard(scored, { perCell: PER_CELL, viable: (c) => wouldSurviveScreen(c) === null });
  // Preserve the exact free-screened shortlist before any paid analyst or choosing
  // seat sees it. The UI labels these candidates, never calls.
  try { recordCandidateBoard(cycle, board, { considered: universe.length }); }
  catch (error) { emit("board:record_failed", { error: String(error?.message || error) }); }
  emit("board:built", {
    considered: universe.length, offBoard: board.offBoard,
    cellsFilled: board.filled, cellsPossible: board.possible,
    cells: board.cells.map((c) => ({ cell: c.key, shortlisted: c.coins.length, seen: c.total,
      best: c.coins[0]?.pair?.baseSymbol ?? null })),
  });

  /* THE FUNNEL — where the desk stopped starting from nothing every pass.
   *
   * Until now this cycle was stateless: sweep, rank, screen, pay for eight workups,
   * publish or refuse, throw all of it away, and begin again from zero. On a slow asset
   * that is merely wasteful. On memecoins it is the wrong shape, for one reason that
   * costs money — when a position finally closed, the desk had NOTHING ready. It began
   * a cold sweep and arrived at a decision four minutes later, in a market whose moves
   * are measured in minutes. It was perpetually researching the market it had missed.
   *
   * So coins live in a standing population now and each pass advances them, rather than
   * recreating them. The division of labour between the two halves is deliberate:
   *
   *   the FUNNEL supplies memory   — what has been screened, what has been studied,
   *                                  what is researched and ready to trade right now
   *   the SWEEP supplies freshness — the live price, liquidity and volume
   *
   * Which is why only coins in the CURRENT sweep are eligible below. The funnel is
   * allowed to remember a verdict; it is never allowed to supply the numbers that
   * verdict gets acted on. A remembered price is exactly how a desk buys a pool that
   * was drained ten minutes ago. */
  funnel.observe(scored);
  const decayed = funnel.decay();

  // The free screen, run over the standing watch list rather than only over this
  // sweep's arrivals. Costs nothing and no model is involved.
  const bySweep = new Map(scored.map((c) => [c.mint, c]));
  let screenPassed = 0, screenHeld = 0;
  for (const row of funnel.dueForScreen(400)) {
    const c = bySweep.get(row.mint);
    if (!c) continue;
    const kill = wouldSurviveScreen(c);
    if (funnel.recordScreen(row.mint, kill) !== "held") screenPassed++; else screenHeld++;
  }

  const shape = funnel.census();
  emit("funnel:shape", {
    watch: shape.watch, screened: shape.screened, studied: shape.studied, ready: shape.ready,
    screenPassed, screenHeld,
    expired: { screen: decayed.screenExpired, verdict: decayed.studyExpired,
               moved: decayed.movedOut, lostSight: decayed.dropped },
    note: `${shape.ready} researched and ready before a slot even opens`,
  });

  /* PICK FROM THE STANDING POOL, not from the last ninety seconds of sweeping.
   *
   * A good name screened twenty minutes ago is still a candidate here. Under the old
   * selection it had been forgotten and was re-discovered from scratch, at full price,
   * every single pass. The board is kept as the fallback for a cold funnel — a first
   * boot, or a wiped database — because an empty funnel must not mean an idle desk. */
  const fromFunnel = funnel.dueForStudy(workups)
    .map((r) => bySweep.get(r.mint))
    .filter(Boolean);

  const shortlist = fromFunnel.length ? fromFunnel
    : board.cells.length ? selectAcrossBoard(board, workups)
    : selectShortlist(scored, workups);        // board empty too: fall back rather than idle
  emit("scout:shortlist", { count: shortlist.length, considered: universe.length,
    source: fromFunnel.length ? "funnel" : board.cells.length ? "board (funnel cold)" : "flat ranking",
    padMix: fromFunnel.length ? `${fromFunnel.filter((c) => canonicalLaunchpad(c.launchpad) === PREFERRED_PAD).length}/${fromFunnel.length} ${PREFERRED_PAD}` : null,
    mix: shortlist.map((c) => c.cellKey ?? c.category) });

  /* THE RESERVE BENCH.
   *
   * A slot lost to `no_data` is a slot lost for nothing. gather() fails before any
   * model is called, so an unreadable coin costs no money — but under the old loop it
   * still consumed one of the cycle's three chances, and the cycle ended having studied
   * one coin instead of three.
   *
   * That became common precisely BECAUSE of the two fixes above: skipping
   * recently-judged coins and screen-failures pushes the cycle further down the ranked
   * list into genuinely obscure micro-caps, which are exactly the coins with patchy
   * data. Ten `no_data` refusals in the last few minutes, against zero before.
   *
   * So an unreadable coin is replaced rather than mourned. Only free failures are
   * replaced — a coin that reached a seat and was refused has been PAID for and has
   * legitimately used its slot. */
  const bench = selectShortlist(
    scored.filter((c) => !shortlist.some((s) => s.mint === c.mint)),
    workups * 3);
  const queue = [...shortlist];
  let replaced = 0;

  /* 4. Only now does anything cost money — and now more than one coin at a time.
   *
   * COINS ARE INDEPENDENT OF EACH OTHER. A workup is eleven to thirteen model calls
   * with a genuinely sequential tail (red team, then risk, then the PM), so a single
   * coin cannot be made much faster — but nothing links one coin's workup to the next,
   * and the desk had never run two. Measured on the live server: a median of 8.6
   * minutes between full verdicts, which is a scheduling ceiling rather than a
   * thinking one.
   *
   * THE BUDGET STILL BINDS, and the work already running is RESERVED against it.
   * Re-reading the accumulator alone is not enough: a workup's cost lands only when it
   * finishes, so three workers checking a cap that nothing in flight has yet charged
   * would each start one more. Measured on a stub, three workers against a $3 cap at
   * $0.42 a workup overshot by $1.20 — half again the bound I had claimed. With every
   * running workup reserving its typical cost, the overshoot comes back to one workup,
   * which is the same bound the strictly-serial loop always had and the best any
   * check-then-spend scheme can offer. The daily budget and hourly pace brakes in
   * llm.js are untouched and absolute. Set PENTHOUSE_WORKUP_CONCURRENCY to 1 to
   * restore the old behaviour exactly. */
  /** Measured on the live desk: $135.71 of model spend across 323 workups in 24 hours. */
  const TYPICAL_WORKUP_USD = Number(process.env.PENTHOUSE_TYPICAL_WORKUP_USD || 0.42);
  const picks = [];
  let workedUp = 0;
  let stopped = null;
  const CONCURRENCY = Math.max(1, Math.min(6,
    Number(process.env.PENTHOUSE_WORKUP_CONCURRENCY || 3)));
  let cursor = 0;
  const studyOne = async (c) => {
    const hook = `house scan · ${c.category}${c.launchpad ? ` · ${c.launchpad}` : ""}`;
    let rec;
    try {
      rec = await runFor(null, () => workup(cycle, c.mint, hook, { alwaysTicket: SEQUENTIAL }));
    } catch (e) {
      // Out of credit is terminal: the remaining candidates cannot be worked up either,
      // and the cycle should end with what it has rather than crash the process.
      if (e instanceof OutOfCredit) {
        stopped = e.constructor.name === "BudgetExhausted" ? "daily budget reached" : "out of credit";
        emit("cycle:halted", { reason: e.constructor.name === "BudgetExhausted" ? "daily_budget" : "out_of_credit" });
        return "halt";
      }
      emit("cycle:error", { mint: c.mint, error: String(e.message) });
      return "error";
    }
    if (!rec || rec.outcome === "no_data") {
      // Free failure: nothing was asked of a model, so the slot is still unspent.
      // Pull the next coin off the bench rather than ending the cycle a candidate short.
      const next = bench.shift();
      if (next && queue.length < workups * 3) {
        replaced++;
        queue.push(next);
        emit("cycle:replaced", { dropped: c.pair?.baseSymbol ?? c.mint?.slice(0, 6),
          reason: "no_data", replacedWith: next.pair?.baseSymbol ?? next.mint?.slice(0, 6),
          note: "an unreadable coin costs nothing, so it must not cost a slot either" });
      }
      return "no_data";
    }
    workedUp++;                       // paid for, whatever the verdict turned out to be
    // THE COHORT. Every workup that got a verdict is a candidate, not only the ones
    // the CEO waved through — the mandate ranks the cohort and publishes its best.
    // Which of them are actually eligible is `eligibility()`'s job, and it refuses
    // every safety failure before conviction is even consulted.
    picks.push({ rec, category: c.category, launchpad: c.launchpad,
      conviction: rec.pm?.conviction ?? rec.conviction ?? null });
    return "studied";
  };

  let inFlight = 0;
  const worker = async () => {
    while (!stopped) {
      // Spend already charged, PLUS a reservation for every workup still running. The
      // reservation is what stops N workers from each starting one more against a cap
      // that nothing in flight has charged yet.
      const usedSoFar = spend.usd - startSpend;
      if (usedSoFar + inFlight * TYPICAL_WORKUP_USD >= CYCLE_BUDGET_USD) {
        stopped = `budget: $${usedSoFar.toFixed(2)} of $${CYCLE_BUDGET_USD}`;
        emit("cycle:budget", { usedUsd: Number(usedSoFar.toFixed(4)), capUsd: CYCLE_BUDGET_USD,
          inFlight, reservedUsd: Number((inFlight * TYPICAL_WORKUP_USD).toFixed(4)) });
        return;
      }
      // The queue grows while it is being walked: a free failure pushes a replacement
      // from the bench, and the cursor must see it.
      if (cursor >= queue.length) return;
      const coin = queue[cursor++];
      inFlight++;
      try { await studyOne(coin); } finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (CONCURRENCY > 1)
    emit("cycle:concurrency", { workers: CONCURRENCY, studied: workedUp,
      note: "coins are independent of one another; the budget cap is re-read per coin" });

  /* 5. THE COHORT PICK — of everything studied, publish the single best one.
   *
   * This replaced an absolute bar that produced 144 kills and zero calls across 177
   * workups. The bar is not lowered on SAFETY: eligibility() refuses every screened,
   * killed, vetoed, unexitable, stopless or refuted candidate first, and refuses the
   * team's own PASS on top of that. What changed is that a lack of CONVICTION — the
   * CEO holding, the PM wanting one more trigger — now ranks rather than blocks. */
  const opened = [];
  const { winner: arithmeticWinner, judged } = pickOne(picks);
  const eligible = judged.filter((j) => j.eligibility.eligible);

  /* THE SEAT THAT CHOOSES.
   *
   * pickOne ranks by arithmetic — tier x 100000 + conviction x 100 + composite — which
   * is defensible and blind. It cannot see that one coin's story is a trend three hours
   * old while another's peaked yesterday, or that a real account with reach posted one
   * and a bought network posted the other. Those decide a memecoin, and a weighted
   * average of five scores cannot represent them.
   *
   * So an agent picks, from the eligible field only. Everything in front of it has
   * already cleared the safety screen, the analysts, the red team and compliance — it
   * cannot admit a honeypot because none reaches it. The arithmetic winner stays as the
   * fallback for when the seat errors or names something that is not on the list. */
  let winner = arithmeticWinner;
  if (eligible.length > 1) {
    try {
      const bp = await runFor(null, () => runBestPick(eligible));
      const chosen = eligible.find((j) => j.rec?.mint === bp?.pick_mint);
      if (chosen) {
        winner = chosen;
        winner.bestPick = bp;
        emit("bestpick:chose", { symbol: bp.pick_symbol, mint: bp.pick_mint,
          why: bp.why, edge: bp.edge, expected: bp.expected_move,
          confidence: bp.confidence, runnerUp: bp.runner_up_mint,
          overrodeArithmetic: arithmeticWinner?.rec?.mint !== bp.pick_mint });
      } else {
        emit("bestpick:unusable", { named: bp?.pick_mint ?? null, candidates: eligible.length,
          note: "the seat named something not on the list — falling back to the ranking" });
      }
    } catch (e) {
      emit("bestpick:failed", { error: String(e?.message || e),
        note: "falling back to the arithmetic ranking rather than skipping the cycle" });
    }
  }
  /* Write every paid verdict back, so the next pass INHERITS it instead of re-buying
   * it. This is the half of the funnel that actually saves money — the screen is free,
   * the workup is not, and until now the desk paid for the same answer about the same
   * coin every time it came round again. */
  for (const j of judged) {
    try {
      funnel.recordStudy(j.rec?.mint, {
        eligible: !!j.eligibility.eligible,
        verdict: j.rec?.pm?.decision ?? null,
        conviction: j.rec?.pm?.conviction ?? j.eligibility.score ?? null,
        thesis: j.rec?.pm?.thesis ?? null,
      });
    } catch { /* bookkeeping must never be able to fail a cycle */ }
    if (j.eligibility.eligible) continue;
    emit("cohort:declined", { mint: j.rec?.mint, symbol: j.rec?.symbol,
      safety: j.eligibility.safety, reason: j.eligibility.reason });
  }
  emit("cohort:ranked", { studied: judged.length,
    eligible: judged.filter((j) => j.eligibility.eligible).length,
    winner: winner ? { symbol: winner.rec?.symbol, tier: winner.eligibility.tier,
      why: winner.eligibility.reason } : null });

  if (winner) {
    const pub = publishCall(winner.rec, { category: winner.category, launchpad: winner.launchpad, wx,
      bestPick: winner.bestPick ?? null });
    if (pub.callId) opened.push({ id: pub.callId, symbol: winner.rec?.symbol });
    // Out of the ready pool: the desk is holding this one, not still shopping for it.
    try { funnel.retire(winner.rec?.mint, "published as a call"); } catch {}
  }

  /* EVERY CYCLE ENDS IN A TRADE — and this is where that instruction is safe to obey.
   *
   * The eligible field has already cleared the free safety screen, all five analysts,
   * the red team and compliance. Nothing in it is a honeypot, nothing in it is
   * unsellable, nothing in it was launched by a farm. So if the first choice could not
   * be published for a reason that is NOT about the coin — the book filled, a weather
   * veto, a race with another lane — the desk takes the next eligible candidate rather
   * than ending the cycle empty.
   *
   * It walks the field in order and stops at the first one that lands. What it will
   * never do is reach past eligibility: a cycle where every candidate failed a measured
   * safety fact ends with no call, and says so. That is not the desk refusing to
   * decide, it is the market not having offered anything holdable. */
  if (!opened.length && eligible.length > 1) {
    for (const cand of eligible) {
      if (cand === winner) continue;
      const pub = publishCall(cand.rec, { category: cand.category, launchpad: cand.launchpad, wx });
      if (pub.callId) {
        opened.push({ id: pub.callId, symbol: cand.rec?.symbol });
        emit("mandate:fellback", { symbol: cand.rec?.symbol,
          from: winner?.rec?.symbol ?? null,
          note: "the first choice could not be published — took the next eligible rather than ending empty" });
        break;
      }
    }
  }

  /* THE MANDATE — every cycle ends in a call. Not by lowering the bar: by
   * refusing to stop interviewing. If the shortlist pass opened nothing, the
   * desk keeps working straight down the ranked list — same gauntlet per coin,
   * more coins — until a call is published, the ranked market is exhausted, or
   * the daily money brake calls time. Those are the only three exits: the
   * mandate can spend the whole day's budget hunting, but it cannot force a
   * seat to lie, because a forced call is just a loss with paperwork. */
  if (!opened.length && process.env.PENTHOUSE_MUST_CALL !== "0") {
    const alreadyTried = new Set(shortlist.map((c) => c.mint));
    let hunted = 0;
    /* THE HUNT NEEDS A CLOCK TOO.
     *
     * It walks the ENTIRE ranked list — some eighty coins — and its only exits were a
     * published call, an exhausted market, or the money brake. But a coin that dies at
     * the free screen costs NOTHING, so the money brake never trips on the common
     * case: the hunt just keeps going, paying a `gather()` round trip per coin, for as
     * long as the market is large.
     *
     * That is the second half of why cycles were not finishing. The first was the
     * whale loop before the cohort pick; this is the same disease after it —
     * `cohort:ranked` fired ten minutes ago while `cycle:end` was still hours old.
     * An unbounded loop of cheap operations is still unbounded.
     *
     * A cycle that ends without a call is a fine outcome and the record already says
     * so. A cycle that never ends says nothing at all. */
    const huntDeadline = Date.now() + Number(process.env.PENTHOUSE_HUNT_BUDGET_MS || 240_000);
    const huntMax = Number(process.env.PENTHOUSE_HUNT_MAX || 12);
    for (const c of scored) {
      if (opened.length) break;
      if (hunted >= huntMax) {
        emit("cycle:hunt_capped", { hunted, note: `stopped after ${huntMax} candidates — the cycle must end` });
        break;
      }
      if (Date.now() > huntDeadline) {
        emit("cycle:hunt_timeboxed", { hunted, note: "out of time — a cycle that never ends reports nothing" });
        break;
      }
      if (alreadyTried.has(c.mint) || liveCallFor(c.mint) || store.recentlyJudged(c.mint)) continue;
      if (wx.regime === "risk_off" && c.category === "established") continue;
      // The screen is free and already knows the answer for most of these. Paying a
      // gather() round trip to rediscover it is the loop's whole cost.
      const doomed = wouldSurviveScreen(c);
      if (doomed) continue;
      hunted++;
      emit("cycle:hunting", { symbol: c.pair?.baseSymbol, score: c.score, hunted });
      let rec;
      try {
        rec = await runFor(null, () => workup(cycle,
          c.mint, `the mandate · hunting for this cycle's call · ${c.category}${c.launchpad ? ` · ${c.launchpad}` : ""}`,
          { alwaysTicket: SEQUENTIAL }));
      } catch (e) {
        if (e instanceof OutOfCredit) {
          stopped = e.constructor.name === "BudgetExhausted" ? "daily budget reached mid-hunt" : "out of credit mid-hunt";
          emit("cycle:halted", { reason: "hunt_budget" });
          break;
        }
        emit("cycle:error", { mint: c.mint, error: String(e.message) });
        continue;
      }
      if (!rec || rec.outcome === "no_data") continue;
      workedUp++;
      const pub = publishCall(rec, { category: c.category, launchpad: c.launchpad, wx });
      if (pub.callId) opened.push({ id: pub.callId, symbol: rec.symbol });
    }
    if (!opened.length && !stopped)
      emit("cycle:hunt_dry", { hunted, note: "the ranked market offered no coin that cleared the SAFETY gauntlet — " +
        "the mandate ranks conviction, it never overrides a measured fact, so a market of honeypots ends in no call" });
  }

  const cost = spend.usd - startSpend;
  emit("cycle:end", { cycle, count: opened.length, spendUsd: Number(cost.toFixed(4)), stopped });
  return { cycle, considered: universe.length, ranked: scored.length,
    workedUp, approved: picks.length, opened: opened.length, replacedUnreadable: replaced,
    costUsd: Number(cost.toFixed(4)), costPerWorkup: workedUp ? Number((cost / workedUp).toFixed(2)) : null,
    stopped };
}

/**
 * Watch the open calls. Deliberately cheap: prices and chain flags only, no model calls,
 * so it can run often without the monitoring costing more than the research.
 */
/* THE FRESH LANE. A six-hour cycle is never early. This runs cheap and often:
 * sweep, keep only coins under 48h old, rank them, and only when the best one
 * shows real ignition does it earn a full workup — one per scan, the budget
 * brake underneath as always. Early is a schedule, not a speed. */
/**
 * THE ONE ROAD from a workup to a live, broadcast call. Every lane — the cohort pick,
 * the mandate hunt, fresh ignition, watch promotion — publishes through here, so the
 * gates can never drift apart between them.
 *
 * Two things are enforced here and nowhere else, because here is the only place they
 * cannot be bypassed:
 *
 *   THE BOOK GATE. One live call at a time. Four lanes run on four different timers;
 *   without a check at the single choke point, two of them firing a minute apart would
 *   quietly put the desk two positions deep and break the mandate the owner asked for.
 *
 *   ELIGIBILITY. Which is where safety lives — screened, killed, vetoed, unexitable,
 *   stopless, refuted and PASSed candidates are refused by mandate.js before conviction
 *   is consulted at all. The mandate lowered the CONVICTION bar; it did not touch this.
 */
export function publishCall(rec, { category = null, launchpad: pad = null, wx = null,
  toFloors = null, bestPick = null, sourceFloor = null } = {}) {
  const e = eligibility(rec);

  /* RECORD THE VERDICT HERE, because this is the one place EVERY lane converges.
   *
   * The funnel was being written only by the main cohort loop, so the hunt lane and the
   * fresh lane paid for workups the funnel never heard about. The instrument then read
   * studied=0 while the desk was visibly producing PM decisions — a number that was
   * wrong in the direction of "nothing is happening", which is the worst direction for
   * a number to be wrong in and cost an hour today already.
   *
   * The UPDATE is keyed on the mint and is a no-op for a coin the funnel has not seen,
   * so recording twice for the main cohort is harmless. */
  try {
    funnel.recordStudy(rec?.mint, {
      eligible: !!e.eligible,
      verdict: rec?.pm?.decision ?? null,
      conviction: rec?.pm?.conviction ?? null,
      thesis: rec?.pm?.thesis ?? null,
    });
  } catch { /* bookkeeping must never be able to fail a publish */ }

  if (!e.eligible) {
    emit("call:withheld", { mint: rec?.mint, symbol: rec?.symbol,
      safety: e.safety, reason: e.reason });
    /* THE SHADOW BOOK. Every refusal is written down with the price it was refused at,
     * so the desk can later be graded on what it turned DOWN. Without this, "we are
     * being appropriately careful" and "we are missing everything" are the same
     * observation — which is exactly the argument ZCAT started. */
    try {
      const ev = rec?.ev ?? {};
      shadow.recordRefusal({
        mint: rec?.mint, symbol: rec?.symbol ?? ev.symbol,
        stage: rec?.outcome === "screened_out" ? "screen"
             : rec?.outcome === "killed" ? "seat"
             : rec?.compliance?.pass === false ? "compliance" : "mandate",
        reason: e.reason, safety: e.safety,
        priceUsd: ev.pair?.priceUsd, mcapUsd: ev.pair?.marketCap ?? ev.pair?.fdv,
      });
    } catch {}
    return { outcome: e.safety ? "unsafe" : "declined", reason: e.reason };
  }

  // MURDOCK's weather veto. Not in eligibility() because it is a fact about the
  // MARKET rather than about the token, and only the cycle knows the weather.
  if (wx?.regime === "risk_off" && category === "established") {
    emit("call:withheld", { mint: rec.mint,
      reason: `MURDOCK: not flying weather — ${majorWeather(wx)} over 25d` });
    return { outcome: "withheld", reason: "risk_off" };
  }

  const book = bookState();
  if (book.full) {
    emit("call:withheld", { mint: rec.mint, symbol: rec.symbol,
      reason: `already holding ${book.holding?.symbol ?? "a position"} — one call at a time` });
    return { outcome: "book_full", reason: "position_open" };
  }

  const ev = rec.ev ?? {};
  const call = openCall({
    mint: rec.mint, symbol: rec.symbol ?? ev.symbol, category, launchpad: pad,
    sourceFloor,
    sourceScope: sourceFloor == null || Number(sourceFloor) === 50 ? "house" : "tenant",
    sourceAttributed: true,
    conviction: rec.pm?.conviction ?? null,
    imageUrl: ev.pair?.imageUrl ?? null,
    entryRef: ev.pair?.priceUsd ?? null,
    stop: Number(rec.ticket?.stop_price),
    target: rec.ticket?.take_profit?.[0]?.price ?? null,
    thesis: rec.pm?.thesis ?? null,
    invalidation: rec.pm?.invalidation ?? null,
    flags: contractFlags(ev).readable ? contractFlags(ev).flags : null,
    liqUsd: ev.pairs?.totalLiquidityUsd ?? ev.pair?.liquidityUsd ?? null,
    rtLossPct: ev.exitProbe?.roundTripLossPct ?? null,
    // The flat gas toll and the ETH mark the bundle measured (evidence contract
    // exitProbe.gasUsdRoundTrip, ethUsd.value): copy.js sizes every tenant from these.
    gasUsdRoundTrip: ev.exitProbe?.gasUsdRoundTrip ?? null,
    ethUsd: ev.ethUsd?.value ?? null,
    // Preserve the team's actual authorization. Floors may be more conservative,
    // but they may never silently throw this away and size larger on their own.
    deskSizeUsd: rec.order?.size ?? rec.ceo?.order_size_usd ?? rec.risk?.position_size_usd ?? null,
    deskRiskUsd: rec.risk?.max_loss_usd ?? null,
    deskEquityUsd: cfg.equityUsd,
    // Stored so a tenant's micro / low / mid sleeve filter has a number to test.
    mcapUsd: ev.pair?.marketCap ?? ev.pair?.fdv ?? null,
    reportFile: rec.reportFile ?? null,
  });
  if (call) {
    const evidenceLinked = linkPublishedCall(rec.decisionRunId, call.id, { floorNo: sourceFloor });
    if (evidenceLinked) {
      /* Provenance rows carry NO mark. They used to pass call.entry_ref, so one
       * observation wrote two-to-three identical marked rows and the two-witness pair
       * rule saw a single read "confirm" itself — silently voiding the invariant for
       * any event kind that writes a mark. The entry price already lives on
       * calls.entry_ref; these rows are narrative, not observations. */
      noteEvent(call.id, "evidence", "linked to immutable decision evidence");
    } else {
      // Direct/manual callers may not carry a decision row. Keep the call operational,
      // but exclude it from policy-learning evidence and make the gap visible.
      noteEvent(call.id, "evidence_unlinked",
        "not eligible for strategy scorecards: no matching attributed decision");
      emit("call:evidence-unlinked", { callId: call.id, sourceFloor });
    }
    // The record shows HOW FAR DOWN the desk reached for this one. A tier-4 call is
    // an approval; a tier-1 call is the mandate taking the cohort's best available
    // when nothing was approved. Both are legitimate, and they are not the same
    // thing, so the difference goes on the call rather than into a footnote.
    noteEvent(call.id, "mandate", `${e.reason} (tier ${e.tier})`);
    // Why the choosing seat picked THIS one, on the call itself — so the record shows
    // the reasoning next to the outcome rather than only the outcome.
    if (bestPick?.why)
      noteEvent(call.id, "bestpick",
        `${bestPick.why} | edge: ${bestPick.edge} | expects ${bestPick.expected_move} | worst case: ${bestPick.worst_case}`);
    /* THE HOUSE TRADES ITS OWN CALLS TOO.
     *
     * `owned` alone meant floor 50 — the HQ, whose state is 'hq' because it is never
     * for sale — was the one floor that never received the calls it had just written.
     * The desk published for everybody except itself, so the house could not put a
     * cent behind its own research and had no skin in the game its tenants took on.
     *
     * The HQ is fed through exactly the same road as a tenant: a delivery row, its own
     * copy settings, its own executor secret, and a poller the owner runs on their own
     * machine with their own wallet. The server gains no key and no custody by this —
     * it still only publishes rows. What changes is that the house eats its own
     * cooking, and its results land in the same graded record as everyone else's. */
    /* `toFloors` narrows the audience to one desk. A tenant's OWN paid research run
     * publishes through here, and the coin it approved is theirs — one floor spending
     * 250,000 $CLAUDECO must not put every other floor into a position. Only the house
     * lanes broadcast to the whole building. */
    const floors = toFloors ?? listFloors()
      .filter((f) => f.state === "owned" || f.n === HQ_FLOOR)
      .map((f) => f.n);
    if (floors.length) broadcast(call.id, floors);
    emit("call:published", { callId: call.id, symbol: call.symbol, tier: e.tier, why: e.reason });
    return { outcome: "published", callId: call.id, tier: e.tier };
  }
  return { outcome: "open_failed" };
}

/**
 * THE PROMOTION PASS — the criteria, acted on. Free until a watch's rules hold;
 * then ONE promoted token per pass goes back through the entire paid gauntlet
 * with the watch context in its hook. Promotion buys a re-examination, never a
 * shortcut: the analysts, red team, risk, PM, compliance and CEO all sit again.
 */
let promoteBusy = false;
export async function promoteWatches() {
  if (promoteBusy) return { skipped: "busy" };
  // One trade at a time: a promotion cannot open a second position, so it must not
  // pay for a workup it could never publish either.
  const book0 = bookState();
  if (book0.full) return { skipped: "position_open", holding: book0.holding?.symbol ?? null };
  promoteBusy = true;
  try {
    const { checkWatchlist } = await import("./watchlist.js");
    const { checked, promoted } = await checkWatchlist();
    if (!promoted.length) return { checked, promoted: 0 };
    /* THE THIRD LANE THAT NEVER LEARNED THE SCREEN.
     *
     * `too_big` kept firing after both the cycle and the fresh lane were fixed, because
     * this one still worked up whatever the watchlist promoted. Watches were added
     * before the market-cap ceiling existed, so the list is full of coins the desk
     * would now refuse on sight — and promoting one buys a workup to rediscover that.
     *
     * A promotion means "the rules I set have held". It does not mean the coin is still
     * something this desk trades. */
    const w = promoted.find((x) => {
      if (liveCallFor(x.mint)) return false;
      const doomed = x.pair ? wouldSurviveScreen(x) : null;
      if (doomed) {
        emit("watch:stale", { mint: x.mint, symbol: x.symbol, reason: doomed,
          note: "watched before the screen moved — it would be refused on arrival" });
        return false;
      }
      return true;
    });
    if (!w) return { checked, promoted: promoted.length, outcome: "none still tradeable" };

    const hook = `watch promoted \u00b7 ${w.symbol ?? w.mint.slice(0, 6)} \u00b7 rules held: ` +
      Object.entries(w.rules).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(", ");
    const rec = await runFor(null, () => workup(new Date().toISOString().replace(/[:.]/g, "-"), w.mint, hook,
      { alwaysTicket: SEQUENTIAL, lane: "promote" }));

    let category = null, pad = null;
    try {
      const c = { mint: w.mint, pair: rec?.ev?.pair };
      category = classify(c).category; pad = launchpad(c);
    } catch {}
    const pub = publishCall(rec, { category, launchpad: pad });
    return { checked, promoted: promoted.length, workedUp: 1, outcome: pub.outcome };
  } catch (e) {
    if (e instanceof OutOfCredit) return { halted: e.message };
    return { error: String(e.message || e) };
  } finally { promoteBusy = false; }
}

/**
 * THE NAMING RACE — the Grok-trade mechanism, read off the chain instead of X.
 *
 * The documented $42k-in-15-minutes Grok trade worked like this: a high-reach
 * X event with a NAMEABLE gap fires, dozens of tokens launch racing to claim
 * the name, one wins the race and runs 11x while the rest die. We do not need
 * an X feed to see the race: when several very young launches share a name
 * inside the same few hours, that cluster IS the on-chain shadow of a trending
 * event. The tradeable fact is the race itself — back only the coin WINNING it
 * (deepest book + our normal ignition read), and mark the losers untouchable,
 * because a naming race pays exactly one winner.
 */
export function namingRaces(universe) {
  // The chain's own nouns are not a theme: on 4663 every fourth launch is a "hood" or
  // "robinhood" something, the way every fourth pump.fun launch was a "sol" something.
  const stop = new Set(["coin", "token", "the", "official", "meme", "pons", "hood", "robinhood", "eth", "inu", "ai"]);
  const clusters = new Map();
  for (const c of universe) {
    const age = c.pair?.ageHours ?? 0;
    if (age <= 0 || age > 12) continue;                       // the race is hours old, not days
    const words = `${c.pair?.baseSymbol ?? ""} ${c.pair?.baseName ?? ""}`
      .toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
    for (const w of new Set(words)) {
      if (!clusters.has(w)) clusters.set(w, []);
      clusters.get(w).push(c);
    }
  }
  const races = new Map();   // mint -> {theme, size, leader}
  for (const [theme, coins] of clusters) {
    const distinct = [...new Map(coins.map((c) => [c.mint, c])).values()];
    if (distinct.length < 4) continue;                        // four rivals in 12h = an event, not a coincidence
    distinct.sort((a, b) => (b.pair?.liquidityUsd ?? 0) - (a.pair?.liquidityUsd ?? 0));
    const leader = distinct[0].mint;
    for (const c of distinct) {
      const prev = races.get(c.mint);
      if (!prev || distinct.length > prev.size)
        races.set(c.mint, { theme, size: distinct.length, leader: c.mint === leader });
    }
  }
  return races;
}

let freshBusy = false;
/**
 * THE LORE LANE'S ONE HANDOFF.
 *
 * scanTrends pays Grok to read what X is accelerating on and then finds the coin
 * wearing that story. Until now the caller logged the winner's name and dropped it, so
 * the desk was buying a front-run signal every twelve minutes and throwing the answer
 * away — the one thing the lane exists to produce. This takes the top candidate through
 * exactly the same gauntlet as every other coin: same screen, same seats, same red team,
 * same publish. Being early is a reason to LOOK, never a reason to skip a check.
 */
export async function trendHandoff(candidates = []) {
  const top = candidates[0];
  if (!top?.mint) return { workedUp: 0, note: "no candidate" };
  if (liveCallFor(top.mint)) return { workedUp: 0, note: "already live" };
  // Same phase rule as every other lane: a curve coin is watched, never paid for.
  const phase = launchPhaseOf(top);
  if (phase != null && phase !== "graduated")
    return { workedUp: 0, note: `on its curve (launch.phase = ${phase}) — watch only` };
  const book = bookState();
  if (book.full) return { workedUp: 0, halted: `book full at ${book.live}` };
  const hook = `trend front-run \u00b7 "${top.theme}" (${top.stage ?? "?"}) \u00b7 ` +
    `${top.whyNow ?? ""} \u00b7 establish whether THIS is the canonical token for that story; ` +
    "a naming race pays one winner and the rest are exit liquidity";
  const rec = await runFor(null, () => workup(
    new Date().toISOString().replace(/[:.]/g, "-"), top.mint, hook,
    { alwaysTicket: SEQUENTIAL, lane: "trend" }));
  /* The pad is the candidate's OWN, from the dex id the sweep saw — never a literal.
     Every trend call used to be labelled "pump.fun" whatever it was, which mislabelled
     the record and, worse, keyed the creator-sold tripwire off a fiction. */
  let pad = canonicalLaunchpad(top.launchpad) ?? null;
  if (!pad) { try { pad = canonicalLaunchpad(launchpad(top.mint, top.dexId ?? top.pair?.dexId ?? null)); } catch { pad = null; } }
  const pub = publishCall(rec, { category: rec?.ev?.category ?? "memecoin", launchpad: pad });
  return { workedUp: 1, symbol: top.symbol, theme: top.theme, launchpad: pad,
    outcome: pub.outcome ?? rec?.outcome ?? rec?.finalDecision };
}

export async function freshScan({ minScore = 45 } = {}) {
  if (freshBusy) return { skipped: "busy" };
  // Same rule as every other lane: while a call is working, the fresh lane does not
  // buy a workup it has no seat to publish into.
  const book0 = bookState();
  if (book0.full) return { skipped: "position_open", holding: book0.holding?.symbol ?? null };
  freshBusy = true;
  try {
    const universe = (await sweep()).map(canonicalCandidate);
    const races = namingRaces(universe);
    const young = [];
    for (const c of universe) {
      if (!c?.mint || liveCallFor(c.mint)) continue;
      // Already judged this coin in the last 6h — a 5-minute lane must not pay
      // to re-ask the same question until circumstances change (that is what
      // the watchlist is for).
      if (store.recentlyJudged(c.mint)) continue;
      const age = c.pair?.ageHours ?? 0;
      if (age <= 0 || age >= 48) continue;
      /* Pre-screen from pair data already in hand: the lane's one workup slot must not
       * be spent on a coin the free screen will kill on arrival — its first champion
       * scored 52 on ignition and died of thin_liquidity.
       *
       * This used to be hand-rolled here, checking liquidity, volume and transactions
       * with its own inline defaults — and when the market-cap ceiling was added to the
       * screen, this copy never learned about it. So the 5-minute lane kept buying
       * workups on coins over the ceiling, and `too_big` became the desk's single most
       * common refusal at 21 occurrences. Two lanes with two copies of one rule is a
       * bug waiting for the next threshold to move; both now call the same function. */
      const wouldDie = wouldSurviveScreen(c);
      if (wouldDie) continue;
      const cat = classify(c);
      const r = rank(c);
      // The race adjustment: the winner of a live naming race gets the seat;
      // the losers are untouchable at any score — the race pays one coin.
      const race = races.get(c.mint);
      if (race) {
        if (race.leader) { r.score += 18; r.why.push(`winning a naming race: ${race.size} launches chasing "${race.theme}"`); }
        else { r.score -= 40; r.why.push(`losing a naming race for "${race.theme}" — the winner takes it all`); }
      }
      if (r.score <= 0) continue;
      young.push({ ...c, category: cat.category, score: r.score, rankWhy: r.why,
        race: race?.leader ? race : null });
    }
    young.sort((a, b) => b.score - a.score);
    const top = young[0];
    emit("fresh:scan", { considered: universe.length, young: young.length,
      top: top ? { symbol: top.pair?.baseSymbol, score: top.score } : null });
    if (!top || top.score < minScore) return { young: young.length, workedUp: 0 };

    const hook = `fresh scan \u00b7 ignition \u00b7 ${top.category}${top.launchpad ? ` \u00b7 ${top.launchpad}` : ""}` +
      (top.race ? ` \u00b7 WINNING A NAMING RACE: ${top.race.size} fresh launches share "${top.race.theme}" \u2014 ` +
        `establish which X event fired this race and whether THIS is the canonical token for it; ` +
        `the race pays one winner and the rest go to zero` : "");
    const rec = await runFor(null, () => workup(new Date().toISOString().replace(/[:.]/g, "-"), top.mint, hook,
      { alwaysTicket: SEQUENTIAL, lane: "fresh" }));
    const pub = publishCall(rec, { category: top.category, launchpad: top.launchpad });
    return { young: young.length, workedUp: 1, outcome: pub.outcome ?? rec?.outcome ?? rec?.finalDecision };
  } catch (e) {
    if (e instanceof OutOfCredit) return { halted: e.message };
    return { error: String(e.message || e) };
  } finally { freshBusy = false; }
}

let monitorBusy = false;
/**
 * SUB-TICK MARKS — cheap price witnesses between full monitor passes.
 *
 * The two-witness high (snipe-v3) assumed witnesses ~15s apart; the server's monitor
 * writes ONE mark per pass, default ten minutes — a 40x gap that made any pump peaking
 * inside a single pass one-witness forever. This loop writes a consensus price for
 * every LIVE call — one free DexScreener read per call, no models — so the pair rule
 * has honest neighbours to confirm against.
 *
 * The fourth review rebuilt three parts of the first version:
 *
 * SINGLE-FLIGHT, MINIMUM SPACING. Office mode arms two start paths, and two identical
 * intervals firing back-to-back wrote near-duplicate marks that satisfied the
 * two-witness rule by racing it — one anomalous DexScreener cache interval became its
 * own second witness. startSubTickMarks arms once per process, the loop refuses to
 * overlap itself, and a mark is only written if the newest existing mark is at least
 * half the cadence old — witnesses must be SEPARATED OBSERVATIONS, whoever writes them.
 *
 * CLOSE PRINTS ANCHOR TO THE MARK BEFORE THEM, NOT THE PRICE AFTER. The first version
 * compared the close print to a read up to ten minutes LATER, direction-blind — so an
 * honest stop close during a continuing dump was "restated" to the post-crash price,
 * corrupting the very stats it was guarding. What distinguishes an anomalous print is
 * that it disagrees with its neighbours on BOTH sides: the print is restated only when
 * it is >30% from the last pre-close mark AND the post-close read agrees with that
 * pre-close mark (the print is the odd one out). An honest close in a moving market
 * agrees with its pre-close neighbour and is confirmed untouched. No pre-close mark
 * within ten minutes -> confirm as-is; one witness cannot convict another.
 *
 * CONFIRMED MEANS FINISHED. Both UPDATEs carry close_confirmed IS NULL, so a settled
 * print can never be re-opened by a later pass or an overlapping loop.
 *
 * Documented residual: the Colonel debrief fires once at close with the provisional
 * print and is not re-run on a restatement — the ~45s window makes a divergence rare,
 * and a wrong debrief narrative is recoverable where a wrong stat is not.
 */
let _subTickArmed = false;
let _subTickBusy = false;
let _subTickSecs = 45;

/* ONE WINDOW for post-close witnessing AND adjudication. The seventh review found
 * them split — witnesses were WRITTEN for 15 minutes after a close while the confirm
 * loop only READ 10 minutes and declared "no second witness will ever come" at the
 * same 10 — so a witness recorded at minute 11, seconds earlier in the very same
 * pass, was permanently ignored and the fake print it would have convicted was
 * confirmed. Two numbers describing one contract will drift; one number cannot. */
const WITNESS_WINDOW_MS = 15 * 60e3;

/**
 * THE ONE DOOR A WITNESS MARK ENTERS BY. The spacing rule ("witnesses must be
 * separated observations") was enforced only inside subTickMarks, while monitorCalls
 * wrote its own mark unconditionally — so a monitor pass overlapping a sub-tick pass
 * could write the same anomalous DexScreener cache interval twice, seconds apart, and
 * the pair rule confirmed the anomaly off its own echo. Every mark writer goes
 * through here now; a mark younger than half the sub-tick cadence is the same
 * observation, whoever fetched it.
 */
export function writeWitnessMark(callId, mark) {
  if (!(mark > 0)) return false;
  const minSpacingMs = (_subTickSecs / 2) * 1000;
  const last = db.prepare(`SELECT MAX(ts) t FROM call_events
    WHERE call_id=? AND mark IS NOT NULL`).get(callId)?.t ?? 0;
  if (Date.now() - last < minSpacingMs) return false;
  noteEvent(callId, "mark", null, mark);
  return true;
}
/* A CALL WHOSE WHOLE LIFE IS SHORTER THAN A FEW MONITOR PASSES.
 *
 * The exit check runs on one flat ten-minute timer for every band, and the bands do not
 * have one flat life. A nano call is held between one and thirty MINUTES, so it was
 * looked at perhaps three times before it closed, and a coin that doubled and gave it
 * all back inside a single gap was recorded — and published — as whatever it happened
 * to be worth when the timer next fired. You cannot sell high at ten-minute resolution
 * on a thirty-minute position.
 *
 * The price is already in hand: the sub-tick fetches it for every live call every 45
 * seconds to write witness marks. Only the DECISION was waiting for the slow timer.
 *
 * The rule is a ratio rather than a list of band names, so it stays true if either
 * clock is retuned: a call is on the fast lane when its own hold window gives it fewer
 * than twelve chances to act on the slow timer. Today that is nano (30m) and micro
 * (1h); low, medium and high get 30 passes over 5h and very_high 144 over a day.
 *
 * IN BLOCKS, which is the unit this chain moves in: the slow timer is 6,000 blocks
 * (10 min at 100 ms), the sub-tick 450, and the nano window 18,000 — so a nano call
 * gets 3 slow passes and 40 sub-ticks. The hold windows themselves (bands.js) are the
 * owner's numbers and are not touched; only the comparison is stated in blocks, so the
 * ratio is read against the chain's cadence and not against Solana's 400 ms slots.
 */
export const FAST_LANE_MIN_PASSES = 12;
export const MONITOR_TICK_MS = () => Math.max(1, Number(process.env.PENTHOUSE_MONITOR_MINS || 10)) * 60_000;
/** Both clocks of a call, in blocks — what the fast-lane decision is actually about. */
export function exitClockBlocks(call, { monitorMs = null, subTickSecs = _subTickSecs } = {}) {
  const holdMax = Number(call?.hold_max_ms);
  if (!Number.isFinite(holdMax) || holdMax <= 0) return null;
  const slow = Number(monitorMs) > 0 ? Number(monitorMs) : MONITOR_TICK_MS();
  const holdBlocks = blocksFor(holdMax);
  const slowBlocks = blocksFor(slow);
  const subTickBlocks = blocksFor(Math.max(15, Number(subTickSecs) || 45) * 1000);
  return { holdBlocks, slowBlocks, subTickBlocks,
    slowPasses: holdBlocks / slowBlocks, subTicks: holdBlocks / subTickBlocks };
}
export function needsFastExitLane(call, { monitorMs = null } = {}) {
  const clocks = exitClockBlocks(call, { monitorMs });
  if (!clocks) return false;                                        // no clock, no fast lane
  return clocks.slowPasses < FAST_LANE_MIN_PASSES;
}

/* THE ONE PLACE A CALL IS CLOSED BY AN EXIT. Both the slow pass and the fast tick land
   here, so the debrief, the event and the tenant announcement cannot drift apart —
   and closeCall refuses a call that is not live, so the two clocks racing on the same
   coin is a no-op rather than a double exit. */
function fireExit(call, exit, mark, { lane = "monitor" } = {}) {
  const closedRow = closeCall(call.id, exit.code, mark);
  if (!closedRow) return false;                 // another pass got there first
  const landing = { ...call, closed_at: Date.now(), close_mark: mark, close_reason: exit.code };
  import("./agents/review.js").then((r) => runForEvidence({
    floor: call.source_floor ?? null,
    evidenceScope: call.source_attributed ? call.source_scope : "unattributed",
  }, () => r.runDebrief(landing))).catch(() => {});
  emit("call:exit", { callId: call.id, symbol: call.symbol, code: exit.code,
    urgency: exit.urgency, detail: exit.detail, mark, lane });
  announceExit(call, exit).catch((e) => noteEvent(call.id, "announce_failed", String(e.message || e)));
  return true;
}

export function startSubTickMarks(secs = 45) {
  if (_subTickArmed) return false;
  _subTickArmed = true;
  _subTickSecs = Math.max(15, Number(secs) || 45);
  setInterval(() => { subTickMarks().catch(() => {}); }, _subTickSecs * 1000);
  return true;
}

export async function subTickMarks() {
  if (_subTickBusy) return { marked: 0, confirmed: 0, skipped: "busy" };
  _subTickBusy = true;
  try {
    let marked = 0, confirmed = 0, fastClosed = 0;
    const minSpacingMs = (_subTickSecs / 2) * 1000;
    /* Witness marks flow for LIVE calls AND for closes still awaiting adjudication.
     * Both writers used to gate on status='live', and closeCall flips status first —
     * so no production path ever recorded a post-close mark, the confirm loop's
     * post-close witness was structurally NULL, and the entire restatement mechanism
     * was dead code that only its own test fixtures (which inserted marks by hand)
     * ever saw work. The sixth review proved it with the production path: a
     * manufactured 6x print confirmed unrestated. The lesson is the green-suite one
     * again: a fixture that hand-builds a world production cannot produce tests the
     * logic and not the system. */
    const live = db.prepare(`SELECT id, mint FROM calls WHERE status='live'
      UNION SELECT id, mint FROM calls
      WHERE status='closed' AND close_confirmed IS NULL AND closed_at > ?`)
      .all(Date.now() - WITNESS_WINDOW_MS);
    for (const call of live) {
      try {
        /* A short-clock call is read on every tick even when the witness door would
           refuse the mark, because here the price is not only a witness — it is the
           only chance this call gets to be sold at a sensible number. */
        const row = db.prepare("SELECT * FROM calls WHERE id=?").get(call.id);
        const fast = row?.status === "live" && needsFastExitLane(row);
        const last = db.prepare(`SELECT MAX(ts) t FROM call_events
          WHERE call_id=? AND mark IS NOT NULL`).get(call.id)?.t ?? 0;
        if (!fast && Date.now() - last < minSpacingMs) continue;   // a witness must be a separate observation
        const px = await ds.pairsFor(call.mint);
        if (!px?.ok) continue;
        const cons = ds.consensus(px.pairs);
        if (cons.ok && writeWitnessMark(call.id, cons.priceUsd)) marked++;

        /* THE FAST LANE. Price only — no flags, no round-trip probe, no liquidity read,
           because this tick does not gather them. evaluateExit skips every one of those
           triggers when its input is null, so the only thing that can fire here is the
           price policy: the stop, the target, the trailing take-profit and the band's
           own clock. The chain-failure exits stay on the full pass that can actually
           observe them, which is where they belong: they are facts about the token, and
           they need the bundle. flagsReadable is stated false so a call opened with
           known flags is never closed for "an authority appeared" on a read that never
           looked. */
        if (fast && cons.ok && cons.priceUsd > 0) {
          const exit = evaluateExit(row, { mark: cons.priceUsd, flagsReadable: false });
          if (exit.fire) {
            fastClosed++;
            fireExit(row, exit, cons.priceUsd, { lane: "subtick" });
          }
        }
      } catch { /* a failed read is a missing witness, never an error */ }
    }
    /* CLOSE-PRINT CONFIRMATION, adjudicated from HISTORY, bounded by CONSERVATISM.
     *
     * Fifth-review rebuild, two defects closed:
     *
     * NO STRANDING. The 10-minute eligibility window assumed a next pass would still
     * see the row — a DexScreener outage or a deploy restart (the very events that
     * produce bad prints) aged the row out unexamined, permanently provisional. Rows
     * stay eligible until confirmed (24h scan bound), and the post-close witness is
     * the first recorded MARK after the close — history, not a live read — so a late
     * pass adjudicates exactly what an on-time pass would have.
     *
     * A RESTATEMENT MAY NEVER FLATTER THE OUTCOME. The both-neighbours rule was
     * direction-blind: a real dump-wick stop close — where the exit alert went out at
     * the wick and follower bots actually sold there — V-bounced, agreed with both
     * neighbours as "anomalous", and was restated to breakeven while followers
     * realized -40%. The book must never diverge from follower reality in its own
     * favour: a restatement is applied only when it makes the recorded outcome WORSE
     * (shrinks a win), never better (never shrinks a loss, never grows a win). The
     * manufactured-6x-win case restates; the honest wick stands. */
    const recent = db.prepare(`SELECT id, mint, close_mark, closed_at, entry_ref FROM calls
      WHERE status='closed' AND close_confirmed IS NULL AND closed_at > ?`).all(Date.now() - 24 * 3600e3);
    for (const call of recent) {
      try {
        /* Witness KINDS only ('mark'/'ok'): closeCall's own 'closed' row carries the
         * print as a mark, and a 1ms clock skew put it AFTER closed_at — the print
         * became its own "first post-close witness" and, being earliest, preempted
         * every genuine one. A print must never adjudicate itself.
         *
         * And the pre-close lookback is an hour, not ten minutes: the realistic
         * producer of a bad print is a data outage, which is exactly what starves a
         * short window — the last honest mark sat 30 seconds outside the old cutoff
         * while the fake print confirmed unopposed. The 30% drift test does the real
         * discriminating; the window only has to contain a witness. */
        const preMark = db.prepare(`SELECT mark FROM call_events
          WHERE call_id=? AND mark IS NOT NULL AND kind IN ('mark','ok') AND ts < ? AND ts > ?
          ORDER BY ts DESC LIMIT 1`).get(call.id, call.closed_at, call.closed_at - 60 * 60e3)?.mark ?? null;
        const postMark = db.prepare(`SELECT mark FROM call_events
          WHERE call_id=? AND mark IS NOT NULL AND kind IN ('mark','ok') AND ts > ? AND ts < ?
          ORDER BY ts ASC LIMIT 1`).get(call.id, call.closed_at, call.closed_at + WITNESS_WINDOW_MS)?.mark ?? null;
        const windowOver = Date.now() > call.closed_at + WITNESS_WINDOW_MS;
        const settle = (restateTo = null, why = null) => {
          if (restateTo != null) {
            const r = db.prepare("UPDATE calls SET close_mark=?, close_confirmed=1 WHERE id=? AND close_confirmed IS NULL")
              .run(restateTo, call.id);
            if (r.changes) noteEvent(call.id, "close_restated", why);
          } else {
            db.prepare("UPDATE calls SET close_confirmed=1 WHERE id=? AND close_confirmed IS NULL").run(call.id);
          }
          confirmed++;
        };
        if (!(preMark > 0) || !(call.close_mark > 0)) { settle(); continue; }   // one witness cannot convict another
        const printDrift = Math.abs(call.close_mark - preMark) / preMark;
        if (printDrift <= 0.30) { settle(); continue; }                        // the print agrees with its neighbour
        if (!(postMark > 0)) {
          if (windowOver) settle();                                            // no second witness will ever come
          continue;                                                            // else wait for the next mark
        }
        const postAgreesWithPre = Math.abs(postMark - preMark) / preMark <= 0.30;
        if (!postAgreesWithPre) { settle(); continue; }                        // the market truly moved through the close
        /* Both neighbours agree the print is the outlier. Restate ONLY if doing so
         * makes the recorded outcome worse. The first version wrote that as
         * pnl(preMark) > pnl(print) with entry_ref in both terms — and entry CANCELS:
         * (preMark - e) > (print - e) is just preMark > print. Worse than redundant,
         * the null-entry guard forced `flatters` false for any call published during
         * a pair-read flake, INVERTING the rule: the one case it existed to prevent —
         * a wick loss restated up to breakeven — happened precisely there. The
         * algebra was the review's finding; the simpler form has no null case. */
        const flatters = preMark > call.close_mark;
        if (flatters) {
          settle(null);                                                        // an honest wick the desk really sold into
        } else {
          settle(preMark,
            `close print ${call.close_mark} was ${Math.round(printDrift * 100)}% from the pre-close mark ${preMark}, ` +
            `corroborated by the post-close mark ${postMark} — restated to ${preMark} (never in the book's favour)`);
        }
      } catch { /* unconfirmed stays unconfirmed; the next loop tries again */ }
    }
    return { marked, confirmed, fastClosed };
  } finally { _subTickBusy = false; }
}

export async function monitorCalls() {
  // Reentrancy: a slow pass (rate-limited RPC, many open calls) must not overlap
  // the next tick and double-fire the same exit.
  if (monitorBusy) return { skipped: "busy" };
  monitorBusy = true;
  try {
    /* Price the SHADOW BOOK on the same tick. These are coins the desk refused; they
     * cost nothing to follow (one free pair read each) and they are the only way to
     * find out whether the bar is calibrated or merely expensive. Done before the open
     * calls so an empty book does not skip it. */
    try {
      const shadows = shadow.openShadows(48, 12);
      for (const sh of shadows) {
        const px = await ds.pairsFor(sh.mint).catch(() => null);
        if (!px?.ok) continue;
        const cons = ds.consensus(px.pairs);
        const now = cons.ok ? cons.priceUsd : Number(px.pairs?.[0]?.priceUsd);
        if (now > 0) shadow.markChecked(sh.id, now);
      }
      if (shadows.length) {
        const card = shadow.scorecard({ sinceH: 168 });
        if (card.graded >= 5)
          emit("shadow:scorecard", { graded: card.graded, wouldHaveHit2x: card.wouldHaveHit2x,
            died: card.died, medianPeakPct: card.medianPeakPct, verdict: card.verdict });
      }
    } catch {}

    const open = liveCalls();
    if (!open.length) return { checked: 0, closed: 0 };
    let closed = 0;

    for (const call of open) {
      // Per-call containment: liveCalls() is newest-first, so one corrupted row
      // would otherwise block exit evaluation for every OLDER live call, forever.
      try {
        const ev = await gather(call.mint, "monitor");
        if (ev.error) {
          // The most dangerous case in the whole monitor: a token that has rugged or
          // been delisted stops returning data, so `continue` would leave the call
          // open forever — precisely when the holder most needs to be told to leave.
          // Persistent unreadability IS the signal.
          noteEvent(call.id, "check_failed", ev.error);
          const misses = (db.prepare(
            "SELECT COUNT(*) n FROM call_events WHERE call_id=? AND kind='check_failed' AND ts > ?")
            .get(call.id, Date.now() - 6 * 3600e3)?.n) ?? 0;
          if (misses >= 4) {
            closeCall(call.id, "went_dark", null);
            emit("call:exit", { callId: call.id, symbol: call.symbol, code: "went_dark", mark: null });
            announceExit(call, { code: "went_dark", urgency: "urgent",
              detail: "the token stopped returning market data — treat as gone and exit" }).catch(() => {});
          }
          continue;
        }

        const cf = contractFlags(ev);
        const now = {
          mark: ev.pair?.priceUsd ?? null,
          liqUsd: ev.pairs?.totalLiquidityUsd ?? ev.pair?.liquidityUsd ?? null,
          rtLossPct: ev.exitProbe?.roundTripLossPct ?? null,
          flags: cf.flags,
          flagsReadable: cf.readable,
        };
        /* ── SEA OTTER'S DECAY ────────────────────────────────────────────
           A thesis is not true forever just because price has not hit the stop.
           Every pass re-runs the deterministic screen: if the coin STILL clears
           the floor it was admitted on, the thesis is re-verified and its clock
           resets. If it stops clearing — liquidity gone, exit gone roachy, a new
           flag — the confidence decays from the last verification, and once it
           has halved the position leaves as STALE. That is an exit no stop would
           ever have produced, on a coin quietly rotting under a flat price. */
        try {
          const sc = screen(ev);
          if (sc.pass) {
            db.prepare("UPDATE calls SET last_verified_at=? WHERE id=?").run(Date.now(), call.id);
          } else {
            const since = call.last_verified_at ?? call.opened_at ?? Date.now();
            const hours = (Date.now() - since) / 3600e3;
            const halfLife = Number(process.env.THESIS_HALFLIFE_HOURS || 12);
            const confidence = Math.pow(0.5, hours / halfLife);      // 1 -> 0.5 -> 0.25
            noteEvent(call.id, "thesis_decay",
              `unverified ${hours.toFixed(1)}h · confidence ${(confidence * 100).toFixed(0)}% · ${sc.fails.map((f) => f.code).join(",")}`);
            if (confidence < 0.5) {
              closeCall(call.id, "thesis_stale", now.mark);
              emit("call:exit", { callId: call.id, symbol: call.symbol, code: "thesis_stale", mark: now.mark });
              announceExit(call, { code: "thesis_stale", urgency: "normal",
                detail: `the thesis has not re-verified for ${hours.toFixed(0)}h — it no longer clears the screen it was admitted on (${sc.fails.map((f) => f.code).join(", ")})` }).catch(() => {});
              continue;
            }
          }
        } catch { /* an unreadable screen never ages a thesis */ }

        const exit = evaluateExit(call, now);
        if (exit.fire) {
          /* COLONEL DEBRIEF grades the landing, the event goes out, and the tenant
             announcement is never awaited — thirty tenants with hung webhooks must not
             delay the NEXT call's exit check. All of it lives in fireExit now, shared
             with the fast lane so the two clocks cannot disagree about what an exit is. */
          if (fireExit(call, exit, now.mark)) closed++;
        } else {
          /* The 'ok' mark rides the shared spacing door: an overlapping sub-tick pass
           * must not let one DexScreener cache interval witness itself twice. When the
           * door refuses (a mark landed seconds ago), the heartbeat row is still
           * written — kind 'ok' with no mark — so pass accounting stays intact. */
          if (!writeWitnessMark(call.id, now.mark)) noteEvent(call.id, "ok", null, null);
        }
      } catch (e) {
        try { noteEvent(call.id, "check_failed", String(e.message || e)); } catch {}
      }
    }
    return { checked: open.length, closed };
  } finally { monitorBusy = false; }
}
