import db, { ensureColumn } from "./lib/store.js";
import { normalise, ZERO_ADDRESS } from "./lib/address.js";

/**
 * CLAUDE TOWER — fifty floors, one desk each.
 * Floor 50 is the headquarters and is never for sale. Floors 1-49 are tenancies.
 *
 * This module owns floor state only. It holds no keys and moves no money: the
 * purchase path is buyer-signed and verified read-only against the chain.
 */
export const FLOORS = 50;
export const HQ_FLOOR = 50;
export const PRICE_USDC = 50;

db.exec(`
CREATE TABLE IF NOT EXISTS floors (
  n INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'vacant',      -- vacant | owned | hq
  owner TEXT,                                 -- wallet address
  name TEXT,                                  -- tenant's name for their desk
  claimed_at INTEGER,
  payment_sig TEXT UNIQUE                     -- one transaction can buy exactly one floor
);
CREATE INDEX IF NOT EXISTS idx_floors_owner ON floors(owner);
`);
// Production grew this column under an older build; nothing in the current tree
// created it, so every FRESH database died on the first floors SELECT.
ensureColumn("floors", "md_name", "TEXT");

// Seed the stack once.
const seeded = db.prepare("SELECT COUNT(*) n FROM floors").get().n;
if (seeded === 0) {
  const ins = db.prepare("INSERT INTO floors (n, state) VALUES (?, ?)");
  for (let n = 1; n <= FLOORS; n++) ins.run(n, n === HQ_FLOOR ? "hq" : "vacant");
}

/**
 * THE DEED TO FLOOR 50.
 *
 * HQ standing used to be a SET — the treasury wallet, anything listed in HQ_OWNER, and
 * the floor's own deed — so several wallets held the keys to the house desk and its
 * executor secret. The owner asked for one wallet, alone.
 *
 * It is written onto the floor rather than kept in a list, so exactly one place answers
 * "who owns the HQ", and it is the same column that answers it for every other floor.
 * Re-asserted on every boot, because an access rule that can drift out of the database
 * is not an access rule.
 *
 * The constant fallback exists so this can never lock the owner out of their own
 * building: if the deed is ever blank, it answers instead. Changing who owns the HQ is
 * then deliberate (HQ_OWNER_WALLET_RH) rather than accidental.
 *
 * ROBINHOOD EDITION: the deed is an EVM address, stored LOWERCASE — wallets return the
 * same address in two spellings and the deed is a plain TEXT compare. The Solana
 * edition's dev wallet cannot hold this deed, so this fork names its own: the deed
 * defaults to the Robinhood tower's dev wallet below (owner's call, 2026-09-06). It
 * previously defaulted to the zero address, which no wallet can sign in as — a
 * penthouse with no signed-in owner rather than a wrong one. That was the right
 * default while no owner was known; one is known now. The zero address remains the
 * "unconfigured" sentinel and is still refused by isHqOwner.
 */
/* The Robinhood tower's dev wallet, given sole ownership of the penthouse by the
   owner on 2026-09-06. EIP-55 verified before it was written here: the address as
   supplied is byte-identical to its own checksummed form, which is what makes a
   transcription error detectable rather than permanent. Stored lowercase because
   floors.owner is a plain TEXT compare — see lib/address.js.
   HQ_OWNER_WALLET_RH still overrides, so a fork or a staging deployment names its
   own owner without editing source. */
export const HQ_OWNER_WALLET =
  normalise((process.env.HQ_OWNER_WALLET_RH || process.env.HQ_OWNER_WALLET || "").trim())
  || "0xcac7f130ba6bed24dea8fc26eab7bfface0d57f5";

db.prepare("UPDATE floors SET state='hq', owner=? WHERE n=? AND (owner IS NULL OR owner <> ?)")
  .run(HQ_OWNER_WALLET, HQ_FLOOR, HQ_OWNER_WALLET);

/** The single wallet that owns the HQ — not the treasury, not a list. */
export function hqOwnerWallet() {
  return normalise(db.prepare("SELECT owner FROM floors WHERE n=?").get(HQ_FLOOR)?.owner) || HQ_OWNER_WALLET;
}
/* SOLE OWNERSHIP — THE DEED, AND NOTHING ELSE (owner's call, 2026-09-06).
   This granted standing to the deed OR the treasury wallet, so two wallets could
   open the house desk's settings and take its executor secret. TREASURY_OWNER_RH
   keeps its real job, which is where lease payments land; money and identity are
   different jobs and this is the line where they were confused.

   Both sides of the compare are still normalised: a checksummed deed and a
   lowercase session are one wallet. The zero address is refused explicitly — it is
   the "no owner configured" sentinel, and nobody can sign as it. */
export const isHqOwner = (w) => {
  const me = normalise(w);
  if (!me || me === ZERO_ADDRESS) return false;
  return me === hqOwnerWallet();
};

export function listFloors() {
  return db.prepare("SELECT n, state, owner, name, md_name FROM floors ORDER BY n").all();
}

export function getFloor(n) {
  return db.prepare("SELECT * FROM floors WHERE n = ?").get(n) || null;
}

export function summary() {
  const rows = listFloors();
  return {
    floors: rows,
    total: FLOORS,
    hq: HQ_FLOOR,
    priceUsdc: PRICE_USDC,
    taken: rows.filter((f) => f.state !== "vacant").length,
    available: rows.filter((f) => f.state === "vacant").length,
  };
}

/** Set the HQ tenant's display name / owner wallet (the building owner). */
export function setHq(owner, name = "Headquarters") {
  db.prepare("UPDATE floors SET owner = ?, name = ?, state = 'hq' WHERE n = ?").run(owner, name, HQ_FLOOR);
}
