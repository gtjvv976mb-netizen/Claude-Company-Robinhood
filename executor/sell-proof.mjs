/**
 * PROVE THE EXIT BEFORE PAYING FOR THE ENTRY.
 *
 * The executor's preflight asks the aggregator for a reverse quote and takes its word for
 * it. A quote is an offer to route, not a demonstration that the tokens can leave this
 * wallet — and the gap between those two is every honeypot ever written: a token whose
 * transfer() reverts for everyone but the deployer quotes beautifully right up until you
 * own it.
 *
 * On this chain that gap cannot be traded out of. Ordering is first-come-first-served and
 * priority fees are refunded, so there is no paying your way out of a position whose
 * transfer has been switched off. The charter's hard constraints name "the sell
 * simulates" as a non-negotiable deterministic gate, and the executor — the last fence
 * before a signature — was the one place not checking it.
 *
 * WHAT THIS DOES: gives the wallet, for the length of ONE eth_call, the exact token
 * balance the buy is about to acquire and an allowance to the router, then executes the
 * real sell calldata against the real router and measures what comes back. Not a quote.
 * The sell, run.
 *
 * ── IT SHIPS FAIL-OPEN, AND THAT IS NOT TIMIDITY ────────────────────────────────────
 *
 * `proveExit()` returns a verdict; it never throws and it never refuses. Getting an
 * allowance slot wrong produces a false refusal on EVERY token, which is a bot that has
 * silently stopped trading — indistinguishable, from the outside, from a quiet market.
 * So this records into gate_observations as `exit_route_unproven` and the refusal is a
 * separate, later, deliberate promotion once observations-report.mjs shows the unreadable
 * rate over a real sample of coins the desk published. A lint that cries wolf gets
 * switched off; a gate promoted on evidence does not.
 *
 * ── THE THREE VERDICTS ARE THREE DIFFERENT FACTS ────────────────────────────────────
 *
 *   proven      the sell executed in simulation and returned at least the floor.
 *   refutable   the sell REVERTED, or returned less than the floor. This is the finding.
 *   unreadable  the node would not answer, or the slot scan found nothing. NOT a pass and
 *               NOT a refusal — the check failed to run, and saying otherwise is the
 *               fail-open-on-a-transport-error bug this repo has fixed twice already.
 */
import { findBalanceSlot, findAllowanceSlot, isTransportError, PROBE_EOA } from "./storage-slots.mjs";

export const EXIT_VERDICTS = Object.freeze(["proven", "refutable", "unreadable"]);
/** The gate name recorded into gate_observations, and later the refusal's clause name. */
export const EXIT_GATE = "exit_route_unproven";

const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const toHex = (n) => "0x" + BigInt(n).toString(16);

/**
 * @param call     (to, data, overrides, opts) => {ok, data} | {ok:false, error}
 * @param token    the ERC-20 about to be bought
 * @param amount   the raw token quantity the buy is expected to acquire
 * @param router   the address the sell calldata is sent to
 * @param data     the sell calldata, built for `wallet` selling `amount`
 * @param wallet   the address that will hold the position
 * @param floor    the minimum acceptable output, raw. Below it the exit is refutable.
 */
export async function proveExit(call, { token, amount, router, data, wallet = PROBE_EOA,
  floor = 0n, quotedOut = null, blockNumber = null, gasLimit = 3_000_000 } = {}) {
  const started = Date.now();
  const fail = (verdict, reason, extra = {}) =>
    ({ verdict, reason, gate: EXIT_GATE, tookMs: Date.now() - started, ...extra });

  try {
    if (!token || !router || !data) return fail("unreadable", "sell proof needs a token, a router and calldata");
    const amt = BigInt(amount ?? 0);
    if (!(amt > 0n)) return fail("unreadable", "sell proof needs the quantity the buy will acquire");

    const bal = await findBalanceSlot(call, token, { probe: wallet, blockNumber });
    if (!bal.ok)
      return fail("unreadable", bal.error, { transport: bal.transport === true, stage: "balance_slot" });
    const allow = await findAllowanceSlot(call, token, router, { probe: wallet, blockNumber });
    if (!allow.ok)
      return fail("unreadable", allow.error, { transport: allow.transport === true, stage: "allowance_slot",
        balanceSlot: String(bal.slot), slotKind: bal.kind });

    /* The wallet is given the position and the allowance for the length of this one call,
       and enough native balance to pay for it. Nothing is written; an eth_call override
       lives and dies inside the request. */
    const overrides = {
      [token]: { stateDiff: { [bal.keyFor(wallet)]: word(amt), [allow.key]: word(amt) } },
      [wallet]: { balance: toHex(10n ** 18n) },
    };
    const r = await call(router, data, overrides, { from: wallet, gas: toHex(gasLimit) });

    if (r && !r.ok && isTransportError(r.error))
      return fail("unreadable", `the sell simulation got no answer from the node (${r.error})`,
        { transport: true, stage: "simulate", balanceSlot: String(bal.slot), allowanceSlot: String(allow.slot), slotKind: bal.kind });

    if (r && !r.ok)
      /* A REVERT IS THE FINDING, not a failure to measure. This is the honeypot. */
      return fail("refutable", `the sell REVERTED in simulation: ${r.error}`,
        { reverted: true, revertReason: String(r.error).slice(0, 200), stage: "simulate",
          balanceSlot: String(bal.slot), allowanceSlot: String(allow.slot), slotKind: bal.kind });

    let out;
    try { out = BigInt(r?.data || "0x0"); }
    catch { return fail("unreadable", "the router returned nothing measurable", { stage: "decode" }); }

    const floorRaw = BigInt(floor ?? 0);
    const quoted = quotedOut == null ? null : BigInt(quotedOut);
    /* What the chain KEPT relative to the quote. A small negative is possible and is
       reported as such rather than clamped — the chain paying more than quoted is
       information, not an error. */
    const keptBps = quoted != null && quoted > 0n ? Number(((quoted - out) * 10_000n) / quoted) : null;
    const shape = { simulatedOut: out.toString(), floor: floorRaw.toString(),
      quotedOut: quoted == null ? null : quoted.toString(), effectiveTaxBps: keptBps,
      balanceSlot: String(bal.slot), allowanceSlot: String(allow.slot), slotKind: bal.kind, stage: "simulate" };

    if (out < floorRaw)
      return fail("refutable",
        `the sell executed but returned ${out} against a floor of ${floorRaw}` +
        (keptBps != null ? ` — the token kept ${keptBps} bps of the quote` : ""), shape);

    return { verdict: "proven", gate: EXIT_GATE, tookMs: Date.now() - started,
      reason: `the sell executed in simulation and returned ${out}` +
        (keptBps != null ? ` (${keptBps} bps under the quote)` : ""), ...shape };
  } catch (e) {
    /* NEVER THROWS. A measurement that can stop the bot trading inverts its own purpose. */
    return fail("unreadable", `sell proof threw: ${String(e?.message || e)}`, { threw: true });
  }
}

/** The journal verdict this maps to. `refutable` is what a promoted gate would kill on. */
export const observationVerdict = (proof) =>
  proof?.verdict === "proven" ? "pass" : proof?.verdict === "refutable" ? "would_refuse" : "unreadable";

/**
 * Record a proof into the journal, never throwing into the caller. `enforcing` says
 * whether the clause was allowed to kill at the time — an observe-only row and an
 * enforcing row are different evidence and a report that mixes them measures its own
 * promotion rather than the market.
 */
export function recordExitProof(journal, proof, { callId = null, mint = null, symbol = null,
  clipWei = null, enforcing = false } = {}) {
  if (!journal?.recordGateObservation) return { ok: false, error: "no journal" };
  /* THE JOURNAL'S OWN WRITER ALREADY SWALLOWS ITS FAILURES, AND THIS WRAPS IT ANYWAY.
     Not belt-and-braces for its own sake: this is the boundary the ENTRY PATH calls, and
     it must hold for any journal it is handed — a stub in a test, a future implementation,
     a mock that throws. The invariant belongs to the caller's safety, not to one
     implementation's politeness. */
  try {
    return journal.recordGateObservation({
      gate: EXIT_GATE,
      verdict: observationVerdict(proof),
      value: {
        reason: proof?.reason ?? null,
        simulatedOut: proof?.simulatedOut ?? null,
        floor: proof?.floor ?? null,
        effectiveTaxBps: proof?.effectiveTaxBps ?? null,
        slotKind: proof?.slotKind ?? null,
        stage: proof?.stage ?? null,
        reverted: proof?.reverted === true,
        transport: proof?.transport === true,
        tookMs: proof?.tookMs ?? null,
      },
      callId, mint, symbol, clipWei, enforcing,
    });
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}
