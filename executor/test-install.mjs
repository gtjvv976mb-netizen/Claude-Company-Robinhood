/** Smoke-test the published WALL-ST-E installer and its complete module graph. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const target = process.argv[2] || "https://robinhood.claudedotcompany.com";
const localRoot = fs.existsSync(target) ? path.resolve(target) : null;
const site = target.replace(/\/$/, "");
/* The complete module graph poller.mjs imports, plus the installer and the LaunchAgent
   tooling. Must equal launchd-runner.mjs RUNTIME_FILES + install.sh RUNTIME_FILES, and
   scripts/build-viewer.mjs EXECUTOR_FILES must publish every one of them. */
const need = ["poller.mjs", "journal.mjs", "evm-executor.mjs", "evm-rpc.mjs", "evm-swap.mjs", "approvals.mjs", "scope-guard.mjs",
  "erc20-hazards.mjs", "thresholds.mjs", "live-thresholds.mjs", "eth-usd-oracle.mjs",
  "balance-verification.mjs", "entry-quote-guard.mjs", "exit-trigger.mjs", "feed-drain.mjs",
  "heartbeat-health.mjs", "sleep-assertion.mjs", "monitor.mjs", "strategy.mjs", "trade-policy.mjs",
  "package.json", "package-lock.json", "install.sh", "macos-launchagent.sh", "macos-release.sh", "launchd-runner.mjs"];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wallste-install-test-"));
const sources = new Map();
let fail = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) fail++;
};

for (const file of need) {
  let ok = false;
  let status = "missing";
  let body = "";
  if (localRoot) {
    const source = path.join(localRoot, "executor", file);
    ok = fs.existsSync(source) && fs.statSync(source).isFile();
    status = ok ? "local" : "missing";
    if (ok) body = fs.readFileSync(source, "utf8");
  } else {
    const response = await fetch(`${site}/executor/${file}`);
    ok = response.ok;
    status = String(response.status);
    if (ok) body = await response.text();
  }
  check(`${file} served (${status})`, ok);
  if (ok) {
    sources.set(file, body);
    fs.writeFileSync(path.join(temp, file), body);
  }
}

for (const [owner, source] of sources) {
  if (!owner.endsWith(".mjs")) continue;
  for (const match of source.matchAll(/from\s+"\.\/([^"]+)"/g)) {
    check(`${owner} imports ./${match[1]} and it is published`, need.includes(match[1]));
  }
}

const installer = sources.get("install.sh") || "";
check("dry run remains the default", /MODE="paper"/.test(installer) && /EXECUTE_VALUE="0"/.test(installer));
check("live mode is explicit", /--live\) MODE="live"/.test(installer) && /EXECUTE_VALUE="1"/.test(installer));
check("live acknowledgement must match the generated public key",
  /LIVE_ACK" != "\$PUBKEY/.test(installer) &&
  /write_env_line LIVE_TRADING_ACK "\$LIVE_ACK"/.test(installer));
check("raised-cap acknowledgement is freshly typed, wallet-bound, number-bound and versioned (v3, ETH)",
  installer.includes('CAPS_ACK_EXPECTED="I acknowledge WALL-ST-E caps v3 for $PUBKEY: $MAX_ETH ETH per trade, $DAILY_CAP ETH per day, $DAILY_LOSS_CAP ETH rolling realized-loss entry brake"') &&
  /IFS= read -r LIVE_CAPS_ACK < \/dev\/tty/.test(installer) &&
  /LIVE_CAPS_ACK" != "\$CAPS_ACK_EXPECTED/.test(installer) &&
  !installer.includes("I raise the live caps for") && !installer.includes("caps v2 for") &&
  installer.indexOf('PUBKEY="$(cd "$RELEASE_DIR"') < installer.indexOf('CAPS_ACK_EXPECTED="I acknowledge WALL-ST-E caps v3'));
check("raised-cap acknowledgement is persisted only through the protected environment path",
  /write_env_line LIVE_CAPS_ACK "\$LIVE_CAPS_ACK"/.test(installer) &&
  /LIVE_CAPS_ACK="\$LIVE_CAPS_ACK" \\/.test(installer) &&
  !installer.includes("--live-caps-ack") && !installer.includes("--caps-ack"));
check("live mode requires two explicit, distinct private HTTPS RPCs",
  /--live requires --rpc-file and --secondary-rpc-file/.test(installer) &&
    /--secondary-rpc must use an independent provider hostname from --rpc/.test(installer) &&
  /public Robinhood Chain RPC is not accepted for either live endpoint/.test(installer) &&
    /write_env_line RH_RPC_SECONDARY/.test(installer));
check("private RPC credentials can stay in owner-only files instead of argv",
  installer.includes("--rpc-file") && installer.includes("--secondary-rpc-file") &&
  /read_private_file "primary RPC"/.test(installer) &&
  /read_private_file "secondary RPC"/.test(installer));
check("live canary defaults cover trade, deployment and realized loss, in ETH",
  /LIVE_CANARY_MAX_ETH="0\.0004"/.test(installer) &&
  /LIVE_CANARY_DAILY_CAP="0\.0008"/.test(installer) &&
  /LIVE_CANARY_DAILY_LOSS_CAP="0\.0008"/.test(installer) &&
  /write_env_line DAILY_LOSS_LIMIT_ETH "\$DAILY_LOSS_CAP"/.test(installer));
check("an optional live raise requires all three explicit numeric cap flags",
  /--daily-loss-cap\) need_value/.test(installer) &&
  /MAX_ETH_SET" -ne 1.*DAILY_CAP_SET" -ne 1.*DAILY_LOSS_CAP_SET" -ne 1/.test(installer) &&
  /raising any live cap requires --max-eth, --daily-cap, and --daily-loss-cap together/.test(installer));
check("installer matches the poller's immutable operator maxima and daily/trade relation, compared in wei not awk floats",
  /LIVE_OPERATOR_MAX_ETH="0\.004"/.test(installer) &&
  /LIVE_OPERATOR_MAX_DAILY_CAP="0\.04"/.test(installer) &&
  /LIVE_OPERATOR_MAX_DAILY_LOSS_CAP="0\.012"/.test(installer) &&
  /d >= m \? "coherent" : "incoherent"/.test(installer) && /BigInt\(m\[1\]\) \* 10n \*\* 18n/.test(installer));

const capsStart = installer.indexOf("# BEGIN LIVE_CAPS_VALIDATOR");
const capsEnd = installer.indexOf("# END LIVE_CAPS_VALIDATOR");
check("installer exposes one reviewed live-cap validator", capsStart >= 0 && capsEnd > capsStart);
if (capsStart >= 0 && capsEnd > capsStart) {
  const validator = installer.slice(capsStart, capsEnd);
  const runCaps = (overrides = {}) => spawnSync("bash", ["-c",
    `set -euo pipefail\n${validator}\nprintf '%s|%s|%s|%s\\n' "$MAX_ETH" "$DAILY_CAP" "$DAILY_LOSS_CAP" "$CAPS_RAISED"`], {
    env: {
      ...process.env,
      MODE: "live",
      MAX_ETH: "",
      DAILY_CAP: "",
      DAILY_LOSS_CAP: "",
      MAX_ETH_SET: "0",
      DAILY_CAP_SET: "0",
      DAILY_LOSS_CAP_SET: "0",
      ...overrides,
    },
    encoding: "utf8",
  });

  const defaults = runCaps();
  check("no live cap flags select the unchanged canary and no raised-cap ceremony",
    defaults.status === 0 && defaults.stdout.trim() === "0.0004|0.0008|0.0008|0");

  const raised = runCaps({
    MAX_ETH: "0.004", DAILY_CAP: "0.04", DAILY_LOSS_CAP: "0.012",
    MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("all three explicit reviewed values select the raised-cap ceremony",
    raised.status === 0 && raised.stdout.trim() === "0.004|0.04|0.012|1");

  const exactMinimum = runCaps({
    MAX_ETH: "0.000001", DAILY_CAP: "0.000001", DAILY_LOSS_CAP: "0.000001",
    MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("the poller's exact minimum remains installable",
    exactMinimum.status === 0 &&
    exactMinimum.stdout.trim() === "0.000001|0.000001|0.000001|0");

  const belowMinimum = [
    { MAX_ETH: "0.0000009", DAILY_CAP: "0.0008", DAILY_LOSS_CAP: "0.0008" },
    { MAX_ETH: "0.0004", DAILY_CAP: "0.0000009", DAILY_LOSS_CAP: "0.0008" },
    { MAX_ETH: "0.0004", DAILY_CAP: "0.0008", DAILY_LOSS_CAP: "0.0000009" },
  ].map((values) => runCaps({
    ...values, MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("every money cap enforces the poller's 0.000001 lower bound before installation",
    belowMinimum.every((result) => result.status !== 0 &&
      /must each be at least 0\.000001/.test(result.stderr)));

  const roundedBoundaryLiterals = [
    { MAX_ETH: "0.0000009999999999999999999", DAILY_CAP: "0.0008", DAILY_LOSS_CAP: "0.0008" },
    { MAX_ETH: "0.0040000000000000000000001", DAILY_CAP: "0.04", DAILY_LOSS_CAP: "0.012" },
    { MAX_ETH: "0.004", DAILY_CAP: "0.0400000000000000000000001", DAILY_LOSS_CAP: "0.012" },
    { MAX_ETH: "0.004", DAILY_CAP: "0.04", DAILY_LOSS_CAP: "0.0120000000000000000000001" },
  ].map((values) => runCaps({
    ...values, MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("over-precise cap literals cannot round onto a permitted boundary",
    roundedBoundaryLiterals.every((result) => result.status !== 0 &&
      /at most 18 fractional digits/.test(result.stderr)));

  // The awk trap, now at 18 digits: one wei over the operator maximum must refuse.
  const oneWeiOver = runCaps({
    MAX_ETH: "0.004000000000000001", DAILY_CAP: "0.04", DAILY_LOSS_CAP: "0.012",
    MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("one wei above the operator maximum is refused (a float comparison would have accepted it)",
    oneWeiOver.status !== 0 && /live caps cannot exceed/.test(oneWeiOver.stderr));

  const nonCanonicalLiterals = [".0004", "00.0004", "1."].map((MAX_ETH) => runCaps({
    MAX_ETH, DAILY_CAP: "0.0008", DAILY_LOSS_CAP: "0.0008",
    MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("installer cap grammar exactly matches the runtime's canonical decimal grammar",
    nonCanonicalLiterals.every((result) => result.status !== 0 &&
      /must be plain decimals/.test(result.stderr)));

  const partial = runCaps({ MAX_ETH: "0.004", MAX_ETH_SET: "1" });
  check("a partial live raise fails closed",
    partial.status !== 0 && /requires --max-eth, --daily-cap, and --daily-loss-cap together/.test(partial.stderr));

  const excessive = [
    { MAX_ETH: "0.0040001", DAILY_CAP: "0.04", DAILY_LOSS_CAP: "0.012" },
    { MAX_ETH: "0.004", DAILY_CAP: "0.0400001", DAILY_LOSS_CAP: "0.012" },
    { MAX_ETH: "0.004", DAILY_CAP: "0.04", DAILY_LOSS_CAP: "0.0120001" },
  ].map((values) => runCaps({
    ...values, MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  }));
  check("each reviewed operator maximum rejects even a minimal excess",
    excessive.every((result) => result.status !== 0 && /live caps cannot exceed/.test(result.stderr)));

  const inverted = runCaps({
    MAX_ETH: "0.002", DAILY_CAP: "0.001", DAILY_LOSS_CAP: "0.001",
    MAX_ETH_SET: "1", DAILY_CAP_SET: "1", DAILY_LOSS_CAP_SET: "1",
  });
  check("daily deployment below one trade fails closed",
    inverted.status !== 0 && /daily-cap must be greater than or equal to --max-eth/.test(inverted.stderr));

  const lower = runCaps({ MAX_ETH: "0.0003", MAX_ETH_SET: "1" });
  check("a partial lowering remains safe and does not require a raise acknowledgement",
    lower.status === 0 && lower.stdout.trim() === "0.0003|0.0008|0.0008|0");
}
check("no aggregator key exists to leak: KyberSwap's routes/build need none and the bytes are proven by eth_call",
  !installer.includes("jupiter") && !installer.includes("JUPITER") && !installer.includes("KYBER_API_KEY"));
check("feed secret stays out of argv and the systemd unit",
  installer.includes("--secret-file") && installer.includes("EnvironmentFile=") &&
  !installer.includes("Environment=CC_SECRET=") && !installer.includes("--secret)"));
check("key, environment and journal are owner-only",
  installer.includes("umask 077") && installer.includes('chmod 600 "$INSTALL_DIR/burner.key"') &&
    installer.includes('chmod 600 "$ENV_NEXT"') && installer.includes('chmod 600 "$STATE_DB"'));
check("one durable state database has exactly one canonical process lock",
  installer.includes('LOCK_FILE="${STATE_DB}.lock"') &&
  installer.includes('write_env_line LOCK_FILE "$LOCK_FILE"'));
check("durable state is initialized before the service starts",
  /LIVE_STATE_INIT_ACK="\$PUBKEY"/.test(installer) && /INIT_ONLY=1/.test(installer) &&
    installer.indexOf('node "$RELEASE_DIR/poller.mjs"') <
      installer.lastIndexOf("sudo systemctl restart cc-executor"));
check("live signing requires a locally pinned runtime source",
  /live mode requires --source-dir from a locally pinned Claude Company checkout/.test(installer) &&
  /if \[ "\$MODE" = "live" \] && \[ -z "\$SOURCE_DIR" \]/.test(installer) &&
  /live source must be detached at the published commit/.test(installer) &&
  /status --porcelain -- "executor\/\$source_file"/.test(installer) &&
  /live --expected-commit must exactly match the published commit/.test(installer));
check("live runtime bytes come from immutable Git blobs, not the worktree cache",
  /git -C "\$source_root" cat-file blob "\$SOURCE_COMMIT:executor\/\$file"/.test(installer) &&
  installer.indexOf("cat-file blob") < installer.indexOf("npm ci --ignore-scripts"));
check("a complete release is staged before the running service is stopped",
  installer.indexOf("npm ci --ignore-scripts") < installer.indexOf("systemctl is-active --quiet cc-executor") &&
  installer.includes('RELEASES_DIR="$INSTALL_DIR/releases"'));
check("activation uses an atomic current symlink and systemd never runs staged files",
  installer.includes('mv -Tf "$LINK_NEXT" "$CURRENT_LINK"') &&
  installer.includes('WorkingDirectory=$CURRENT_LINK') &&
  installer.includes('ExecStart=$NODE_BIN $CURRENT_LINK/poller.mjs'));
check("failed upgrades restore the prior unit, symlink, environment and journal",
  installer.includes("rollback_install()") && installer.includes('install -m 0644 "$UNIT_BACKUP"') &&
  installer.includes('mv -Tf "$LINK_RESTORE" "$CURRENT_LINK"') &&
  installer.includes('mv -f "$ENV_BACKUP" "$ENV_FILE"') &&
  installer.includes('cp -p "$STATE_BACKUP" "$STATE_DB"') &&
  installer.includes("systemctl disable cc-executor"));
check("the journal rollback boundary closes before the new service can run",
  installer.includes("ACTIVATION_COMMITTED=1") &&
  installer.indexOf("ACTIVATION_COMMITTED=1") <
    installer.lastIndexOf("sudo systemctl restart cc-executor") &&
  /if \[ "\$status" -ne 0 \] && \[ "\$ACTIVATION_COMMITTED" -eq 0 \]/.test(installer) &&
  /durable state was not rolled back/.test(installer));
check("generated EnvironmentFile is never sourced or evaluated",
  !/(^|\n)\s*(?:source|\.)\s+["']?\$ENV_FILE/m.test(installer) &&
  !/(^|[;\s])eval(?:[;\s]|$)/m.test(installer));

const writerStart = installer.indexOf("# BEGIN SYSTEMD_ENV_WRITER");
const writerEnd = installer.indexOf("# END SYSTEMD_ENV_WRITER");
check("installer exposes one reviewed systemd EnvironmentFile writer",
  writerStart >= 0 && writerEnd > writerStart);
if (writerStart >= 0 && writerEnd > writerStart) {
  const writer = installer.slice(writerStart, writerEnd);
  const marker = path.join(temp, "must-not-exist");
  const rendered = path.join(temp, "rendered.env");
  const payload = `https://rpc.invalid/query?a=1&space=two words;quote=\"'` +
    `&dollar=\$(touch ${marker})&tick=\`touch ${marker}\`&percent=%n&slash=\\tail`;
  const probe = spawnSync("bash", ["-c", `${writer}\nwrite_env_line ADVERSARIAL "$PAYLOAD" > "$OUTPUT"`], {
    env: { ...process.env, PAYLOAD: payload, OUTPUT: rendered }, encoding: "utf8",
  });
  check("adversarial environment value renders without executing shell syntax",
    probe.status === 0 && fs.existsSync(rendered) && !fs.existsSync(marker));
  if (probe.status === 0 && fs.existsSync(rendered)) {
    const line = fs.readFileSync(rendered, "utf8");
    const match = /^ADVERSARIAL="([\s\S]*)"\n$/.exec(line);
    let decoded = null;
    if (match) {
      decoded = match[1].replace(/\\([\\"$`])/g, "$1");
    }
    check("systemd quoting round-trips %, whitespace, quotes, $, backticks, semicolons, ampersands and query strings",
      decoded === payload);
  } else {
    check("systemd quoting round-trips %, whitespace, quotes, $, backticks, semicolons, ampersands and query strings", false);
  }
}
check("Node >=22.13 and <25 and pinned execution dependencies are required",
  installer.includes("Node >=22.13 and <25") &&
    /a<25&&\(a>22\|\|\(a===22&&b>=13\)\)/.test(installer) &&
    installer.includes("package-lock.json") &&
    installer.includes("npm ci --ignore-scripts"));
check("installer never pipes a mutable bootstrap script into a privileged shell",
  !/nodesource[\s\S]*\|[\s\S]*sudo\s+-E\s+bash/.test(installer));
check("installer stages the complete durable execution and monitoring module graph",
  /RUNTIME_FILES=\(poller\.mjs journal\.mjs evm-executor\.mjs evm-rpc\.mjs evm-swap\.mjs approvals\.mjs scope-guard\.mjs erc20-hazards\.mjs thresholds\.mjs live-thresholds\.mjs eth-usd-oracle\.mjs balance-verification\.mjs entry-quote-guard\.mjs exit-trigger\.mjs feed-drain\.mjs heartbeat-health\.mjs sleep-assertion\.mjs monitor\.mjs strategy\.mjs trade-policy\.mjs\)/.test(installer));
{
  // Three lists, one set: the installer's, the runner's, and the heartbeat fingerprint's.
  const runtimeList = (installer.match(/RUNTIME_FILES=\(([^)]*)\)/) || [])[1]?.split(/\s+/) ?? [];
  const runnerSource = sources.get("launchd-runner.mjs") || "";
  const runnerList = [...(runnerSource.match(/const RUNTIME_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const heartbeatSource = sources.get("heartbeat-health.mjs") || "";
  const heartbeatList = [...(heartbeatSource.match(/const TRADING_RUNTIME_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const mjs = (list) => list.filter((f) => f.endsWith(".mjs") && f !== "monitor.mjs").sort().join(",");
  check("installer, launchd runner and heartbeat fingerprint name the same trading runtime",
    mjs(runtimeList) === mjs(runnerList) && mjs(runnerList) === mjs(heartbeatList),
    `${mjs(runtimeList)} | ${mjs(runnerList)} | ${mjs(heartbeatList)}`);
  check("every runtime file is in the published need list", runtimeList.every((f) => need.includes(f)));
}
const manifest = sources.get("package.json") ? JSON.parse(sources.get("package.json")) : {};
const lock = sources.get("package-lock.json") ? JSON.parse(sources.get("package-lock.json")) : {};
check("published manifest pins the one signing dependency, ethers, to an exact version",
  manifest.dependencies?.ethers === "6.17.0" && Object.keys(manifest.dependencies ?? {}).length === 1);
check("published lock agrees with the pinned manifest and carries no Solana package",
  lock.packages?.[""]?.dependencies?.ethers === "6.17.0" &&
  !Object.keys(lock.packages ?? {}).some((name) => /solana|bs58/.test(name)));
check("systemd can write only the executor directory",
  installer.includes("ProtectSystem=strict") && installer.includes("ReadWritePaths=$INSTALL_DIR") &&
  installer.includes("NoNewPrivileges=true"));
check("installer never funds or imports a user wallet",
  installer.includes("No wallet was funded") && !/airdrop|requestAirdrop|solana transfer/.test(installer));

fs.rmSync(temp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed — the published installer is NOT safe to ship` :
  "\nPublished WALL-ST-E install graph and live gates are complete.");
process.exit(fail ? 1 : 0);
