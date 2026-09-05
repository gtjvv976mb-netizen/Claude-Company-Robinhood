import db, { ensureColumn } from "./lib/store.js";
import crypto from "node:crypto";
import { emit } from "./lib/bus.js";
import { CATEGORY_RISK } from "./market.js";
import { cfg } from "./config.js";
import { CAP_BANDS } from "./categories.js";
import { liveCalls, getCall, CURVE_LAUNCHPADS, canonicalLaunchpad } from "./calls.js";
import { inArrears } from "./leasing.js";

/** The pads a floor can choose between, on Robinhood Chain (4663). `pons-v2` is the
 * current PONS factory, `pons` its V1 (WETH-paired, V3); `uniswap` is a coin that was
 * simply listed; `other` covers established coins with no pad. The set is the executor
 * scope-guard's and the sweep's vocabulary — one list, built from the pads that carry a
 * creator (calls.js) plus the two that do not. */
export const LAUNCHPADS = [...CURVE_LAUNCHPADS, "uniswap", "other"];

/**
 * COPY TRADING — how one house call becomes fifty different decisions.
 *
 * Every line here is deterministic code. That is the point: it runs per floor, per call,
 * and must cost nothing, or the product stops working at scale. The expensive thinking
 * happened once, upstairs.
 *
 * "Auto" never means the desk signs. It means the call is delivered instantly with a
 * ready ticket the tenant taps once in their own wallet. There is no code path here that
 * touches a key, and none should ever be added.
 */

export const APPETITES = {
  conservative: { riskPctPerTrade: 0.5, minConviction: 70, maxOpen: 3,
    categories: ["established", "utility", "infra"],
    note: "Only the survivable categories, small size, high bar." },
  balanced:     { riskPctPerTrade: 1.5, minConviction: 55, maxOpen: 5,
    categories: ["established", "utility", "infra", "defi", "ai"],
    note: "Everything but pure memecoins." },
  aggressive:   { riskPctPerTrade: 3.0, minConviction: 40, maxOpen: 8,
    categories: ["established", "utility", "infra", "defi", "ai", "memecoin", "unclear"],
    note: "Takes memecoins. The base rate on those is brutal — size accordingly." },
};

/* THE UNITS CHANGED UNDER THE COLUMNS (2026-09-05).
 *
 * The Solana desk sized tenants in SOL: bankroll_sol, fixed_sol, size_sol. On chain
 * 4663 the gas token is ETH and the executor's caps are ETH, so the feed contract now
 * speaks bankroll_eth / fixed_eth and the delivery carries size_eth. The rename is
 * done as NEW columns beside the old ones rather than in place, for one reason that
 * matters more than tidiness: a number declared in SOL is not a number in ETH, and a
 * migration that copied 5 across would have turned a $1,000 bankroll into a $12,000
 * one without anybody typing it. So:
 *
 *   - the ETH columns are the ones READ; a row whose ETH column is NULL (an existing
 *     database gains them empty) is read from its SOL column for exactly one release,
 *     with `legacy_units` set so the UI and the feed can say so — the value is taken
 *     as declared, never converted, because converting it would be the desk
 *     re-deriving a number the tenant chose;
 *   - the SOL-named columns STAY in the schema for that release as MIRRORS: every
 *     write lands in both, so office.js (`SELECT d.size_sol`), alerts.js and the
 *     dashboard keep working on a fresh database until they move to the ETH names
 *     (docs/HANDOFF-desk-loop.md). Once a row's ETH column is set, its SOL column is a
 *     copy of the ETH number and nothing more;
 *   - the first save writes the ETH columns and the row stops being legacy;
 *   - the house floor is the one exception, seeded below from the owner's own ETH
 *     instruction rather than read from its SOL one.
 *
 * `DEFAULT_BANKROLL_ETH` is the ETH translation of the old 5 SOL default at the same
 * rate the house seed uses (0.6 SOL -> 0.05 ETH, i.e. $2,450/ETH and ~$204/SOL):
 * 5 x 204 / 2450 = 0.417, rounded to 0.4. AWAITING OWNER CONFIRMATION, like the seed. */
export const DEFAULT_BANKROLL_ETH = 0.4;

db.exec(`
CREATE TABLE IF NOT EXISTS copy_settings (
  floor_no    INTEGER PRIMARY KEY REFERENCES floors(n),
  appetite    TEXT NOT NULL DEFAULT 'balanced',
  bankroll_eth REAL NOT NULL DEFAULT ${DEFAULT_BANKROLL_ETH},   -- ETH, held in the tenant own wallet
  fixed_eth   REAL NOT NULL DEFAULT 0,         -- 0 = auto, else the same ETH on every trade
  bankroll_sol REAL NOT NULL DEFAULT ${DEFAULT_BANKROLL_ETH},   -- MIRROR of bankroll_eth for one release (see above)
  fixed_sol   REAL NOT NULL DEFAULT 0,         -- MIRROR of fixed_eth for one release
  auto        INTEGER NOT NULL DEFAULT 0,     -- deliver instantly with a ready ticket
  categories  TEXT,                            -- JSON override of the appetite default
  launchpads  TEXT,                            -- JSON allow-list of pads; null = every pad
  updated_at  INTEGER
);

-- One row per (call, floor): what this floor was told, and what it did about it.
CREATE TABLE IF NOT EXISTS deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     INTEGER NOT NULL REFERENCES calls(id),
  floor_no    INTEGER NOT NULL,
  verdict     TEXT NOT NULL,        -- offered | skipped
  reason      TEXT,
  size_eth    REAL,
  size_sol    REAL,                 -- MIRROR of size_eth for one release
  taken       INTEGER NOT NULL DEFAULT 0,
  taken_at    INTEGER,
  delivered_at INTEGER NOT NULL,
  UNIQUE (call_id, floor_no)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_floor ON deliveries(floor_no, id DESC);
`);

/**
 * A floor has two numbers, and conflating them would be the most dangerous mistake in
 * this product:
 *
 *   BUDGET   — $CLAUDECO. The access token, and nothing else: it pays the lease and
 *              the rent. It is never traded and buys no exposure.
 *   BANKROLL — ETH. The trading capital, which stays in the tenant own wallet. The
 *              desk never holds it, never sees it, and never signs for it. It exists
 *              here only as a declared number so calls can be sized.
 *
 * The desk can spend the first and only ever sizes against the second.
 */
// Migrations for databases that predate these columns — production is always one of them.
// The ETH columns are added EMPTY on an old database: see the units note above. The
// SOL mirrors are added with their historical defaults on a database old enough to
// lack even those (they existed on the Solana desk since 2026-08-30).
ensureColumn("copy_settings", "bankroll_eth", "REAL");
ensureColumn("copy_settings", "fixed_eth", "REAL");
ensureColumn("copy_settings", "bankroll_sol", "REAL NOT NULL DEFAULT 5");
ensureColumn("copy_settings", "fixed_sol", "REAL NOT NULL DEFAULT 0");
ensureColumn("deliveries", "size_sol", "REAL", "size_usd");
ensureColumn("copy_settings", "webhook_url", "TEXT");
ensureColumn("copy_settings", "executor_url", "TEXT");
ensureColumn("copy_settings", "executor_secret", "TEXT");
// Self-reported executor liveness: {mode,wallet,cursor,open,ts,seenAt} JSON. The site
// never CLAIMS the bot is live — it relays what the bot last said about itself.
ensureColumn("copy_settings", "executor_heartbeat", "TEXT");
// The last 48 pulses, oldest first: {seenAt, mode, open, state}. The single latest blob
// gave the WALL-ST-E tab no history at all — every past pulse was overwritten.
ensureColumn("copy_settings", "executor_heartbeat_log", "TEXT");
ensureColumn("copy_settings", "launchpads", "TEXT");
ensureColumn("copy_settings", "min_liq_usd", "REAL");   // per-floor liquidity floor; null = no floor
ensureColumn("deliveries", "size_eth", "REAL");

/* THE THREE DIALS A TENANT OWNS.
 *
 * Everything above decides WHICH calls reach a floor. These decide what the floor
 * DOES with one, and each has an explicit auto mode where the desk decides instead —
 * because the honest default for someone who has never watched this run is not a
 * number they had to invent, it is "let the team choose and show me what it chose".
 *
 *   take_profit_x  0 = auto (the execution seat's authored target), else a hard
 *                  multiple: 2 sells at a double, 10 rides for a ten-bagger.
 *   fixed_eth      0 = auto (Kelly sizing on the record), else the same size every
 *                  trade. Overrides how MUCH, never WHETHER.
 *   mcap_tier      which end of the market this floor wants: micro, low, mid, any.
 *
 * A tenant who sets nothing gets auto on all three, which is exactly the desk's own
 * behaviour — so the dials add choice without changing the default experience. */
ensureColumn("copy_settings", "take_profit_x", "REAL NOT NULL DEFAULT 0");
ensureColumn("copy_settings", "mcap_tier", "TEXT NOT NULL DEFAULT 'any'");

/* One-time data migrations need their own ledger. ALTER TABLE keeps schemas current,
 * but it cannot repair a value that an older release seeded incorrectly. In that
 * release floor 50 was created with the balanced preset, whose category list excludes
 * memecoins; the memecoin desk consequently skipped every call it published. The
 * migration changes only the legacy default shape (balanced + no explicit category
 * override), so a deliberate custom allow-list is never touched. */
db.exec(`
CREATE TABLE IF NOT EXISTS data_migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`);

function migrateData(name, fn) {
  if (db.prepare("SELECT 1 FROM data_migrations WHERE name=?").get(name)) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.prepare("INSERT INTO data_migrations (name, applied_at) VALUES (?,?)")
      .run(name, Date.now());
    db.exec("COMMIT");
    return true;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

migrateData("2026-08-31-hq-memecoin-appetite", () => {
  db.prepare(`UPDATE copy_settings SET appetite='aggressive', updated_at=?
              WHERE floor_no=50 AND appetite='balanced' AND categories IS NULL
                AND (updated_at IS NULL OR updated_at < 1788101164000)`)
    .run(Date.now());
});

/**
 * The market-cap sleeves a floor can subscribe to.
 *
 * These are the SAME five bands the desk sorts the market into — see categories.js.
 * They were briefly their own thing, derived from the screen's ceiling, which created
 * two market-cap taxonomies that disagreed the moment the ceiling moved: the desk
 * would call a coin "low" while a tenant's "low" sleeve refused it. One vocabulary,
 * defined once, or the filter a tenant picks does not mean what the desk means by it.
 */
/* THE AUTO SIZE, for a tenant who states funds but no per-trade number: a percentage of
 * their own bankroll, scaled by the category's risk and the call's conviction. One desk
 * number, because sizing policy is the team's job too — the tenant's lever is the
 * explicit per-trade ETH amount, which overrides this entirely. */
export const AUTO_RISK_PCT_PER_TRADE = Number(process.env.DESK_AUTO_RISK_PCT || 3);

export const MCAP_TIERS = {
  ...Object.fromEntries(Object.entries(CAP_BANDS).map(([k, b]) => [k, { lo: b.lo, hi: b.hi, note: b.note }])),
  any: { lo: 0, hi: Infinity, note: "every band the desk calls" },
};

/* THE HOUSE FLOOR'S SIZE, IN ETH (2026-09-05).
   On the Solana desk the owner asked for a fixed 0.2 SOL per trade on a 0.6 SOL wallet
   (2026-09-02, after floor 50 sat starved for twelve hours at 0.05 SOL x 3%). This is
   the ETH translation of exactly that instruction at $2,450/ETH: 0.6 SOL -> 0.05 ETH
   bankroll, 0.2 SOL -> 0.016 ETH fixed. AWAITING OWNER CONFIRMATION — the numbers are
   a currency conversion of the owner's words, not new words from the owner. It seeds
   only the house floor, only while that floor is in the starved state or has never
   been sized in ETH at all; anything set afterwards in the Team tab wins. */
const HOUSE_SEED = { floor: 50, bankrollEth: 0.05, fixedEth: 0.016 };

/* ONE-TIME CORRECTION FOR THE HOUSE FLOOR (2026-09-03). Floor 50 sat on the `micro`
   sleeve, so it refused every call above $100k — and after the sleeves were rebuilt
   around the owner's six bands, `micro` means $20k-$60k, which would have refused
   almost everything. The owner wants all six bands traded, so the house floor is put
   on `any` once. It moves only a floor still holding the pre-rebuild default; a
   sleeve chosen in the Team tab afterwards wins. */
function widenHouseFloorSleeve() {
  try {
    const cur = db.prepare("SELECT mcap_tier FROM copy_settings WHERE floor_no=?").get(HOUSE_SEED.floor);
    if (!cur || cur.mcap_tier !== "micro") return;
    db.prepare("UPDATE copy_settings SET mcap_tier='any', updated_at=? WHERE floor_no=? AND mcap_tier='micro'")
      .run(Date.now(), HOUSE_SEED.floor);
    console.log(`[copy] house floor ${HOUSE_SEED.floor} was on the micro sleeve and refused every larger call; widened to every sleeve`);
  } catch (e) { console.error("[copy] house sleeve widen skipped:", e.message); }
}

function seedStarvedHouseFloor() {
  try {
    const cur = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(HOUSE_SEED.floor);
    if (!cur) {
      /* A FRESH DATABASE has no house row, and settingsFor() would create one at the
         tenant default (0.4 ETH, auto) — not the owner's instruction. The house floor is
         born seeded (measured on the first Robinhood boot, 2026-09-05: the feed showed
         bankroll_eth 0.4 for floor 50 until this branch existed). */
      db.prepare("INSERT INTO copy_settings (floor_no, appetite, bankroll_eth, fixed_eth, bankroll_sol, fixed_sol, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(HOUSE_SEED.floor, "aggressive", HOUSE_SEED.bankrollEth, HOUSE_SEED.fixedEth, HOUSE_SEED.bankrollEth, HOUSE_SEED.fixedEth, Date.now());
      console.log(`[copy] house floor ${HOUSE_SEED.floor} created seeded: bankroll ${HOUSE_SEED.bankrollEth} ETH, fixed ${HOUSE_SEED.fixedEth} ETH per trade (awaiting owner confirmation)`);
      return;
    }
    /* Two ways in. NEVER SIZED IN ETH: the row predates the unit change, so its SOL
       numbers are the owner's Solana instruction and the seed is that instruction in
       this chain's currency — reading 0.6 SOL as 0.6 ETH would size the house at
       twelve times what was asked. STARVED: the same trap as 2026-09-02, in ETH. */
    const neverSizedInEth = cur.bankroll_eth == null && cur.fixed_eth == null;
    const starved = Number(cur.bankroll_eth) < HOUSE_SEED.bankrollEth && !(Number(cur.fixed_eth) > 0);
    if (!neverSizedInEth && !starved) return;
    db.prepare("UPDATE copy_settings SET bankroll_eth=?, fixed_eth=?, bankroll_sol=?, fixed_sol=?, updated_at=? WHERE floor_no=?")
      .run(HOUSE_SEED.bankrollEth, HOUSE_SEED.fixedEth, HOUSE_SEED.bankrollEth, HOUSE_SEED.fixedEth, Date.now(), HOUSE_SEED.floor);
    console.log(`[copy] house floor ${HOUSE_SEED.floor} was ${neverSizedInEth ? "never sized in ETH" : "starved"} ` +
      `(bankroll ${cur.bankroll_eth ?? `${cur.bankroll_sol ?? "?"} SOL-era`}, fixed ${cur.fixed_eth ?? cur.fixed_sol ?? "?"}); ` +
      `seeded bankroll ${HOUSE_SEED.bankrollEth} ETH, fixed ${HOUSE_SEED.fixedEth} ETH per trade (awaiting owner confirmation)`);
  } catch (e) { console.error("[copy] house seed skipped:", e.message); }
}
seedStarvedHouseFloor();
widenHouseFloorSleeve();

/** The ETH view of a stored row, with the one-release fallback to its SOL columns. */
function ethView(s) {
  const legacy = s.bankroll_eth == null && s.bankroll_sol != null;
  /* A SOL-era row's NUMBER is never read as ETH: 2 SOL (~$300) sized as 2 ETH (~$4,900)
     is a 12x rescale of the tenant's stated risk, delivered as "the size you set". A
     legacy row has NO bankroll until the tenant re-enters one; legacy_units says why
     (review, 2026-09-05). The mirror columns still let an old reader see its old value. */
  const bankrollEth = s.bankroll_eth != null ? Number(s.bankroll_eth) : legacy ? 0 : DEFAULT_BANKROLL_ETH;
  const fixedEth = s.fixed_eth != null ? Number(s.fixed_eth) : 0;
  return { bankrollEth, fixedEth, legacy };
}

/* A stored allow-list, in this chain's vocabulary. A row carried over from the Solana
 * desk may hold ["pump.fun","bags.fm"] — pads no coin here carries — and read literally
 * that is a floor that never receives another call, with no explanation. Foreign names
 * are dropped on read (through the alias table, so "pons" and "hood.fun" survive as
 * "pons-v2" and "hoodit"); a list with nothing left means "no preference", every pad,
 * exactly as an empty list does on save. The row itself is rewritten on its next save. */
function storedPads(json) {
  if (!json) return LAUNCHPADS;
  let list;
  try { list = JSON.parse(json); } catch { return LAUNCHPADS; }
  if (!Array.isArray(list)) return LAUNCHPADS;
  const kept = [...new Set(list.map(canonicalLaunchpad).filter((p) => LAUNCHPADS.includes(p)))];
  return kept.length ? kept : LAUNCHPADS;
}

export function settingsFor(floorNo) {
  let s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  if (!s) {
    /* This is a memecoin desk. 'balanced' — whose own note reads "Everything but
     * pure memecoins" — receives NONE of what it publishes. Seeding tenants with it
     * meant a floor that leased, installed the bot and touched nothing got zero calls,
     * forever, with no message saying why: the end-to-end tenant test measured
     * offered=0 skipped=1 on untouched defaults. A default that delivers nothing is
     * not a cautious setting; it is a product that does not work. New floors are
     * seeded with the appetite that matches what this desk actually publishes;
     * existing rows are never rewritten, and every tenant can still choose. */
    const appetite = "aggressive";
    // The ETH columns are written explicitly: on a migrated database they are
    // nullable and a bare INSERT would create a "legacy" row with no legacy value.
    db.prepare("INSERT INTO copy_settings (floor_no, appetite, bankroll_eth, fixed_eth, bankroll_sol, fixed_sol, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(floorNo, appetite, DEFAULT_BANKROLL_ETH, 0, DEFAULT_BANKROLL_ETH, 0, Date.now());
    s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  }
  /* THE FEED SECRET IS MINTED ON DEMAND, NOT AS A SIDE EFFECT OF A WEBHOOK.
   * It previously appeared only when a tenant set an executor_url — but the shipped
   * bot POLLS /executor/feed and never receives a webhook, so the documented path
   * could not obtain the credential it is authenticated by. Every floor gets one the
   * first time its settings are read; it is revealed only to that floor's owner. */
  if (!s.executor_secret) {
    db.prepare("UPDATE copy_settings SET executor_secret=? WHERE floor_no=? AND executor_secret IS NULL")
      .run(crypto.randomBytes(24).toString("hex"), floorNo);
    s = db.prepare("SELECT * FROM copy_settings WHERE floor_no=?").get(floorNo);
  }
  const preset = APPETITES[s.appetite] ?? APPETITES.balanced;
  const { bankrollEth, fixedEth, legacy } = ethView(s);
  return { ...s, auto: !!s.auto, preset,
    bankroll_eth: bankrollEth, fixed_eth: fixedEth,
    /* Read-compat, ONE release: the SOL-named keys carry the ETH number so a reader
     * that has not moved yet (the feed route, the alerts, the viewer form) keeps
     * working, and `legacy_units` says whether that number came from a SOL column. */
    bankroll_sol: bankrollEth, fixed_sol: fixedEth,
    legacy_units: legacy ? "sol_column" : null,
    units: "ETH",
    categories: s.categories ? JSON.parse(s.categories) : preset.categories,
    // null means every pad — a floor that has expressed no preference should not
    // silently miss calls when a new launchpad is added.
    launchpads: storedPads(s.launchpads) };
}

export function saveSettings(floorNo, patch) {
  const cur = settingsFor(floorNo);
  const appetite = APPETITES[patch.appetite] ? patch.appetite : cur.appetite;
  // The ETH key is canonical; the SOL-named key is accepted for one release from a
  // viewer that has not been rebuilt. Same number, same meaning: a declaration to
  // THIS desk, in this desk's currency.
  const bankPatch = patch.bankrollEth ?? patch.bankrollSol;
  // NaN survives both clamps and binds as NULL into a NOT NULL column, throwing away
  // the ENTIRE settings save; and a bankroll of 0 sizes every call to nothing, muting
  // the floor with no explanation. Fall back to the stored value in both cases.
  const bankRaw = Number(bankPatch ?? cur.bankroll_eth);
  /* The 100,000 clamp is inherited from the SOL column unchanged: it exists to catch a
     typo, and 100,000 ETH is as much of one as 100,000 SOL was. */
  const bankroll = Number.isFinite(bankRaw) && bankRaw > 0
    ? Math.min(100_000, bankRaw)
    : (Number(cur.bankroll_eth) > 0 ? Number(cur.bankroll_eth) : DEFAULT_BANKROLL_ETH);
  const auto = patch.auto == null ? (cur.auto ? 1 : 0) : (patch.auto ? 1 : 0);
  // The column is an EXPLICIT override and nothing else. The first version wrote the
  // previous appetite's list back whenever the appetite changed, so switching to
  // aggressive silently kept conservative's categories and the floor still refused
  // memecoins. Null means "follow whatever the appetite says".
  // Omitted key = keep the stored override; the UI form sends only appetite/
  // bankroll/auto/webhook, and writing NULL for what it did not send silently
  // wiped explicit category/launchpad overrides on every ordinary save.
  const raw = db.prepare("SELECT categories, launchpads FROM copy_settings WHERE floor_no=?").get(floorNo) || {};
  // An empty selection means "follow my appetite's default", NOT "chase nothing" —
  // storing [] would silently skip every call, an easy footgun off one stray click.
  const catList = Array.isArray(patch.categories) ? patch.categories.filter((c) => c in CATEGORY_RISK) : null;
  const cats = "categories" in patch
    ? (catList && catList.length ? JSON.stringify(catList) : null)
    : raw.categories ?? null;
  const hook = "webhookUrl" in patch ? (patch.webhookUrl || null) : cur.webhook_url ?? null;
  // The executor lane: setting a URL mints the floor's signing secret once;
  // clearing the URL keeps the secret so re-enabling doesn't rotate it under
  // a bot the tenant already configured.
  let execUrl = cur.executor_url ?? null, execSecret = cur.executor_secret ?? null;
  if ("executorUrl" in patch) {
    execUrl = patch.executorUrl || null;
    if (execUrl && !execSecret) execSecret = crypto.randomBytes(24).toString("hex");
  }
  // The POLLER needs a secret but no URL — it dials out. Minting was gated on
  // setting a webhook URL, so a tenant had to invent a fake one to get their
  // own secret. Ask for it directly instead.
  if (patch.mintExecutorSecret && !execSecret) execSecret = crypto.randomBytes(24).toString("hex");
  // A secret that has been seen by anyone else is spent. Rotation invalidates
  // the old one the instant it is written: any executor still holding it gets
  // 401 on its next poll and simply stops — it can never trade on a stale key.
  if (patch.rotateExecutorSecret) execSecret = crypto.randomBytes(24).toString("hex");
  // Same empty-selection footgun the categories column already guards against: an
  // empty allow-list is stored literally and the floor never receives another call.
  // Empty means "no preference" (every pad), never "no pads".
  const padList = Array.isArray(patch.launchpads)
    ? [...new Set(patch.launchpads.map(canonicalLaunchpad).filter((l) => LAUNCHPADS.includes(l)))] : null;
  const pads = "launchpads" in patch
    ? (padList && padList.length ? JSON.stringify(padList) : null)
    : raw.launchpads ?? null;
  // The liquidity floor: a coin whose book at call-time is thinner than this is
  // skipped for this floor. 0 / null = no floor. Omitted key keeps the stored value.
  const minLiq = "minLiqUsd" in patch
    ? (patch.minLiqUsd == null ? null : Math.max(0, Math.min(50_000_000, Number(patch.minLiqUsd) || 0)) || null)
    : cur.min_liq_usd ?? null;
  /* THE TENANT'S THREE DIALS. Each accepts 0 / "auto" meaning "the desk decides",
   * which is the default — a number someone had to invent before ever watching this
   * run is worse than the team's own judgement. Clamped, because a take-profit of
   * 0.5x is an instruction to sell at a 50% loss and a 900 ETH "fixed fund" on a
   * 0.4 ETH bankroll is a typo, not a strategy. */
  const takeProfitX = "takeProfitX" in patch
    ? (patch.takeProfitX == null || patch.takeProfitX === "auto" ? 0
       : Math.min(100, Math.max(1.05, Number(patch.takeProfitX) || 0)))
    : (cur.take_profit_x ?? 0);
  const fixedKey = "fixedEth" in patch ? "fixedEth" : "fixedSol" in patch ? "fixedSol" : null;
  const fixedEth = fixedKey
    ? (patch[fixedKey] == null || patch[fixedKey] === "auto" ? 0
       : Math.min(bankroll, Math.max(0, Number(patch[fixedKey]) || 0)))
    : (cur.fixed_eth ?? 0);
  const mcapTier = "mcapTier" in patch && MCAP_TIERS[patch.mcapTier] ? patch.mcapTier : (cur.mcap_tier ?? "any");

  // The ETH columns are the record; the SOL columns are written as mirrors of the same
  // ETH number for one release. A legacy row stops being legacy on its first save.
  db.prepare("UPDATE copy_settings SET appetite=?, bankroll_eth=?, bankroll_sol=?, auto=?, categories=?, launchpads=?, min_liq_usd=?, webhook_url=?, executor_url=?, executor_secret=?, take_profit_x=?, fixed_eth=?, fixed_sol=?, mcap_tier=?, updated_at=? WHERE floor_no=?")
    .run(appetite, bankroll, bankroll, auto, cats, pads, minLiq, hook, execUrl, execSecret, takeProfitX, fixedEth, fixedEth, mcapTier, Date.now(), floorNo);
  return settingsFor(floorNo);
}

const openCount = (floorNo) => db.prepare(`
  SELECT COUNT(*) n FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? AND d.taken=1 AND c.status='live'`).get(floorNo).n;

/* HOW MANY POSITIONS A BOT MAY HOLD AT ONCE. Set by the desk, not the tenant: it is a
 * property of how this desk trades — several small clips running at once, each on its
 * own band's clock — and not a taste the customer should have to have. */
export const MAX_OPEN_POSITIONS = Number(process.env.DESK_MAX_OPEN_POSITIONS || 8);

/* THE SMALLEST CLIP GAS DOES NOT EAT.
 *
 * The Solana number was 0.02 SOL, chosen so that two worst-case 500k-lamport fees
 * ($0.20) were 5% of the clip. Same policy here — gas at or under 5% of the position —
 * but gas on 4663 is FLAT and MOVING: a round trip is 660,996 gas both legs
 * (live-thresholds.mjs, measured 2026-09-04), $1.15 at the 0.706 gwei base fee of that
 * day and ~$8 at the >5 gwei intraday spikes. $1.15 / 5% = $23 = 0.0094 ETH at
 * $2,450, rounded to 0.01. The constant is the floor for a floor that cannot read gas
 * live; `minExecutableEth()` recomputes it from a live reading when the call carries
 * one, because a constant tuned on a 0.7 gwei day is wrong by 8x on a 5 gwei one. */
export const MIN_EXECUTABLE_ETH = Number(process.env.MIN_EXECUTABLE_ETH || 0.01);
export const GAS_SHARE_OF_CLIP_MAX = 0.05;
export function minExecutableEth({ gasUsdRoundTrip = null, ethUsd = null } = {}) {
  const gas = Number(gasUsdRoundTrip), eth = Number(ethUsd);
  if (!(gas > 0) || !(eth > 0)) return MIN_EXECUTABLE_ETH;
  return Math.max(MIN_EXECUTABLE_ETH, Number(((gas / GAS_SHARE_OF_CLIP_MAX) / eth).toFixed(4)));
}

/**
 * What should THIS floor do about THIS call?
 *
 * THE TENANT CHOOSES TWO NUMBERS: how much money their bot has, and how much ETH goes
 * into each trade. Nothing else (owner, 2026-09-03). Every other question — which
 * launchpad, which category, which market-cap sleeve, what liquidity is enough, what
 * conviction clears the bar — is the trading team's job, and the team answers it once,
 * upstream, by deciding what to publish at all. A customer who has to assemble a
 * filter policy before their bot works has been handed the desk's job; and every one
 * of those filters was, in practice, a way to receive nothing. On 2026-09-02 the house
 * floor's own bot sat armed for twelve hours while every call it was sent died on one
 * of them.
 *
 * So what remains here is only what is genuinely per-floor: whether the rent is paid,
 * how much of the tenant's own money to put in, and whether that money is enough to
 * clear the chain's gas.
 */
export function decide(floorNo, call) {
  const s = settingsFor(floorNo);

  // Rent unpaid: the floor stops receiving NEW calls. It never stops receiving exits —
  // holding someone in a position over a billing dispute would be indefensible, and
  // exits are published to every floor regardless of what it owes.
  if (inArrears(floorNo))
    return { verdict: "skipped", reason: "rent is overdue — top up $CLAUDECO to resume new calls" };
  const risk = CATEGORY_RISK[call.category] ?? CATEGORY_RISK.unclear;

  const open = openCount(floorNo);
  if (open >= MAX_OPEN_POSITIONS)
    return { verdict: "skipped", reason: `already holding ${open} of a maximum ${MAX_OPEN_POSITIONS}` };

  /* SIZE. Two ways, and the tenant picks: a FIXED fund — the same ETH on every trade,
   * which makes a young record legible because every outcome is comparable — or auto,
   * where the desk sizes from the floor's bankroll, the category's risk and the call's
   * own conviction. Fixed overrides how MUCH; it never overrides the refusals above. */
  const convScale = call.conviction != null ? Math.min(1, Math.max(0.4, call.conviction / 100)) : 0.6;
  const autoSize = s.bankroll_eth * (AUTO_RISK_PCT_PER_TRADE / 100) * risk.sizeMultiplier * convScale;
  const fixed = Number(s.fixed_eth) > 0 ? Number(s.fixed_eth) : null;
  // NULL is a legacy call with no portable desk cap. Zero is an explicit refusal
  // and must stay zero all the way downstream; treating both as falsy would revive
  // a trade the team authorized at no size.
  const hasDeskCap = call.desk_size_usd != null && Number(call.desk_equity_usd) > 0;
  const deskRatio = hasDeskCap
    ? Math.max(0, Number(call.desk_size_usd) || 0) / Number(call.desk_equity_usd) : null;
  const teamCapEth = deskRatio != null ? s.bankroll_eth * deskRatio : Infinity;
  const uncapped = fixed ?? autoSize;
  /* A SIZE THAT CANNOT BE EXECUTED IS NOT AN OFFER.
   *
   * Gas does not scale with trade size, so below a certain notional it eats the
   * trade — and on this chain that is the WHOLE cost model, not a footnote: a round
   * trip is a flat ~$1.15 at 0.7 gwei whether the clip is $6 or $6,000. An executor
   * applying any honest cost check must refuse the small end, and on the Solana desk
   * it did — measured, every call for a day was offered between 0.0015 and 0.0092 SOL
   * and every one was correctly refused as "costs eat the target". The floor was
   * publishing trades that were arithmetically impossible to take.
   *
   * teamCapEth caused it: a tenant's size is scaled to the same fraction-of-book the
   * desk uses, and the desk's paper book trades ~0.03% per position. On a 0.4 ETH
   * bankroll that is 0.00012 ETH. The cap's intent — never outrun the desk's
   * conviction — is right, but a cap that produces unexecutable sizes is a refusal
   * dressed as an offer.
   *
   * So: below the executable floor the call is lifted to it when the bankroll can
   * genuinely afford that (the risk stays inside the appetite's per-trade budget),
   * and otherwise refused honestly — saying the bankroll is too small for the gas,
   * which is a fact the tenant can act on, rather than offering a trade their bot
   * will silently decline. */
  // From the call row (calls.gas_usd_at_call / eth_usd_at_call, written at publication),
  // or from an in-memory call that carries the bundle's names; absent, the constant.
  const floorEth = minExecutableEth({
    gasUsdRoundTrip: call.gas_usd_at_call ?? call.gas_usd_round_trip ?? call.gasUsdRoundTrip,
    ethUsd: call.eth_usd_at_call ?? call.eth_usd ?? call.ethUsd });
  /* A FIXED SIZE IS THE OPERATOR'S NUMBER. The team's book-allocation cap
     exists to keep AUTO sizing in proportion to the desk's own conviction; it
     was also shrinking an explicit fixed order (0.2 SOL) to 0.0006 and then
     "lifting" it to the fee floor — so the operator asked for 0.2 and got the
     floor on every trade, with the reason string cheerfully saying both. Fixed
     means fixed; the refusals above still apply. */
  const raw = fixed != null
    ? (deskRatio === 0 ? 0 : fixed)   // an explicit ZERO authorization is never revived by a fixed size
    : Math.min(uncapped, teamCapEth);
  let sizeEth = Number(raw.toFixed(4));
  let liftedForFees = false;
  if (sizeEth > 0 && sizeEth < floorEth) {
    /* The lift is bounded by the risk the tenant actually chose. An EXPLICIT fixed
     * size is that choice, stated in ETH; the appetite percentage is the AUTO rule
     * for tenants who did not state one. This branch used to read only the
     * percentage, so a floor with a fixed size was refused with the advice "...or set
     * a fixed size" — the house floor sat on that contradiction for a day while an
     * armed bot polled an empty feed. */
    const perTradeBudget = fixed != null ? fixed : s.bankroll_eth * (AUTO_RISK_PCT_PER_TRADE / 100);
    if (floorEth <= perTradeBudget) {
      sizeEth = floorEth;
      liftedForFees = true;
    } else {
      return { verdict: "skipped",
        reason: `a tradeable position needs ~${floorEth} ETH (below that, gas eats the trade) ` +
          `but this floor's per-trade budget is ${perTradeBudget.toFixed(4)} ETH — raise the bankroll or set a fixed size` };
    }
  }
  if (sizeEth < 0.0001) return { verdict: "skipped", reason: "the sized position rounds to nothing on this bankroll" };

  const baseHow = fixed
    ? `${fixed} ETH a trade, the size you set`
    : `auto · ${risk.sizeMultiplier}x for ${call.category} · conviction ${Math.round(call.conviction ?? 0)}`;
  const how = fixed == null && Number.isFinite(teamCapEth) && teamCapEth < uncapped
    ? `${baseHow} · capped to the team's ${(deskRatio * 100).toFixed(3)}% book allocation`
    : baseHow;
  return { verdict: "offered", sizeEth,
    // One-release read-compat for callers that have not moved off the SOL name.
    sizeSol: sizeEth,
    reason: liftedForFees
      ? `${how} · lifted to ${sizeEth} ETH so gas does not eat the trade`
      : how };
}

/** Broadcast one call to every leased floor. Deterministic, so this is free. */
export function broadcast(callId, leasedFloors) {
  const call = getCall(callId);
  if (!call) return { ok: false, error: "no such call" };
  let offered = 0, skipped = 0;
  for (const floorNo of leasedFloors) {
    const d = decide(floorNo, call);
    try {
      // size_eth is the record; size_sol mirrors it for the readers that have not moved.
      db.prepare(`INSERT INTO deliveries (call_id,floor_no,verdict,reason,size_eth,size_sol,delivered_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(callId, floorNo, d.verdict, d.reason, d.sizeEth ?? null, d.sizeEth ?? null, Date.now());
      d.verdict === "offered" ? offered++ : skipped++;
    } catch (e) { if (!/UNIQUE/i.test(String(e.message))) throw e; }
  }
  emit("call:broadcast", { callId, symbol: call.symbol, offered, skipped });
  // Durable per-floor entry alerts + webhooks — the loop starts with hearing
  // about the call, not with happening to have the tab open. Fire and forget.
  if (offered) import("./alerts.js").then((a) => a.announceEntry(call)).catch(() => {});
  return { ok: true, offered, skipped };
}

/* `deliveries.size_sol` is read through COALESCE for one release, so a delivery row
 * written by the Solana build (size_eth NULL) still reports a size; `size_eth` is the
 * name every new reader takes. */
const SIZE_EXPR = "COALESCE(d.size_eth, d.size_sol)";

export const feedFor = (floorNo, limit = 25) => db.prepare(`
  SELECT d.*, ${SIZE_EXPR} AS size_eth, ${SIZE_EXPR} AS size_sol,
         c.mint, c.symbol, c.category, c.launchpad, c.conviction, c.status,
         c.entry_ref, c.entry_lo, c.entry_hi, c.stop, c.target, c.opened_at, c.closed_at,
         c.thesis, c.invalidation, c.close_reason, c.close_mark, c.image_url,
         c.mcap_at_call, c.liq_at_call, c.rt_loss_at_call, c.hold_band, c.hold_min_ms, c.hold_max_ms,
         c.gas_usd_at_call, c.eth_usd_at_call,
         (SELECT e.mark FROM call_events e WHERE e.call_id = c.id AND e.mark IS NOT NULL
          ORDER BY e.id DESC LIMIT 1) AS last_mark,
         (SELECT MAX(e.ts) FROM call_events e WHERE e.call_id = c.id AND e.mark IS NOT NULL) AS last_mark_ts
  FROM deliveries d JOIN calls c ON c.id=d.call_id
  WHERE d.floor_no=? ORDER BY d.id DESC LIMIT ?`).all(floorNo, limit);

/** The tenant says they took it. Bookkeeping over a number they declared — never a balance we hold. */
export function markTaken(floorNo, callId, taken = true) {
  // Only an OFFERED delivery can be taken: marking a skipped or ancient call
  // pulls it into fill-scanning and settlement it was never part of.
  const r = db.prepare("UPDATE deliveries SET taken=?, taken_at=? WHERE floor_no=? AND call_id=? AND verdict='offered'")
    .run(taken ? 1 : 0, taken ? Date.now() : null, floorNo, callId);
  return r.changes === 1;
}
