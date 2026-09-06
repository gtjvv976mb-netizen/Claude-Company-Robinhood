import assert from "node:assert/strict";
import fs from "node:fs";

/* ── THE PENTHOUSE HAS ONE OWNER (ROBINHOOD EDITION) ──────────────────────────
 * HQ standing gates the house desk's settings and the executor secret. It was
 * granted to the deed holder OR TREASURY_OWNER_RH, so two wallets held it, while
 * office.js declared "SOLE OWNERSHIP … the deed alone" directly above the call.
 *
 * This fork's deed also had no owner at all: it defaulted to the zero address
 * until HQ_OWNER_WALLET_RH was set. The owner named the Robinhood tower's dev
 * wallet on 2026-09-06 and it is the default now.
 *
 * TREASURY_OWNER_RH is set to a DIFFERENT wallet on purpose, so reinstating the
 * OR fails here instead of passing quietly. */
if (!process.env.CLAUDE_CO_DB) throw new Error("test runner must provide CLAUDE_CO_DB");

const DEED = "0xcac7f130ba6bed24dea8fc26eab7bfface0d57f5";               // stored form
const CHECKSUMMED = "0xCAC7f130BA6bED24dEa8fC26EaB7bFfACe0d57F5";        // as a wallet displays it
const TREASURY = "0x00000000000000000000000000000000deadbeef";
process.env.TREASURY_OWNER_RH = TREASURY;

const { getAddress } = await import("ethers");
/* The deed was transcribed from a message. EIP-55 is what makes a typo detectable
   rather than permanent, so it is asserted here and not merely at review time. */
assert.equal(getAddress(DEED), CHECKSUMMED, "the deed's checksum must match the address as supplied");

const tower = await import("./src/tower.js");
const { ZERO_ADDRESS } = await import("./src/lib/address.js");

assert.equal(tower.hqOwnerWallet(), DEED, "the RH dev wallet holds the deed on floor 50");
assert.notEqual(tower.hqOwnerWallet(), ZERO_ADDRESS, "the penthouse is no longer ownerless");

/* One wallet, either spelling — floors.owner is a plain TEXT compare, so a
   checksummed session and a lowercase deed must still be one person. */
for (const spelling of [DEED, CHECKSUMMED, DEED.toUpperCase().replace("0X", "0x")])
  assert.equal(tower.isHqOwner(spelling), true, `the deed holder owns the HQ as ${spelling}`);

assert.equal(tower.isHqOwner(TREASURY), false,
  "the treasury wallet must NOT hold the penthouse — it is where lease payments land, not an identity");
assert.equal(process.env.TREASURY_OWNER_RH, TREASURY,
  "the treasury really was configured, so the check above proves something");

for (const nobody of ["", null, undefined, ZERO_ADDRESS, ZERO_ADDRESS.toUpperCase().replace("0X", "0x"),
  "0x000000000000000000000000000000000000dead", DEED.slice(0, -1), DEED + "0", "not-an-address",
  "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3"])   // the Solana dev wallet cannot hold this deed
  assert.equal(tower.isHqOwner(nobody), false, `not an owner: ${JSON.stringify(nobody)}`);

/* THE ZERO ADDRESS IS NEVER AN OWNER, INCLUDING WHEN IT IS THE DEED.
   With a real deed configured this is trivially true and proves nothing — the
   comparison fails anyway. It only bites when the deed is UNCONFIGURED, which is
   the sentinel's whole purpose. So the case is forced in a child process with the
   deed explicitly set to the zero address; without the explicit guard in
   isHqOwner, a session claiming to be 0x0…0 would then own the penthouse. */
{
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const path = await import("node:path");
  const probe = `
    const t = await import("./src/tower.js");
    const { ZERO_ADDRESS } = await import("./src/lib/address.js");
    process.stdout.write(JSON.stringify({
      deed: t.hqOwnerWallet(), zeroOwns: t.isHqOwner(ZERO_ADDRESS) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env,
      HQ_OWNER_WALLET_RH: ZERO_ADDRESS,
      CLAUDE_CO_DB: path.join(os.tmpdir(), `hq-zero-${process.pid}.db`) },
  });
  assert.equal(r.status, 0, `zero-deed probe failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.deed, ZERO_ADDRESS, "the probe really did configure an unowned penthouse");
  assert.equal(out.zeroOwns, false,
    "with the deed unset, a session claiming the zero address must still not own the HQ");
}

const towerSrc = fs.readFileSync(new URL("./src/tower.js", import.meta.url), "utf8");
const fn = towerSrc.slice(towerSrc.indexOf("export const isHqOwner"),
  towerSrc.indexOf("export function listFloors"));
assert.doesNotMatch(fn, /TREASURY/, "isHqOwner must not read the treasury");
assert.match(towerSrc, /HQ_OWNER_WALLET_RH/, "an explicit env override still names a different owner");

console.log("HQ sole ownership (RH): the dev wallet's deed alone, either spelling, treasury refused");
