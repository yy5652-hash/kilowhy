// One JSON-returning LLM step: call the provider, pull the last JSON object out of the reply (reasoning may leak into content),
// validate its shape, and on an unparsable or wrong-shaped reply retry once with a stricter instruction. Every call is recorded with its route
// (routed model, label, latency, race width, receipt id). A transport error is recorded and returned, never thrown: the agent degrades instead.
import { extractJson } from "./provider_text.ts";
import type { ChatMessage, ChatRequest, ChatResult, Mode } from "./provider_shared.ts";
import type { LlmCall } from "./agent_types.ts";

export type ChatFn = (req: ChatRequest) => Promise<ChatResult>;
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
/** How to ask the model not to think out loud: an extra system line and/or extra request body fields (decided by scripts/reasoning_probe.ts, see docs/latency.md). */
export interface ReasoningControl { systemLine?: string; extra?: Record<string, unknown> }
export interface LlmEnv { chat: ChatFn; calls: LlmCall[]; reasoning?: ReasoningControl; onCall?: (call: LlmCall) => void }
export interface CallOpts { maxTokens?: number; deadlineMs?: number; hedgeAfterMs?: number; retryTransient?: boolean; direct?: string }   // retryTransient: one more try after a quick 429 / 5xx / network failure (never after a timeout)
export interface JsonStep<T> { value: T | null; error?: string; rawText?: string }

const STRICTER = (why: string) =>
  `Your previous reply could not be used: ${why}. Reply again with ONE valid JSON object that follows the schema exactly. No prose before or after it, no markdown fences, no comments, no trailing commas, and double quotes on every key and string.`;

/** Applies the reasoning control: the extra system line goes at the end of the first system message. */
export function withReasoning(messages: ChatMessage[], rc?: ReasoningControl): ChatMessage[] {
  if (!rc?.systemLine) return messages;
  return messages.map((m, i) => (i === 0 && m.role === "system" ? { ...m, content: `${m.content}\n${rc.systemLine}` } : m));
}

/** KILOWHY_PATIENCE=N (default 1) gives Nightshift N times longer before the hedge and the deadline of every step, so a run can be served by Nightshift alone while it is slow (used to record the demo film). */
export const PATIENCE = Math.max(1, Number(process.env.KILOWHY_PATIENCE) || 1);

const TRANSIENT = /HTTP 429|HTTP 5\d\d|network error|Too Many Requests/i;
const QUICK_FAILURE_MS = 20_000;
const TRANSIENT_PAUSE_MS = 1_500;

export async function askJson<T>(env: LlmEnv, step: string, mode: Mode, messages: ChatMessage[], check: (v: unknown) => Checked<T>, opts: CallOpts = {}): Promise<JsonStep<T>> {
  let msgs = messages;
  let lastError = "";
  let lastText = "";
  let retriedTransient = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const label = retriedTransient && attempt === 0 ? `${step} (retry after ${"a transient error"})` : attempt === 0 ? step : `${step} (stricter retry)`;
    let res: ChatResult;
    const t0 = performance.now();
    const record = (c: LlmCall) => { const call = { ...c, wallMs: Math.round(performance.now() - t0) }; env.calls.push(call); env.onCall?.(call); };
    try {
      res = await env.chat({ mode, messages: withReasoning(msgs, env.reasoning), ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}), ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs * PATIENCE } : {}), ...(opts.hedgeAfterMs ? { hedgeAfterMs: opts.hedgeAfterMs * PATIENCE } : {}), ...(opts.direct ? { direct: opts.direct } : {}), ...(env.reasoning?.extra ? { extra: env.reasoning.extra } : {}) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      record({ step: label, error });
      if (opts.retryTransient && !retriedTransient && TRANSIENT.test(error) && !/timeout/i.test(error) && performance.now() - t0 < QUICK_FAILURE_MS) {
        retriedTransient = true; attempt--;                  // does not count as a stricter retry
        await new Promise((r) => setTimeout(r, TRANSIENT_PAUSE_MS));
        continue;
      }
      return { value: null, error: `${label}: ${error}` };
    }
    lastText = res.content;
    const json = extractJson(res.content);
    let rejected: string | undefined;
    if (json === null) lastError = "it contained no JSON object";
    else {
      const c = check(json);
      if (c.ok) { record({ step: label, route: res.route }); return { value: c.value, rawText: res.content }; }
      lastError = c.error;
    }
    const flat = res.content.replace(/\s+/g, " ");
    rejected = `${lastError}; ${res.route.usage.outputTokens ?? "?"} output tokens; starts "${flat.slice(0, 80)}" ends "${flat.slice(-80)}"`;
    record({ step: label, route: res.route, rejected });
    msgs = [...messages, { role: "assistant", content: res.content.slice(0, 2000) }, { role: "user", content: STRICTER(lastError) }];
  }
  return { value: null, error: `${step}: ${lastError}`, rawText: lastText };
}

/** Corrective turn for the narrative: the error list (placeholder problems and verifier findings) is fed back verbatim. */
export const correctiveMessage = (errors: string[]): string =>
  `Your answer was rejected for these reasons:\n${errors.map((e) => `- ${e}`).join("\n")}\nFix every item and reply again with the complete corrected JSON object (same schema). Never write digits: use the {F#} placeholder of the fact for every figure, date and time, and only cite facts of hypotheses marked supported in "sentences".`;
