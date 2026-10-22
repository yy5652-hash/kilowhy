// One JSON-returning LLM step: call the provider, pull the last JSON object out of the reply (reasoning may leak into content),
// validate its shape, and on an unparsable or wrong-shaped reply retry once with a stricter instruction. Every call is recorded with its route
// (routed model, label, latency, race width, receipt id). A transport error is recorded and returned, never thrown: the agent degrades instead.
import { extractJson } from "./provider_text.ts";
import type { ChatMessage, ChatRequest, ChatResult, Mode } from "./provider_shared.ts";
import type { LlmCall } from "./agent_types.ts";

export type ChatFn = (req: ChatRequest) => Promise<ChatResult>;
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
export interface LlmEnv { chat: ChatFn; calls: LlmCall[] }
export interface JsonStep<T> { value: T | null; error?: string; rawText?: string }

const STRICTER = (why: string) =>
  `Your previous reply could not be used: ${why}. Reply again with ONE valid JSON object that follows the schema exactly. No prose before or after it, no markdown fences, no comments, no trailing commas, and double quotes on every key and string.`;

export async function askJson<T>(env: LlmEnv, step: string, mode: Mode, messages: ChatMessage[], check: (v: unknown) => Checked<T>): Promise<JsonStep<T>> {
  let msgs = messages;
  let lastError = "";
  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const label = attempt === 0 ? step : `${step} (stricter retry)`;
    let res: ChatResult;
    try {
      res = await env.chat({ mode, messages: msgs });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      env.calls.push({ step: label, error });
      return { value: null, error: `${label}: ${error}` };
    }
    env.calls.push({ step: label, route: res.route });
    lastText = res.content;
    const json = extractJson(res.content);
    if (json === null) lastError = "it contained no JSON object";
    else {
      const c = check(json);
      if (c.ok) return { value: c.value, rawText: res.content };
      lastError = c.error;
    }
    msgs = [...messages, { role: "assistant", content: res.content.slice(0, 2000) }, { role: "user", content: STRICTER(lastError) }];
  }
  return { value: null, error: `${step}: ${lastError}`, rawText: lastText };
}

/** Corrective turn for the narrative: the verifier's error list is fed back verbatim. */
export const correctiveMessage = (errors: string[]): string =>
  `The verifier rejected your answer for these reasons:\n${errors.map((e) => `- ${e}`).join("\n")}\nFix every item and reply again with the complete corrected JSON object (same schema). Copy fact displays exactly, cite the facts each number comes from, and remove any number that is not in the facts table.`;
