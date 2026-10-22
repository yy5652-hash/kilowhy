// Narrative step with verification: the model writes placeholder text, code renders and repairs it (narration.ts), the verifier checks the rendered
// answer, and up to `maxCorrections` corrective retries feed the error list back. If no attempt verifies, the caller falls back to the template.
// One attempt is two parts, exported separately so the Markovian chain can run them as two chunks: narrateDraft (the LLM call) and narrateCheck (code only).
import type { Fact } from "./facts.ts";
import type { ChatMessage } from "./provider_shared.ts";
import { askJson, correctiveMessage, type LlmEnv } from "./agent_llm.ts";
import { checkNarrativeShape, NARRATIVE_MAX_TOKENS } from "./agent_prompts.ts";
import { addCounterfactualFraming, answerFromReply, dropContradictions } from "./narration.ts";
import { errorLine, verifyAnswer, type Answer, type VerifyCtx, type VerifyError } from "./verifier.ts";

const TRANSIENT = /timeout|HTTP 429|HTTP 5\d\d|network error|Too Many Requests/i;

export interface NarrateOutcome {
  answer: Answer | null;                                 // null: nothing verified
  attempts: number;
  repairs: string[];                                     // repairs applied to the accepted answer
  history: { attempt: number; errors: string[]; repairs: string[] }[];
  lastErrors: string[]; lastDetail: VerifyError[];
}

export type NarrativeValue = Extract<ReturnType<typeof checkNarrativeShape>, { ok: true }>["value"];
export type NarrativeDraft = { value: NarrativeValue; rawText?: string; directTried: boolean } | { value: null; error: string; rawText?: string; directTried: boolean };
export interface DraftArgs { env: LlmEnv; messages: ChatMessage[]; step: string; deadlineMs: number; hedgeAfterMs: number; allowDirect: boolean }

/** One narrative call (with the stricter retry inside askJson). If Meterless and the alongside call both failed quickly, one more call goes straight to the labelled NVIDIA route. */
export async function narrateDraft(a: DraftArgs): Promise<NarrativeDraft> {
  const opts = { maxTokens: NARRATIVE_MAX_TOKENS, deadlineMs: a.deadlineMs, hedgeAfterMs: a.hedgeAfterMs, retryTransient: true };
  let nr = await askJson(a.env, a.step, "deep", a.messages, checkNarrativeShape, opts);
  let directTried = false;
  // Meterless and the alongside call both failed (timeout, rate limit): once Meterless is out of the way, one call straight to the labelled NVIDIA route often goes through
  if (!nr.value && nr.rawText === undefined && TRANSIENT.test(nr.error ?? "") && a.allowDirect) {
    directTried = true;
    nr = await askJson(a.env, `${a.step} (direct retry)`, "deep", a.messages, checkNarrativeShape, { ...opts, hedgeAfterMs: undefined, direct: `the first ${a.step} call failed: ${(nr.error ?? "").replace(/^[^:]*: /, "").slice(0, 120)}` });
  }
  return nr.value ? { value: nr.value, rawText: nr.rawText, directTried } : { value: null, error: nr.error ?? "unusable narrative", rawText: nr.rawText, directTried };
}

export interface CheckOutcome {
  answer: Answer | null;                                 // the accepted answer, or null when it did not verify
  repairs: string[];                                     // repairs applied to the accepted answer
  errors: string[]; detail: VerifyError[];               // why it was rejected
  rejectedRepairs: string[];                             // repairs applied to a rejected draft (kept in the history)
}

/** Placeholders -> text, verifier, and the cheap repair of status contradictions. Pure. */
export function narrateCheck(reply: NarrativeValue, facts: Fact[], vctx: VerifyCtx): CheckOutcome {
  const n = answerFromReply(reply, facts, vctx.hypotheses, new Set(vctx.evidenceIds), vctx.quality);
  let v = n.errors.length ? { passed: false, errors: [] as VerifyError[] } : verifyAnswer(n.answer, vctx);
  let candidate = n.answer, repairs = n.repairs;
  // cheap repairs instead of a corrective round trip: leave out status contradictions, add the counterfactual clause to a tariff comparison
  for (const fixer of [dropContradictions, addCounterfactualFraming]) {
    if (v.passed || n.errors.length) break;
    const fix = fixer(candidate, v.errors);
    if (fix) { const v2 = verifyAnswer(fix.answer, vctx); if (v2.passed) { v = v2; candidate = fix.answer; repairs = [...repairs, ...fix.notes]; } }
  }
  if (v.passed) return { answer: candidate, repairs, errors: [], detail: [], rejectedRepairs: [] };
  return { answer: null, repairs: [], errors: [...n.errors, ...v.errors.map(errorLine)], detail: v.errors, rejectedRepairs: n.repairs };
}

export async function narrate(a0: { env: LlmEnv; messages: ChatMessage[]; facts: Fact[]; vctx: VerifyCtx; maxCorrections: number; deadlineMs: number; hedgeAfterMs: number; directRetryBeforeMs?: number }): Promise<NarrateOutcome> {
  const t0 = performance.now();
  let directTried = false;
  const a = { directRetryBeforeMs: 40_000, ...a0 };   // a direct retry only if the first call failed early enough to leave room for it
  const out: NarrateOutcome = { answer: null, attempts: 0, repairs: [], history: [], lastErrors: [], lastDetail: [] };
  let messages = a.messages;
  while (out.attempts < 1 + a.maxCorrections && !out.answer) {
    out.attempts++;
    const step = out.attempts === 1 ? "narrative" : `narrative (correction ${out.attempts - 1})`;
    const d = await narrateDraft({ env: a.env, messages, step, deadlineMs: a.deadlineMs, hedgeAfterMs: a.hedgeAfterMs, allowDirect: !directTried && performance.now() - t0 < a.directRetryBeforeMs });
    directTried ||= d.directTried;
    if (!d.value) {
      out.lastErrors = [d.error]; out.lastDetail = [];
      out.history.push({ attempt: out.attempts, errors: out.lastErrors, repairs: [] });
      if (d.rawText === undefined) break;                  // the provider itself failed: another try would fail the same way
      messages = [...a.messages, { role: "assistant", content: d.rawText.slice(0, 3000) }, { role: "user", content: correctiveMessage(out.lastErrors) }];
      continue;
    }
    const c = narrateCheck(d.value, a.facts, a.vctx);
    if (c.answer) { out.answer = c.answer; out.repairs = c.repairs; out.lastErrors = []; out.lastDetail = []; break; }
    out.lastErrors = c.errors; out.lastDetail = c.detail;
    out.history.push({ attempt: out.attempts, errors: out.lastErrors, repairs: c.rejectedRepairs });
    messages = [...a.messages, { role: "assistant", content: JSON.stringify(d.value) }, { role: "user", content: correctiveMessage(out.lastErrors) }];
  }
  return out;
}
