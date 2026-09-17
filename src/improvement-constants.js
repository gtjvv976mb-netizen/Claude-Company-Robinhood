// v3: the `thresholds` section (name/value/provenance/at) — Robinhood edition, 2026-09-05.
export const IMPROVEMENT_BUNDLE_VERSION = "codex-improvement-bundle.v3";
export const IMPROVEMENT_REPORT_VERSION = "codex-improvement-report.v1";
/** THE DESK'S ONE CLAIM FLOOR — the sample below which no edge, no hit rate and no
 *  "the bar is costing more than it saves" verdict is claimable. src/perf.js
 *  edgeClaimable, src/shadow.js scorecard() and the improvement bundle all read THIS
 *  rather than restating 100, because a friendlier floor invented for a new consumer is
 *  how a bar stops being a bar. The shadow scorecard was emitting a recommendation to
 *  LOOSEN the desk's refusals off five graded coins while this repo required a hundred
 *  for every other claim it makes. */
export const CLAIM_SAMPLE_FLOOR = 100;
export const IMPROVEMENT_SAMPLE_GATE = CLAIM_SAMPLE_FLOOR;
export const IMPROVEMENT_MIN_COVERAGE_PCT = 80;
