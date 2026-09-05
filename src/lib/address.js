import { getAddress } from "ethers";
import { isAddress as isSolanaAddress } from "./base58.js";

/**
 * Addresses on Robinhood Chain (chainId 4663, an Arbitrum Nitro L2) are 20-byte EVM
 * addresses. A wallet may hand us any mix of case — MetaMask returns lowercase from
 * eth_requestAccounts, Rabby returns EIP-55 — and every primary key in this building
 * (floors.owner, leases.wallet, sessions.wallet, credits.wallet) is a plain TEXT
 * compare. So one address MUST have one spelling in storage, or the same person is two
 * tenants and the one-floor-per-wallet index means nothing.
 *
 *   normalise()  — lowercase, the storage and comparison form
 *   display()    — EIP-55 checksum, what a human sees
 *   namespaced() — CAIP-10-style "eip155:4663:<lower>", for anything that may one day
 *                  hold sessions from more than one chain
 *
 * isSolanaAddress stays exported for the legacy import path only. This fork's door is
 * EVM-only: a base58 key is refused at auth, not translated.
 */
export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";
export const CHAIN_NAME = "Robinhood Chain";
export const CHAIN_NAMESPACE = `eip155:${CHAIN_ID}`;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(s) {
  return typeof s === "string" && EVM_RE.test(s);
}

/** Lowercase, or null when the input is not an address at all. */
export function normalise(s) {
  return isEvmAddress(s) ? s.toLowerCase() : null;
}

/** EIP-55 checksum for display. Falls back to the input for a non-address. */
export function display(s) {
  try { return isEvmAddress(s) ? getAddress(s) : s; } catch { return s; }
}

export function namespaced(s) {
  const n = normalise(s);
  return n ? `${CHAIN_NAMESPACE}:${n}` : null;
}

/** "eip155:4663" (with or without an address suffix) is ours; anything else is not. */
export function isOurChain(chain) {
  if (chain == null || chain === "") return true;   // an old client that names no chain
  return String(chain) === CHAIN_NAMESPACE || String(chain).startsWith(CHAIN_NAMESPACE + ":");
}

export const isZeroAddress = (s) => normalise(s) === ZERO_ADDRESS;

export { isSolanaAddress };
