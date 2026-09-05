# Claude Company — $CLAUDECO (Robinhood Chain edition)

**This edition is not launched.** `metadata.json` carries the all-zero placeholder address
and `"addressStatus"` says so; the launch itself — PONS V2, paired to native ETH, the
exempt-list decision, and the three files that change in the same commit — is
`docs/LAUNCH-CHECKLIST.md`. The name, symbol, socials and image are the same as the Solana
edition's, by the owner's decision ("the socials, image will be the same"); only the chain
and the address differ.

| Field | Value |
|---|---|
| Name | `Claude Company` |
| Symbol | `CLAUDECO` |
| Standard | ERC-20 on Robinhood Chain, chainId 4663 (`0x1237`) |
| Decimals | 18 (`CLAUDECO_RH_DECIMALS`; PONS launches are 18-decimal ERC-20s) |
| Address | `0x0000000000000000000000000000000000000000` — placeholder until launch |
| Solana edition | `HRkkxgaFDDmZ3qZX8xP5SiMRBNvFNVUUv4FJUjPCpump`, https://claudedotcompany.com |

The Solana notes below (Metaplex limits, mint/freeze authority) describe the ORIGINAL
edition and are kept for the art pipeline they document; the EVM equivalents of "mint it
plain" — no owner, no pause, no blocklist, no transfer tax, no insider exempt list — are
in the launch checklist, and they are exactly what `executor/scope-guard.mjs` and the
Forensics seat refuse in other people's tokens.

## The Solana edition's field limits (kept for reference)

| Field | Value | Limit |
|---|---|---|
| Name | `Claude Company` | 14 / 32 bytes |
| Symbol | `CLAUDECO` | 8 / 10 bytes |
| Decimals | 6 (recommended, matches USDC) | — |

`CLAUDECO` is "Claude Co" without the space. Spaces are legal in a Metaplex symbol, but a
ticker is a handle people type and bots match — every space-symbol token on Solana today
sits at zero liquidity.

## The art

| File | Use |
|---|---|
| `claudeco-512.png` | **The token image.** Upload this one; point `metadata.json` `image` at its live URL |
| `claudeco-256/128/64/32.png` | Pre-scaled copies; `claudeco-sizes.png` shows the 32px wallet-list check |
| `banner-1500x500.png` | X / Twitter profile header |
| `banner-1200x630.png` | OG / link-preview card |

The mark is the CEO's head from floor 50 — the one figure in the building with Claude's
spark where a face would be. It is designed inside a circle-safe square (wallets mask
token images to a circle) and the spark's ray widths are set by the geometry that keeps
eleven spokes distinct at 32px. Regenerate everything with `python3 token/make-image.py`
(fonts in `token/fonts/`, OFL-licensed).

## Before minting

**Mint it plain.** Claude Tower's own Forensics seat checks for exactly these and treats
them as near-disqualifying. If you mint with them live, your product flags your token:

- [ ] Mint authority **revoked** — otherwise supply can be inflated under holders
- [ ] Freeze authority **revoked** — otherwise a holder's account can be frozen mid-sell
- [ ] If Token-2022: **no** `transferHook`, `transferFeeConfig`, `permanentDelegate`,
      or `defaultAccountState`. Plain SPL is the safer default.

## After uploading metadata

A file on disk is not a file on the web. Metadata pointing at a 404 image is the fastest
route to a spam flag:

```bash
curl -sI "$IMAGE_URL" | head -1 && curl -s "$IMAGE_URL" | wc -c
```

Check the **status and the byte count**. A 200 that returns 0 bytes is still broken.

## Disclaimer

Ship this line in the metadata, the site footer and the socials:

> An independent project. Not affiliated with, endorsed by, or connected to Anthropic.

"Claude Company" reads as a corporate identity rather than a tribute, and impersonation is
what Jupiter, Phantom and DexScreener flag. The disclaimer is most of the difference
between how a listing reviewer reads the two.
