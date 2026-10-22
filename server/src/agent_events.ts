// Progress events of an investigation, for a live UI: step started / finished (with milliseconds), evidence created, each LLM call with its route,
// each hypothesis result. `investigate(question, { onEvent })` calls the listener synchronously; a throwing listener never breaks the run.
import type { Evidence } from "./evidence.ts";
import type { LlmCall } from "./agent_types.ts";

export type StepName = "sites" | "intent" | "plan" | "data" | "hypotheses" | "recommend" | "extraSql" | "facts" | "narrative" | "template" | "memory";
export type ProgressEvent =
  | { type: "step"; step: StepName; status: "started" | "finished"; ms?: number }
  | { type: "evidence"; evidence: { id: string; hypothesisId: string; title: string; rowCount: number; zetarisRunId: string; sources: Evidence["sources"] } }
  | { type: "hypothesis"; id: string; name: string; status: string }
  | { type: "llm"; call: LlmCall }
  | { type: "memory"; action: "recall"; query: string; count: number; ids: string[]; route: string; ms: number }                // H-MEM recall at the start
  | { type: "memory"; action: "write"; written: { id: string; hypothesis: string }[]; skipped: number }                  // confirmed causes written after the answer
  | { type: "chunk"; id: number; kind: string; label: string; ms: number; llmCalls: number; inputTokens: number; outputTokens: number; carryoverTokens: number; route: string | null }   // one chunk of the Markovian chain finished (tokens estimated, chars/4)
  | { type: "reset"; reason: string }   // the speculative data work was for a different scope: clear evidence and hypotheses shown so far
  | { type: "done"; totalMs: number };

export type Emit = (e: ProgressEvent) => void;

/** Wraps a listener so that it can be called without checks and cannot throw into the caller. */
export function safeEmit(listener?: (e: ProgressEvent) => void): Emit {
  return (e) => { try { listener?.(e); } catch { /* a UI listener must never break the investigation */ } };
}

/** Runs `fn` between a "started" and a "finished" event; the elapsed milliseconds are added to `timings[step]`. */
export async function timed<T>(emit: Emit, timings: Record<string, number>, step: StepName, fn: () => Promise<T>): Promise<T> {
  const s = performance.now();
  emit({ type: "step", step, status: "started" });
  try { return await fn(); } finally {
    const ms = Math.round(performance.now() - s);
    timings[step] = (timings[step] ?? 0) + ms;
    emit({ type: "step", step, status: "finished", ms });
  }
}

export const evidenceEvent = (e: Evidence): ProgressEvent => ({ type: "evidence", evidence: { id: e.id, hypothesisId: e.hypothesisId, title: e.title, rowCount: e.rowCount, zetarisRunId: e.zetarisRunId, sources: e.sources } });
