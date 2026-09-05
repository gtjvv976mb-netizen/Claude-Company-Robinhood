import { ask } from "../lib/llm.js";
import { z } from "zod";
import { cfg } from "../config.js";
import { runContext } from "../lib/bus.js";
import {
  EVALUATION_VERSION,
  POLICY_VERSION,
  evidenceScopeFor,
  evaluationSummary,
  runtimeBehaviorFingerprint,
} from "../evaluation.js";
import { decisionManifest } from "../provenance.js";

export const CEOOut = z.object({
  ruling: z.enum(["APPROVE", "DECLINE", "HOLD"]),
  one_line: z.string().describe("What the CEO says to the floor, in one sentence."),
  reasoning: z.string().describe("Why, in under 100 words. Address the desk's own track record."),
  order_size_usd: z.number().describe("Final size. May only cut the risk seat's number; 0 on DECLINE."),
  size_change_reason: z.string().describe("Empty string if unchanged from the risk seat."),
  conditions: z.array(z.string()).describe("Conditions attached to the approval."),
  questions_for_the_desk: z.array(z.string()).describe("What the desk failed to answer."),
  confidence: z.number().min(0).max(1),
});

/**
 * THE CEO SEAT — the last agent, sitting behind the door.
 *
 * It is the only seat that sees the desk's own historical record, because the question
 * it answers is not "is this a good trade" (the PM already answered that) but
 * "do I trust this desk on this trade today". It approves the order.
 *
 * It never signs and never sends. The signature belongs to the human whose office this is.
 */
export async function runCEO({ ev, pm, risk, redteam, ticket, compliance }, opts = {}) {
  const floorNo = runContext.getStore()?.floor ?? null;
  const evidenceScope = evidenceScopeFor(floorNo);
  const record = { forwardPerformance: evaluationSummary({
    evidenceScope,
    ...(evidenceScope === "tenant" ? { floorNo } : {}),
    promptManifestHash: decisionManifest().hash,
    evaluationVersion: EVALUATION_VERSION,
    policyVersion: POLICY_VERSION,
    behaviorFingerprint: runtimeBehaviorFingerprint({
      runKind: opts.lane ?? "cycle",
      pmProvider: opts.pmProvider ?? "claude",
    }),
    // The mandate may publish a HELD/PROPOSE/WATCH winner after every deterministic
    // safety gate clears. Show the CEO the desk's actual published record, not the
    // cleaner subset of decisions the CEO previously approved.
    decisionCohort: "published",
  }) };

  return ask({
    seat: "CEO",
    model: process.env.DESK_MODEL_CEO || "claude-opus-5",
    /* Configurable, default unchanged. xhigh on Opus was the single most expensive
     * setting the desk has run (config.js: the red team's xhigh alone was a third of the
     * bill), and the CEO is a judgment seat with the largest input of any Opus call.
     * The default stays xhigh because nothing has measured high against it on the
     * CEO's APPROVE/DECLINE agreement yet; cfg.effort.ceo (if config.js adds it) or
     * DESK_EFFORT_CEO lowers it once that measurement exists. */
    effort: cfg.effort?.ceo || process.env.DESK_EFFORT_CEO || "xhigh",
    schema: CEOOut,
    system: `You are the CEO of Claude Company, a small research firm trading memecoins on
Robinhood Chain. Your desk has just brought you a trade. You are the final approval, and the capital is yours.

You are NOT re-running the analysis. Five analysts, an adversary, a risk officer and a
portfolio manager have already done that, and second-guessing their work line by line is
how a CEO becomes a bottleneck. Your job is the judgment only you can make:

1. **Do I trust this desk on this trade?** You can see the desk's own record below —
   how many names it has looked at, what it has killed and why. A desk that approves
   everything is not filtering. A desk that has never proposed anything is not working.
   And read an EMPTY record correctly: zero settled trades is not evidence of danger,
   it is a book that has never opened. It cannot become a track record until you let
   the system take its first calculated positions. Caution that keeps the book empty
   is the one mistake this seat cannot recover from, because it destroys the feedback
   the whole firm learns by.
2. **Is the size right for the book, today?** The risk seat sized this idea in isolation.
   You see the whole firm. You may cut size. Cutting is cheap; being wrong at size is not.
3. **When the red team said "refuted" and the PM proposed anyway, YOU are the judge.**
   Read the attack and the PM's answer side by side. An answer that carries a fact the
   attack missed defeats it — approve at the cut size. An answer that is rhetoric
   restated does not — decline and say which sentence failed. This dispute reaching
   you is the system working, not a breach.
4. **Did anyone fail to answer the hard question?** If the red team landed an attack and
   the PM's answer was words rather than evidence, that is a DECLINE or a HOLD, however
   good the rest of the case looks.
5. **Is this a trade, or is it a story I enjoyed reading?** Say so plainly if it is the latter.

Rulings — and the systematic rule that orders them:
- APPROVE — the DEFAULT for a clean proposal (compliance clear, red team not refuted).
  You are the last check for PROCESS violations, not a second portfolio manager;
  the firm's edge is the system taking its calculated risk many times at small size.
  Cut the size if the book needs it — approving smaller is almost always better
  than not approving.
- HOLD — you want something specific first. Put it in questions_for_the_desk.
- DECLINE — for a named, evidenced flaw the desk failed to answer, stated in one
  sentence. Never for generic uncertainty: that was priced into the size already.

Absolute constraint on you, as on every seat: you do not execute. An APPROVE produces an
order slip that a human being signs in their own wallet. You never hold a key, you never
sign, and you never send. If you find yourself reasoning about doing so, that is the
constraint failing, not an edge case to route around.

Book equity: $${cfg.equityUsd}. Ceiling per idea: ${cfg.maxRiskPct}% ($${(cfg.equityUsd * cfg.maxRiskPct / 100).toFixed(2)}).`,
    /* Compact JSON, as the decision seats already send: the pretty-printed form was
     * measured at roughly a quarter of the input tokens (decision.js), and this seat
     * reads five JSON blobs plus the firm's record on the priciest model in the house. */
    prompt:
      `A proposal has reached your door.\n\n` +
      `=== THE FIRM'S RECORD TO DATE ===\n${JSON.stringify(record)}\n\n` +
      `=== TOKEN ===\n${ev.symbol} (${ev.address ?? ev.mint})\n` +
      `price $${ev.pair?.priceUsd} · liquidity $${ev.pairs?.totalLiquidityUsd} across ${ev.pairs?.count} venues · ` +
      `round-trip cost ${ev.exitProbe?.roundTripLossPct ?? "unmeasured"}%\n\n` +
      `=== PM ===\n${JSON.stringify(pm)}\n\n` +
      `=== RED TEAM ===\n${JSON.stringify(redteam)}\n\n` +
      `=== RISK ===\n${JSON.stringify(risk)}\n\n` +
      `=== TICKET ===\n${JSON.stringify(ticket)}\n\n` +
      `=== COMPLIANCE ===\n${JSON.stringify(compliance)}`,
  });
}
