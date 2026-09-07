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
import { shapeHolders } from "./evm.js";

const BASE = process.env.RH_EXPLORER_BASE || "https://robinhoodchain.blockscout.com";
/* A browser User-Agent is REQUIRED. Without it this host 403s, which is why the
   explorer was written off as absent for a week. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const lower = (a) => String(a ?? "").toLowerCase();

async function get(path, { timeoutMs = 12_000 } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json", "user-agent": UA },
    redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
  return r.json();
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
  const inferred = items.slice(0, top)
    .filter((it) => it?.address?.is_contract && /pool|pair|vault|router|manager|locker|curve/i.test(String(it?.address?.name ?? "")))
    .map((it) => ({ address: lower(it.address.hash), label: `pool:${String(it.address.name).toLowerCase()}` }));

  const shaped = shapeHolders(balances, { supply, decimals, exclude: [...exclude, ...inferred] });
  if (!shaped.ok) return shaped;
  if (meta == null) meta = await tokenMeta(address).catch(() => null);
  return {
    ...shaped,
    /* The page length is NOT the holder count. */
    count: meta?.holdersCount ?? shaped.count,
    source: "explorer",
    bundleScannedTop: Math.min(top, items.length),
    sampledHolders: balances.size,
    inferredPools: inferred.length,
    complete: true,
  };
}
