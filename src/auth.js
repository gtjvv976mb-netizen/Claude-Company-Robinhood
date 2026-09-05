import crypto from "node:crypto";
import { verifyMessage, hashMessage, AbiCoder } from "ethers";
import db, { ensureColumn } from "./lib/store.js";
import { isEvmAddress, normalise, display, isOurChain, isSolanaAddress,
  CHAIN_ID, CHAIN_NAME, CHAIN_NAMESPACE } from "./lib/address.js";
import { evmRpc, ethCall } from "./treasury-evm.js";

/**
 * Wallet sign-in. The user proves they control an address by signing a plain text
 * message — never a transaction. A message signature cannot move funds, so there is
 * nothing to lose by signing it, and nothing for this server to abuse by asking.
 *
 * The nonce is single-use and short-lived: without that, one captured signature would
 * be a permanent bearer token for that wallet.
 *
 * THIS DOOR IS EVM-ONLY. The Solana edition verified ed25519 over a base58 key; here the
 * wallet signs with personal_sign (EIP-191: "\x19Ethereum Signed Message:\n" + length +
 * message) and the server recovers the secp256k1 signer. node:crypto has no secp256k1
 * recover, which is what `ethers` is for. A base58 wallet is refused with a message
 * that says which chain it is on, rather than a generic "bad wallet".
 *
 * Smart wallets. Coinbase Smart Wallet, Safe and the passkey wallets do not sign with
 * a key ecrecover can find: they answer EIP-1271 isValidSignature(hash, sig) from the
 * account contract, and before the account is deployed they wrap the signature in an
 * ERC-6492 envelope (abi.encode(factory, factoryCalldata, innerSig) ++ 32-byte magic).
 * The rule here: a signature that is longer than 65 bytes, or that carries the 6492
 * magic, or that recovers to some other address, goes to the chain — one read-only
 * eth_call against RH_RPC. An account that is not yet deployed on 4663 cannot be asked,
 * and we say so instead of guessing (the counterfactual path needs a universal
 * validator contract this repo does not vendor; see the comment in verifyOnChain).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet);
`);
// Which chain a session was minted on. Every row this fork writes says 4663; the column
// exists so a database that ever holds both editions cannot confuse them.
ensureColumn("sessions", "chain", "INTEGER");

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export const SIGN_IN_PREFIX = "Claude Company — sign in";
export const CHAIN_LINE = `Chain: ${CHAIN_NAME} (${CHAIN_ID})`;

/** ERC-6492: the last 32 bytes of a wrapped signature. */
export const ERC6492_MAGIC = "6492649264926492649264926492649264926492649264926492649264926492";
/** EIP-1271: isValidSignature(bytes32,bytes) selector, and the value it returns on success. */
const EIP1271_SELECTOR = "0x1626ba7e";

/** What is wrong with this wallet string, said for the person holding it. */
export function walletProblem(wallet) {
  if (isEvmAddress(wallet)) return null;
  if (isSolanaAddress(wallet))
    return `that is a Solana address — this building is on ${CHAIN_NAME} (chainId ${CHAIN_ID}); connect an EVM wallet (0x…)`;
  return "not an EVM address (expected 0x followed by 40 hex characters)";
}

export function issueNonce(wallet, { chain = null } = {}) {
  const problem = walletProblem(wallet);
  if (problem) throw new Error(problem);
  if (!isOurChain(chain)) throw new Error(`wrong chain: this building signs on ${CHAIN_NAMESPACE}`);
  const w = normalise(wallet);
  const nonce = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO auth_nonces (nonce, wallet, issued_at) VALUES (?,?,?)")
    .run(nonce, w, Date.now());
  return { nonce, message: buildMessage(w, nonce), chain: CHAIN_NAMESPACE, wallet: w };
}

/** The wallet line carries the EIP-55 spelling: it is what the person sees in the
 *  wallet's signing sheet. Storage is lowercase; the two always agree because both
 *  come from the same normalised row. The chain line is what stops a message signed
 *  for one edition being replayed at the other. */
export function buildMessage(wallet, nonce) {
  return `${SIGN_IN_PREFIX}\n\n${CHAIN_LINE}\nWallet: ${display(wallet)}\nNonce: ${nonce}\n\n` +
    `Signing proves you control this wallet. It is not a transaction and moves no funds.`;
}

const hexBytes = (sig) => {
  const s = String(sig || "");
  if (!/^0x[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) return null;
  return (s.length - 2) / 2;
};

/** Try ecrecover first: the common case, no RPC. */
function recoverMatches(message, signature, wallet) {
  try { return normalise(verifyMessage(message, signature)) === wallet; }
  catch { return false; }
}
/** A well-formed 65-byte ECDSA signature recovers to SOME key. When that key is simply
 *  not this wallet, the answer is final and free — no chain read can make it match. */
function recoversToSomeone(message, signature) {
  try { return isEvmAddress(verifyMessage(message, signature)); }
  catch { return false; }
}

/**
 * EIP-1271 / ERC-6492 on the chain, read-only. Returns { ok, error }.
 * `rpc`/`call` are injectable so the test can stand in for the chain without a network.
 */
export async function verifyOnChain({ wallet, message, signature, call = ethCall, rpc = evmRpc }) {
  let sig = String(signature).toLowerCase();
  const wrapped = sig.endsWith(ERC6492_MAGIC);
  if (wrapped) {
    // abi.encode(address factory, bytes factoryCalldata, bytes innerSig) ++ magic
    try {
      const body = "0x" + sig.slice(2, -ERC6492_MAGIC.length);
      const [, , inner] = AbiCoder.defaultAbiCoder().decode(["address", "bytes", "bytes"], body);
      sig = String(inner).toLowerCase();
    } catch { return { ok: false, error: "malformed ERC-6492 signature" }; }
  }
  const code = await rpc("eth_getCode", [wallet, "latest"]);
  if (!code.ok) return { ok: false, error: `could not read the account on ${CHAIN_NAME}: ${code.error}` };
  if (!code.data || code.data === "0x") {
    /* Counterfactual accounts. ERC-6492's reference validator deploys the account inside
       an eth_call (state override) and then asks it — that needs the validator's bytecode
       vendored and audited here, and until it is we refuse rather than trust a signature
       nobody on this chain can check. The account becomes checkable the moment it sends
       its first transaction on 4663. */
    return { ok: false, error: wrapped
      ? `this smart wallet is not deployed on ${CHAIN_NAME} yet — send any transaction from it on chain ${CHAIN_ID} first, then sign in`
      : "signature does not match" };
  }
  const hash = hashMessage(message);
  const data = EIP1271_SELECTOR + AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes"], [hash, sig]).slice(2);
  const r = await call(wallet, data);
  if (!r.ok) return { ok: false, error: `isValidSignature failed: ${r.error}` };
  const word = String(r.data || "").toLowerCase();
  const good = word.length >= 10 && word.slice(0, 10) === EIP1271_SELECTOR;
  return good ? { ok: true } : { ok: false, error: "the account contract rejected the signature" };
}

export async function verifySignature({ wallet, nonce, signature, signatureB58, chain = null, onChain = verifyOnChain }) {
  const problem = walletProblem(wallet);
  if (problem) return { ok: false, error: problem };
  if (!isOurChain(chain)) return { ok: false, error: `wrong chain: this building signs on ${CHAIN_NAMESPACE}` };
  const w = normalise(wallet);

  const row = db.prepare("SELECT * FROM auth_nonces WHERE nonce = ?").get(String(nonce || ""));
  if (!row) return { ok: false, error: "unknown nonce" };
  if (row.used_at) return { ok: false, error: "nonce already used" };
  if (row.wallet !== w) return { ok: false, error: "nonce belongs to another wallet" };
  if (Date.now() - row.issued_at > NONCE_TTL_MS) return { ok: false, error: "nonce expired" };

  const sig = signature ?? signatureB58;     // the old field name still arrives from cached pages
  const n = hexBytes(sig);
  if (n == null) return { ok: false, error: "bad signature encoding (expected 0x-hex from personal_sign)" };
  if (n < 65) return { ok: false, error: "signature too short" };

  const message = buildMessage(w, nonce);
  const burn = () => db.prepare("UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(Date.now(), nonce).changes === 1;
  let good = n === 65 && recoverMatches(message, sig, w);
  if (!good && n === 65 && recoversToSomeone(message, sig)) {
    /* A plain ECDSA signature from another key, or over another message: final, free, and
       the honest signer keeps the nonce for a second try. No RPC was spent. */
    return { ok: false, error: "signature does not match" };
  }
  if (!good) {
    /* THE NONCE IS SPENT BEFORE THE RPC IS. An ecrecover mismatch costs nothing and leaves
       an honest signer a retry on the same nonce; the on-chain path (EIP-1271/6492) costs an
       eth_getCode and an eth_call on the keyed RPC — the node the treasury scanner and every
       balance read share — so one free nonce must not buy an unbounded number of those.
       Burn first, then ask the chain; a failure there costs the caller a fresh nonce
       (review, 2026-09-05). */
    if (!burn()) return { ok: false, error: "nonce already used" };
    const r = await onChain({ wallet: w, message, signature: sig });
    if (!r.ok) return { ok: false, error: r.error };
    good = true;
  } else if (!burn()) {
    // burn the nonce before minting a session, so a replay races against nothing
    return { ok: false, error: "nonce already used" };
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token, wallet, chain, created_at, expires_at) VALUES (?,?,?,?,?)")
    .run(token, w, CHAIN_ID, now, now + SESSION_TTL_MS);
  return { ok: true, token, wallet: w, chain: CHAIN_NAMESPACE, expiresAt: now + SESSION_TTL_MS };
}

/** The session's wallet, lowercase — the form every lease, floor and credit row compares against. */
export function walletFor(token) {
  if (!token) return null;
  const s = db.prepare("SELECT wallet, expires_at FROM sessions WHERE token = ?").get(token);
  if (!s || s.expires_at < Date.now()) return null;
  // SLIDING renewal: a session that is being USED never expires under its user.
  // The old fixed 7-day window signed people out mid-life — they came back to a
  // zeroed masthead and locked tabs with no way back but the tower. Renew at
  // most once a day to keep this lookup write-light.
  const now = Date.now();
  if (s.expires_at - now < SESSION_TTL_MS - 24 * 3600 * 1000)
    db.prepare("UPDATE sessions SET expires_at=? WHERE token=?").run(now + SESSION_TTL_MS, token);
  return s.wallet;
}

export function signOut(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
