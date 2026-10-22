// Narrative step with verification: the model writes placeholder text, code renders and repairs it (narration.ts), the verifier checks the rendered
// answer, and up to `maxCorrections` corrective retries feed the error list back. If no attempt verifies, the caller falls back to the template.
import type { Fact } from "./facts.ts";
import type { ChatMessage } from "./provider_shared.ts";
import { askJson, correctiveMessage, type LlmEnv } from "./agent_llm.ts";
import { checkNarrativeShape, NARRATIVE_MAX_TOKENS } from "./agent_prompts.ts";
import { answerFromReply, dropContradictions } from "./narration.ts";
import { errorLine, verifyAnswer, type Answer, type VerifyCtx, type VerifyError } from "./verifier.ts";

const TRANSIENT = /timeout|HTTP 429|HTTP 5\d\d|network error|Too Many Requests/i;

export interface NarrateOutcome {
  answer: Answer | null;                                 // null: nothing verified
  attempts: number;
  repairs: string[];                                     // repairs applied to the accepted answer
  history: { attempt: number; errors: string[]; repairs: string[] }[];
  lastErrors: string[]; lastDetail: VerifyError[];
}

export async function narrate(a0: { env: LlmEnv; messages: ChatMessage[]; facts: Fact[]; vctx: VerifyCtx; maxCorrections: number; deadlineMs: number; hedgeAfterMs: number; directRetryBeforeMs?: number }): Promise<NarrateOutcome> {
  const t0 = performance.now();
  let directTried = false;
  const a = { directRetryBeforeMs: 40_000, ...a0 };   // a direct retry only if the first call failed early enough to leave room for it
  const out: NarrateOutcome = { answer: null, attempts: 0, repairs: [], history: [], lastErrors: [], lastDetail: [] };
  const evidenceIds = new Set(a.vctx.evidenceIds);
  let messages = a.messages;
  while (out.attempts < 1 + a.maxCorrections && !out.answer) {
    out.attempts++;
    const step = out.attempts === 1 ? "narrative" : `narrative (correction ${out.attempts - 1})`;
    const opts = { maxTokens: NARRATIVE_MAX_TOKENS, deadlineMs: a.deadlineMs, hedgeAfterMs: a.hedgeAfterMs, retryTransient: true };
    let nr = await askJson(a.env, step, "deep", messages, checkNarrativeShape, opts);
    // Meterless and the alongside call both failed (timeout, rate limit): once Meterless is out of the way, one call straight to the labelled NVIDIA route often goes through
    if (!nr.value && nr.rawText === undefined && TRANSIENT.test(nr.error ?? "") && !directTried && performance.now() - t0 < a.directRetryBeforeMs) {
      directTried = true;
      nr = await askJson(a.env, `${step} (direct retry)`, "deep", messages, checkNarrativeShape, { ...opts, hedgeAfterMs: undefined, direct: `the first ${step} call failed: ${(nr.error ?? "").replace(/^[^:]*: /, "").slice(0, 120)}` });
    }
    if (!nr.value) {
      out.lastErrors = [nr.error ?? "unusable narrative"]; out.lastDetail = [];
      out.history.push({ attempt: out.attempts, errors: out.lastErrors, repairs: [] });
      if (nr.rawText === undefined) break;                  // the provider itself failed: another try would fail the same way
      messages = [...a.messages, { role: "assistant", content: nr.rawText.slice(0, 3000) }, { role: "user", content: correctiveMessage(out.lastErrors) }];
      continue;
    }
    const n = answerFromReply(nr.value, a.facts, a.vctx.hypotheses, evidenceIds);
    let v = n.errors.length ? { passed: false, errors: [] as VerifyError[] } : verifyAnswer(n.answer, a.vctx);
    let candidate = n.answer, repairs = n.repairs;
    if (!v.passed && !n.errors.length) {
      const fix = dropContradictions(candidate, v.errors);
      if (fix) { const v2 = verifyAnswer(fix.answer, a.vctx); if (v2.passed) { v = v2; candidate = fix.answer; repairs = [...repairs, ...fix.notes]; } }
    }
    if (v.passed) { out.answer = candidate; out.repairs = repairs; out.lastErrors = []; out.lastDetail = []; break; }
    out.lastErrors = [...n.errors, ...v.errors.map(errorLine)]; out.lastDetail = v.errors;
    out.history.push({ attempt: out.attempts, errors: out.lastErrors, repairs: n.repairs });
    messages = [...a.messages, { role: "assistant", content: JSON.stringify(nr.value) }, { role: "user", content: correctiveMessage(out.lastErrors) }];
  }
  return out;
}
