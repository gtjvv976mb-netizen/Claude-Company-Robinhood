/**
 * `npm test` DOES NOT TOUCH THE NETWORK, AND THIS IS WHAT MAKES THAT TRUE.
 *
 * Preloaded into every test by scripts/test-all.mjs. Any outbound socket to something
 * that is not loopback fails the test file that opened it, loudly and by name.
 *
 * Written 2026-09-09, after three test files had grown live sections that between them
 * reached six hosts and added ~30 seconds to every run. Each of those sections was written
 * carefully — each probed reachability first and skipped when the RPC did not answer — and
 * each still went red on a busy day, because reachability at the top of a block does not
 * survive to the twentieth request inside it. A test that goes red when a third party rate-
 * limits you is not testing your code, and the cost is not the minute: it is that people
 * learn to re-run red instead of reading it.
 *
 * Live checks belong in scripts/check-*-live.mjs, where they are run on purpose and where
 * "the chain disagrees" (exit 1) is kept apart from "the chain did not answer" (exit 2).
 *
 * A recorded fixture is how a live answer gets into a test: see
 * test-fixtures/scope-guard-4663.json, gather-*-4663.json and pons-live-4663.json.
 */
import net from "node:net";

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|::)$/i;
const isLocal = (host) => host == null || host === "" || LOOPBACK.test(String(host));
const who = process.argv[1]?.split("/").slice(-2).join("/") ?? "a test";
const seen = new Set();

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { host: args[1], port: args[0] };
  const host = o.path ? null : o.host;          // a unix socket is not the network
  if (!isLocal(host)) {
    const where = `${host}:${o.port ?? "?"}`;
    if (!seen.has(where)) {
      seen.add(where);
      process.stderr.write(
        `\nOFFLINE GUARD: ${who} tried to reach ${where}.\n` +
        `Tests must not make live network calls — they are slow, and a rate limit or a\n` +
        `timeout then reads as a code regression. Record the answer into test-fixtures/\n` +
        `and stub the reader, or move the live half into scripts/check-*-live.mjs.\n` +
        `(scripts/offline-guard.mjs)\n\n`);
    }
    throw new Error(`offline guard: ${who} may not connect to ${where}`);
  }
  return realConnect.apply(this, args);
};

/* The throw above stops the connection, but undici and friends will happily turn it into
   a caught "fetch failed" that a tolerant test then reports as a SKIP. So the verdict is
   also carried to the exit code, where nothing can swallow it. */
process.on("exit", (code) => {
  if (seen.size && !code) {
    process.stderr.write(`OFFLINE GUARD: failing ${who} — it reached ${[...seen].join(", ")}\n`);
    process.exitCode = 1;
  }
});
