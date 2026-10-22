// The compact JSON carryover of the Markovian investigation chain (scope, hypothesis table, evidence ids, readings, open questions) and the rules that keep it
// inside the engine's carryover budget. Pure. The engine accepts a state checkpoint only if it is within carryoverTokens (estimated chars/4); anything longer would be
// cut to "heuristic" or "truncation" and a cut JSON is useless, so fitState shrinks the state step by step until it fits.
import type { IntentType } from "./agent_types.ts";

export interface ChainState {
  v: 1;
  q: string;                                  // the question (shortened)
  type: IntentType;
  scope: string;                              // "S2 Crumb & Co Brixton" or "ALL"
  win: string;                                // both windows
  plan: string[];                             // hypothesis order from the plan chunk
  mem: string[];                              // M# facts available (remembered notes)
  hyp: Record<string, string>;                // hypothesis id -> s (supported) | r (ruled_out) | i (inconclusive)
  ev: Record<string, string[]>;               // hypothesis id -> evidence ids
  read: Record<string, string>;               // hypothesis id -> reading (plain words with {F#} placeholders), written by the interpret chunks
  done: string[];                             // chunks finished, e.g. ["plan", "interpret 1/3"]
  next: string;                               // what the next chunk does: "interpret 2", "narrative", "verify", "done"
  open: string[];                             // open questions
  att: number;                                // narrative drafts so far
  err: string[];                              // what the verifier rejected in the last draft (shortened)
}

export const STATUS_CODE: Record<string, string> = { supported: "s", ruled_out: "r", inconclusive: "i" };
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);   // the engine's own estimator (ceil(chars / 4)), always labelled "estimated"

/** Text that survives the engine's marker sanitiser unchanged: no `<`, `>`, `@`, square brackets, and no run of dashes. */
export const clean = (s: string): string => s.replace(/[<>@[\]]/g, " ").replace(/-{2,}/g, "-").replace(/\s+/g, " ").trim();
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}~`);

export function newState(init: Pick<ChainState, "q" | "type" | "scope" | "win" | "plan" | "mem" | "hyp" | "ev">): ChainState {
  return { v: 1, ...init, q: cut(clean(init.q), 120), scope: clean(init.scope), win: clean(init.win), read: {}, done: [], next: "plan", open: [], att: 0, err: [] };
}

export function serialize(s: ChainState): string { return JSON.stringify(s); }

export function parseState(text: string): ChainState | null {
  try {
    const o = JSON.parse(text) as ChainState;
    return o && o.v === 1 && typeof o.next === "string" && o.hyp && o.read ? o : null;
  } catch { return null; }
}

/**
 * The serialised state, shrunk until it fits `maxChars`: readings first (140, then 100, then 60 characters), then the evidence ids of hypotheses that are not supported,
 * then the error list, then the readings of ruled-out hypotheses, then the question. The structure (scope, hypothesis table, next step) is never cut.
 */
export function fitState(state: ChainState, maxChars: number): { text: string; state: ChainState; shrunk: string[] } {
  const s: ChainState = JSON.parse(JSON.stringify(state));
  const shrunk: string[] = [];
  const size = () => serialize(s).length;
  const steps: [string, () => void][] = [
    ["readings to 140 characters", () => { for (const k of Object.keys(s.read)) s.read[k] = cut(s.read[k], 140); }],
    ["readings to 100 characters", () => { for (const k of Object.keys(s.read)) s.read[k] = cut(s.read[k], 100); }],
    ["readings to 60 characters", () => { for (const k of Object.keys(s.read)) s.read[k] = cut(s.read[k], 60); }],
    ["evidence ids of hypotheses that are not supported dropped", () => { for (const k of Object.keys(s.ev)) if (s.hyp[k] !== "s") delete s.ev[k]; }],
    ["verifier errors shortened", () => { s.err = s.err.slice(0, 2).map((e) => cut(e, 80)); }],
    ["readings of ruled-out hypotheses dropped", () => { for (const k of Object.keys(s.read)) if (s.hyp[k] === "r") delete s.read[k]; }],
    ["question shortened", () => { s.q = cut(s.q, 40); }],
    ["done list shortened", () => { s.done = s.done.slice(-3); }],
  ];
  for (const [label, fn] of steps) {
    if (size() <= maxChars) break;
    fn(); shrunk.push(label);
  }
  return { text: serialize(s), state: s, shrunk };
}

/** The F# ids a reading cites. */
export const citedFacts = (reading: string): string[] => [...reading.matchAll(/\{(F\d+)(?::abs)?\}/g)].map((m) => m[1]);
