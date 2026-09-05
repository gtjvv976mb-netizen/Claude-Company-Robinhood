/**
 * THE DESK'S TECHNIQUE, AS DATA.
 *
 * Every seat's instructions used to be a constant in a source file, which meant the
 * desk could measure itself precisely and change nothing about itself without a human
 * writing a patch. The evidence existed — decision_runs, forward_marks, scorecards —
 * and nothing read it back into the way the seats actually work.
 *
 * This is that missing half. A seat's standing guidance lives here, in the database,
 * and is appended to its system prompt on the next workup. Codex writes it. No deploy,
 * no merge, no permission (the owner's explicit instruction, 2026-09-03): the coach is
 * allowed to change the technique of the team he is coaching.
 *
 * AUTONOMY IS NOT ABSENCE OF LIMITS. Three things keep an autonomous coach honest, and
 * none of them is an approval queue:
 *
 *   1. INVARIANTS he cannot cross at all. They are about custody, money and the
 *      deterministic safety gates — never about opinion. A coach may rewrite how the
 *      Forensics seat reasons; he may not raise a size cap or retire the Red Team.
 *   2. VERSIONING. Every change records the evidence that motivated it, so a change is
 *      always answerable to the numbers that produced it.
 *   3. AUTO-ROLLBACK. A version whose cohort underperforms its predecessor on settled
 *      evidence reverts itself. The desk cannot drift somewhere bad and stay there
 *      because nobody happened to look.
 *
 * Guidance is TEXT THE MODEL READS, so it is written from structured outcomes only —
 * scores, verdicts, marks, timings. Market and social prose never reaches this file.
 * A coin whose bio contained "ignore your risk seat" would otherwise be one hop from
 * the prompt of the seat that reads it.
 */
import db, { ensureColumn } from "./lib/store.js";
import { emit } from "./lib/bus.js";
import { sha256, canonicalJson } from "./canonical.js";

db.exec(`
CREATE TABLE IF NOT EXISTS desk_policy (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  seat         TEXT NOT NULL,
  guidance     TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  author       TEXT NOT NULL DEFAULT 'codex',
  version      TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  retired_at   INTEGER,
  retired_why  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desk_policy_seat ON desk_policy(seat, active, id DESC);

CREATE TABLE IF NOT EXISTS policy_versions (
  version      TEXT PRIMARY KEY,
  parent       TEXT,
  created_at   INTEGER NOT NULL,
  note         TEXT,
  reverted_at  INTEGER,
  reverted_why TEXT
);
`);
ensureColumn("desk_policy", "retired_why", "TEXT");

/* WHAT A COACH MAY NEVER DO.
 *
 * Every one of these is either somebody's money or a deterministic safety gate.
 * They are matched against the guidance text itself, so a change that argues for
 * crossing one is refused before it can be read by a seat. This is deliberately
 * blunt: a coach with a good argument for raising a size cap should still lose,
 * because the argument is exactly what an injected string would supply.
 */
export const POLICY_INVARIANTS = [
  { id: "custody", test: /\b(private key|seed phrase|keypair|signer|sign the transaction|custody)\b/i,
    why: "the desk never holds a key; nothing in a seat's technique may reference custody" },
  { id: "caps", test: /\b(raise|increase|lift|remove|ignore|bypass)\b[^.]{0,40}\b(cap|limit|ceiling|max ?sol|daily loss)\b/i,
    why: "position, daily and loss caps belong to the operator, not to the coach" },
  /* The screen's gates in BOTH chains' vocabulary. The Solana names stay because a
     coach that has read the old scorecards may still use them; the EVM names are the
     gates this chain actually has — a note saying "ignore the proxy admin" or "relax
     the LP lock threshold" passed this matcher before 2026-09-05 and would have been
     installed automatically. */
  { id: "screen", test: /\b(skip|ignore|bypass|disable|relax|loosen|waive)\b[^.]{0,40}\b(screen|mint authority|freeze authority|mint role|pause|blacklist|proxy|upgrade key|proxy admin|timelock|lp lock|locker|position nft|pair ?token|sell ?sim|honeypot|rug check|scope guard|beacon|graduation|exempt list|insider (?:float|ceiling)|clone)\b/i,
    why: "the free screen's kill gates are facts, not opinions" },
  { id: "redteam", test: /\b(ignore|overrule|disable|retire|skip)\b[^.]{0,30}\b(red ?team|refutation|compliance)\b/i,
    why: "the adversary and the compliance check are structural, not tunable" },
  { id: "gate", test: /\b(lower|reduce|ignore|waive)\b[^.]{0,30}\b(sample gate|minimum sample|evidence bar|significance)\b/i,
    why: "a coach may not lower the bar that judges the coach" },
  /* The owner's line on this chain (executor/scope-guard.mjs): an equity may be a pair
     asset, never a position. A note steering a seat toward holding, buying or longing a
     stock token — however it is phrased — is refused before any seat reads it. */
  { id: "scope",
    /* "equity" alone is the desk's word for its own capital (cfg.equityUsd, book equity);
       only the security senses are refused (review, 2026-09-05). */
    test: /\b(buy|long|accumulate|own|hold)\b(?:\s+[A-Za-z$]+){0,4}?\s+(stock tokens?|equity tokens?|share tokens?|tokeni[sz]ed (?:stocks?|shares?|equit(?:y|ies))|robinhood tokens?|the equit(?:y|ies)\b(?!\s+(?:curve|at risk|usd|\$|budget|of the book)))|\b(stock tokens?|equity tokens?|share tokens?|robinhood tokens?)\b[^.]{0,40}\bas (?:a |the )?(?:position|long|directional)\b/i,
    why: "an equity may be a pair asset, never a position" },
];

/** Null when the guidance is safe to install; otherwise the invariant it broke. */
export function checkInvariants(guidance) {
  const text = String(guidance || "");
  for (const inv of POLICY_INVARIANTS) if (inv.test.test(text)) return inv;
  return null;
}

const nowVersion = () => `p-${new Date().toISOString().slice(0, 10)}-${sha256(String(Date.now())).slice(0, 6)}`;

/** The guidance a seat is working under right now, oldest first. */
export function policyFor(seat) {
  return db.prepare(`SELECT guidance FROM desk_policy
                     WHERE active=1 AND (seat=? OR seat='*') ORDER BY id`).all(seat)
    .map((r) => r.guidance);
}

/** The seat's system prompt, with its standing guidance appended. */
export function withPolicy(seat, system) {
  const notes = policyFor(seat);
  if (!notes.length) return system;
  /* Framed as the desk's own standing orders, and explicitly ranked BELOW the seat's
     charter: guidance sharpens how a seat reasons, it never redefines what it is for. */
  return `${system}\n\n=== STANDING ORDERS (from the desk's own results; they refine your judgement, they do not replace your charter) ===\n` +
    notes.map((n, i) => `${i + 1}. ${n}`).join("\n");
}

/** The generation currently in force. */
export function currentVersion() {
  const row = db.prepare(`SELECT version FROM policy_versions
                          WHERE reverted_at IS NULL ORDER BY created_at DESC LIMIT 1`).get();
  return row?.version ?? "p-genesis";
}

/**
 * Install a change. Autonomous by design — there is no approval argument — but every
 * change is versioned, attributed and reversible, and a change that crosses an
 * invariant is refused with the reason recorded rather than silently dropped.
 */
export function applyPolicy({ seat, guidance, rationale, evidence = {}, author = "codex",
  replaces = null, version = null } = {}) {
  const s = String(seat || "").trim();
  const g = String(guidance || "").trim();
  if (!s || !g) return { ok: false, error: "a policy change needs a seat and guidance" };
  if (g.length > 600) return { ok: false, error: "guidance must be one paragraph a seat can hold in mind" };
  /* THE COACH MAY NOT COACH HIMSELF. Standing orders are injected by seat name, so a
     note addressed to Codex would land in the prompt of the seat that writes notes —
     a loop that amplifies its own drift with nothing outside it to check the drift. */
  if (/^codex$/i.test(s) || s === "*") {
    emit("policy:refused", { seat: s, invariant: "self", why: "the coach may not write his own standing orders" });
    return { ok: false, error: "refused — the coach may not write his own standing orders", invariant: "self" };
  }
  const broke = checkInvariants(g);
  if (broke) {
    emit("policy:refused", { seat: s, invariant: broke.id, why: broke.why });
    return { ok: false, error: `refused — ${broke.why}`, invariant: broke.id };
  }
  const v = version || nowVersion();
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO policy_versions (version, parent, created_at, note)
                VALUES (?,?,?,?)`).run(v, currentVersion(), now, rationale ?? null);
    // A seat's guidance is a short standing list, not an archive: replacing is how a
    // coach corrects himself, and an unbounded list would eventually be the prompt.
    if (replaces) {
      db.prepare("UPDATE desk_policy SET active=0, retired_at=?, retired_why=? WHERE id=? AND active=1")
        .run(now, "replaced by a newer reading of the same evidence", replaces);
    }
    const info = db.prepare(`INSERT INTO desk_policy
      (seat, guidance, rationale, evidence, author, version, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(s, g, String(rationale || "").slice(0, 800), canonicalJson(evidence), author, v, now);
    trimSeat(s);
    db.exec("COMMIT");
    emit("policy:changed", { seat: s, version: v, guidance: g, rationale, author });
    return { ok: true, id: Number(info.lastInsertRowid), version: v };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

/** At most six standing notes per seat: the oldest retires when a seventh arrives. */
const MAX_NOTES_PER_SEAT = 6;
function trimSeat(seat) {
  const rows = db.prepare("SELECT id FROM desk_policy WHERE seat=? AND active=1 ORDER BY id DESC").all(seat);
  for (const r of rows.slice(MAX_NOTES_PER_SEAT)) {
    db.prepare("UPDATE desk_policy SET active=0, retired_at=?, retired_why=? WHERE id=?")
      .run(Date.now(), "aged out — a seat carries at most six standing orders", r.id);
  }
}

/** Retire one note (a coach correcting himself, or a rollback). */
export function retirePolicy(id, why = "retired") {
  const r = db.prepare("UPDATE desk_policy SET active=0, retired_at=?, retired_why=? WHERE id=? AND active=1")
    .run(Date.now(), String(why).slice(0, 300), id);
  return { ok: r.changes > 0 };
}

/**
 * REVERT A GENERATION. The safety net that makes autonomy survivable: if the cohort
 * decided under a version is measurably worse than its parent's, every note that
 * version installed goes inactive and the desk returns to the technique that was
 * working. Called by the tutor's own health check, and callable by hand.
 */
export function revertVersion(version, why = "cohort underperformed its parent") {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = db.prepare(`UPDATE desk_policy SET active=0, retired_at=?, retired_why=?
                          WHERE version=? AND active=1`).run(now, String(why).slice(0, 300), version);
    db.prepare("UPDATE policy_versions SET reverted_at=?, reverted_why=? WHERE version=?")
      .run(now, String(why).slice(0, 300), version);
    db.exec("COMMIT");
    emit("policy:reverted", { version, notes: n.changes, why });
    return { ok: true, retired: n.changes };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    return { ok: false, error: String(e.message || e) };
  }
}

/** Everything in force, for the floor's Codex tab and for the tutor's own context. */
export function activePolicy() {
  return db.prepare(`SELECT id, seat, guidance, rationale, author, version, created_at
                     FROM desk_policy WHERE active=1 ORDER BY seat, id`).all();
}

/** The record of what the coach has done, including what was retired and why. */
export function policyHistory(limit = 50) {
  return db.prepare(`SELECT id, seat, guidance, rationale, author, version, active,
                            created_at, retired_at, retired_why
                     FROM desk_policy ORDER BY id DESC LIMIT ?`).all(Math.min(200, limit));
}
