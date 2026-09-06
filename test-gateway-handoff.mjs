import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE GATEWAY IS A DIFFERENT ORIGIN ────────────────────────────────────────
 * The gateway is claudedotcompany.com and this tower is
 * robinhood.claudedotcompany.com. sessionStorage is per-origin, so the reader
 * here had never once seen the gateway's cc_gate — and the value it did expect
 * was the wrong shape besides: the gateway stored a descriptor OBJECT where
 * this side tested String(g.wallet) against /^0x…$/, which stringifies to
 * "[object Object]". Doubly dead, silently, since the towers moved to their own
 * subdomains. It travels in the fragment now — never sent to a server, stripped
 * on arrival — and carries only which provider to prefer. */
const html = fs.readFileSync(new URL("./viewer/tower.html", import.meta.url), "utf8");
const gate = html.slice(html.indexOf("const GATE = (() => {"), html.indexOf("async function providerHolding"));

assert.match(gate, /\/\[#&\]cc=\(\[\^&\]\*\)\/\.exec\(location\.hash \|\| ""\)/,
  "the handoff is read from the fragment");
assert.match(gate, /history\.replaceState\(null, "", location\.pathname \+ location\.search\)/,
  "...and stripped from the URL on arrival");
assert.match(gate, /if \(!g\) g = JSON\.parse\(sessionStorage\.getItem\("cc_gate"\) \|\| "null"\)/,
  "a same-origin build still works the old way");
assert.match(gate, /const world = g && \(g\.w \|\| g\.world\)/,
  "both the new and the old key are accepted");
assert.match(gate, /wallet: \/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(raw\) \? raw\.toLowerCase\(\) : null/,
  "an address that is not an address becomes null instead of poisoning the gate");
assert.match(gate, /rdns: \(g && \(g\.r \|\| g\.rdns\)\) \|\| null/,
  "the provider preference is what actually crosses");
assert.match(gate, /try \{ g = JSON\.parse\(decodeURIComponent\(hop\[1\]\)\); \} catch \{\}/,
  "a malformed fragment is ignored, not thrown");

/* Every consumer must survive a gate with no address, which is now the norm. */
for (const use of [
  /GATE\?\.wallet && !token\(\) \? `Continue as \$\{short\(GATE\.wallet\)\}` : "Connect wallet"/,
  /let prefer = GATE\?\.rdns \|\| null;/,
  /if \(GATE\?\.wallet && !prefer\) prefer = await providerHolding\(GATE\.wallet\);/,
]) assert.match(html, use, "gate consumers stay null-safe");

console.log("gateway handoff: crosses the origin, carries no address, survives junk");
