/**
 * THE UNITS CHANGED UNDER THE COLUMNS, AND AN EXISTING DATABASE MUST NOT BRICK.
 *
 * The Solana desk sized tenants in SOL (bankroll_sol, fixed_sol, size_sol). Chain 4663
 * sizes in ETH (bankroll_eth, fixed_eth, size_eth — the feed contract). This test builds
 * a database in the OLD shape, points copy.js at it, and asserts the one-release
 * read-compat: a row with no ETH value is read from its SOL column as declared, flagged
 * `legacy_units`, and stops being legacy on its first save; the house floor is seeded
 * from the owner's ETH instruction instead; and every write lands in the ETH column
 * with the SOL column mirroring it so readers that have not moved keep working.
 *
 * Nothing here converts a SOL number into an ETH one. 5 SOL is not 5 ETH, and a desk
 * that silently multiplied a tenant's declared bankroll by twelve would be worse than
 * one that refused to boot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

/* THE OLD SHAPE, verbatim from copy.js as it stood on the Solana desk (2026-09-04). */
const LEGACY_DDL = `
CREATE TABLE IF NOT EXISTS floors (n INTEGER PRIMARY KEY, state TEXT, owner TEXT);
CREATE TABLE IF NOT EXISTS copy_settings (
  floor_no    INTEGER PRIMARY KEY REFERENCES floors(n),
  appetite    TEXT NOT NULL DEFAULT 'balanced',
  bankroll_sol REAL NOT NULL DEFAULT 5,
  auto        INTEGER NOT NULL DEFAULT 0,
  categories  TEXT,
  launchpads  TEXT,
  updated_at  INTEGER,
  webhook_url TEXT, executor_url TEXT, executor_secret TEXT,
  executor_heartbeat TEXT, executor_heartbeat_log TEXT, min_liq_usd REAL,
  take_profit_x REAL NOT NULL DEFAULT 0,
  fixed_sol   REAL NOT NULL DEFAULT 0,
  mcap_tier   TEXT NOT NULL DEFAULT 'any'
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER NOT NULL, floor_no INTEGER NOT NULL,
  verdict TEXT NOT NULL, reason TEXT, size_sol REAL, taken INTEGER NOT NULL DEFAULT 0,
  taken_at INTEGER, delivered_at INTEGER NOT NULL, UNIQUE (call_id, floor_no)
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, symbol TEXT, category TEXT, launchpad TEXT,
  source_floor INTEGER, source_scope TEXT NOT NULL DEFAULT 'unattributed', source_attributed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live', conviction REAL, entry_ref REAL, entry_lo REAL, entry_hi REAL, stop REAL, target REAL,
  thesis TEXT, invalidation TEXT, flags_at_call TEXT, liq_at_call REAL, rt_loss_at_call REAL,
  opened_at INTEGER NOT NULL, closed_at INTEGER, close_reason TEXT, close_mark REAL, report_file TEXT
);
-- node:sqlite enforces foreign keys, and copy_settings references floors(n).
INSERT INTO floors (n, state, owner) VALUES (50, 'hq', NULL), (8, 'owned', '0x' || substr('8888888888888888888888888888888888888888', 1, 40)),
  (7, 'owned', NULL), (9, 'owned', NULL);
INSERT INTO copy_settings (floor_no, appetite, bankroll_sol, fixed_sol, launchpads, updated_at)
  VALUES (50, 'aggressive', 0.6, 0.2, NULL, 1);                          -- the house, in SOL (owner, 2026-09-02)
INSERT INTO copy_settings (floor_no, appetite, bankroll_sol, fixed_sol, launchpads, updated_at)
  VALUES (8, 'aggressive', 2, 0.1, '["pump.fun","bags.fm"]', 1);        -- a tenant who chose numbers, and Solana pads
INSERT INTO copy_settings (floor_no, appetite, bankroll_sol, fixed_sol, updated_at)
  VALUES (7, 'aggressive', 5, 0, NULL);                                  -- an untouched Solana-era default
INSERT INTO calls (id, mint, symbol, status, entry_ref, stop, target, opened_at) VALUES (1, 'LegacyMint111', 'OLD', 'closed', 1, 0.8, 2, 1);
INSERT INTO deliveries (call_id, floor_no, verdict, reason, size_sol, delivered_at) VALUES (1, 8, 'offered', 'legacy row', 0.1, 1);
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-co-compat-"));
const file = path.join(dir, "legacy.sqlite");
{
  const raw = new DatabaseSync(file);
  raw.exec(LEGACY_DDL);
  raw.close();
}
// copy.js opens the database named by CLAUDE_CO_DB at import time — so the legacy file
// is named BEFORE anything from src/ is imported, and imported dynamically after.
process.env.CLAUDE_CO_DB = file;
const copy = await import("./src/copy.js");
const { settingsFor, saveSettings, decide, broadcast, feedFor, LAUNCHPADS, DEFAULT_BANKROLL_ETH,
  MIN_EXECUTABLE_ETH, minExecutableEth } = copy;
const { CURVE_LAUNCHPADS, openCall } = await import("./src/calls.js");

console.log("\nAN OLD DATABASE OPENS, AND THE ETH COLUMNS ARRIVE EMPTY");
{
  const raw = new DatabaseSync(file, { readOnly: true });
  const cols = raw.prepare("PRAGMA table_info(copy_settings)").all().map((c) => c.name);
  ok("bankroll_eth and fixed_eth were added", cols.includes("bankroll_eth") && cols.includes("fixed_eth"));
  ok("bankroll_sol and fixed_sol still exist (mirrors for one release)", cols.includes("bankroll_sol") && cols.includes("fixed_sol"));
  const tenant = raw.prepare("SELECT bankroll_eth, fixed_eth, bankroll_sol FROM copy_settings WHERE floor_no=8").get();
  ok("a tenant row was NOT backfilled — 2 SOL was not copied into the ETH column",
    tenant.bankroll_eth == null && tenant.fixed_eth == null && tenant.bankroll_sol === 2,
    `bankroll_eth=${tenant.bankroll_eth} fixed_eth=${tenant.fixed_eth} bankroll_sol=${tenant.bankroll_sol}`);
  const dcols = raw.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name);
  ok("deliveries gained size_eth beside size_sol", dcols.includes("size_eth") && dcols.includes("size_sol"));
  raw.close();
}

console.log("\nA LEGACY ROW HAS NO ETH BANKROLL UNTIL THE TENANT RE-ENTERS ONE, AND SAYS SO");
{
  /* 2 SOL (~$300) read as 2 ETH (~$4,900) is a 12x rescale of the tenant's stated risk,
     delivered as "the size you set". The review of 2026-09-05 called it, rightly. */
  const s = settingsFor(8);
  ok("a SOL-era number is NOT read as ETH — the row has no bankroll", s.bankroll_eth === 0 && s.fixed_eth === 0,
    `bankroll_eth=${s.bankroll_eth} fixed_eth=${s.fixed_eth}`);
  ok("...and flagged as coming from the SOL column", s.legacy_units === "sol_column", String(s.legacy_units));
  ok("the SOL-named keys mirror the ETH view for readers that have not moved",
    s.bankroll_sol === 0 && s.fixed_sol === 0 && s.units === "ETH");
  ok("a Solana pad allow-list is dropped on read — every pad, rather than pads that do not exist here",
    Array.isArray(s.launchpads) && !s.launchpads.includes("pump.fun") && s.launchpads.includes("pons-v2"),
    s.launchpads.join(","));
}

console.log("\nTHE HOUSE FLOOR IS SEEDED FROM THE OWNER'S ETH INSTRUCTION, NOT READ FROM ITS SOL ONE");
{
  const h = settingsFor(50);
  ok("0.6 SOL / 0.2 SOL became 0.05 ETH / 0.016 ETH (awaiting owner confirmation)",
    h.bankroll_eth === 0.05 && h.fixed_eth === 0.016, `bankroll_eth=${h.bankroll_eth} fixed_eth=${h.fixed_eth}`);
  ok("...and the house row is no longer legacy", h.legacy_units === null);
  ok("...with the mirrors written too", h.bankroll_sol === 0.05 && h.fixed_sol === 0.016);
}

console.log("\nTHE FIRST SAVE WRITES ETH AND THE ROW STOPS BEING LEGACY");
{
  const s1 = saveSettings(8, { bankrollEth: 1 });
  ok("bankroll_eth is written", s1.bankroll_eth === 1 && s1.legacy_units === null, `bankroll_eth=${s1.bankroll_eth} legacy=${s1.legacy_units}`);
  ok("the SOL-era fixed size is NOT carried over as ETH — the tenant re-enters it", s1.fixed_eth === 0, `fixed_eth=${s1.fixed_eth}`);
  const raw = new DatabaseSync(file, { readOnly: true });
  const row = raw.prepare("SELECT bankroll_eth, bankroll_sol, fixed_eth, fixed_sol FROM copy_settings WHERE floor_no=8").get();
  raw.close();
  ok("the SOL columns now MIRROR the ETH ones", row.bankroll_sol === 1 && row.fixed_sol === 0,
    `bankroll_sol=${row.bankroll_sol} fixed_sol=${row.fixed_sol}`);
  const s2 = saveSettings(8, { fixedSol: 0.05 });
  ok("the old patch key (fixedSol) is accepted for one release and lands in fixed_eth", s2.fixed_eth === 0.05, `fixed_eth=${s2.fixed_eth}`);
  const s3 = saveSettings(8, { fixedEth: "auto" });
  ok("the new key wins and auto is expressible", s3.fixed_eth === 0 && s3.bankroll_eth === 1);
  const s4 = saveSettings(8, { launchpads: ["pons-v2", "pump.fun", "uniswap"] });
  ok("a launchpad allow-list keeps only this chain's pads", JSON.stringify(s4.launchpads) === JSON.stringify(["pons-v2", "uniswap"]),
    s4.launchpads.join(","));
}

console.log("\nA FRESH FLOOR GETS THE ETH DEFAULT, NEVER THE SOLANA ONE");
{
  const n = settingsFor(9);
  ok("a new floor starts at the ETH default", n.bankroll_eth === DEFAULT_BANKROLL_ETH && n.legacy_units === null,
    `${n.bankroll_eth} ETH (0.4 = the old 5 SOL at the house-seed rate; awaiting owner confirmation)`);
  const u = settingsFor(7);
  ok("an untouched Solana default (5) is NOT read as 5 ETH — no bankroll, FLAGGED, the tenant's to re-enter",
    u.bankroll_eth === 0 && u.legacy_units === "sol_column", `bankroll_eth=${u.bankroll_eth} legacy=${u.legacy_units}`);
}

console.log("\nTHE PAD VOCABULARY IS THE CHAIN'S");
{
  ok("LAUNCHPADS = the creator pads + uniswap + other",
    JSON.stringify(LAUNCHPADS) === JSON.stringify([...CURVE_LAUNCHPADS, "uniswap", "other"]), LAUNCHPADS.join(","));
  ok("the contract's set, exactly", ["pons-v2", "pons", "hoodit", "pools.trade", "bankr", "uniswap"].every((p) => LAUNCHPADS.includes(p)) &&
    !LAUNCHPADS.includes("pump.fun"));
}

console.log("\nSIZES ARE OFFERED IN ETH, WITH GAS AS THE FLOOR");
{
  ok("the executable floor is 0.01 ETH (gas at 5% of a $23 clip at $1.15 and $2,450/ETH)", MIN_EXECUTABLE_ETH === 0.01);
  const spike = minExecutableEth({ gasUsdRoundTrip: 8, ethUsd: 2_450 });
  ok("a 5 gwei spike ($8 round trip) lifts the floor to ~0.065 ETH — a constant would have lied by 6x",
    Math.abs(spike - 0.0653) < 0.001, `${spike} ETH`);
  ok("unreadable gas falls back to the constant, never to zero", minExecutableEth({}) === MIN_EXECUTABLE_ETH);

  saveSettings(8, { fixedEth: 0.05 });
  const call = openCall({ mint: "0xAbCdEf0000000000000000000000000000000001", symbol: "T", category: "memecoin",
    launchpad: "pons-v2", entryRef: 1, stop: 0.8, target: 2, conviction: 60, invalidation: "the story dies" });
  const d = decide(8, call);
  ok("a fixed 0.05 ETH floor is offered 0.05 ETH", d.verdict === "offered" && d.sizeEth === 0.05, `${d.verdict} ${d.sizeEth} — ${d.reason}`);
  ok("...and the SOL-named alias carries the same number for one release", d.sizeSol === d.sizeEth);
  ok("the reason speaks ETH, not SOL", /ETH/.test(d.reason) && !/SOL/.test(d.reason), d.reason);

  saveSettings(8, { fixedEth: "auto", bankrollEth: 0.05 });
  const tiny = decide(8, { ...call, gas_usd_round_trip: 8, eth_usd: 2_450 });
  const spiked = openCall({ mint: "0xAbCdEf0000000000000000000000000000000009", symbol: "SPK", category: "memecoin",
    launchpad: "pons-v2", entryRef: 1, stop: 0.8, target: 2, conviction: 60, gasUsdRoundTrip: 8, ethUsd: 2_450 });
  ok("the gas toll and ETH mark are persisted on the call row at publication",
    spiked?.gas_usd_at_call === 8 && spiked?.eth_usd_at_call === 2_450, `gas_usd_at_call=${spiked?.gas_usd_at_call} eth_usd_at_call=${spiked?.eth_usd_at_call}`);
  const fromRow = decide(8, spiked);
  ok("...and decide() reads them from the ROW, so the spike floor applies hours later without the bundle",
    fromRow.verdict === "skipped" && /0\.0653 ETH/.test(fromRow.reason), fromRow.reason);
  ok("a starved auto floor under a gas spike is refused honestly, in ETH",
    tiny.verdict === "skipped" && /ETH/.test(tiny.reason) && /gas/.test(tiny.reason), tiny.reason);

  saveSettings(8, { fixedEth: 0.05 });
  const b = broadcast(call.id, [8]);
  ok("broadcast delivers", b.ok && b.offered === 1, JSON.stringify(b));
  const feed = feedFor(8, 5);
  const fresh = feed.find((r) => r.call_id === call.id);
  const legacy = feed.find((r) => r.call_id === 1);
  ok("a fresh delivery reports size_eth AND mirrors size_sol", fresh?.size_eth === 0.05 && fresh?.size_sol === 0.05,
    `size_eth=${fresh?.size_eth} size_sol=${fresh?.size_sol}`);
  ok("a Solana-era delivery row (size_sol only) still reports a size through size_eth", legacy?.size_eth === 0.1,
    `size_eth=${legacy?.size_eth}`);
  const raw = new DatabaseSync(file, { readOnly: true });
  const drow = raw.prepare("SELECT size_eth, size_sol FROM deliveries WHERE call_id=?").get(call.id);
  raw.close();
  ok("...and on disk both delivery columns hold the ETH number", drow.size_eth === 0.05 && drow.size_sol === 0.05);
}

console.log("\nA STARVED HOUSE FLOOR IN ETH IS RE-SEEDED ON BOOT (second process, second database)");
{
  const file2 = path.join(dir, "starved.sqlite");
  const raw = new DatabaseSync(file2);
  raw.exec(LEGACY_DDL.replace(/INSERT INTO copy_settings[\s\S]*$/, ""));
  raw.exec(`ALTER TABLE copy_settings ADD COLUMN bankroll_eth REAL; ALTER TABLE copy_settings ADD COLUMN fixed_eth REAL;
    INSERT INTO copy_settings (floor_no, appetite, bankroll_sol, fixed_sol, bankroll_eth, fixed_eth, updated_at)
      VALUES (50, 'aggressive', 0.6, 0.2, 0.01, 0, 1);`);
  raw.close();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const c = await import(${JSON.stringify(new URL("./src/copy.js", import.meta.url).href)});
     console.log(JSON.stringify(c.settingsFor(50)));`],
    { env: { ...process.env, CLAUDE_CO_DB: file2, NODE_ENV: "test" }, encoding: "utf8" });
  let h = null;
  try { h = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  ok("a house floor at 0.01 ETH with no fixed size is seeded to 0.05 / 0.016",
    h?.bankroll_eth === 0.05 && h?.fixed_eth === 0.016, r.status === 0 ? `bankroll_eth=${h?.bankroll_eth} fixed_eth=${h?.fixed_eth}` : r.stderr.slice(-300));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
