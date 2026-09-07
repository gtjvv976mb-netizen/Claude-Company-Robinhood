import db from "./src/lib/store.js";
import { evaluateExit, getCall, openCall } from "./src/calls.js";
import {
  DEFAULTS,
  POLICY_VERSION as EXECUTOR_POLICY_VERSION,
  openPosition,
  stepPosition,
} from "./executor/strategy.mjs";
import { POLICY_VERSION, pricePolicy } from "./executor/trade-policy.mjs";

let pass = 0, fail = 0;
const ok = (name, condition, detail = "") => {
  if (condition) { pass++; console.log(`  ok   ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  \u2014 ${detail}` : ""}`); }
};

const call = openCall({
  mint: "Parity1111111111111111111111111111111111111",
  symbol: "PARITY",
  category: "memecoin",
  entryRef: 1,
  stop: 0.62,
  target: 1.9,
  thesis: "one policy",
  invalidation: "structure fails",
  liqUsd: 100_000,
  rtLossPct: 2,
});
const market = (mark) => ({
  mark,
  liqUsd: 100_000,
  rtLossPct: 2,
  flags: [],
  flagsReadable: true,
});
const executorAt = (mark, over = {}) => {
  const pos = openPosition({
    call: { mint: call.mint, symbol: call.symbol, stop: call.stop, target: call.target,
      openedAtMs: over.openedAtMs ?? Date.now() },
    sol: 0.02,
    fillPrice: 1,
    cfg: DEFAULTS,
  });
  return stepPosition({ pos, mark, cfg: DEFAULTS, nowMs: over.nowMs ?? Date.now() });
};

console.log("\nSERVER AND EXECUTOR IDENTIFY THE SAME PRICE EXITS");
const stopServer = evaluateExit(call, market(0.61));
const stopExecutor = executorAt(0.61);
ok("stop sells in both paths", stopServer.fire && stopExecutor.action === "sell",
  `${stopServer.code} / ${stopExecutor.reason}`);

const targetServer = evaluateExit(call, market(1.9));
const targetExecutor = executorAt(1.9);
ok("authored target sells in both paths", targetServer.code === "target_hit" &&
  targetExecutor.action === "sell" && targetExecutor.fraction === 1,
  `${targetServer.code} / ${targetExecutor.reason}`);

const takeServer = evaluateExit(call, market(2));
const takeExecutor = executorAt(2);
ok("2x sells in both paths", takeServer.code === "take_profit" &&
  takeExecutor.action === "sell" && takeExecutor.fraction === 1,
  `${takeServer.code} / ${takeExecutor.reason}`);

console.log("\nTIME EXPIRY USES ONE POLICY ON BOTH SIDES");
/* Derived from the backstop, not written as 25 hours. The literal was chosen to sit just
   past the old 24-hour default; when that default was re-measured for Robinhood Chain
   (120h, see executor/trade-policy.mjs) the literal fell INSIDE the window and this
   assertion failed while describing correct behaviour. */
const pastBackstop = Date.now() - (DEFAULTS.maxAgeHours + 1) * 3600e3;
db.prepare("UPDATE calls SET opened_at=? WHERE id=?").run(pastBackstop, call.id);
const agedCall = getCall(call.id);
const ageServer = evaluateExit(agedCall, market(1.1));
const ageExecutor = executorAt(1.1, { openedAtMs: pastBackstop, nowMs: Date.now() });
ok("the age backstop sells in both paths", ageServer.code === "thesis_expired" &&
  ageExecutor.action === "sell" && /age exit/.test(ageExecutor.reason),
  `${ageServer.code} / ${ageExecutor.reason}`);

/* THE BAND'S CLOCK MUST ALSO AGREE. A nano call is held for half an hour, and the paper
 * record has to close at the same moment the tenant's bot does — otherwise the desk's
 * published performance describes a trade nobody could have had. */
const nanoOpened = Date.now() - 31 * 60_000;
db.prepare("UPDATE calls SET opened_at=?, hold_band='nano', hold_max_ms=? WHERE id=?")
  .run(nanoOpened, 30 * 60_000, call.id);
const nanoCall = getCall(call.id);
const nanoServer = evaluateExit(nanoCall, market(1.1));
const nanoExecutor = stepPosition({
  pos: openPosition({ call: { mint: call.mint, symbol: call.symbol, stop: call.stop, target: call.target,
    openedAtMs: nanoOpened, hold_band: "nano", hold_max_ms: 30 * 60_000 },
    sol: 0.02, fillPrice: 1, cfg: DEFAULTS }),
  mark: 1.1, cfg: DEFAULTS, nowMs: Date.now(),
});
ok("a closed band window sells in both paths", nanoServer.code === "thesis_expired" &&
  nanoExecutor.action === "sell" && /nano window closed/.test(nanoExecutor.reason),
  `${nanoServer.code} / ${nanoExecutor.reason}`);

console.log("\nTHE POLICY IS VERSIONED ON EVERY SURFACE");
ok("strategy re-exports the shared version", EXECUTOR_POLICY_VERSION === POLICY_VERSION,
  `${EXECUTOR_POLICY_VERSION} / ${POLICY_VERSION}`);
ok("new calls retain the policy version", call.policy_version === POLICY_VERSION, call.policy_version);
const pure = pricePolicy({
  position: { entry: 1, stop: 0.62, target: 1.9, high: 1, openedAtMs: Date.now() },
  mark: 2,
});
ok("pure decisions identify their policy version", pure.policyVersion === POLICY_VERSION,
  pure.policyVersion);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
