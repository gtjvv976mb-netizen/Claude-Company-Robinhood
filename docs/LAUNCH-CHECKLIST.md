> **Launched 2026-09-04 22:56 UTC** — `0x7039986CaC6C7885b53f10c7492E653055470ab9` on PONS V2, paired to **NVDA** (pool `0x595aa54d2a32d9c6ced42e88355dae507aaf6fa5`), read from the chain and GeckoTerminal on 2026-09-05: 1,000,000,000 supply, 18 decimals, 3,248-byte PONS V2 bytecode, no beacon. The address is wired into render.yaml, .env.example, token/metadata.json, the homepage and the desk's own refusal list. Still the owner's: set `CLAUDECO_RH_TOKEN` in the Render dashboard when the service exists.

# Launching the Robinhood edition of $CLAUDECO

The access token for this tower: it leases a floor and pays rent, and it is never a
position — `executor/scope-guard.mjs` refuses it as a trade target exactly as it refuses
every other token the desk has a conflict in. It launches on **PONS V2** on Robinhood
Chain (4663). Everything below is from the September 2026 sweep, with the measurement
that established each fact; where a fact is from documentation rather than a probe it says
so, and where something could not be verified it says UNVERIFIED.

Nothing in this file sends a transaction. The launch is signed by the owner, from the
owner's wallet, after every box is ticked.

## Facts the launch is built on

| Fact | How it was established |
|---|---|
| PONS V2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`; launch event topic0 `0x308c39…ba980`; each launch is a curve proxy exposing `quoteToken()` (`0x217a4b70`) and `token()` (`0xfc0c546a`) | shared contract, from the sweep's log reads |
| **WETH is NOT an approved pair token.** `approvedPairTokens(0x0Bd7D308…AD73)` → `0x…0000` | `eth_call` on the factory via the public RPC, 2026-09-05 |
| USDG (`0x5fc5360D…d168`, 6 decimals) **is** approved → `0x…0001`; PONS itself and the `0xEeee…EEeE` native sentinel are not (`0x…0000`); `address(0)` is not | same probe, same day |
| Native ETH is the default quote path, not an allowlist entry | V2 docs: "approved pair assets are native ETH and pons-approved ERC-20s"; consistent with both ETH representations reading 0 above. **The exact `launchToken` overload/argument that selects native ETH is UNVERIFIED** — the ABI is not in this repository; read it off the factory (Blockscout, browser UA) before signing |
| Launch fee 0.0005 ETH | docs.ponsfamily.com (V1 page; V2 UNVERIFIED as identical — check the factory's fee getter before signing) |
| Graduation at 4.2 ETH default; the curve's reserve plus held-back tokens become a full-range Uniswap V4 position transferred to a permanent locker; pool fee field 0, a shared hook charges the 1% trade fee (70% creator / 30% protocol) | V2 docs; V4 PoolManager `0x8366a39c…0951`, Initialize topic0 `0xdd466e67…6438` |
| Snipe tax on buys: 99% at block 0 decaying to ~25% at 1 s, ~3% at 2 s, 0 at 5 s; up to **32 exempt addresses fixed at creation** (`ExemptionListTooLong` past that); collected tax joins the creator fee | V2 docs |
| The equities (203 Robinhood Stock Tokens, 283-byte beacon proxies on `0xe10b6f6b…1b00`) are pausable, blocklisted, thin off-hours (GME token $59.17 and $246.72 the same day) | scope-guard measurements 2026-09-04/05; Bitquery |
| "AnthropicAI • Robinhood Token" (44-byte clone) and "ANTHROPIC • Pre IPO Token" (295-byte proxy on a non-Robinhood beacon) exist on chain | Blockscout index, 2026-09-05 (scope-guard.mjs header) |
| Gas: `eth_gasPrice` 0.02 → 0.7 gwei in two weeks, spikes > 5 gwei; 0.41 gwei on 2026-09-05 | per-ticket reads; the executor never caches it |

## The decisions, and why each is what it is

1. **Pair to native ETH.** Not WETH — it is not on the allowlist (measured above, the
   call would revert). Not USDG — it is approved, but a USDG-quoted token can only be
   bought by someone holding USDG on 4663, which almost nobody does; every tenant already
   holds ETH to trade. Not an equity — thin, pausable and blocklisted, and a floor lease
   that can be frozen by an issuer is not a lease.
2. **Do not launch, buy, or associate with any "Anthropic" token.** Both on-chain
   "Anthropic" tokens are impersonations — one wears the Stock Token name marker as a
   plain clone, the other sits behind a foreign beacon. `scope-guard.mjs` refuses both,
   and this project's disclaimer ("not affiliated with … Anthropic") is not decorative.
   Refuse any suggestion to pair, bundle or cross-promote with them.
3. **The exempt list: EMPTY, or the treasury address alone.** The exempt list is the
   insider structure — the desk's own Forensics seat kills a coin where exempt wallets
   hold the float, and `docs/LESSONS.md` carries the Solana holder-concentration lesson
   that this is the 4663 port of. Naming friends, a market-maker, or "just the team
   multisig and two helpers" is the thing this desk exists to detect in other people's
   launches. If the treasury is exempted it is so the treasury can seed the floor-lease
   supply at launch price without a 99% tax; that purchase is disclosed (the address is
   public in `TREASURY_OWNER_RH`). **Owner decision; the default taken here is EMPTY.**
4. **Accept the snipe tax as the protection it is.** Block-0 buys by anyone not on the
   list pay 99%; the real contest is at 2–5 s across 20–30 FCFS blocks. This launch is
   not trying to win that race and is not selling to the people who are.
5. **Creator fee: leave the default; never set it above the cap.** The desk's forensics
   compare `creatorTaxBps` to `maxCreatorTaxBps()`; be what it wants to see.
6. **Graduation is not an event to trade.** Launches with identical settings graduate
   into pools of the same size and price; the V4 position is locked forever. There is no
   migration pop to plan around.

## The launch, step by step

- [ ] 1. **Wallet.** A dedicated launching wallet funded with ≥ 0.05 ETH on 4663 (fee
      0.0005 ETH + gas at up to 5 gwei + the treasury's own seed buy if any). Bridge via
      `https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum`
      (~10 min in; ~7 days out). No private key ever touches this repository, a chat, or
      a Render/GitHub field.
- [ ] 2. **Metadata.** Same name `Claude Company`, symbol `CLAUDECO`, same image
      (`token/claudeco-512.png`, served at
      `https://robinhood.claudedotcompany.com/assets/claudeco-512.png` — **curl it and
      check status AND byte count before the launch tx**; a 404 image is how tokens get
      flagged as spam), same socials as the Solana edition. `token/metadata.json` already
      carries everything except the address.
- [ ] 3. **Read the factory before signing.** With a browser (Blockscout answers 200 to a
      browser UA, 403 to curl): confirm the launch fee getter, the `launchToken` overload
      that takes no pair token (native ETH), the exemption argument, and
      `maxCreatorTaxBps()`. Record the values in this file's table when you have them.
- [ ] 4. **Launch** from the launching wallet: native-ETH pair, default graduation
      (4.2 ETH), default creator fee, exempt list per decision 3. Save the tx hash.
- [ ] 5. **Verify on chain, read-only, from a terminal**, before announcing:
      `eth_getTransactionReceipt` status `0x1` (a `0x0` with no logs is an ArbOS
      compliance void — gas burned, nothing launched); the `0x308c39…ba980` launch log;
      then on the new curve proxy `token()` and `quoteToken()`; then on the token
      `name()` = `Claude Company`, `symbol()` = `CLAUDECO`, `decimals()` = 18.
- [ ] 6. **Paste the address into the three places, in ONE commit**, so the site, the
      metadata and the API can never disagree:
      - `render.yaml` and the Render dashboard: `CLAUDECO_RH_TOKEN=<address>`
        (`CLAUDECO_RH_DECIMALS` stays `18`).
      - `token/metadata.json`: `address`, and remove `addressStatus`.
      - `viewer/index.html` `#caval` and its placeholder comment; the copy above it
        ("Not launched yet…") becomes the verification line: "Launched on PONS V2 against
        ETH, exempt list <empty|treasury only>, verify on Blockscout."
      Then `npm test && npm run build`, commit, and the owner pushes.
- [ ] 7. **Do not touch `executor/scope-guard.mjs`.** The access token is not a position.
      Its allowlist (GOOGL/AMZN/NVDA as pair assets only) is untouched by the launch, and
      the desk's research never covers, rates or prices $CLAUDECO.
- [ ] 8. **Set `TREASURY_OWNER_RH`** in Render if not already; leasing opens when both it
      and the token address are real. Re-run `docs/DEPLOY-ROBINHOOD.md` (e) and confirm
      `/api/lease/config` now returns a non-null `pay`.
- [ ] 9. **Announce** with the address, the tx hash and the exempt-list decision stated
      plainly. The desk never DMs, never airdrops, and cannot ask anyone to sign anything.

## What would make this launch one the desk itself would refuse

Any of: WETH or an equity as the pair; an exempt list longer than the treasury; a creator
fee at the cap; a bundled block-0 buy from wallets that are not the disclosed treasury; a
second "official" address; an image URL that 404s. Each of these is a screen in
`src/agents/analysts.js` or `executor/scope-guard.mjs`. Read them before launch day.
