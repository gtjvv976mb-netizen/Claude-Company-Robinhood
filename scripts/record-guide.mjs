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
  /* TOWER */
  { id: "hook",       title: "Fifty floors",      say: "Fifty floors. Sixteen analysts on every one of them. And a bot that trades what they publish \u2014 on Robinhood Chain, with your key, on your machine." },
  { id: "tower",      title: "The tower",         say: "This is Claude Tower. Every floor is one automated research desk, working the same chain, around the clock. The house desk runs upstairs on floor fifty, and everything it finds is published in the open." },
  { id: "directory",  title: "The directory",     say: "The directory. Forty nine floors are yours to take; floor fifty is the house. Every floor shows its own record \u2014 nothing hidden behind a login, nothing back-dated." },
  { id: "lease",      title: "Lease a floor",     say: "Pick a vacant floor and here is what it costs. One floor per wallet. And beside it, the house bot's real record, kept with the house's own money." },
  { id: "enter",      title: "Walk in",           say: "Let's walk into headquarters. No sign-in, no pass, no waiting list." },
  /* THE FLOOR, SEAT BY SEAT — the camera is on each agent as they are introduced */
  { id: "desk",       title: "The desk",          say: "This is the floor. Sixteen agents. Each has one job and one question to answer, and they work in order \u2014 cheap code narrows the field, and the expensive minds only reason about what survived." },
  { id: "scout",      title: "The scout",         say: "Austin Powerz is the scout. He sweeps the field: every new launch on the chain, today, and what deserves attention right now." },
  { id: "screener",   title: "The screen",        say: "Maxwell Smort runs the screen. It costs nothing and it kills most of them \u2014 no volume, no participants, too small, too big, a market that looks washed." },
  { id: "forensics",  title: "Forensics",         say: "Sterling Archor reads the contract. Loudly. Can this token be used against the holder \u2014 a pause switch, a blocklist, a proxy somebody else controls? He executes a real transfer in simulation and measures what actually arrives." },
  { id: "liquidity",  title: "Liquidity",         say: "Ethan Hunted asks the only question that matters: can I get back out? He simulates the sell before anyone is allowed to buy. An unproven exit is a trap until proven otherwise." },
  { id: "flow",       title: "Flow",              say: "Sam Fishy watches the real traffic, in the dark. Is the demand real, or manufactured?" },
  { id: "narrative",  title: "Narrative",         say: "Black Widower gets the truth out of the story. Is there one, is it true, and are we early?" },
  { id: "redteam",    title: "The red team",      say: "Then Agent Forty Eight. The red team. Paid to argue that the whole idea loses money \u2014 and if he wins the argument, there is no trade." },
  { id: "risk",       title: "Risk",              say: "Mini-Meh makes your size smaller. The stop, the target and the position are derived from the numbers, never guessed." },
  { id: "ceo",        title: "The sign-off",      say: "And Big C signs off. Or doesn't. Nothing is published without the boss." },
  { id: "team",       title: "Your team",         say: "The Team tab is the roster. On a floor you lease, this is also where you choose who runs your bot \u2014 one command on your own machine, and a key that never leaves it." },
  /* THE CALLS */
  { id: "candidates", title: "Candidates",        say: "Now the calls. Start with candidates: five ranked slots in every market-cap tier, captured after the free screen and before any decision. Not reviewed, not approved, not executable \u2014 and the page says so." },
  { id: "published",  title: "Published",         say: "Published is what survived the whole floor. An entry, a stop and a target, timestamped the moment it was made, and never edited after. These are the calls your bot takes." },
  { id: "book",       title: "The book",          say: "The Overview is the desk's own book. What the bot is holding, drawn from its stop to its target, with a dot where the coin stands now." },
  /* THE RECORD */
  { id: "tape",       title: "The tape",          say: "Activity. The tape is every event as it happened \u2014 names in, the shortlist, the workups \u2014 each one timestamped." },
  { id: "decisions",  title: "Decisions",         say: "Decisions is the why. When a call was withheld, the reason is written down, in plain words, next to the coin." },
  { id: "performance",title: "Performance",       say: "Performance is the building's record. Floors leased, calls published, closed above entry, closed below. Settled results \u2014 not a projection." },
  /* THE BOT */
  { id: "wallste",    title: "WALL-ST-E",         say: "And this is Wall Street E. The bot. Here is the thing this chain does differently: gas is flat. Six hundred and sixty one thousand units a round trip, whatever you trade. So the size of the position, not the price of the coin, decides whether a trade can pay for itself. The measured cheapest clip is eleven point two thousandths of an E T H, and that is the default." },
  { id: "custody",    title: "Your key",          say: "The desk never holds a key. Its own bot panel is owner-only \u2014 the site cannot reach your wallet, cannot move your money, and never sees your private key. That key is made on your machine and stays there. The site publishes research. You trade, or you don't." },
  { id: "board",      title: "The board",         say: "And on the wall, the board keeps the live book, redrawn every ten seconds." },
  { id: "end",        title: "Plug in",           say: "Lease a floor. Plug in. Let it work." },
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
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
  recordVideo: { dir: WORK, size: { width: 1920, height: 1080 } } });
await ctx.addInitScript(() => {
  const install = () => {
    if (document.getElementById("cc-guide-cap")) return;
    const bar = document.createElement("div"); bar.id = "cc-guide-cap";
    bar.style.cssText = "position:fixed;left:50%;bottom:40px;transform:translateX(-50%);max-width:1400px;padding:18px 28px;" +
      "background:rgba(10,12,16,.86);color:#f4f1e8;font:600 29px/1.35 Archivo,Helvetica,Arial,sans-serif;border-radius:16px;" +
      "z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.45);text-align:center;pointer-events:none;opacity:0;transition:opacity .35s";
    document.body.appendChild(bar);
    const step = document.createElement("div"); step.id = "cc-guide-step";
    step.style.cssText = "position:fixed;left:26px;top:20px;padding:9px 15px;background:rgba(217,119,87,.92);color:#2a1a14;" +
      "font:700 18px/1 Archivo,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;border-radius:6px;z-index:2147483647;pointer-events:none;opacity:0";
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
/* One colour per chapter, from the {0,128,255}^3 lattice: 27 points, every pair at
   least 128 apart, so nearest()'s 90-unit acceptance can never confuse two. Black is
   left out because the page's own chrome at the marker's corner reads (7,8,12). */
const PALETTE = [];
for (const r of [255, 0, 128]) for (const g of [255, 0, 128]) for (const b of [255, 0, 128])
  if ((r || g || b) && !(r === 255 && g === 255 && b === 255)) PALETTE.push([r, g, b]);
/* WHITE GOES LAST. The take opens on about two seconds of blank white before the first
   paint, and the readback is monotonic from zero — so whichever chapter owns white
   would be "found" in the blank and its narration laid over nothing. Measured: with
   white at index 0 the hook read 0.0s while its real marker was at 18s. */
PALETTE.push([255, 255, 255]);
if (PALETTE.length < CHAPTERS.length) throw new Error("every chapter needs its own marker colour");
const t0 = Date.now();
const marks = [];
const chapter = async (id) => {
  const c = CHAPTERS.find((x) => x.id === id);
  marks.push({ id: c.id, title: c.title, say: c.say, at: Math.round((Date.now() - t0) / 100) / 10 });
  const i = CHAPTERS.indexOf(c);
  await page.evaluate(([text, lbl, color]) => window.__cap?.(text, lbl, color), [c.say, c.title, `rgb(${PALETTE[i].join(",")})`]).catch(() => {});
};
/* Re-pin a chapter's caption and marker after a navigation, without logging a new
   chapter: the clock keeps running from the original mark. */
const recap = (id) => {
  const c = CHAPTERS.find((x) => x.id === id), i = CHAPTERS.indexOf(c);
  return page.evaluate(([text, lbl, color]) => window.__cap?.(text, lbl, color), [c.say, c.title, `rgb(${PALETTE[i].join(",")})`]).catch(() => {});
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
 * On tower.html the wheel handler owns the zoom and the pointer handlers own the orbit,
 * so the shot can never desync from what a visitor's own mouse would do. On the floor
 * the page exposes its own camera handles: __figure(seat, yaw, width) frames one named
 * agent, __follow(seat) tracks one, __resetView() returns to the room. THE CAMERA IS ON
 * WHOEVER THE VOICE IS TALKING ABOUT. A seat that does not exist is a hard failure, for
 * the same reason a missing tab is: it would record a chapter of the wrong thing. */
const stage = "#stage, canvas";
const wheelBy = async (deltaY, steps = 4) => {
  const box = await page.locator(stage).first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, deltaY / steps);
    await page.waitForTimeout(40);
  }
};
/* dy is a vertical drag: the page reads it as "look higher or lower on the tower"
   (camGoal moves 0.09 world units per pixel) without touching the rail's selection. */
const orbitBy = async (dx, ms = 2200, dy = 0) => {
  const box = await page.locator(stage).first().boundingBox();
  const cy = box.y + box.height * 0.55;
  const from = box.x + box.width * 0.45;
  /* ONE MOVE, INTERPOLATED BY PLAYWRIGHT. Sixty awaited single-step moves each waited
     for a 1080p WebGL frame to come back through the relay, and the two orbit chapters
     ran 62s and 97s against ~8s of narration — measured off the marker track. A single
     move with `steps` emits the same intermediate pointermoves without a round trip
     between each, and the page's own drag handler does the smoothing. */
  await page.mouse.move(from, cy);
  await page.mouse.down();
  await page.mouse.move(from + dx, cy + dy, { steps: 24 });
  await page.mouse.up();
  await page.waitForTimeout(Math.min(ms, 1500));
};
/* WIDTH 12, NOT 6.5. The name tags are sprites scaled for the room-wide view; at 6.5
   world units a tag fills the frame, the agent is mostly out of it, and the neighbour's
   tag intrudes — measured on the Forensics frame. At 12 the agent, the desk and the tag
   all fit, with enough room to tell which corner of the floor you are in. */
const frame = async (seat, width = 12) => {
  const r = await page.evaluate(([s, w]) => window.__figure?.(s, Math.PI / 4, w) ?? "no __figure", [seat, width]);
  if (!/framed$/.test(String(r))) throw new Error(`cannot frame "${seat}": ${r}`);
};
const resetView = () => page.evaluate(() => { try { window.__resetView?.(); } catch {} });
const subview = (group, view) => page.evaluate(([g, v]) => window.__activateDashboardSubview?.(g, v), [group, view]);
const closeRail = () => page.evaluate(() => { try { closeRail(); } catch {} });
/* A seat chapter: cut to the agent, then hold for the line. */
const seatChapter = async (id, seat, width) => { await chapter(id); await frame(seat, width); await hold(holdFor(id, 7000)); };

/* ── THE TOWER ──────────────────────────────────────────────────────────────── */
/* WAIT FOR THE TOWER, NOT FOR "load". The load event waits on every subresource, and on
   take 9 one of them held it for twenty seconds while the tower had been on screen since
   the third — twenty silent seconds at the top of the film. The canvas is the thing the
   opening line is about, so that is what the opening waits for. */
await page.goto(`${SITE}/tower.html`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector("canvas", { timeout: 120000 });
await hold(3000);
/* WIDE FIRST. The opening line is "fifty floors", so the opening shot holds all fifty.
   The page opens focused on the penthouse (it selects the house floor on load, and the
   look-at eases up to it), so at any width the frame holds the top of the tower and
   drops the base: take 8 opened on eight floors while the voice said fifty. +500 on the
   wheel is 108 units, and a 330-pixel upward drag brings the look-at down to mid-tower
   without changing the rail's selection — the whole tower, plaza to roof, HQ still in
   the directory card. Measured on a 1080p probe. */
await wheelBy(500, 6);
await orbitBy(0, 1600, -330);
await hold(600);
await chapter("hook");        await orbitBy(200, 3000);
                              await hold(Math.max(600, holdFor("hook", 6500) - 3000));
/* "The house desk runs upstairs on floor fifty": push in and rise to the penthouse.
   select(50) eases the look-at up to it exactly as a visitor's click on that floor would,
   and the rail follows to the house desk's own entry. */
await chapter("tower");       await page.evaluate(() => { try { select(50, true); } catch {} });
                              await wheelBy(-900, 12);
                              await orbitBy(-240, 3200);
                              await hold(Math.max(600, holdFor("tower", 9500) - 3600));
await chapter("directory");
/* The directory is the right-hand rail; walk it down a little so the eye follows the
   words "forty nine floors". Best-effort: the rail's own scroller, if it has one. */
await page.evaluate(() => {
  const els = [...document.querySelectorAll("aside, nav, div")].filter((e) => e.scrollHeight > e.clientHeight + 40 && e.getBoundingClientRect().left > innerWidth * 0.6);
  els[0]?.scrollBy({ top: 320, behavior: "smooth" });
});
await hold(holdFor("directory", 8500));
await chapter("lease");
await page.evaluate((n) => { try { select(n, true); } catch {} }, VACANT);
await hold(holdFor("lease", 8500));
await chapter("enter");       await hold(1500);

/* ── THE FLOOR ──────────────────────────────────────────────────────────────── */
/* THE WALK-IN HAPPENS UNDER THE LINE. Take 8 said "let's walk in" over a still tower,
   then sat on it for fifteen silent seconds while the floor loaded. Navigate while the
   line is still playing and re-pin the same caption on the new page, so the words stay
   up through the load and the desk chapter opens on a room that is already lit. */
await page.goto(`${SITE}/floor.html?floor=50`, { waitUntil: "load", timeout: 120000 });
await recap("enter");
await hold(Math.max(6000, holdFor("enter", 4000) - 1500));
await chapter("desk");        await closeRail(); await resetView(); await hold(holdFor("desk", 11000));
await seatChapter("scout",     "Scout");
await seatChapter("screener",  "Screener");
await seatChapter("forensics", "Forensics");
await seatChapter("liquidity", "Liquidity");
await seatChapter("flow",      "Flow");
await seatChapter("narrative", "Narrative");
await seatChapter("redteam",   "Red Team");
await seatChapter("risk",      "Risk");
await seatChapter("ceo",       "CEO", 13);
await chapter("team");        await resetView(); await clickTab("team"); await hold(2500);
await page.evaluate(() => document.querySelector(".teamstrip")?.scrollIntoView({ block: "start", behavior: "smooth" }));
await hold(Math.max(1000, holdFor("team", 11000) - 2500));

/* ── THE CALLS ──────────────────────────────────────────────────────────────── */
await chapter("candidates");  await clickTab("calls"); await subview("calls", "candidates"); await hold(holdFor("candidates", 11000));
await chapter("published");   await subview("calls", "published"); await hold(holdFor("published", 10000));
await chapter("book");        await clickTab("overview"); await hold(3500);
await page.evaluate(() => document.querySelector(".bot-book")?.scrollIntoView({ block: "center", behavior: "smooth" }));
await hold(Math.max(1000, holdFor("book", 9000) - 3500));

/* ── THE RECORD ─────────────────────────────────────────────────────────────── */
await chapter("tape");        await clickTab("activity"); await subview("activity", "tape"); await hold(holdFor("tape", 9000));
await chapter("decisions");   await subview("activity", "decisions"); await hold(holdFor("decisions", 8500));
await chapter("performance"); await clickTab("performance"); await subview("performance", "building"); await hold(holdFor("performance", 9500));

/* ── THE BOT ────────────────────────────────────────────────────────────────── */
await chapter("wallste");
await closeRail();
/* WALL-ST-E roams the floor; follow him if he is built, and if there is no bot figure
   (no heartbeat on this floor) fall back to the room rather than a black frame. */
const followed = await page.evaluate(() => String(window.__follow?.("__bot") ?? ""));
if (!/^following/.test(followed)) { await resetView(); console.warn(`bot figure not followed (${followed}); showing the room`); }
await hold(holdFor("wallste", 18000));
await chapter("custody");     await clickTab("wallste"); await hold(holdFor("custody", 12000));
await chapter("board");       await closeRail(); await resetView(); await hold(holdFor("board", 7000));
await chapter("end");         await hold(holdFor("end", 4500));
/* Tail padding: the encoder drops the last seconds on close, so they are padding. */
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
const raw = execFileSync(FFMPEG, ["-loglevel", "error", "-i", webm, "-vf", "crop=4:4:1915:1,scale=1:1", "-r", "10",
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

/* THE FILM OPENS A BREATH BEFORE THE FIRST LINE, HOWEVER LONG THE PAGE TOOK. The head of
   the take is whatever the browser needed to bring the tower up, which varies by take
   (9.8s, then 27.8s) and is nobody's business: trim it to 1.5s before the hook and shift
   every chapter by the same amount, so the mix and the chapters file stay in lockstep. */
const lead = Math.max(0, Math.round((marks[0].at - 1.5) * 10) / 10);
marks.forEach((m) => { m.at = Math.round((m.at - lead) * 10) / 10; });
const trimmed = Math.round((duration - lead) * 10) / 10;

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
execFileSync(FFMPEG, ["-y", "-ss", String(lead), "-i", webm, ...inputs,
  "-filter_complex", filters.join(";") + ";" + mixed,
  "-map", "0:v:0", "-map", "[voice]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  "-c:a", "aac", "-b:a", "96k", "-shortest", mp4], { stdio: "inherit" });
/* And the same recording as VP9/Opus, for Chromium builds that ship without H.264. */
const webmOut = path.join(ROOT, "token", "guide-walkthrough.webm");
execFileSync(FFMPEG, ["-y", "-ss", String(lead), "-i", webm, ...inputs,
  "-filter_complex", filters.join(";") + ";" + mixed,
  "-map", "0:v:0", "-map", "[voice]",
  "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4",
  "-c:a", "libopus", "-b:a", "64k", "-shortest", webmOut], { stdio: "inherit" });
fs.writeFileSync(path.join(ROOT, "token", "guide-chapters.json"),
  JSON.stringify({ site: SITE, recordedAt: new Date().toISOString(), duration: trimmed, chapters: marks }, null, 2) + "\n");
console.log(`guide: ${mp4} (${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB, ~${trimmed}s, ${lead}s trimmed from the head)`);
console.log(marks.map((m) => `${m.at}s ${m.id}`).join(" | "));
