import { z } from "zod";

export const Finding = z.object({
  claim: z.string().describe("One specific assertion, stated plainly."),
  value: z.string().describe("The actual number or fact behind the claim."),
  source: z.string().describe("Evidence key path (e.g. 'pair.liquidityUsd'), a URL you read, or 'inference'."),
});

/** Every analyst seat answers in this shape so the PM can weigh them like for like. */
export const AnalystOut = z.object({
  headline: z.string().describe("One sentence a portfolio manager could act on."),
  score: z.number().min(0).max(100).describe("0 = disqualifying, 50 = neutral, 100 = exceptional, on YOUR dimension only."),
  confidence: z.number().min(0).max(1).describe("Lower this when evidence was missing. Do not fake certainty."),
  findings: z.array(Finding),
  risks: z.array(z.string()).describe("What could go wrong on your dimension specifically."),
  missing_data: z.array(z.string()).describe("Data you needed and did not get."),
  kill: z.boolean().describe("True only for a disqualifying defect on your dimension. A kill stops the pipeline."),
  kill_reason: z.string().describe("Empty string when kill is false."),
});

export const ScoutOut = z.object({
  picks: z.array(z.object({
    // Field name kept for every consumer that reads picks[].mint; the value is the
    // ERC-20 contract address on chain 4663.
    mint: z.string().describe("The token's contract address, exactly as it appears in the feed."),
    why_now: z.string().describe("The specific, time-sensitive reason this deserves attention today."),
    interest: z.number().min(0).max(100),
  })),
  discarded_reasoning: z.string(),
});

/**
 * THE FACTS A REFUTATION MAY LAND ON. Each code is confirmed against the bundle by
 * redteam-policy.js before a "refuted" is allowed to stand. The six EVM codes are the
 * rug vectors this chain actually has — an EOA-held upgrade key, a pullable position
 * NFT, a quote asset the bot cannot hold, bespoke bytecode nobody has verified, sells
 * the sequencer or ArbOS voids, and an exempt list holding the float — none of which
 * the Solana list could name, so a refutation on them was always downgraded.
 */
export const RED_TEAM_FACT_CODES = [
  "wash_trading", "deployer_misconduct", "live_authority", "holder_control",
  "exit_failure", "liquidity_collapse", "fake_social_proof", "false_identity", "unlock_risk",
  "upgrade_key_live", "lp_unlocked", "pair_token_gate", "unverified_code",
  "sequencer_exclusion", "insider_float",
  "other",
];

export const RedTeamOut = z.object({
  headline: z.string().describe("The single strongest reason this trade loses money."),
  bear_case: z.string(),
  attacks: z.array(z.object({
    target: z.string().describe("Which analyst claim or assumption you are attacking."),
    attack: z.string(),
    severity: z.enum(["fatal", "serious", "minor"]),
    evidence: z.string(),
    fact_code: z.enum(RED_TEAM_FACT_CODES),
    evidence_path: z.string().describe("Exact evidence-bundle path, or empty only when source_url supplies external proof."),
    observed_value: z.string(),
    threshold_or_comparison: z.string(),
    source_url: z.string().nullable(),
    verification_status: z.enum(["verified", "inference", "unverified"]),
  })),
  unfalsifiable_claims: z.array(z.string()).describe("Bull-case claims that cannot be checked and should carry no weight."),
  what_would_change_my_mind: z.string(),
  verdict: z.enum(["refuted", "wounded", "survives"]),
  confidence: z.number().min(0).max(1),
});

export const RiskOut = z.object({
  risk_tier: z.enum(["minimal", "quarter", "half", "full"])
    .describe("Judgment only. Code converts this tier into dollars from the configured book and hard rails."),
  size_rationale: z.string().describe("Why this risk tier fits the evidence and red-team verdict."),
  stop_price: z.number().describe("Price at which the thesis is mechanically wrong. 0 if not applicable."),
  stop_rationale: z.string(),
  liquidity_adjusted: z.boolean().describe("True if you reduced size because the exit probe said you could not get out at full size."),
  portfolio_notes: z.string(),
  confidence: z.number().min(0).max(1),
});

export const PMOut = z.object({
  decision: z.enum(["PROPOSE", "WATCH", "PASS"]),
  conviction: z.number().min(0).max(100),
  thesis: z.string().describe("Why this makes money, in plain language, in under 80 words."),
  invalidation: z.string().describe("The specific observable that proves the thesis wrong."),
  time_horizon: z.string(),
  how_red_team_was_answered: z.string().describe("Required. If you cannot answer the red team, the decision is not PROPOSE."),
  key_disagreement: z.string().describe("Where the analysts conflicted and how you resolved it."),
  watch_triggers: z.array(z.string()).describe("For WATCH: what would promote this to PROPOSE."),
  watch_rules: z.object({
    price_above_usd: z.number().nullable().describe("Promote when price holds above this. Null if not a condition."),
    buys_h1_at_least: z.number().nullable().describe("Promote when hourly buys reach this. Null if not a condition."),
    liq_at_least_usd: z.number().nullable().describe("Promote when liquidity reaches this. Null if not a condition."),
    hours: z.number().min(1).max(72).describe("How long the watch stands before it expires."),
  }).nullable().describe("For WATCH only, otherwise null. MACHINE-CHECKABLE promotion rules — the desk re-runs this token automatically when every non-null rule holds. A WATCH without rules is a PASS that lies about itself."),
});

export const TicketOut = z.object({
  action: z.literal("BUY").describe("This desk proposes long entries only."),
  entry_zone_low: z.number(),
  entry_zone_high: z.number(),
  entry_style: z.enum(["market", "limit", "scale-in"]),
  slices: z.array(z.object({
    pct_of_position: z.number(),
    trigger: z.string(),
  })),
  max_slippage_bps: z.number(),
  suggested_route: z.string().describe("From evidence.exitProbe: the KyberSwap route (aggregator-api.kyberswap.com/robinhood) or the single Uniswap V3/V4 pool, naming the pairToken leg when the pool is not WETH/native-quoted."),
  stop_price: z.number(),
  take_profit: z.array(z.object({ price: z.number(), pct_to_sell: z.number(), rationale: z.string() })),
  execution_warnings: z.array(z.string()).describe("Everything that would surprise a human placing this by hand — always including that a send with no receipt was dropped by the sequencer and must be reconciled by nonce, never assumed filled."),
});

/**
 * THE BEST PICK — one coin chosen from a pre-vetted field.
 *
 * Every candidate this seat sees has already cleared the free safety screen, every
 * analyst, the red team and compliance. So it is not being asked "is this safe" — that
 * is settled and not its business. It is asked the only question left: of these, which
 * one MAKES MONEY, and which would you regret.
 */
export const BestPickOut = z.object({
  // Field names kept (pick_mint / runner_up_mint) for every consumer downstream; the
  // value is the contract address on chain 4663.
  pick_mint: z.string().describe("The contract address of the single coin to trade. Must be one of the candidates."),
  pick_symbol: z.string(),
  why: z.string().describe("Why THIS one and not the others, in under 60 words. Compare, do not describe."),
  edge: z.string().describe("The specific thing that makes it likely to move — the trend, the lore, the endorsement, the flow."),
  runner_up_mint: z.string().nullable().describe("The next best, or null if there genuinely was no second choice."),
  why_not_runner_up: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  expected_move: z.enum(["2x_or_better", "50_to_100pct", "modest", "unclear"])
    .describe("Honest read on how far this goes, not how far you hope."),
  worst_case: z.string().describe("What kills this trade, in one sentence. Not 'the market' — the specific thing."),
});
