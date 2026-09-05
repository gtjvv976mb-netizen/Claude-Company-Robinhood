/**
 * EVERY KEY A CHARTER CITES MUST BE A KEY THE BUNDLE PRODUCES.
 *
 * A seat told to read a field that is never produced "teaches that seat to hallucinate"
 * (docs/EVIDENCE-CONTRACT.md's own words). Commit 871a163 said the five charters had
 * been normalised to one namespace; the shipped text still spelled the same field three
 * ways, and nothing checked. This file does: it pulls every `a.b.c` path out of the
 * charter strings in src/agents/*.js (and DESK.md, which is injected into every prompt),
 * and asserts each resolves to a row in the contract table. The misses are PRINTED, so
 * the fix is never a guess.
 *
 * The extraction is the template literal itself, not the file: `${...}` expressions are
 * skipped (they are code, e.g. cfg.maxCandidates), and escaped backticks inside a
 * charter are unescaped before matching.
 */
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const here = new URL("./", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, here), "utf8");

/** Template literals in a JS source, with ${} expressions removed and escapes resolved. */
export function templateLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "`") { i++; continue; }
    let j = i + 1, text = "";
    while (j < src.length) {
      const ch = src[j];
      if (ch === "\\") { text += src[j + 1] ?? ""; j += 2; continue; }
      if (ch === "`") break;
      if (ch === "$" && src[j + 1] === "{") {
        let depth = 1; j += 2;
        while (j < src.length && depth > 0) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          j++;
        }
        text += " ";
        continue;
      }
      text += ch; j++;
    }
    out.push({ text, at: i });
    i = j + 1;
  }
  return out;
}

/** Charters are the long ones; short template strings are prompt glue and event text. */
const CHARTER_MIN_CHARS = 400;

/* Prose that the path regex also matches and that is not an evidence key. Kept short and
   explicit so a new false positive has to be added here by hand, in the open. */
const NOT_A_KEY = new Set(["e.g", "i.e", "vs", "etc"]);
const PROSE_DOMAINS = /\.(com|io|md|mjs|js|network|za|fun|trade)$/i;

/**
 * The paths cited in one charter, normalised: trailing dots stripped, `evidence.` prefix
 * dropped. The regex is the plan's `[a-z]+\.[a-zA-Z0-9_.\[\]]+` anchored at a word
 * boundary and allowing camelCase in the first segment — without that, `xRead.dev_handle`
 * was read from the R onward as `ead.dev_handle` and `sellSim.ok` as `im.ok`.
 */
export function citedPaths(text) {
  const found = new Set();
  const re = /\b[a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.\[\]]+/g;
  for (const m of text.matchAll(re)) {
    let p = m[0].replace(/\.+$/, "");
    if (NOT_A_KEY.has(p) || PROSE_DOMAINS.test(p)) continue;
    if (/^\d/.test(p) || !/\./.test(p)) continue;
    // A sentence that ends on a key and starts the next without a space ("holders.top1Pct.Do")
    // is not a path; the contract has no capitalised segment.
    p = p.replace(/\.[A-Z][a-z]+$/, "");
    if (p.startsWith("evidence.")) p = p.slice("evidence.".length);
    found.add(p);
  }
  return [...found];
}

/** Rows of the contract table: the first backticked cell of each table line. */
export function contractRows(md) {
  const rows = new Set();
  for (const line of md.split("\n")) {
    if (!/^\|\s*`/.test(line)) continue;
    // The whole first cell: a row may name two or three keys ("`a` / `b`").
    const cell = line.slice(1).split("|")[0];
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      const k = m[1].trim().replace(/^evidence\./, "").replace(/\.\*$/, ".*");
      if (k) rows.add(k);
    }
  }
  return rows;
}

/** A cited path resolves to a row, a row that names it with a wildcard tail, or a parent row of an object. */
export function resolves(path, rows) {
  if (rows.has(path)) return true;
  if (rows.has("evidence." + path)) return true;
  // A bare top-level key ("exitProbe", from "evidence.exitProbe") resolves when any row lives under it.
  if (!path.includes(".")) { for (const r of rows) if (r.startsWith(path + ".")) return true; }
  for (const r of rows) {
    if (r.endsWith("*") && path.startsWith(r.slice(0, -1))) return true;
    if (r.endsWith("_") && path.startsWith(r)) return true;
  }
  // "xRead.dev_" (a prose wildcard) resolves when any row starts with it.
  if (path.endsWith("_")) for (const r of rows) if (r.startsWith(path)) return true;
  // pair.priceChange.m5 resolves through a row for pair.priceChange; sellSim.ok through
  // the `sellSim` object row, whose description names its members.
  const parent = path.split(".").slice(0, -1).join(".");
  return parent.length > 0 && rows.has(parent);
}

console.log("\nTHE CONTRACT TABLE IS READABLE");
const contract = read("./docs/EVIDENCE-CONTRACT.md");
const rows = contractRows(contract);
ok("the table has rows", rows.size > 40, `${rows.size} rows`);
ok("the rows this rewrite depends on are present",
  ["contract.cloneOf", "deployer.priorLaunches", "deployer.fundedBy", "launch.exemptShareOfSupplyPct",
   "launch.creatorTaxBps", "launch.maxCreatorTaxBps", "launch.graduatedAt", "pairs.pools[].pairTokenClass",
   "holders.poolShareOfSupplyPct", "exitProbe.gasUsdRoundTrip", "ethUsd.value", "ethUsd.stalenessSec"]
    .every((k) => rows.has(k)),
  ["contract.cloneOf", "deployer.priorLaunches", "deployer.fundedBy", "launch.exemptShareOfSupplyPct",
   "launch.creatorTaxBps", "launch.maxCreatorTaxBps", "launch.graduatedAt", "pairs.pools[].pairTokenClass",
   "holders.poolShareOfSupplyPct", "exitProbe.gasUsdRoundTrip", "ethUsd.value", "ethUsd.stalenessSec"]
    .filter((k) => !rows.has(k)).join(", ") || "all present");
ok("every row names its producing source",
  contract.split("\n").filter((l) => /^\|\s*`/.test(l)).every((l) => l.split("|").length >= 5 && !/\|\s*—\s*\|\s*$/.test(l)),
  contract.split("\n").filter((l) => /^\|\s*`/.test(l) && (l.split("|").length < 5 || /\|\s*—\s*\|\s*$/.test(l))).slice(0, 5).join(" || "));

console.log("\nEVERY PATH A CHARTER CITES RESOLVES TO A ROW");
const files = fs.readdirSync(new URL("./src/agents/", here)).filter((f) => f.endsWith(".js"));
let total = 0;
const misses = [];
for (const f of files) {
  const src = read(`./src/agents/${f}`);
  const charters = templateLiterals(src).filter((t) => t.text.length >= CHARTER_MIN_CHARS);
  for (const t of charters) {
    for (const p of citedPaths(t.text)) {
      total++;
      if (!resolves(p, rows)) misses.push(`${f}: ${p}`);
    }
  }
}
for (const p of citedPaths(read("./DESK.md"))) { total++; if (!resolves(p, rows)) misses.push(`DESK.md: ${p}`); }
ok(`all ${total} cited paths resolve`, misses.length === 0,
  misses.length ? `MISSING (${misses.length}):\n    ${[...new Set(misses)].join("\n    ")}` : "no misses");

console.log("\nTHE SCANNER ITSELF IS TRUSTWORTHY");
{
  const lits = templateLiterals("const a = `x ${cfg.one} y \\`candles.bars\\` z`; const b = `pair.priceUsd`;");
  ok("a ${} expression is not read as prose", !lits[0].text.includes("cfg.one"), lits[0].text);
  ok("an escaped backtick is unescaped", lits[0].text.includes("`candles.bars`"), lits[0].text);
  ok("both literals are found", lits.length === 2 && lits[1].text === "pair.priceUsd");
  const paths = citedPaths("read holders.top1Pct and e.g. pair.priceChange.m5/h1 on pump.fun; evidence.address. xRead.dev_* too.");
  ok("prose tokens are dropped and keys kept",
    paths.includes("holders.top1Pct") && paths.includes("pair.priceChange.m5") && paths.includes("address") &&
    paths.includes("xRead.dev_") && !paths.some((p) => /e\.g|pump/.test(p)), paths.join(", "));
  const r = new Set(["pair.priceChange", "xRead.dev_handle", "address"]);
  ok("a child resolves through its parent row", resolves("pair.priceChange.m5", r));
  ok("a prose wildcard resolves through any matching row", resolves("xRead.dev_", r));
  ok("an unknown key does not resolve", !resolves("holders.invented", r));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
