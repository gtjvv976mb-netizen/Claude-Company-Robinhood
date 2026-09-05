/**
 * THE CACHE PREFIX IS A SHAPE, AND A SHAPE CAN BE ASSERTED WITHOUT A KEY.
 *
 * Prompt caching on both providers is a byte-prefix lookup: stable content first,
 * markers on it, volatile content after the last marker. Every saving this desk
 * expects from caching rests on the request having that shape, and nothing checked
 * it — the seat charter was sent uncached on a mistaken argument, the narrative seat
 * bought its bundle twice, and the Grok X read put the token FIRST so no two reads
 * shared a prefix. These assertions hold the built request up to the light. They do
 * not prove the provider hits (that is usage.cache_read_input_tokens / cached_tok in
 * the ledger, checked live); they prove the request gives it the chance.
 */
import fs from "node:fs";
import { z } from "zod";
import {
  buildRequest, compactBrief, systemBlocks, SHARED_RULES, CACHE_TTL, CYCLE_BUDGET_USD,
} from "./src/lib/llm.js";
import { xReadBody, XREAD_INSTRUCTIONS } from "./src/lib/grok.js";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const Out = z.object({ score: z.number(), note: z.string() });
const CHARTER = "You are the TEST seat. Score the thing.";

console.log("\nTWO SYSTEM TIERS, BOTH UNDER A MARKER");
{
  const req = buildRequest({ seat: "Test", model: "claude-sonnet-5", effort: "medium",
    schema: Out, system: CHARTER, prompt: "hello" });
  ok("system is an array of two blocks", Array.isArray(req.system) && req.system.length === 2,
    `${req.system.length} blocks`);
  ok("tier 1 is SHARED_RULES", req.system[0].text === SHARED_RULES);
  ok("tier 1 carries cache_control", req.system[0].cache_control?.type === "ephemeral",
    JSON.stringify(req.system[0].cache_control));
  ok("tier 2 carries cache_control (it used to be sent uncached)",
    req.system[1].cache_control?.type === "ephemeral", JSON.stringify(req.system[1].cache_control));
  ok("tier 2 starts with the seat charter", req.system[1].text.startsWith(CHARTER));
  ok("default TTL is 5m, so the marker carries no ttl field",
    CACHE_TTL === "5m" && req.system[0].cache_control.ttl === undefined,
    `CACHE_TTL=${CACHE_TTL}, ttl=${req.system[0].cache_control.ttl}`);
  ok("the seat tier never takes the 1h TTL (longer TTLs must precede shorter ones)",
    systemBlocks("Test", CHARTER, { ttl: "1h" })[1].cache_control.ttl === undefined &&
    systemBlocks("Test", CHARTER, { ttl: "1h" })[0].cache_control.ttl === "1h");
  ok("the same inputs build byte-identical system blocks (a prefix must be stable)",
    JSON.stringify(req.system) === JSON.stringify(buildRequest({ seat: "Test",
      model: "claude-sonnet-5", effort: "medium", schema: Out, system: CHARTER, prompt: "other" }).system));
  ok("a plain prompt is the user message", req.messages[0].content === "hello");
  ok("Sonnet gets effort in output_config", req.output_config.effort === "medium");
  ok("...and no fallbacks (Sonnet rejects them with a 400)", req.fallbacks === undefined);
}

console.log("\nCAPABILITY GATES SURVIVE THE REFACTOR");
{
  const haiku = buildRequest({ seat: "Scout", model: "claude-haiku-4-5", effort: "low",
    schema: Out, system: CHARTER, prompt: "x" });
  ok("Haiku gets no effort (it 400s on it)", haiku.output_config.effort === undefined);
  ok("Haiku still carries the marker (a no-op under 4,096 tokens, left in deliberately)",
    haiku.system[0].cache_control?.type === "ephemeral");
  const opus = buildRequest({ seat: "PM", model: "claude-opus-5", effort: "xhigh",
    schema: Out, system: CHARTER, prompt: "x" });
  ok("Opus gets server-side fallbacks", opus.fallbacks === "default" &&
    opus.betas?.includes("server-side-fallback-2026-07-01"));
  ok("xhigh gets 24000 max_tokens", opus.max_tokens === 24000, `${opus.max_tokens}`);
}

console.log("\nCONTENT BLOCKS PASS THROUGH VERBATIM: BUNDLE FIRST UNDER A MARKER, SEAT TEXT AFTER");
{
  const bundle = "=== EVIDENCE BUNDLE ===\n" + JSON.stringify({ symbol: "PONSY", address: "0xabc" });
  const content = [
    { type: "text", text: bundle, cache_control: { type: "ephemeral" } },
    { type: "text", text: CHARTER },
    { type: "text", text: "Analyse PONSY from the Test seat only." },
  ];
  const req = buildRequest({ seat: "Test", model: "claude-sonnet-5", effort: "medium",
    schema: Out, system: "shared analyst contract", prompt: "IGNORED", content });
  const c = req.messages[0].content;
  ok("the user message is the block array", Array.isArray(c) && c.length === 3, `${c.length} blocks`);
  ok("the FIRST user block is the one carrying cache_control",
    c[0].cache_control?.type === "ephemeral" && c[1].cache_control === undefined && c[2].cache_control === undefined);
  ok("the first block is the bundle", c[0].text === bundle);
  ok("the seat text comes AFTER the bundle", c[1].text === CHARTER);
  ok("prompt is ignored when content is given", JSON.stringify(req).includes("IGNORED") === false);
  ok("blocks are the caller's objects, byte for byte",
    JSON.stringify(c) === JSON.stringify(content));
  const bad = (content, why) => {
    try { buildRequest({ seat: "T", model: "claude-sonnet-5", schema: Out, system: CHARTER, content }); return false; }
    catch (e) { return /content/.test(e.message); };
  };
  ok("an empty content array is refused", bad([]));
  ok("a non-text block is refused", bad([{ type: "image", text: "x" }]));
  ok("a marker with a bad ttl is refused", bad([{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "2h" } }]));
  ok("a 1h marker on a block is accepted",
    !bad([{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }]));
}

console.log("\nSHARED_RULES IS RETARGETED");
{
  ok("names Robinhood Chain", SHARED_RULES.includes("Robinhood Chain"));
  ok("names the chain id", SHARED_RULES.includes("4663"));
  ok("no longer says pump.fun charges a percentage", !SHARED_RULES.includes("pump.fun charges"));
  ok("no 'Solana research desk'", !SHARED_RULES.includes("Solana research desk"));
  ok("the cost paragraph is a gas toll, cited to the bundle",
    SHARED_RULES.includes("661,000") && SHARED_RULES.includes("exitProbe.gasUsdRoundTrip"));   // the MEASURED round trip (ROUND_TRIP_GAS), not the 227,860/swap the lanes were first handed
  ok("the pool fee is the PONS 1%, not 1.25% a side",
    SHARED_RULES.includes("1% on a PONS curve") && !SHARED_RULES.includes("1.25%"));
  ok("the band clock survives (it is chain-agnostic)", SHARED_RULES.includes("hold.holdMaxMs"));
  const bytes = Buffer.byteLength(SHARED_RULES, "utf8");
  ok("SHARED_RULES clears the Sonnet 1,024-token minimum by bytes/4 (an estimate, not count_tokens)",
    bytes / 4 > 1024, `${bytes} bytes ≈ ${Math.round(bytes / 4)} tokens`);
  ok("...but not Haiku's 4,096, which is why the scout's marker is a no-op",
    bytes / 4 < 4096, `${Math.round(bytes / 4)} < 4096`);
}

console.log("\nTHE SHAPING CALL DROPS THE BUNDLE BUT KEEPS THE X READ");
{
  const xRead = { verdict: "organic", dev_handle: "@someone" };
  const head = `Research the narrative around PONSY (0xabc) on Robinhood Chain.\n\n` +
    `Known links from on-chain listing data: {"socials":[],"websites":[]}\nScout's reason for surfacing it: house scan\n\n`;
  const ev = { symbol: "PONSY", address: "0xabc", pair: { liquidityUsd: 12345 }, holders: { top10Pct: 40 }, xRead };
  const prompt = head + "=== EVIDENCE BUNDLE ===\n" + JSON.stringify(ev);
  const brief = compactBrief(prompt);
  ok("the identity header survives", brief.startsWith("Research the narrative around PONSY (0xabc)"));
  ok("the bundle is gone", !brief.includes("liquidityUsd") && !brief.includes("top10Pct"));
  ok("the X read survives", brief.includes('"dev_handle":"@someone"'));
  ok("it is materially shorter", brief.length < prompt.length, `${brief.length} < ${prompt.length} chars`);
  ok("a prompt with no bundle marker is sent unchanged (never blinder, only cheaper)",
    compactBrief("just a brief") === "just a brief");
  ok("an explicit brief object wins", compactBrief(prompt, { symbol: "X" }) === '{"symbol":"X"}');
}

console.log("\nTHE GROK X READ: STABLE PREFIX FIRST, TOKEN LAST");
{
  const a = xReadBody({ symbol: "PONSY", mint: "0x1111111111111111111111111111111111111111", hook: "house scan", handle: "@ponsy", lore: "a frog" });
  const b = xReadBody({ symbol: "HOODIE", mint: "0x2222222222222222222222222222222222222222", hook: "trend", handle: null, lore: null });
  const prefix = (body) => JSON.stringify({ ...body, input: body.input.slice(0, -1) });
  ok("everything before the final input item is byte-identical across two tokens",
    prefix(a) === prefix(b), `${prefix(a).length} bytes of shared prefix`);
  ok("the first input item is the hoisted instruction block", a.input[0].content === XREAD_INSTRUCTIONS);
  const last = a.input[a.input.length - 1].content;
  const rest = JSON.stringify(a.input.slice(0, -1));
  for (const tok of ["PONSY", "0x1111111111111111111111111111111111111111", "@ponsy", "a frog", "house scan"])
    ok(`"${tok}" appears only in the final item`, last.includes(tok) && !rest.includes(tok));
  ok("the instruction names Robinhood Chain and not a Solana token",
    XREAD_INSTRUCTIONS.includes("Robinhood Chain") && !XREAD_INSTRUCTIONS.includes("Solana token"));
  ok("the instruction asks who the audience is, and gives equity cashtags to the stock",
    /WHO IS THE AUDIENCE/.test(XREAD_INSTRUCTIONS) && /belongs to the STOCK/.test(XREAD_INSTRUCTIONS));
  ok("no from_date on the X read (a creator's record is history)", a.tools[0].from_date === undefined);
  ok("the instruction is the stable ~3.5 KB block",
    Buffer.byteLength(XREAD_INSTRUCTIONS) > 3000, `${Buffer.byteLength(XREAD_INSTRUCTIONS)} bytes`);
}

console.log("\nONE CYCLE BUDGET");
ok("CYCLE_BUDGET_USD defaults to 8 (was 4 here, 8 elsewhere)", CYCLE_BUDGET_USD === 8, `${CYCLE_BUDGET_USD}`);

console.log("\nTHE SEATS THAT CALL ask() ARE WIRED THE WAY THE REPORT SAYS");
{
  const tutor = fs.readFileSync(new URL("./src/agents/codex-tutor.js", import.meta.url), "utf8");
  ok("the coach's ask() names a model", /ask\(\{[\s\S]{0,900}model: process\.env\.DESK_MODEL_TUTOR \|\| "claude-opus-5"/.test(tutor));
  ok("the coach is a Robinhood Chain coach", tutor.includes("Robinhood Chain") && !tutor.includes("Solana research desk"));
  const ceo = fs.readFileSync(new URL("./src/agents/ceo.js", import.meta.url), "utf8");
  ok("the CEO no longer pretty-prints", !ceo.includes("null, 2"));
  ok("the CEO's effort is configurable and still defaults to xhigh",
    /effort: cfg\.effort\?\.ceo \|\| process\.env\.DESK_EFFORT_CEO \|\| "xhigh"/.test(ceo));
  const index = fs.readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
  const hunt = index.slice(index.indexOf("const trendHunt = async"));
  ok("the trend scan checks the book before importing the scanner",
    hunt.indexOf("bookState()") > 0 && hunt.indexOf("bookState()") < hunt.indexOf('import("./trends.js")'));
  ok("...and the trend lane's budget",
    hunt.indexOf('lane: "trend"') > 0 && hunt.indexOf('lane: "trend"') < hunt.indexOf('import("./trends.js")'));
  ok("the doctor asks eth_chainId and eth_blockNumber on RH_RPC",
    index.includes('"eth_chainId"') && index.includes('"eth_blockNumber"') && index.includes("RH_RPC") &&
    !index.includes("getTokenLargestAccounts") && !index.includes("getSlot"));
  ok("the doctor's chain check is 0x1237", index.includes('"0x1237"'));
}


console.log("\nSTANDING ORDERS RIDE THE SEAT BLOCK, NOT THE SHARED PREFIX");
{
  const { applyPolicy, policyFor } = await import("./src/desk-policy.js").catch(() => ({}));
  const { z } = await import("zod");
  const schema = z.object({ a: z.string() });
  const bundle = "=== EVIDENCE BUNDLE ===\n{}";
  const mk = (seat) => buildRequest({ seat, model: "claude-sonnet-5", effort: "medium", schema,
    system: "THE ANALYST CONTRACT", content: [
      { type: "text", text: bundle, cache_control: { type: "ephemeral" } },
      { type: "text", text: "=== YOUR SEAT ===\nyou are " + seat },
      { type: "text", text: "Analyse it." } ] });
  const a = mk("Forensics"), b = mk("Flow");
  ok("with content, the system tier is byte-identical across seats",
    JSON.stringify(a.system) === JSON.stringify(b.system));
  ok("...and the bundle block is byte-identical across seats",
    a.messages[0].content[0].text === b.messages[0].content[0].text);
  ok("the seat block still names the seat", /you are Flow/.test(b.messages[0].content[1].text));
  // a content payload with no seat block keeps the old behaviour (orders on the system tier)
  const c = buildRequest({ seat: "Flow", model: "claude-sonnet-5", effort: "medium", schema,
    system: "X", content: [{ type: "text", text: "no seat block here" }] });
  ok("no seat block: request still builds", Array.isArray(c.system) && c.system.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
