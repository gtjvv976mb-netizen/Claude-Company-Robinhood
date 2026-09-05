/**
 * THE DOOR ON ROBINHOOD CHAIN.
 *
 * A wallet signs a plain-text nonce message with personal_sign (EIP-191) and the server
 * recovers the signer. This test creates a throwaway secp256k1 key in-process — no
 * network, no chain — and walks the whole door: nonce, sign, verify, session; then the
 * ways in that must stay shut: a message whose chain line was altered, a replay of a
 * burned nonce, a nonce issued to one wallet presented by another, and a Solana base58
 * key at an EVM door. The smart-wallet branch (EIP-1271 / ERC-6492) is exercised with an
 * injected chain reader so the on-chain call's three outcomes are pinned without RPC.
 */
process.env.CLAUDE_CO_DB = process.env.CLAUDE_CO_DB || "/tmp/evm-auth-test.db";
// The scanner section below needs a launched token and a treasury; leasing.js reads
// both at module load, so they are set before anything imports it.
process.env.CLAUDECO_RH_TOKEN = "0x39dbed3a2bd333467115de45665cc57f813c4571";
process.env.TREASURY_OWNER_RH = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
import fs from "node:fs";
try { fs.rmSync(process.env.CLAUDE_CO_DB); } catch {}

import { Wallet, hashMessage, AbiCoder } from "ethers";
const auth = await import("./src/auth.js");
const { isEvmAddress, normalise, display, namespaced, CHAIN_ID } = await import("./src/lib/address.js");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok   ${n}${d ? "  — " + d : ""}`))
                                 : (fail++, console.log(`  FAIL ${n}${d ? "  — " + d : ""}`)); };

console.log("\nADDRESS HELPERS");
{
  const w = Wallet.createRandom();
  ok("a checksummed address is an EVM address", isEvmAddress(w.address), w.address);
  ok("normalise lowercases", normalise(w.address) === w.address.toLowerCase(), normalise(w.address));
  ok("display restores EIP-55", display(w.address.toLowerCase()) === w.address, display(w.address.toLowerCase()));
  ok("the namespace is eip155:4663:<lower>", namespaced(w.address) === `eip155:4663:${w.address.toLowerCase()}`, namespaced(w.address));
  ok("a Solana key is not an EVM address", !isEvmAddress("3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3"));
  ok("39 hex chars is not an address", !isEvmAddress("0x" + "a".repeat(39)));
}

console.log("\nHAPPY PATH — an EOA signs the nonce message");
const wallet = Wallet.createRandom();
const ADDR = wallet.address;                      // checksummed, as Rabby would send it
{
  const n = auth.issueNonce(ADDR, { chain: "eip155:4663" });
  ok("a nonce is issued", typeof n.nonce === "string" && n.nonce.length > 20, n.nonce.slice(0, 8) + "…");
  ok("the message carries the chain line", n.message.includes("Chain: Robinhood Chain (4663)"));
  ok("the message shows the EIP-55 wallet", n.message.includes(`Wallet: ${ADDR}`));
  ok("the nonce is filed under the lowercase wallet", n.wallet === ADDR.toLowerCase(), n.wallet);
  const signature = await wallet.signMessage(n.message);      // exactly what personal_sign returns
  ok("the signature is 65 bytes of 0x-hex", /^0x[0-9a-f]{130}$/i.test(signature), `${(signature.length - 2) / 2} bytes`);
  const r = await auth.verifySignature({ wallet: ADDR.toLowerCase(), nonce: n.nonce, signature, chain: "eip155:4663" });
  ok("verify accepts it", r.ok === true, r.error ?? "");
  ok("a session token is minted", typeof r.token === "string" && r.token.length > 30);
  ok("the session wallet is lowercase", r.wallet === ADDR.toLowerCase(), r.wallet);
  ok("the session names its chain", r.chain === "eip155:4663", r.chain);
  ok("walletFor(token) resolves to the same lowercase wallet", auth.walletFor(r.token) === ADDR.toLowerCase());

  console.log("\nREPLAY — the same signature a second time");
  const again = await auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature });
  ok("a burned nonce is refused", again.ok === false && /already used/.test(again.error), again.error);
}

console.log("\nWRONG CHAIN LINE — a message signed for another edition");
{
  const n = auth.issueNonce(ADDR);
  const forged = n.message.replace("Chain: Robinhood Chain (4663)", "Chain: Solana (mainnet-beta)");
  ok("the forged message differs", forged !== n.message);
  const signature = await wallet.signMessage(forged);
  const r = await auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature,
    onChain: async () => ({ ok: false, error: "the account contract rejected the signature" }) });
  ok("a signature over the wrong chain line does not open the door", r.ok === false, r.error);
  ok("...and the nonce is still unburned for the honest signer", (await (async () => {
    const good = await wallet.signMessage(n.message);
    return auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature: good });
  })()).ok === true);
}

console.log("\nCHAIN NAMESPACE AT THE DOOR");
{
  let threw = null;
  try { auth.issueNonce(ADDR, { chain: "solana:mainnet" }); } catch (e) { threw = e.message; }
  ok("a nonce for another chain namespace is refused", /wrong chain/.test(threw || ""), threw);
  const n = auth.issueNonce(ADDR, { chain: "eip155:4663:" + ADDR.toLowerCase() });
  ok("the CAIP-10 form with the address suffix is accepted", !!n.nonce);
  const sig = await wallet.signMessage(n.message);
  const r = await auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature: sig, chain: "eip155:1" });
  ok("verify with chain eip155:1 is refused", r.ok === false && /wrong chain/.test(r.error), r.error);
}

console.log("\nANOTHER WALLET'S NONCE");
{
  const other = Wallet.createRandom();
  const n = auth.issueNonce(other.address);
  const sig = await wallet.signMessage(auth.buildMessage(ADDR.toLowerCase(), n.nonce));
  const r = await auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature: sig });
  ok("a nonce issued to another wallet is refused", r.ok === false && /another wallet/.test(r.error), r.error);
}

console.log("\nA SOLANA WALLET AT AN EVM DOOR");
{
  const sol = "3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3";
  let threw = null;
  try { auth.issueNonce(sol); } catch (e) { threw = e.message; }
  ok("the nonce is refused", !!threw);
  ok("...with a message that names the chain and the fix", /Solana address/.test(threw) && /4663/.test(threw) && /0x/.test(threw), threw);
  const r = await auth.verifySignature({ wallet: sol, nonce: "x", signature: "0x00" });
  ok("verify says the same thing", r.ok === false && /Solana address/.test(r.error), r.error);
  const r2 = await auth.verifySignature({ wallet: ADDR, nonce: "nope", signature: "0x" + "ab".repeat(65) });
  ok("an unknown nonce is refused before any crypto", r2.ok === false && /unknown nonce/.test(r2.error), r2.error);
  const n = auth.issueNonce(ADDR);
  const r3 = await auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature: "5VERYbase58looking" });
  ok("a base58 signature is refused as bad encoding", r3.ok === false && /encoding/.test(r3.error), r3.error);
}

console.log("\nSMART WALLETS — EIP-1271 and ERC-6492, with the chain stubbed");
{
  const SEL = "0x1626ba7e";
  const coder = AbiCoder.defaultAbiCoder();
  // A 1271 wallet's "signature" is whatever bytes its contract accepts; make it 70 bytes
  // so ecrecover cannot be tried on it and the on-chain path is forced.
  const contractSig = "0x" + "11".repeat(70);
  const account = Wallet.createRandom().address;   // stands in for a deployed account contract

  // (1) deployed account that says yes
  {
    const n = auth.issueNonce(account);
    const message = auth.buildMessage(account, n.nonce);
    const seen = {};
    const r = await auth.verifySignature({ wallet: account, nonce: n.nonce, signature: contractSig,
      onChain: (args) => auth.verifyOnChain({ ...args,
        rpc: async (m, p) => { seen.code = [m, p[0]]; return { ok: true, data: "0x6080" }; },
        call: async (to, data) => { seen.call = { to, data }; return { ok: true, data: SEL + "0".repeat(56) }; } }) });
    ok("a deployed 1271 account that returns the magic opens the door", r.ok === true, r.error ?? "");
    ok("...after eth_getCode on the account", seen.code?.[0] === "eth_getCode" && seen.code?.[1] === account.toLowerCase());
    ok("...and isValidSignature(hash, sig) with the EIP-191 hash of THIS message",
      seen.call?.to === account.toLowerCase() && seen.call?.data.startsWith(SEL) &&
      seen.call.data.includes(hashMessage(message).slice(2)), seen.call?.data.slice(0, 20) + "…");
  }
  // (2) deployed account that says no
  {
    const n = auth.issueNonce(account);
    const r = await auth.verifySignature({ wallet: account, nonce: n.nonce, signature: contractSig,
      onChain: (args) => auth.verifyOnChain({ ...args,
        rpc: async () => ({ ok: true, data: "0x6080" }),
        call: async () => ({ ok: true, data: "0x" + "0".repeat(64) }) }) });
    ok("a deployed account that returns zero is refused", r.ok === false && /rejected/.test(r.error), r.error);
  }
  // (3) ERC-6492 wrapper on an account NOT yet deployed on 4663
  {
    const n = auth.issueNonce(account);
    const inner = "0x" + "22".repeat(65);
    const wrapped = coder.encode(["address", "bytes", "bytes"], [Wallet.createRandom().address, "0x1234", inner]) + auth.ERC6492_MAGIC;
    ok("the wrapped signature ends with the 6492 magic", wrapped.endsWith(auth.ERC6492_MAGIC));
    const r = await auth.verifySignature({ wallet: account, nonce: n.nonce, signature: wrapped,
      onChain: (args) => auth.verifyOnChain({ ...args,
        rpc: async () => ({ ok: true, data: "0x" }),
        call: async () => { throw new Error("must not be called for an undeployed account"); } }) });
    ok("an undeployed 6492 account is refused, not guessed", r.ok === false && /not deployed/.test(r.error), r.error);
  }
  // (4) ERC-6492 wrapper on an account that IS deployed: the inner signature is used
  {
    const n = auth.issueNonce(account);
    const inner = "0x" + "33".repeat(65);
    const wrapped = coder.encode(["address", "bytes", "bytes"], [Wallet.createRandom().address, "0x", inner]) + auth.ERC6492_MAGIC;
    let sigSeen = null;
    const r = await auth.verifySignature({ wallet: account, nonce: n.nonce, signature: wrapped,
      onChain: (args) => auth.verifyOnChain({ ...args,
        rpc: async () => ({ ok: true, data: "0x6080" }),
        call: async (to, data) => { sigSeen = data; return { ok: true, data: SEL + "0".repeat(56) }; } }) });
    ok("a deployed account is asked with the UNWRAPPED inner signature", r.ok === true && sigSeen?.includes("33".repeat(65)) &&
      !sigSeen.includes(auth.ERC6492_MAGIC), r.error ?? "");
  }
  // (5) an RPC failure is an error, never a yes
  {
    const n = auth.issueNonce(account);
    const r = await auth.verifySignature({ wallet: account, nonce: n.nonce, signature: contractSig,
      onChain: (args) => auth.verifyOnChain({ ...args, rpc: async () => ({ ok: false, error: "HTTP 429" }) }) });
    ok("an unreadable chain refuses the door", r.ok === false && /429/.test(r.error), r.error);
  }
}

console.log("\nSESSIONS");
{
  const n = auth.issueNonce(ADDR);
  const sig = await wallet.signMessage(n.message);
  const r = await auth.verifySignature({ wallet: ADDR, nonce: n.nonce, signature: sig });
  auth.signOut(r.token);
  ok("signOut ends the session", auth.walletFor(r.token) === null);
  ok(`every session row is stamped chain ${CHAIN_ID}`, (await import("./src/lib/store.js")).default
    .prepare("SELECT COUNT(*) n FROM sessions WHERE chain <> ?").get(CHAIN_ID).n === 0);
}

console.log("\nTHE TREASURY SCANNER — Transfer logs become credits, with the chain injected");
{
  const t = await import("./src/treasury-evm.js");
  const leasing = await import("./src/leasing.js");
  const db = (await import("./src/lib/store.js")).default;
  const TOKEN = process.env.CLAUDECO_RH_TOKEN, TREASURY = process.env.TREASURY_OWNER_RH.toLowerCase();
  const payer = "0x1111111111111111111111111111111111111111";
  const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
  const mkLog = (from, to, value, txHash, logIndex, block) => ({
    address: TOKEN, topics: [t.TRANSFER_TOPIC, word(from), word(to)],
    data: "0x" + BigInt(value).toString(16).padStart(64, "0"),
    transactionHash: txHash, logIndex: "0x" + logIndex.toString(16), blockNumber: "0x" + block.toString(16), removed: false,
  });
  const calls = [];
  const HEAD = 54_600_000;
  const price = leasing.PRICE_BASE_UNITS;
  /* The payment lands at HEAD+40: the first run parks the cursor at HEAD-1 (no history
     walk), so a log before that is exactly what the scanner must NOT go back for. */
  const PAY_BLOCK = HEAD + 40;
  const logsByRange = (from, to) => {
    const out = [];
    if (from <= PAY_BLOCK && PAY_BLOCK <= to) {
      out.push(mkLog(payer, TREASURY, price, "0xaa".padEnd(66, "1"), 3, PAY_BLOCK));          // a real payment
      out.push(mkLog(payer, TREASURY, 5n, "0xaa".padEnd(66, "1"), 7, PAY_BLOCK));             // 2nd transfer, same tx: its own credit
      out.push(mkLog(TREASURY, payer, 99n, "0xbb".padEnd(66, "2"), 0, PAY_BLOCK));            // treasury paying OUT: not a credit
      out.push(mkLog("0x0000000000000000000000000000000000000000", TREASURY, 7n, "0xcc".padEnd(66, "3"), 0, PAY_BLOCK)); // a mint: not a payment
    }
    return out;
  };
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === "eth_blockNumber") return { ok: true, data: "0x" + HEAD.toString(16) };
    if (method === "eth_getLogs") {
      const f = params[0];
      ok("getLogs is scoped to the token and topic[2] = the treasury (once)",
        f.address === TOKEN && f.topics[0] === t.TRANSFER_TOPIC && f.topics[1] === null && f.topics[2] === word(TREASURY), "");
      return { ok: true, data: logsByRange(Number(f.fromBlock), Number(f.toBlock)) };
    }
    if (method === "eth_getBlockByNumber") return { ok: true, data: { timestamp: "0x68ba0000" } };
    return { ok: false, error: "unexpected " + method };
  };
  // first run: the cursor starts at the head (no history walk), so nothing is credited
  const first = await t.scanOnce({ rpc });
  ok("a first run starts at the head and credits nothing", first.ok && first.credited === 0 && first.scanned === 0, JSON.stringify(first));
  // the chain moves 100 blocks, past the payment
  const HEAD2 = HEAD + 100;
  const second = await t.scanOnce({ rpc, head: HEAD2 });
  ok("the new range is scanned in one getLogs call and the payment found", second.ok && second.from === HEAD && second.to === HEAD2 - 1 && second.credited === 2 && second.scanned === 4, JSON.stringify(second));
  const rows = db.prepare("SELECT * FROM credits ORDER BY id").all();
  ok("two credits: one per Transfer LOG, not per transaction", rows.length === 2, `${rows.length} rows`);
  ok("the treasury's outgoing transfer and the mint were not credited", rows.every((r) => r.wallet === payer), rows.map((r) => r.wallet).join(","));
  ok("the payer's credit balance is the sum, in base units", leasing.balanceOf(payer) === price + 5n, leasing.balanceOf(payer).toString());
  ok("signature = tx hash, slot = block number, block_time from the block", rows[0]?.signature === "0xaa".padEnd(66, "1") && rows[0]?.slot === PAY_BLOCK && rows[0]?.block_time === 0x68ba0000, `${rows[0]?.slot} ${rows[0]?.block_time}`);
  // the same range again (a cursor reset) must not double-credit
  db.prepare("UPDATE scanner_state SET value=? WHERE key='last_block'").run(String(PAY_BLOCK - 10));
  const third = await t.scanOnce({ rpc, head: HEAD2 });
  ok("re-reading the range credits nothing twice", third.ok && third.credited === 0 && leasing.balanceOf(payer) === price + 5n, JSON.stringify(third));
  ok("the cursor advanced to head - confirmations", Number(db.prepare("SELECT value FROM scanner_state WHERE key='last_block'").get().value) === HEAD2 - 1);
  // enough credit → the floor can be taken, keyed on the lowercase wallet
  const took = leasing.allocate({ wallet: payer.toUpperCase().replace("0X", "0x"), floorNo: 7, name: "Seven" });
  ok("the credited wallet can lease a floor, whatever the case it signed in with", took.ok === true && took.wallet === payer, JSON.stringify(took));
  ok("...and the config says the token is launched for this test", leasing.config().launched === true && leasing.payConfig()?.treasury === TREASURY);
  // a failed getLogs page leaves the cursor where it was
  db.prepare("UPDATE scanner_state SET value=? WHERE key='last_block'").run(String(HEAD2 - 1));
  const broken = await t.scanOnce({ head: HEAD2 + 10, rpc: async (m) => m === "eth_getLogs" ? { ok: false, error: "HTTP 429" } : rpc(m, []) });
  ok("a failed page reports partial and does not move the cursor", broken.ok === false && broken.partial === true &&
    Number(db.prepare("SELECT value FROM scanner_state WHERE key='last_block'").get().value) === HEAD2 - 1, JSON.stringify(broken));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
