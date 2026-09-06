#!/usr/bin/env node
/**
 * THE BURNER EXISTS ON EXACTLY ONE DISK.
 *
 * install.sh generates burner.key locally, prints its address, and tells the operator
 * to send ETH to it. Nothing in this repo has ever offered a way to copy that key
 * somewhere else or to check that a copy still works, so a dead host, a reimaged VPS
 * or a mistyped `rm` has always meant the funds in it are gone.
 *
 * Local and offline. It opens no socket, and is deliberately the only file in the
 * executor that imports nothing capable of one.
 *
 *   node burner-backup.mjs                     address and status only. Safe.
 *   node burner-backup.mjs --out <file>        write a 0600 recovery file.
 *   node burner-backup.mjs --verify <file>     prove it restores the same wallet.
 *                                              Do this BEFORE you need it; an
 *                                              unverified backup is a guess.
 *   node burner-backup.mjs --show --i-understand
 *
 * The recovery file holds the raw 0x-prefixed private key, which MetaMask, Rabby and
 * every other EVM wallet accept under "import private key" — so recovery needs no part
 * of this software, which is the point of a recovery path.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Wallet, getAddress } from "ethers";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const die = (m) => { console.error(`burner-backup: ${m}`); process.exit(1); };

/* Under systemd, stdout is the journal — a log with a retention policy, a permission
   model and a shipping pipeline, and none of those are places for a private key.
   systemd sets JOURNAL_STREAM on every unit it starts. */
if (process.env.JOURNAL_STREAM && (flag("--show") || flag("--out")))
  die("refusing to emit key material from a systemd unit — its output is the journal. Run this from a shell.");

const KEY_FILE = path.resolve(process.env.KEY_FILE || value("--key-file") || "./burner.key");

function readKey() {
  let st;
  try { st = fs.lstatSync(KEY_FILE); } catch { die(`no key file at ${KEY_FILE}`); }
  if (!st.isFile() || st.isSymbolicLink()) die("the key file must be a regular, non-symlink file");
  if ((st.mode & 0o077) !== 0) die(`key file permissions must be 0600 (chmod 600 ${KEY_FILE})`);
  const text = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(text)) die("the key file does not contain a 32-byte hex private key");
  return text.startsWith("0x") ? text : "0x" + text;
}

/** Accepts either spelling, so a file a wallet exported verifies too. */
export function walletFromBackupText(text) {
  const line = String(text).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error("no key found in the recovery file");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(line)) throw new Error("not a 32-byte hex private key");
  return new Wallet(line.startsWith("0x") ? line : "0x" + line);
}

const secret = readKey();
const address = getAddress(new Wallet(secret).address);

if (flag("--verify")) {
  const file = value("--verify");
  if (!file) die("--verify needs a path");
  let restored;
  try { restored = walletFromBackupText(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (e) { die(`that recovery file does not restore a wallet: ${e.message}`); }
  const got = getAddress(restored.address);
  if (got !== address) die(`that recovery file restores ${got}, which is NOT this bot's wallet ${address}`);
  console.log(`verified — ${path.resolve(file)} restores ${address}`);
  process.exit(0);
}

if (flag("--out")) {
  const file = value("--out");
  if (!file) die("--out needs a path");
  const out = path.resolve(file);
  if (fs.existsSync(out)) die(`${out} already exists — refusing to overwrite a recovery file`);
  const body = [
    `# WALL-ST-E burner recovery key — Robinhood Chain (4663)`,
    `# wallet ${address}`,
    `# written ${new Date().toISOString()} on ${os.hostname()}`,
    `#`,
    `# ANYONE WITH THE LINE BELOW CONTROLS THIS WALLET AND EVERYTHING IN IT.`,
    `# It is a raw private key, the form MetaMask and Rabby accept under "import`,
    `# private key" — you do not need this software to recover the funds. Keep it off`,
    `# any machine that runs the bot, and out of any backup that syncs.`,
    ``, secret, ``,
  ].join("\n");
  const fd = fs.openSync(out, "wx", 0o600);
  try { fs.writeFileSync(fd, body); } finally { fs.closeSync(fd); }
  fs.chmodSync(out, 0o600);
  console.log(`wrote ${out} (0600) for wallet ${address}`);
  console.log(`now prove it: node burner-backup.mjs --verify ${out}`);
  process.exit(0);
}

if (flag("--show")) {
  if (!flag("--i-understand"))
    die("--show prints a private key to this terminal. Add --i-understand if that is what you want.");
  console.log(secret);
  process.exit(0);
}

const st = fs.lstatSync(KEY_FILE);
console.log(`wallet   ${address}`);
console.log(`keyfile  ${KEY_FILE} (mode ${(st.mode & 0o777).toString(8)})`);
console.log(`\nThis key exists on this disk and nowhere else. To change that:`);
console.log(`  node burner-backup.mjs --out ~/wall-st-e-rh-recovery.txt`);
console.log(`  node burner-backup.mjs --verify ~/wall-st-e-rh-recovery.txt`);
console.log(`then move that file somewhere this machine cannot reach.`);
