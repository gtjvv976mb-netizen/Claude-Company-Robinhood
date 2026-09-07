/**
 * THE CHAIN'S OWN INDEX — holder distribution without replaying the ledger.
 *
 * WHY THIS EXISTS. evm.holdersFromLedger rebuilds the holder table by replaying every
 * Transfer log from the token's launch block. On Solana that is cheap. On Robinhood
 * Chain a block is 100ms, so a two-month-old token is ~46 MILLION blocks of logs, and
 * the desk's scan budget is 120,000 — about 3.4 hours. Every token older than that
 * returned "no launch block — ledger has no start", the screen read UNVERIFIED, and the
 * coin was killed.
 *
 * Measured on the live RH desk, 2026-09-07: 673 workups, 673 kills, $0 of Anthropic
 * spend, zero calls published, ever. `unverified_holders` and `not_graduated` fired on
 * 24 of 24 sampled workups. The screen was not discriminating between coins; it was
 * reporting its own inability to see any of them, and it had been doing so since the
 * fork was cut.
 *
 * THIS IS NOT A BYPASS. The 2026-09-05 review closed a real fail-open: an ESTIMATED
 * launch block let a token whose supply moved before the estimate replay a partial
 * ledger and report a clean top-10. Nothing here estimates anything. Blockscout indexes
 * the chain's actual current balances, so the distribution it returns is the truth as of
 * now — strictly better than a replay, which can only ever reconstruct it. When the
 * explorer cannot answer, this returns ok:false and the screen refuses exactly as it
 * does today. Fail-closed is preserved.
 *
 * WHAT IS SAMPLED, AND WHAT IS NOT. Concentration (top1, top10, head and mid shares)
 * reads only the largest holders, so a top-N page answers it exactly. The bundle
 * fingerprint scans the sample rather than every holder — a bundler's wallets sit at
 * the top by construction, but this is a narrower scan than the ledger's and is
 * labelled `bundleScannedTop`. The holder COUNT is taken from the explorer's own
 * holders_count, never from the page length, because a page of 100 would otherwise
 * report a 2,078-holder token as having 100.
 *
 * Blockscout answers 403 to a default fetch UA and 200 to a browser one.
 */
import { shapeHolders, V4_POOL_MANAGER } from "./evm.js";

const BASE = process.env.RH_EXPLORER_BASE || "https://robinhoodchain.blockscout.com";
/* A browser User-Agent is REQUIRED. Without it this host 403s, which is why the
   explorer was written off as absent for a week. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const lower = (a) => String(a ?? "").toLowerCase();

/* A HICCUP MUST NOT COST A COIN. This is on the critical path now — it is what supplies
   holder concentration for every token older than the 3.4-hour ledger budget, which is
   essentially all of them — and the screen correctly REFUSES when holders are
   unverified. So a single 429 or a dropped connection turns into a coin the desk never
   looks at. Observed live: one SIZE run returned unverified_holders and the next two
   returned clean. Retried on transient conditions only; a 404 is an answer and is
   returned at once. Bounded at three waits, then the failure stands honestly. */
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
async function get(path, { timeoutMs = 12_000, retries = 3 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        headers: { accept: "application/json", "user-agent": UA },
        redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return r.json();
      last = new Error(`explorer HTTP ${r.status}`);
      if (!TRANSIENT_HTTP.has(r.status)) throw last;
    } catch (e) {
      last = e;
      /* An explicit non-transient HTTP answer is final; anything else (abort, socket,
         DNS) is worth one more try. */
      if (/explorer HTTP/.test(String(e.message)) && !TRANSIENT_HTTP.has(Number(String(e.message).match(/\d+/)?.[0]))) throw e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw last ?? new Error("explorer unreachable");
}

/** Token metadata: supply, decimals and the TRUE holder count. */
export async function tokenMeta(address) {
  try {
    const j = await get(`/api/v2/tokens/${address}`);
    const supply = j?.total_supply != null ? BigInt(String(j.total_supply)) : null;
    return {
      ok: supply != null && supply > 0n,
      supply, decimals: Number(j?.decimals ?? 18),
      holdersCount: j?.holders_count != null ? Number(j.holders_count) : null,
      symbol: j?.symbol ?? null, name: j?.name ?? null,
      error: supply != null && supply > 0n ? null : "explorer returned no total supply",
    };
  } catch (e) { return { ok: false, error: `explorer token read failed: ${e.message}` }; }
}

/**
 * The holder distribution, in the exact shape evm.holdersFromLedger returns, so the
 * screen and the seats read one structure whatever produced it.
 */
export async function holdersFromExplorer(address, { supply = null, decimals = 18, exclude = [], top = 100 } = {}) {
  let meta = null;
  if (supply == null) {
    meta = await tokenMeta(address);
    if (!meta.ok) return { ok: false, error: meta.error };
    supply = meta.supply; decimals = meta.decimals;
  }
  let items;
  try {
    const j = await get(`/api/v2/tokens/${address}/holders`);
    items = Array.isArray(j?.items) ? j.items : null;
  } catch (e) { return { ok: false, error: `explorer holders read failed: ${e.message}` }; }
  if (!items || !items.length) return { ok: false, error: "explorer returned no holders" };

  const balances = new Map();
  for (const it of items.slice(0, top)) {
    const addr = lower(it?.address?.hash);
    const value = String(it?.value ?? "");
    if (!/^0x[0-9a-f]{40}$/.test(addr) || !/^\d+$/.test(value)) continue;
    balances.set(addr, (balances.get(addr) ?? 0n) + BigInt(value));
  }
  if (!balances.size) return { ok: false, error: "no readable holder rows" };

  /* CONTRACTS THE EXPLORER ALREADY LABELS ARE POOLS. The ledger path builds `exclude`
     from the pools DexScreener reported; the explorer knows about pools DexScreener
     never listed, and a pool counted as a holder reads as one wallet owning half the
     float. Names like "UniswapV3Pool" are added to the exclusion set rather than being
     trusted for anything else. */
  /* WHAT MAY BE SUBTRACTED FROM CONCENTRATION, AND WHY IT MUST NOT BE A NAME.
   *
   * Excluding a holder REMOVES IT FROM top1Pct, which is the single number
   * holder_concentration (>50%) and the red team's holder_control both read. This
   * filtered on `is_contract` plus a substring of the explorer's NAME —
   * pool|pair|vault|router|manager|locker|curve — with no verification requirement. The
   * name is chosen by the deployer. Reproduced against this module: one holder named
   * "TeamTreasuryVault" holding 70% of supply came back as top1Pct 4%, and the one gate
   * that exists to catch a wallet owning the float read it as a rounding error.
   *
   * The ledger path this replaced never had that weakness — it built `exclude` from
   * addresses with PROVENANCE: DexScreener's pair addresses, evm.V4_POOL_MANAGER, and
   * the curve/vault decoded out of the launch receipt (evidence.js). Provenance is what
   * was traded away for a substring, so provenance is what comes back:
   *
   *   - `exclude` (passed in by the caller, address-keyed) is the authority and is
   *     applied by shapeHolders exactly as before.
   *   - a name match may only ADD to it when the explorer has VERIFIED the contract's
   *     source, and only for words that name a liquidity venue. `vault`, `router` and
   *     `manager` are dropped: they are free-standing words an attacker would pick, and
   *     none of them names a pool.
   *   - anything name-matched but unverified is reported in `nameOnlyContracts` and is
   *     NOT subtracted, so a large holder can never be hidden by what it calls itself. */
  const knownPools = new Set((exclude ?? []).map((e) => lower(e?.address)).filter(Boolean));
  const looksLikeVenue = (n) => /uniswap|pancake|sushi|ramses|velodrome|aerodrome|pons/i.test(n) &&
    /pool|pair|curve|locker/i.test(n);
  const top100 = items.slice(0, top);
  const inferred = top100
    .filter((it) => it?.address?.is_contract && it?.address?.is_verified &&
      !knownPools.has(lower(it?.address?.hash)) && looksLikeVenue(String(it?.address?.name ?? "")))
    .map((it) => ({ address: lower(it.address.hash), label: `pool:${String(it.address.name).toLowerCase()}` }));
  /* Named like a venue but NOT verified — counted, never subtracted. */
  const nameOnlyContracts = top100
    .filter((it) => it?.address?.is_contract && !it?.address?.is_verified &&
      /pool|pair|vault|router|manager|locker|curve|treasury/i.test(String(it?.address?.name ?? "")))
    .map((it) => ({ address: lower(it.address.hash), name: String(it.address.name) }));

  const shaped = shapeHolders(balances, { supply, decimals, exclude: [...exclude, ...inferred] });
  if (!shaped.ok) return shaped;

  if (meta == null) meta = await tokenMeta(address).catch(() => null);
  /* shapeHolders stamps every result with "Balances rebuilt from the complete Transfer
     ledger" — true of the path it was written for, and FALSE here. This data is a top-N
     page from the explorer's index, and that note goes to the analyst seats, which read
     it as provenance when they weigh concentration. A seat told the ledger was complete
     will treat a clean top-10 as stronger evidence than it is. Replaced with what
     actually happened. */
  shaped.note = `Balances read from the chain's explorer index (top ${Math.min(top, items.length)} ` +
    `holders of ${meta?.holdersCount ?? "an unknown number"}), NOT rebuilt from a Transfer ledger — ` +
    "the ledger cannot reach this token's launch block on a 100ms chain. Concentration " +
    "(top1/top10) is exact because it only needs the largest holders; the bundle-cluster " +
    "fingerprint scans that page only. Pool and burn addresses were excluded by ADDRESS " +
    "where the caller supplied one, and by verified contract name otherwise; a large holder " +
    "that merely NAMES itself like a pool is reported in nameOnlyContracts and is NOT excluded.";
  return {
    ...shaped,
    /* The page length is NOT the holder count. */
    count: meta?.holdersCount ?? shaped.count,
    source: "explorer",
    bundleScannedTop: Math.min(top, items.length),
    sampledHolders: balances.size,
    inferredPools: inferred.length,
    /* THE POOLS THEMSELVES, not just how many. A token whose float sits in a contract the
       explorer has VERIFIED and named "UniswapV3Pool" is trading on a real AMM, and that
       is chain-indexed evidence rather than a DEX label — which matters because
       DexScreener reports a live PONS bonding curve as dexId "uniswap" (review,
       2026-09-05), so the label cannot distinguish a curve from a pool and this can. */
    poolContracts: inferred.map((e) => e.label),
    /* Contracts that NAME themselves like a venue but whose source is unverified. They
       are left in the concentration numbers on purpose; this is here so a reader can
       see that a large holder was noticed and deliberately not excused. */
    nameOnlyContracts,
    /* POSITIVE EVIDENCE OF A LIVE CURVE, which must veto the "amm" upgrade even when a
       pool is also present. A graduated PONS coin legitimately holds both a V4 pool and
       a launch LOCKER (SIZE holds "poolmanager" and "ponsv2launchlocker" — a locker is
       locked LP, which is benign and is not a curve). A coin still ON its curve holds the
       CURVE contract, and that is a different word. Named narrowly on purpose: matching
       "locker" here would refuse exactly the graduated coins this desk wants. */
    curveHolder: items.slice(0, top).some((it) =>
      it?.address?.is_contract && /curve|bonding/i.test(String(it?.address?.name ?? "")) &&
      !/locker/i.test(String(it?.address?.name ?? ""))),
    /* THE V4 PoolManager IS NOT PROOF, AND THAT COST COVERAGE — deliberately.
     *
     * This briefly matched evm.V4_POOL_MANAGER by address and returned true, on the
     * reasoning that a name-only test made every V4-only token invisible and
     * uniswap-v4-robinhood is one of the two venues carrying this chain's volume.
     * An address does beat a name. But the V4 PoolManager is a SINGLETON — every V4
     * pool on the chain keeps its tokens in that one contract (evm.js:49) — so its
     * presence among a token's holders proves the token has SOME V4 position. It does
     * not prove that position is a graduated pool rather than a live PONS curve.
     *
     * DEX_VENUES puts the live curve at "pons-v2" (v2) and the graduated hook pools at
     * "pons-v2-dex" (v4), which would make the inference safe — except that the comment
     * directly above that table says, in the fork's own words, "that split is an
     * inference from the ids, not a documented contract, and the chain-native reads
     * below are the authority when the two disagree." A safety gate cannot rest on an
     * inference its own source flags as one, and the hole it would open is precisely
     * the one the 2026-09-05 review closed: a coin still on its curve reading as
     * tradeable.
     *
     * So proof requires a contract the explorer has VERIFIED and named as a specific AMM
     * pool. V4-only tokens therefore do not earn the "amm" phase and are refused, which
     * is the fail-closed direction. To restore that coverage properly, read the V4
     * Initialize log for the token (pons-live.graduationFor already does exactly this,
     * TOPIC_V4_INITIALIZE on the PoolManager) — that is the chain-native read the
     * comment above names as the authority, and it distinguishes the two cases. */
    verifiedAmmPool: items.slice(0, top).some((it) => {
      const name = String(it?.address?.name ?? "");
      return it?.address?.is_contract && it?.address?.is_verified &&
        /uniswap|pancake|sushi|ramses|velodrome|aerodrome/i.test(name) && /pool|pair/i.test(name);
    }),
    complete: true,
  };
}
