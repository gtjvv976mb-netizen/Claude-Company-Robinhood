/**
 * THE WORLD DIRECTOR — the server runs the office, the clients only watch it.
 *
 * The ambient life on a floor (errands, desk business, snack-room arguments,
 * throwaway chatter) used to be client-side dice: every visitor watched a
 * different office. Now one director rolls the dice here and broadcasts the
 * result, so two people looking at the same floor see the same person walk to
 * the same shredder saying the same line at the same moment — and because every
 * emit is chronicled, the office's whole day is on the record like everything
 * else.
 *
 * The events are semantic, not positional: the client owns coordinates, lines
 * and animation. The server only says WHO does WHAT and WHICH line — indexes
 * into tables the client already ships. That keeps this file free of any
 * knowledge of the room's geometry.
 */
import { emit } from "./lib/bus.js";

const SEATS = ["Scout", "Screener", "Forensics", "Liquidity", "Flow", "Technical",
  "Narrative", "Red Team", "Risk", "PM", "Execution", "Compliance", "Scribe", "Regime", "Review",
  "Codex"];

// Client-side table sizes, mirrored here so an index is never out of range.
// If a table grows on the client, grow the constant — an index too large is
// clamped there anyway, but the variety would silently shrink.
const ROUTINE_LINES = 3, TASK_LINES = 3, CHATTER_LINES = 8, SNACK_SCRIPTS = 8, VISIT_SCRIPTS = 10;

// Ambient life away from the desks: the fridge raid, the kitchenette, the sofa,
// the meeting table, the cooler, a long look out the window, and the coffee run.
// Solo or duo — the client owns where these places are and what gets said there.
const AMBIENT_KINDS = ["fridge", "cook", "sofa", "meeting", "cooler", "window", "coffee"];
/* THE PRINCIPALS. The three figures with their own rooms used to sit in them
   all day, which made the most interesting corners of the floor the deadest.
   Now they walk: the boss takes the morale round, Codex Banks inspects the
   work, and Grox consults one of them. Rolled here like every other world
   event so two viewers see the same round at the same moment. */
const PRINCIPAL_ROUNDS = ["morale", "inspect", "consult"];
const ROUND_LINES = 4;
// "coffee" is a duo, but an asymmetric one: A boils the kettle and carries a cup
// to B's desk, and B never leaves the seat. Same casting call, one walker.
const AMBIENT_DUO = new Set(["sofa", "meeting", "cooler", "coffee"]);
const AMBIENT_LINES = 4;

let timer = null;

export function startWorld() {
  if (timer) return;
  if (process.env.WORLD_ENABLED === "0") { console.log("[world] disabled"); return; }

  const rnd = Math.random;   // ambience needs no reproducibility, only agreement
  const tick = () => {
    const roll = rnd();
    if (roll < 0.26) {
      // one agent walks to another's desk and they actually talk — the office
      // interacting with itself, not fourteen soloists sharing a room
      const a = SEATS[(rnd() * SEATS.length) | 0];
      let b = SEATS[(rnd() * SEATS.length) | 0];
      if (b === a) b = SEATS[(SEATS.indexOf(a) + 3) % SEATS.length];
      emit("world:visit", { a, b, vi: (rnd() * VISIT_SCRIPTS) | 0 });
    } else if (roll < 0.40) {
      // a paper physically changes hands — the office trades documents, visibly
      const a = SEATS[(rnd() * SEATS.length) | 0];
      let b = SEATS[(rnd() * SEATS.length) | 0];
      if (b === a) b = SEATS[(SEATS.indexOf(a) + 5) % SEATS.length];
      emit("world:paper", { a, b, li: (rnd() * 4) | 0 });
    } else if (roll < 0.52) {
      // two agents take a break together and have the same argument everywhere
      const a = SEATS[(rnd() * SEATS.length) | 0];
      let b = SEATS[(rnd() * SEATS.length) | 0];
      if (b === a) b = SEATS[(SEATS.indexOf(a) + 1) % SEATS.length];
      emit("world:snack", { a, b, ti: (rnd() * SNACK_SCRIPTS) | 0 });
    } else if (roll < 0.70) {
      // somebody lives a little: the office is a place, not a spreadsheet
      const kind = AMBIENT_KINDS[(rnd() * AMBIENT_KINDS.length) | 0];
      const a = SEATS[(rnd() * SEATS.length) | 0];
      let b = null;
      if (AMBIENT_DUO.has(kind)) {
        b = SEATS[(rnd() * SEATS.length) | 0];
        if (b === a) b = SEATS[(SEATS.indexOf(a) + 2) % SEATS.length];
      }
      emit("world:ambient", { kind, a, b, li: (rnd() * AMBIENT_LINES) | 0 });
    } else if (roll < 0.86) {
      const round = PRINCIPAL_ROUNDS[(rnd() * PRINCIPAL_ROUNDS.length) | 0];
      const seat = SEATS[(rnd() * SEATS.length) | 0];
      emit("world:round", { round, seat, li: (rnd() * ROUND_LINES) | 0 });
    } else {
      const seat = SEATS[(rnd() * SEATS.length) | 0];
      const r2 = rnd();
      if (r2 < 0.35) emit("world:act", { seat, kind: "errand", li: (rnd() * ROUTINE_LINES) | 0 });
      else if (r2 < 0.75) emit("world:act", { seat, kind: "task", li: (rnd() * TASK_LINES) | 0 });
      else emit("world:act", { seat, kind: "chat", li: (rnd() * CHATTER_LINES) | 0 });
    }
    timer = setTimeout(tick, 4500 + rnd() * 5500);
  };
  timer = setTimeout(tick, 3000);
  console.log("[world] the server runs the office");
}
