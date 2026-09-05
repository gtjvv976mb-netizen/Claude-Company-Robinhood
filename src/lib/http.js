// Hosted research-desk market-data requests use these helpers. Execution is not
// routed through this module: the only signing path lives in the separately run,
// user-operated polling executor under executor/.
export async function getJson(url, { headers = {}, timeoutMs = 12000, label } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, url: label || url };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), url: label || url };
  } finally {
    clearTimeout(t);
  }
}

/** A JSON POST that reads back JSON. Used for aggregator route builds — a request that
 *  returns calldata to SIMULATE, never one that sends anything. */
export async function postJson(url, body, { headers = {}, timeoutMs = 15000, label } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}${data?.message ? ": " + data.message : ""}`, url: label || url };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), url: label || url };
  } finally {
    clearTimeout(t);
  }
}

export async function rpc(endpoint, method, params, { timeoutMs = 12000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    if (j.error) return { ok: false, error: j.error.message };
    return { ok: true, data: j.result };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* Read-only RPC methods. Anything not on this list is refused before it is sent.
 *
 * THE EVM SET, for chain 4663. Every one of these is a read: eth_call executes against
 * state and discards it (the state-override third argument is a SIMULATION input, not a
 * write), eth_getLogs and the storage/code reads are pure lookups. eth_sendRawTransaction
 * and eth_sign* are deliberately absent and always will be: the desk never signs. */
const EVM_READS = [
  "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getLogs", "eth_blockNumber",
  "eth_gasPrice", "eth_getBalance", "eth_getTransactionCount", "eth_getBlockByNumber",
  "eth_chainId", "eth_getTransactionReceipt", "eth_estimateGas",
];
/* The Solana names stay until the files that still speak them (index.js doctor,
   perf.js, passes.js, leasing.js, scanner.js) are ported by their lanes — see
   docs/HANDOFF-data-sources.md. Against an EVM endpoint they return a method-not-found
   error through the ordinary {ok:false} path rather than throwing here, which is the
   difference between a doctor line reading "unavailable" and a boot crash. */
const SOLANA_READS = [
  "getAccountInfo", "getMultipleAccounts", "getTokenLargestAccounts",
  "getTokenSupply", "getSignaturesForAddress", "getBalance", "getSlot", "getLatestBlockhash",
  "getTransaction", "getProgramAccounts", "getTokenAccountsByOwner", "getTokenAccountBalance",
];
const ALLOWED = new Set([...EVM_READS, ...SOLANA_READS]);
export const isReadMethod = (m) => ALLOWED.has(m);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (r) => !r.ok && /429|Too many requests|rate/i.test(String(r.error || ""));

export async function readRpc(endpoint, method, params, opts = {}) {
  if (!ALLOWED.has(method)) {
    throw new Error(`readRpc refused non-read method: ${method}`);
  }
  // The public RPC rate-limits the expensive reads, and a 429 on holders is not a
  // cosmetic loss: holder concentration is the single most decision-relevant datum the
  // forensics seat has. Back off and try again before giving up on it.
  /* Measured on rpc.mainnet.chain.robinhood.com, 2026-09-05: the answer to a burst is
     a JSON-RPC error whose message is "Too Many Requests" with HTTP 200 — so the match
     is on the message, not the status. Eleven sequential eth_getLogs calls tripped it;
     the same eleven with 150ms between them did not. */
  const attempts = opts.attempts ?? 3;
  let last;
  for (let i = 1; i <= attempts; i++) {
    last = await rpc(endpoint, method, params, opts);
    if (last.ok) return last;
    if (!rateLimited(last) || i === attempts) break;
    await sleep(700 * i * i);
  }
  return last;
}

/** The public RPC 429s on JSON-RPC batches past roughly ten (measured 2026-09-04). */
export const BATCH_MAX = 10;

/**
 * Many reads in one HTTP round trip, at most BATCH_MAX per request, in order.
 *
 * Returns one {ok, data|error} per call, positionally. A 429 on the whole batch backs
 * off and retries the batch; a per-call error stays with its call. Every method is
 * checked against the read allowlist BEFORE anything is sent, so a stray write in a
 * batch refuses the batch rather than slipping past inside it.
 */
export async function readRpcBatch(endpoint, calls, { timeoutMs = 15000, attempts = 3, spacingMs = 120 } = {}) {
  for (const c of calls) if (!ALLOWED.has(c.method)) throw new Error(`readRpcBatch refused non-read method: ${c.method}`);
  const out = new Array(calls.length);
  for (let start = 0; start < calls.length; start += BATCH_MAX) {
    const slice = calls.slice(start, start + BATCH_MAX);
    const body = slice.map((c, i) => ({ jsonrpc: "2.0", id: start + i, method: c.method, params: c.params }));
    let results = null, lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), signal: ctl.signal });
        if (res.status === 429) { lastErr = "HTTP 429"; await sleep(700 * i * i); continue; }
        if (!res.ok) { lastErr = `HTTP ${res.status}`; break; }
        const j = await res.json();
        const arr = Array.isArray(j) ? j : [j];
        // A whole-batch rate limit arrives as one error object, not an array.
        if (!Array.isArray(j) && j?.error && rateLimited({ ok: false, error: j.error.message })) {
          lastErr = j.error.message; await sleep(700 * i * i); continue;
        }
        results = arr;
        break;
      } catch (e) { lastErr = String(e?.message || e); break; }
      finally { clearTimeout(t); }
    }
    if (!results) { slice.forEach((_, i) => { out[start + i] = { ok: false, error: lastErr ?? "batch failed" }; }); continue; }
    const byId = new Map(results.map((r) => [Number(r.id), r]));
    slice.forEach((_, i) => {
      const r = byId.get(start + i);
      out[start + i] = !r ? { ok: false, error: "missing from batch response" }
        : r.error ? { ok: false, error: r.error.message } : { ok: true, data: r.result };
    });
    if (start + BATCH_MAX < calls.length && spacingMs) await sleep(spacingMs);
  }
  return out;
}
