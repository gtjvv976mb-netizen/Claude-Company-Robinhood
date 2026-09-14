/* THE GUIDE, RECORDED FROM THE REAL SITE — ROBINHOOD EDITION.
 *
 * The Solana tower's scripts/record-guide.mjs is this file's parent, and the shape is
 * deliberately the same: record the PUBLISHED pages as real clicks on the live site with
 * a caption bar drawn over them, speak the narration with Piper, and burn the voice into
 * the picture at each chapter's second. Nothing here is a mock-up of the product; if the
 * board is empty the video shows an empty board, which is the point of recording the
 * real thing. Writes:
 *
 *     token/guide-walkthrough.mp4     the video, voice included (H.264/AAC)
 *     token/guide-walkthrough.webm    the same, VP9/Opus, for Chromium builds without H.264
 *     token/guide-chapters.json       each chapter's title, narration and start second
 *
 * All three are committed like the other finished media, so `npm run build` needs none of
 * the tooling below. Run this only to re-record after the site changes.
 *
 * WHAT DIFFERS FROM THE SOLANA RECORDING, and why:
 *   - the chain, the sizes and the wallet story are this chain's. Gas here is FLAT, so
 *     the clip is the thing that decides whether a round trip can pay for itself, and the
 *     narration says the measured number rather than a round one.
 *   - the tower's tabs are read from the live page before recording, so a tab that has
 *     been renamed fails loudly here instead of recording a chapter of nothing.
 *   - HOLDS ARE SIZED TO THE VOICE, as on Solana: each chapter waits at least as long as
 *     its spoken line, measured after synthesis. Change the words and the waits re-measure
 *     themselves on the next run.
 *
 * Needs, none of them build dependencies:
 *   - playwright (npm) and a Chromium it can launch: PLAYWRIGHT_CHROMIUM=/path/to/chrome
 *   - piper-tts (pip) and a voice: PIPER_VOICE=/path/to/en_US-lessac-medium.onnx
 *   - an ffmpeg binary: FFMPEG=/path/to/ffmpeg (npm's @ffmpeg-installer/ffmpeg is fine)
 *
 *     GUIDE_SITE=https://robinhood.claudedotcompany.com \
 *     PIPER_VOICE=…/en_US-lessac-medium.onnx FFMPEG=…/ffmpeg \
 *     node scripts/record-guide.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.GUIDE_SITE || "https://robinhood.claudedotcompany.com").replace(/\/$/, "");
const API = (process.env.GUIDE_API || "https://claude-company-robinhood-api.onrender.com").replace(/\/$/, "");
const WORK = process.env.GUIDE_WORK || path.join(ROOT, ".guide-work");
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || undefined;
const VOICE = process.env.PIPER_VOICE;
const FFMPEG = process.env.FFMPEG || "ffmpeg";
if (!VOICE) throw new Error("PIPER_VOICE must name a Piper .onnx voice");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "voice"), { recursive: true });

/* THE WORDS. Every number spoken here is one this repo measured on chain 4663 and
   registered in executor/live-thresholds.mjs — the flat round-trip gas, the cheapest
   clip, the hold. A guide that quotes a number the machine does not use is marketing;
   the assertion below keeps these two honest with each other. */
export const CHAPTERS = [
  { id: "hook",     title: "Fifty floors",     say: "Fifty floors. Sixteen analysts on every one of them. And a bot that trades what they publish \u2014 on Robinhood Chain, with your key, on your machine." },
  { id: "tower",    title: "The tower",        say: "This is Claude Tower. Every floor is one automated research desk, working the same chain, around the clock. The house desk runs upstairs on floor fifty, and everything it finds is published in the open." },
  { id: "directory",title: "The directory",    say: "Forty nine floors are yours to take. Floor fifty is the house. Every floor shows its own record \u2014 nothing is hidden behind a login, and nothing is back-dated." },
  { id: "lease",    title: "Lease a floor",    say: "Pick a vacant floor and here is what it costs. One floor per wallet. Beside it, the house bot's real record, kept with the house's own money." },
  { id: "enter",    title: "Walk in",          say: "Let's walk into headquarters. No sign-in, no pass, no waiting list." },
  { id: "desk",     title: "The desk",         say: "This is the floor. Sixteen agents, each with one job and one question to answer. A scout hunting today's launches. Forensics reading the contract for traps. Liquidity asking the only question that matters \u2014 can I get back out. And a red team paid to argue that the whole idea loses money." },
  { id: "overview", title: "The book",         say: "The Overview is the desk's own book. Profit and loss straight out of the journal, what the bot is holding right now, and every closed trade drawn from its stop to its target." },
  { id: "calls",    title: "The calls",        say: "Calls. Every idea the desk publishes, with an entry, a stop and a target, timestamped the moment it was made. Nothing is edited after the fact. These are the calls your bot takes." },
  { id: "team",     title: "Your team",        say: "The Team tab is the roster \u2014 and on a floor you lease, it is where you choose who runs your bot. That is one command on your own machine, and a key that never leaves it." },
  { id: "wallste",  title: "WALL-ST-E",        say: "Wall Street E is the bot. Here is the thing this chain does differently: gas is flat. Six hundred and sixty one thousand units a round trip, whatever you trade. So the size of the position, not the price of the coin, decides whether a trade can pay for itself. The measured cheapest clip is eleven point two thousandths of an E T H, and that is the default." },
  { id: "custody",  title: "Your key",         say: "The desk never holds a key. It cannot reach your wallet, it cannot move your money, and it never sees your private key \u2014 that is made on your machine and stays there. The site publishes research. You trade, or you don't." },
  { id: "board",    title: "The board",        say: "And on the wall, the board keeps the live book, redrawn every ten seconds." },
  { id: "end",      title: "Plug in",          say: "Lease a floor. Plug in. Let it work." },
];

/* THE NARRATION AND THE REGISTRY MUST AGREE. The Solana desk's own lesson — two copies
   of one number is a disagreement waiting to happen — applies to a number that is spoken
   aloud just as much as to one that is signed. */
{
  await import("../executor/live-thresholds.mjs");
  const { threshold } = await import("../executor/thresholds.mjs");
  const clip = threshold("size.cheapestClipEth").value;
  const gasK = Math.round(threshold("swap.roundTripGasUnits").value / 1000);
  const said = CHAPTERS.find((c) => c.id === "wallste").say;
  if (clip !== 0.0112) throw new Error(`the narration says 0.0112 ETH; the registry says ${clip}. Re-record with the right words.`);
  if (gasK !== 661) throw new Error(`the narration says 661k gas; the registry says ${gasK}k. Re-record with the right words.`);
  /* Case-insensitive: the sentence that carries the gas figure may begin with it, and a
     capital letter is not a changed number. The guard exists to catch a number that
     drifted from the registry, not a rewritten sentence. */
  if (!/eleven point two thousandths/i.test(said) || !/six hundred and sixty one thousand/i.test(said))
    throw new Error("the WALL-ST-E line no longer spells out the registry's numbers");
}

/* 1 · THE VOICE FIRST, so every hold can be sized to its line. */
const wavSeconds = (file) => {
  const b = fs.readFileSync(file);
  const rate = b.readUInt32LE(24), channels = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  return (b.length - 44) / (rate * channels * (bits / 8));
};
const spoken = {};
for (const c of CHAPTERS) {
  const wav = path.join(WORK, "voice", `${c.id}.wav`);
  /* LENGTH_SCALE IS THE DELIVERY, NOT A DETAIL. 1.05 read as a man reciting a form;
     0.96 is closer to someone telling you about something they built. The voice itself
     is chosen by PIPER_VOICE — en_US-ryan-high carries sentence stress that the medium
     models flatten, which is most of the difference between "narrated" and "read". */
  execFileSync("python3", ["-m", "piper", "--model", VOICE, "--output_file", wav, "--length_scale", "0.96"], { input: c.say });
  spoken[c.id] = wavSeconds(wav);
}
const holdFor = (id, floorMs) => Math.max(floorMs, Math.ceil(spoken[id] * 1000) + 900);

/* 2 · THE RECORDING: real pages, real clicks, a caption bar for the eye. */
const browser = await chromium.launch({ headless: true, executablePath: CHROME,
  args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--font-render-hinting=none"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  recordVideo: { dir: WORK, size: { width: 1280, height: 720 } } });
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById("cc-guide-cap")) return;
    const bar = document.createElement("div"); bar.id = "cc-guide-cap";
    bar.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:920px;padding:12px 18px;" +
      "background:rgba(10,12,16,.86);color:#f4f1e8;font:600 19px/1.35 Archivo,Helvetica,Arial,sans-serif;border-radius:12px;" +
      "z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.45);text-align:center;pointer-events:none;opacity:0;transition:opacity .35s";
    document.body.appendChild(bar);
    const step = document.createElement("div"); step.id = "cc-guide-step";
    step.style.cssText = "position:fixed;left:18px;top:14px;padding:6px 10px;background:rgba(217,119,87,.92);color:#2a1a14;" +
      "font:700 12px/1 Archivo,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;border-radius:6px;z-index:2147483647;pointer-events:none;opacity:0";
    document.body.appendChild(step);
    /* A 6-pixel colour marker in the top-right corner, one colour per chapter: the
       recording's own clock. Wall-clock marks drift against a headless renderer that
       drops frames, so chapter times are read back from the video itself. */
    const mark = document.createElement("div"); mark.id = "cc-guide-mark";
    mark.style.cssText = "position:fixed;right:0;top:0;width:6px;height:6px;z-index:2147483647;pointer-events:none;background:transparent";
    document.body.appendChild(mark);
  };
  if (document.body) install(); else document.addEventListener("DOMContentLoaded", install);
  window.__cap = (text, label, color) => {
    install();
    document.getElementById("cc-guide-mark").style.background = color || "transparent";
    const bar = document.getElementById("cc-guide-cap"); bar.textContent = text; bar.style.opacity = text ? "1" : "0";
    const step = document.getElementById("cc-guide-step"); step.textContent = label || ""; step.style.opacity = label ? "1" : "0";
  };
});
const page = await ctx.newPage();
page.on("pageerror", () => {});
/* Behind a proxy, the browser's own network stack may not carry the session's CA;
   relaying through Node's fetch does. Harmless where no proxy is in the way. */
if (process.env.GUIDE_RELAY_FETCH === "1") {
  await page.route("**/*", async (route) => {
    const req = route.request();
    try {
      const r = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined, redirect: "manual" });
      const body = Buffer.from(await r.arrayBuffer());
      const headers = {}; r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k)) headers[k] = v; });
      await route.fulfill({ status: r.status, headers, body });
    } catch { await route.abort(); }
  });
}

/* A vacant floor, chosen from the live directory so the lease card really is a lease
   card: the tower's `floors` array is module-scoped and not reachable from evaluate. */
const VACANT = await (async () => {
  try {
    const r = await fetch(`${API}/api/tower/floors`);
    const rows = (await r.json()).floors || [];
    const vacant = rows.filter((f) => f.state === "vacant").map((f) => f.n).sort((a, b) => b - a);
    return vacant[0] || 14;
  } catch { return 14; }
})();
/* One colour per chapter, and they must stay far apart in RGB: the chapter clock is
   read back by sampling this marker out of the finished video, and nearest() only
   accepts a match inside 90 units. Thirteen chapters, thirteen corners of the cube. */
const PALETTE = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255],
                 [255,128,0],[128,0,255],[0,128,255],[128,255,0],[255,0,128],[0,255,128],[255,255,255]];
if (PALETTE.length < CHAPTERS.length) throw new Error("every chapter needs its own marker colour");
const t0 = Date.now();
const marks = [];
const chapter = async (id) => {
  const c = CHAPTERS.find((x) => x.id === id);
  marks.push({ id: c.id, title: c.title, say: c.say, at: Math.round((Date.now() - t0) / 100) / 10 });
  const i = CHAPTERS.indexOf(c);
  await page.evaluate(([text, lbl, color]) => window.__cap?.(text, lbl, color), [c.say, c.title, `rgb(${PALETTE[i].join(",")})`]).catch(() => {});
};
const hold = (ms) => page.waitForTimeout(ms);
/* A TAB THAT IS NOT THERE IS A CHAPTER OF NOTHING. The Solana recorder clicked blind;
   this one refuses, because a silently-missed click records a page nobody asked for and
   nobody notices until the video is watched. */
const clickTab = async (dest) => {
  const found = await page.evaluate((d) => {
    const el = document.querySelector(`.dtab[data-destination="${d}"]`);
    if (!el) return false;
    el.click(); return true;
  }, dest);
  if (!found) throw new Error(`the floor page has no tab "${dest}" — the site changed; fix the chapter list`);
};

/* ── CAMERA WORK, THROUGH THE PAGE'S OWN CONTROLS ─────────────────────────────
 * The first take opened on tower.html at its default framing and the building came out
 * a speck in a purple void, cropped off the bottom — a guide to a fifty-floor tower in
 * which you cannot see the tower. Both fixes drive the real UI rather than poking the
 * scene graph: the page's wheel handler owns the zoom (camWorldWidth, clamped 16..150,
 * default 78) and its pointer handlers own the orbit, so the recording can never
 * desync from what a visitor's own mouse would do. Reaching past them into
 * __tower.camera would also have been undone on the next frame: placeCamera() runs
 * every frame from module-scoped state. */
const stage = "#stage, canvas";
const wheelBy = async (deltaY, steps = 8) => {
  const box = await page.locator(stage).first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, deltaY / steps);
    await page.waitForTimeout(40);
  }
};
const orbitBy = async (dx, ms = 2200) => {
  const box = await page.locator(stage).first().boundingBox();
  const cy = box.y + box.height * 0.55;
  const from = box.x + box.width * 0.45;
  await page.mouse.move(from, cy);
  await page.mouse.down();
  const steps = Math.max(12, Math.round(ms / 45));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from + (dx * i) / steps, cy, { steps: 1 });
    await page.waitForTimeout(ms / steps);
  }
  await page.mouse.up();
};

await page.goto(`${SITE}/tower.html`, { waitUntil: "load", timeout: 120000 });
await hold(3000);
/* WIDE, THEN IN. The line over the opening shot is "fifty floors", so the opening shot
   has to contain fifty floors: the first cut pushed straight to about 34 world units and
   said it over a close-up of the penthouse. Establish the whole building (78 -> ~53),
   then push in on the second chapter, which is where the detail belongs. */
await wheelBy(-420);
await hold(700);

await chapter("hook");        await orbitBy(200, 3000);
                              await hold(Math.max(600, holdFor("hook", 6500) - 3000));
await chapter("tower");       await wheelBy(-340, 10);
                              await orbitBy(-240, 3200);
                              await hold(Math.max(600, holdFor("tower", 9500) - 3600));
await chapter("directory");   await hold(holdFor("directory", 8000));
await chapter("lease");
await page.evaluate((n) => { try { select(n, true); } catch {} }, VACANT);
await hold(holdFor("lease", 8000));

await chapter("enter");       await hold(holdFor("enter", 4000));
await page.goto(`${SITE}/floor.html?floor=50`, { waitUntil: "load", timeout: 120000 });
await hold(9000);

/* THE OFFICE IS THE BEST SHOT ON THE SITE and the first take walked straight past it
   into the tabs. Close the rail, let the room and its named agents carry the chapter. */
await chapter("desk");
await page.evaluate(() => { try { closeRail(); } catch {} });
await hold(holdFor("desk", 15000));

await chapter("overview");    await clickTab("overview"); await hold(4500);
await page.evaluate(() => document.querySelector(".bot-book")?.scrollIntoView({ block: "center", behavior: "smooth" }));
await hold(Math.max(1000, holdFor("overview", 11000) - 4500));
await chapter("calls");       await clickTab("calls");    await hold(holdFor("calls", 9000));
await chapter("team");        await clickTab("team");     await hold(3000);
await page.evaluate(() => (document.querySelector("[data-runner-option]") || document.querySelector("#teamcontrolpanel"))?.scrollIntoView({ block: "start", behavior: "smooth" }));
await hold(Math.max(1000, holdFor("team", 12000) - 3000));
await chapter("wallste");     await clickTab("wallste");  await hold(holdFor("wallste", 18000));
await chapter("custody");     await hold(holdFor("custody", 12000));
await chapter("board");
await page.evaluate(() => { try { closeRail(); } catch {} });
await hold(holdFor("board", 7000));
await chapter("end");         await hold(holdFor("end", 4500));
/* TAIL PADDING, BECAUSE THE ENCODER LOSES THE LAST FEW SECONDS. Playwright finalises the
   video when the context closes, and the first take of this cut ran 197.4s by the wall
   clock and 191.2s in the file — the closing chapter's marker was never written, and the
   readback below correctly refused to place it. The caption is cleared and the page then
   sits for six seconds doing nothing, so what the encoder drops is padding rather than
   the last thing the film says. */
await page.evaluate(() => window.__cap?.("", "", "transparent"));
await hold(6000);
const video = page.video();
await ctx.close();
const webm = await video.path();
await browser.close();
const duration = Math.round((Date.now() - t0) / 100) / 10;

/* 3 · THE CLOCK IS THE VIDEO'S OWN. A headless renderer drops frames, so the wall-clock
   second a chapter began drifts against where it appears in the file — two seconds by
   the end of a ninety-second take. Each chapter painted its colour into the top-right
   marker; read it back at ten samples a second and take the first three-sample hold. */
const PAL = PALETTE.slice(0, marks.length);
const raw = execFileSync(FFMPEG, ["-loglevel", "error", "-i", webm, "-vf", "crop=4:4:1275:1,scale=1:1", "-r", "10",
  "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 26 });
const nearest = (r, g, b) => {
  let best = -1, d = Infinity;
  PAL.forEach((c, i) => { const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (dd < d) { d = dd; best = i; } });
  return d < 90 * 90 ? best : -1;
};
const seq = []; for (let i = 0; i + 2 < raw.length; i += 3) seq.push(nearest(raw[i], raw[i + 1], raw[i + 2]));
/* MONOTONIC, BECAUSE CHAPTERS ARE. Searching the whole film for each colour from zero
   put the last chapter at 0.0s: a Playwright recording opens on about a second of blank
   WHITE page before the first paint, and the thirteenth marker is white. Any colour can
   collide with something that happens before its chapter — the browser's own loading
   frames, a flash of a light theme — and no palette fixes that in general. Chapter k+1
   cannot begin before chapter k, so each search starts where the last one ended, and a
   collision earlier in the film is simply never looked at. */
let from = 0;
marks.forEach((m, k) => {
  for (let i = from; i + 2 < seq.length; i++)
    if (seq[i] === k && seq[i + 1] === k && seq[i + 2] === k) { m.at = i / 10; from = i + 1; return; }
  console.warn(`chapter ${m.id}: marker not found after ${(from / 10).toFixed(1)}s; keeping the wall-clock second ${m.at}`);
});
/* A chapter map that is not increasing would put narration under the wrong screen, which
   is the whole failure this readback exists to prevent. Refuse rather than ship it. */
for (let i = 1; i < marks.length; i++)
  if (!(marks[i].at > marks[i - 1].at))
    throw new Error(`chapter clock is not monotonic: ${marks[i - 1].id}@${marks[i - 1].at}s then ${marks[i].id}@${marks[i].at}s`);

/* 4 · THE MIX: each line laid at its chapter's second, then muxed with the picture. */
const inputs = [];
const filters = [];
marks.forEach((m, i) => {
  inputs.push("-i", path.join(WORK, "voice", `${m.id}.wav`));
  filters.push(`[${i + 1}:a]adelay=${Math.round(m.at * 1000)}|${Math.round(m.at * 1000)}[a${i}]`);
});
/* amix scales every input by 1/N and the lines never overlap, so volume=N restores them
   — on every ffmpeg, including ones without amix's normalize option. */
const mixed = marks.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${marks.length}:dropout_transition=0,volume=${marks.length}[voice]`;
fs.mkdirSync(path.join(ROOT, "token"), { recursive: true });
const mp4 = path.join(ROOT, "token", "guide-walkthrough.mp4");
execFileSync(FFMPEG, ["-y", "-i", webm, ...inputs,
  "-filter_complex", filters.join(";") + ";" + mixed,
  "-map", "0:v:0", "-map", "[voice]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "96k", "-shortest", mp4], { stdio: "inherit" });
/* And the same recording as VP9/Opus, for Chromium builds that ship without H.264. */
const webmOut = path.join(ROOT, "token", "guide-walkthrough.webm");
execFileSync(FFMPEG, ["-y", "-i", webm, ...inputs,
  "-filter_complex", filters.join(";") + ";" + mixed,
  "-map", "0:v:0", "-map", "[voice]",
  "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
  "-c:a", "libopus", "-b:a", "64k", "-shortest", webmOut], { stdio: "inherit" });
fs.writeFileSync(path.join(ROOT, "token", "guide-chapters.json"),
  JSON.stringify({ site: SITE, recordedAt: new Date().toISOString(), duration, chapters: marks }, null, 2) + "\n");
console.log(`guide: ${mp4} (${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB, ~${duration}s)`);
console.log(marks.map((m) => `${m.at}s ${m.id}`).join(" | "));
