import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Wallet, getAddress } from "ethers";

/* Everything here uses a THROWAWAY key in a temp directory. The live burner.key is
   never read, never written, and never named. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-rh-backup-"));
const tool = new URL("./burner-backup.mjs", import.meta.url).pathname;
const w = Wallet.createRandom();
const keyfile = path.join(dir, "burner.key");
fs.writeFileSync(keyfile, w.privateKey, { mode: 0o600 });
fs.chmodSync(keyfile, 0o600);
const ADDR = getAddress(w.address);
const SECRET = w.privateKey;

/* The environment is part of the fixture: a GitHub runner is started by systemd, so
   JOURNAL_STREAM is already ambient and would make the tool refuse. Cleared here and
   set only by the case that tests it — the Solana copy of this suite was green on
   macOS and red on every Linux host until that was fixed. */
const run = (args, env = {}) => {
  const base = { ...process.env, KEY_FILE: keyfile };
  delete base.JOURNAL_STREAM;
  return spawnSync(process.execPath, [tool, ...args],
    { encoding: "utf8", env: { ...base, ...env }, cwd: dir });
};

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`PASS  ${name}`); };

ok("the default output names the wallet and never the secret", () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(ADDR));
  assert.doesNotMatch(r.stdout, new RegExp(SECRET.slice(2)), "the key must not appear in the safe output");
});

ok("--show refuses without the second explicit flag, and obeys it with", () => {
  assert.notEqual(run(["--show"]).status, 0);
  const r = run(["--show", "--i-understand"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), SECRET);
});

ok("a recovery file is 0600 and restores the wallet independently", () => {
  const out = path.join(dir, "rec.txt");
  assert.equal(run(["--out", out]).status, 0);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const line = fs.readFileSync(out, "utf8").split("\n").map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  /* restored the way a wallet would, not through this tool */
  assert.equal(getAddress(new Wallet(line).address), ADDR);
});

ok("--verify accepts its own file and rejects another wallet's", () => {
  assert.equal(run(["--verify", path.join(dir, "rec.txt")]).status, 0);
  const wrong = path.join(dir, "wrong.txt");
  fs.writeFileSync(wrong, Wallet.createRandom().privateKey, { mode: 0o600 });
  const r = run(["--verify", wrong]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT this bot's wallet/);
});

ok("a key without the 0x prefix is accepted, since the key file may be written either way", () => {
  const bare = path.join(dir, "bare.txt");
  fs.writeFileSync(bare, SECRET.slice(2), { mode: 0o600 });
  assert.equal(run(["--verify", bare]).status, 0);
});

ok("it refuses to overwrite an existing recovery file", () => {
  const r = run(["--out", path.join(dir, "rec.txt")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to overwrite/);
});

ok("a group-readable key file is refused outright", () => {
  fs.chmodSync(keyfile, 0o640);
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be 0600/);
  fs.chmodSync(keyfile, 0o600);
});

ok("it will not emit key material from a systemd unit", () => {
  for (const args of [["--show", "--i-understand"], ["--out", path.join(dir, "j.txt")]]) {
    const r = run(args, { JOURNAL_STREAM: "8:12345" });
    assert.notEqual(r.status, 0, `${args[0]} must refuse under systemd`);
    assert.match(r.stderr, /output is the journal/);
    assert.doesNotMatch(r.stdout, new RegExp(SECRET.slice(2)));
  }
  assert.ok(!fs.existsSync(path.join(dir, "j.txt")), "and it must not have written the file either");
  assert.equal(run([], { JOURNAL_STREAM: "8:12345" }).status, 0, "reading the address stays allowed");
});

ok("the tool imports nothing that can open a socket", () => {
  const src = fs.readFileSync(tool, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["node:http", "node:https", "node:net", "node:dgram", "fetch(", "JsonRpcProvider"])
    assert.ok(!src.includes(bad), `an offline recovery tool must not reference ${bad}`);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} burner recovery checks passed (Robinhood)`);
