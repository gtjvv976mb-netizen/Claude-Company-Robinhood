import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE KILL SWITCH THAT DISARMS YOUR STOPS ──────────────────────────────────
 * There are two control files and they do very different things:
 *
 *   PAUSE_ENTRIES  blocks new entries only (poller.mjs:955). Exits keep working.
 *   HARD_STOP      blocks entries (poller.mjs:956) AND EVERY EXIT (poller.mjs:1076).
 *
 * The installer advertised them as two bare lines — "Pause entries: touch …" and
 * "Hard stop: touch …" — with nothing to say the second disarms the stop-loss on
 * every open position. An operator reaching for a kill switch reads "hard stop" as
 * the stronger, safer one, and that is the moment it costs them. This test is about
 * what a human is TOLD, because the behaviour itself is deliberate and stays. */
const poller = fs.readFileSync(new URL("./poller.mjs", import.meta.url), "utf8");
const install = fs.readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const floor = fs.readFileSync(new URL("../viewer/office3d.html", import.meta.url), "utf8");

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

ok("the behaviour under test is still the behaviour: hard stop blocks exits", () => {
  assert.match(poller, /if \(hardStop\(\)\) throw new Error\(/,
    "sellAll still refuses under a hard stop — this test documents it, it does not change it");
  assert.match(poller, /if \(pauseEntries\(\)\) return log\(`SKIP/,
    "and the entry pause still only skips entries");
});

ok("the refusal names the consequence, the remedy, and the gentler sentinel", () => {
  const msg = poller.slice(poller.indexOf("HARD STOP is present at"), poller.indexOf("HARD STOP is present at") + 700);
  assert.match(msg, /blocks EXITS as well as entries/, "say what it does");
  assert.match(msg, /no stop-loss while it is there/, "say what that costs");
  assert.match(msg, /Remove it to let the bot close the position/, "say how to undo it");
  assert.match(msg, /entry-pause sentinel/, "point at the control they probably meant");
  assert.doesNotMatch(msg, /^HARD STOP is present — automated exits are blocked; manage the wallet manually$/m,
    "the old message implied an external wallet was the only way out");
});

ok("the installer explains both sentinels rather than listing them", () => {
  const summary = install.slice(install.indexOf("Stop OPENING"), install.indexOf("Stop OPENING") + 500);
  assert.match(summary, /stops stay armed, open positions still exit/, "what the pause does");
  assert.match(summary, /INCLUDING EXITS/, "what the hard stop does");
  assert.match(summary, /no stop-loss until you remove it/, "and what that means for money");
  assert.match(summary, /rm \$HARD_STOP_FILE/, "and how to undo it");
  /* The bare two-line form is what made this dangerous. */
  assert.doesNotMatch(install, /^ {2}Pause entries: {2}touch \$PAUSE_FILE$/m);
  assert.doesNotMatch(install, /^ {2}Hard stop: {6}touch \$HARD_STOP_FILE$/m);
});

ok("the dashboard warns while the hard stop is ACTIVE, not in the abstract", () => {
  const block = floor.slice(floor.indexOf('dashMetric("Hard stop"'), floor.indexOf('dashMetric("Hard stop"') + 420);
  assert.match(block, /BLOCKS EXITS TOO/, "an active hard stop is not a neutral state");
  assert.match(block, /health\?\.hardStop === true\n?\s*\? "BLOCKS EXITS TOO/,
    "the warning is conditional on it actually being active");
  assert.match(block, /: "self-reported control state"/, "and the ordinary caption survives when it is clear");
});

console.log(`\n${n} control-sentinel disclosure checks passed`);
