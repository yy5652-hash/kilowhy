// The ways we try to make Nemotron skip its reasoning, and the summary of a probe run (pure; used by scripts/reasoning_probe.ts and tested).
import type { ChatMessage, ChatRequest } from "./provider_shared.ts";

export interface Variant { id: string; label: string; systemLine?: string; extra?: Record<string, unknown>; maxTokens?: number }
export const VARIANTS: Variant[] = [
  { id: "baseline", label: "no control, no cap" },
  { id: "cap500", label: "max_tokens 500 only", maxTokens: 500 },
  { id: "no_think_line", label: 'system line "/no_think", cap 500', systemLine: "/no_think", maxTokens: 500 },
  { id: "thinking_off_line", label: 'system line "detailed thinking off", cap 500', systemLine: "detailed thinking off", maxTokens: 500 },
  { id: "kwargs_enable_thinking", label: "chat_template_kwargs enable_thinking=false, cap 500", extra: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: 500 },
  { id: "kwargs_and_line", label: 'enable_thinking=false + "detailed thinking off", cap 500', systemLine: "detailed thinking off", extra: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: 500 },
  { id: "thinking_disabled", label: 'thinking {type: "disabled"}, cap 500', extra: { thinking: { type: "disabled" } }, maxTokens: 500 },
  { id: "low_effort", label: "chat_template_kwargs low_effort=true, cap 500", extra: { chat_template_kwargs: { low_effort: true } }, maxTokens: 500 },
  { id: "reasoning_effort_obj", label: 'reasoning {effort: "low"}, cap 500', extra: { reasoning: { effort: "low" } }, maxTokens: 500 },
  { id: "reasoning_effort_low", label: 'reasoning_effort "low", cap 500', extra: { reasoning_effort: "low" }, maxTokens: 500 },
];

export function requestFor(v: Variant, messages: ChatMessage[], mode: "deep" | "fast" | "auto" = "deep", capOverride?: number): ChatRequest {
  const msgs = v.systemLine ? messages.map((m, i) => (i === 0 && m.role === "system" ? { ...m, content: `${m.content}\n${v.systemLine}` } : m)) : messages;
  return { mode, messages: msgs, ...(capOverride !== undefined ? (capOverride > 0 && v.maxTokens ? { max_tokens: capOverride } : {}) : v.maxTokens ? { max_tokens: v.maxTokens } : {}), ...(v.extra ? { extra: v.extra } : {}), deadlineMs: 120_000 };
}

export interface ProbeRow { variant: string; ok: boolean; wallMs: number; outputTokens: number | null; routedModel: string | null; leaked: boolean; jsonOk: boolean; provider?: string; preview?: string; error?: string }
export interface ProbeSummary { variant: string; providers?: string[]; n: number; okRate: number; jsonRate: number; leakRate: number; medianWallMs: number | null; medianOutputTokens: number | null; models: string[] }

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
export function summarize(rows: ProbeRow[]): ProbeSummary[] {
  const ids = [...new Set(rows.map((r) => r.variant))];
  return ids.map((variant) => {
    const rs = rows.filter((r) => r.variant === variant), ok = rs.filter((r) => r.ok);
    return {
      variant, n: rs.length, okRate: ok.length / rs.length, jsonRate: ok.filter((r) => r.jsonOk).length / rs.length, leakRate: ok.length ? ok.filter((r) => r.leaked).length / ok.length : 0,
      medianWallMs: median(ok.map((r) => r.wallMs)), medianOutputTokens: median(ok.flatMap((r) => (r.outputTokens === null ? [] : [r.outputTokens]))),
      models: [...new Set(ok.map((r) => r.routedModel ?? "?"))].sort(), providers: [...new Set(ok.map((r) => r.provider ?? "?"))].sort(),
    };
  });
}
