/**
 * THE NODE VERSION IS PINNED, IN EVERY PLACE THAT DECIDES IT, TO THE SAME NUMBER.
 *
 * This service ran for days and then could not be redeployed. Its Node version was
 * pinned NOWHERE — not in render.yaml, not in .node-version, not in .nvmrc — and
 * package.json carried only a RANGE, ">=22.13.0 <25". A range is not a pin: the build
 * platform picks a version inside it, and the pick can move under a service that has
 * not been rebuilt in days, which is exactly the shape of "it worked on Friday".
 *
 * This app cannot survive the wrong pick. src/lib/store.js and src/funnel.js import
 * DatabaseSync from node:sqlite, which does not exist before Node 22.5 — so an older
 * default is not a warning, it is an import error at boot and in all 114 test files.
 *
 * Two files now name the version and package.json bounds it. Three copies of one fact
 * is the arrangement this repo has been burned by more than any other, so they are
 * asserted equal here rather than trusted: the pin must be an exact version, both
 * copies must agree, and the version must satisfy the engines range it lives inside.
 *
 *   node test-node-pin.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const dotNode = fs.readFileSync(new URL("./.node-version", import.meta.url), "utf8").trim();
const render = fs.readFileSync(new URL("./render.yaml", import.meta.url), "utf8");

console.log("\nTHE PIN IS AN EXACT VERSION, NOT A RANGE");
ok(".node-version names one exact version", /^\d+\.\d+\.\d+$/.test(dotNode), dotNode);
const renderPin = render.match(/key:\s*NODE_VERSION\s*\n\s*value:\s*"?(\d+\.\d+\.\d+)"?/)?.[1];
ok("render.yaml pins NODE_VERSION to an exact version", !!renderPin, renderPin ?? "absent");
ok("...and the two agree", dotNode === renderPin, `${dotNode} vs ${renderPin}`);

console.log("\nTHE PIN SATISFIES THE RANGE package.json DECLARES");
{
  const range = pkg.engines?.node ?? "";
  const [maj, min, pat] = dotNode.split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  let lo = null, hi = null;
  for (const part of range.split(/\s+/)) {
    const m = part.match(/^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!m) continue;
    const v = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    if (m[1] === ">=") lo = v; else hi = v;
  }
  ok("engines declares a lower and an upper bound", !!lo && !!hi, range);
  ok("the pinned version is at or above the lower bound", cmp([maj, min, pat], lo) >= 0, `${dotNode} >= ${lo?.join(".")}`);
  ok("...and below the upper bound", cmp([maj, min, pat], hi) < 0, `${dotNode} < ${hi?.join(".")}`);
}

console.log("\nTHE PIN IS HIGH ENOUGH FOR THE ONE API THE APP CANNOT RUN WITHOUT");
{
  /* node:sqlite's DatabaseSync landed in 22.5. Asserted against the real imports rather
     than a remembered number: if the app stops using it, this check should stop too. */
  const users = ["src/lib/store.js", "src/funnel.js"]
    .filter((f) => /from "node:sqlite"/.test(fs.readFileSync(new URL("./" + f, import.meta.url), "utf8")));
  ok("the app really does depend on node:sqlite", users.length > 0, users.join(", "));
  const [maj, min] = dotNode.split(".").map(Number);
  ok("the pin is at least 22.5, where DatabaseSync exists", maj > 22 || (maj === 22 && min >= 5), dotNode);
}

console.log("\nTHE RUNNING NODE CAN ACTUALLY LOAD IT");
ok("node:sqlite imports on this interpreter", await (async () => {
  try { await import("node:sqlite"); return true; } catch { return false; }
})(), process.version);

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
