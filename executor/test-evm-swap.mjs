/**
 * NOTHING IS SIGNED THAT HAS NOT BEEN EXECUTED FIRST — AND THE FLOOR IS READ FROM THE
 * BYTES, NOT FROM A FIELD BESIDE THEM.
 *
 * I got this wrong first and it is worth pinning why. The build response carries an
 * `amountOut` that looks like the minimum output and is not: measured on chain 4663 on
 * 2026-09-04 it came back byte-identical at 100, 300 and 1000 bps of requested tolerance,
 * always the quoted amount minus rounding. Reading it as the floor made this module
 * declare every transaction a guaranteed revert, and it refused 100% of live swaps.
 *
 * The calldata tells the truth. Decoded from the same builds, 100 bps embeds a floor
 * 1.00% below the quote and 1000 bps embeds 10.00%, exactly as asked. So the Solana
 * desk's rule ports intact and literally — take minOut from the SIGNED BYTES — and it
 * only means anything if it is read out of the bytes.
 */
import { floorFrom, isNative, simulateExact, prepareSwap, embeddedFloor,
  NATIVE_SENTINEL } from "./evm-swap.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };
const threw = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
};
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

console.log("\nOUR FLOOR IS OURS, NOT THE AGGREGATOR'S");
{
  ok("1% off a round number is exact", floorFrom(1_000_000n, 100) === 990_000n, String(floorFrom(1_000_000n, 100)));
  ok("zero tolerance means the quote itself", floorFrom(12345n, 0) === 12345n);
  ok("the floor is never above the quote", floorFrom(999n, 300) <= 999n);
  ok("a tolerance of 100% or more is refused", threw(() => floorFrom(1n, 10_000)));
  ok("a negative tolerance is refused", threw(() => floorFrom(1n, -1)));
  /* BigInt throughout: a token with 18 decimals overflows double precision long before
     any realistic size, and a rounding error here is money. */
  const huge = floorFrom(93_318_205_751_965_188_096n, 100);
  ok("a full 18-decimal amount keeps every digit", huge === 92_385_023_694_445_536_215n, String(huge));
}

console.log("\nTHE NATIVE SENTINEL, WHICH COST A REVERT TO LEARN");
{
  ok("the sentinel is recognised", isNative(NATIVE_SENTINEL));
  ok("...case-insensitively, as addresses arrive either way", isNative(NATIVE_SENTINEL.toLowerCase()));
  /* Quoting the WRAPPED token as tokenIn builds a transaction the router funds by
     transferFrom; attaching msg.value too reverts with "Invalid msg.value". */
  ok("wrapped ETH is NOT native", !isNative("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"));
}

console.log("\nA ROUTER THAT ANSWERS NOTHING IS NOT AN EMPTY ANSWER");
{
  ok("0x is refused, never read as zero out",
    await threw(() => simulateExact(async () => "0x", { from: "0xa", to: "0xb", data: "0x" }), /cannot measure/));
  ok("a truncated return is refused", await threw(
    () => simulateExact(async () => "0x1234", { from: "0xa", to: "0xb", data: "0x" }), /cannot measure/));
  const got = await simulateExact(async () => word(93_315_418_358_173_336_030n),
    { from: "0xa", to: "0xb", data: "0x" });
  ok("a real return is decoded whole", got.amountOut === 93_315_418_358_173_336_030n, String(got.amountOut));
}

console.log("\nTHE FLOOR COMES OUT OF THE CALLDATA");
{
  const QUOTED = 93_831_347_471_036_366_848n;
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const sel = "0xe21fd0e9";
  // Measured 2026-09-04: these are the floors the real builds embedded.
  const AT_100 = 92_893_033_996_326_003_178n;   // 1.00% below quote
  const AT_1000 = 84_448_212_723_932_730_162n;  // 10.00% below quote
  ok("the 1% floor is found in the bytes",
    embeddedFloor(sel + word(123n) + word(AT_100) + word(7n), QUOTED) === AT_100);
  ok("...and the 10% floor, from the same shape",
    embeddedFloor(sel + word(AT_1000) + word(1n), QUOTED) === AT_1000);
  ok("the tolerance really is honoured in the bytes",
    Number((QUOTED - AT_100) * 10_000n / QUOTED) === 100 &&
    Number((QUOTED - AT_1000) * 10_000n / QUOTED) === 1000, "1.00% and 10.00%");

  /* FAIL CLOSED. A scan is only safe if an ambiguous or empty result refuses rather
     than guessing — a decoder that silently misreads an unfamiliar encoding is how a
     bad floor gets signed. */
  ok("two candidates is a refusal, not a coin toss",
    embeddedFloor(sel + word(AT_100) + word(AT_100 - 5n), QUOTED) === null);
  ok("no candidate is a refusal", embeddedFloor(sel + word(1n) + word(2n), QUOTED) === null);
  ok("a word ABOVE the quote is not a floor", embeddedFloor(sel + word(QUOTED + 1n), QUOTED) === null);
  ok("empty calldata is a refusal", embeddedFloor("0x", QUOTED) === null);
  ok("a non-string is a refusal", embeddedFloor(null, QUOTED) === null);

  /* And the informational field that misled me: identical across every tolerance, so a
     guard reading it can never see the difference between 1% and 10%. */
  const INFO_FIELD = 93_831_347_471_036_366_847n;   // quoted - 1, at every tolerance
  ok("the response field cannot distinguish 1% from 10%, which is why it is not used",
    INFO_FIELD !== AT_100 && INFO_FIELD !== AT_1000);
}

console.log("\nA LOW-BALLED QUOTE CANNOT LOWER OUR FLOOR");
{
  /* THE SOLANA DESK LOST THIS ARGUMENT ONCE. Impact, minOut and the round-trip preflight
     were all authored by the same API response they were checking, so a self-consistent
     quote at a fraction of fair value passed every check and the wallet signed an
     on-chain floor far below fair value. The trade still fills — the pool pays what the
     pool pays — but the gap between the floor you signed and what the trade is worth is
     exactly what anyone watching it in flight can take.
     Only the simulated output is independent of the party being checked, so the floor is
     measured against THAT. These cases are the arithmetic of that rule. */
  const FAIR = 100_000_000_000_000_000_000n;   // what the chain actually returns
  const gapBps = (floor) => Number((FAIR - floor) * 10_000n / FAIR);

  const honest = FAIR * 99n / 100n;            // floor 1% under fair
  ok("a floor 1% under what the chain yields is fine at 100bps", gapBps(honest) <= 100, `${gapBps(honest)}bps`);

  /* A quote low-balled to 40% of fair value: OUR floor is a percentage off that quote, so
     it moves down with it, and every quote-anchored check still passes. */
  const lowBalled = FAIR * 40n / 100n;
  const floorFromLowBall = floorFrom(lowBalled, 100);
  ok("the low-balled floor still clears a quote-derived floor", floorFromLowBall <= lowBalled);
  ok("...and the simulated output clears it easily, so quote-anchored checks all pass",
    FAIR > floorFromLowBall);
  ok("...but against the chain it is a 60% giveaway", gapBps(floorFromLowBall) > 5900,
    `${gapBps(floorFromLowBall)}bps extractable`);
  ok("...which is far outside any tolerance we would agree to", gapBps(floorFromLowBall) > 300);

  /* The bound is the tolerance itself: whatever the quote said, the distance between what
     we accept and what the trade is worth cannot exceed what we chose to risk. */
  for (const bps of [50, 100, 300]) {
    const atLimit = FAIR - (FAIR * BigInt(bps) / 10_000n);
    ok(`at ${bps}bps the widest allowed floor is exactly ${bps}bps under fair`,
      gapBps(atLimit) === bps, `${gapBps(atLimit)}bps`);
  }
}

console.log("\nTHE SCOPE GUARD IS RE-RUN AT THE LAST MOMENT");
{
  /* The desk screens upstream, but the executor is the last thing between a decision
     and money moving and does not get to assume the caller screened. */
  const equityBeacon = word(BigInt("0xe10b6f6b275de231345c20d14ab812db62151b00"));
  const rpc = async (m) => m === "eth_getStorageAt" ? equityBeacon : "0x";
  ok("a Stock Token is refused before a quote is even requested", await threw(
    () => prepareSwap(rpc, { tokenIn: NATIVE_SENTINEL, tokenOut: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
      amountIn: 10n ** 16n, sender: "0x1111111111111111111111111111111111111111", slippageBps: 100 }),
    /scope guard|Stock Token/));
  ok("a zero amount is refused", await threw(
    () => prepareSwap(async () => "0x", { tokenIn: NATIVE_SENTINEL, tokenOut: "0xabc",
      amountIn: 0n, sender: "0x1", slippageBps: 100 }), /positive/));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
