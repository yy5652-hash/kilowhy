// Turns the model's placeholder reply into an Answer: substitutes {F#} placeholders with fact displays, derives the cited facts and their evidence,
// repairs what can be repaired without changing meaning, and reports the rest as errors for a corrective retry.
//  - digits outside placeholders: repaired when they spell exactly one fact's display, otherwise an error;
//  - a sentence that cites a fact of a hypothesis that is not supported is dropped (a ruled-out item for a hypothesis that is not ruled_out likewise);
//  - unknown placeholder ids and sentences without any placeholder are errors.
import type { Fact } from "./facts.ts";
import { renderPlaceholders } from "./placeholders.ts";
import { resolveHypothesis, type Answer, type AnswerItem, type HypInfo, type RuledOutItem, type VerifyError } from "./verifier.ts";

export interface ReplyShape {
  headline?: unknown; sentences?: unknown; ruledOut?: unknown; recommendation?: unknown;
}
export interface Narration { answer: Answer; repairs: string[]; errors: string[] }

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const evidenceList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).map((x) => String(x).replace(/[[\]\s]/g, "").toUpperCase()).filter((x) => /^E\d+$/.test(x));

export function answerFromReply(reply: ReplyShape, facts: Fact[], hyps: HypInfo[], evidenceIds: Set<string>): Narration {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const statusOf = new Map(hyps.map((h) => [h.id, h.status]));
  const errors: string[] = [];
  const repairs: string[] = [];
  const item = (raw: unknown, where: string, given: unknown = undefined, dropWithoutCitation = false): AnswerItem | null => {
    const text = typeof raw === "string" ? raw : "";
    const r = renderPlaceholders(text, byId, where);
    if (dropWithoutCitation && r.facts.length === 0 && r.errors.length === 1 && /no placeholder/.test(r.errors[0])) {   // prose with no figure cannot be checked: leave it out
      repairs.push(`${where} dropped: it has no {F#} placeholder, so nothing in it can be checked`);
      return null;
    }
    errors.push(...r.errors); repairs.push(...r.repairs);
    if (r.errors.length) return null;
    const ev = new Set(r.facts.map((id) => byId.get(id)!.evidence).filter(Boolean));   // a remembered note (M#) has no evidence of its own
    for (const e of evidenceList(given)) if (evidenceIds.has(e)) ev.add(e);
    return { text: r.text, facts: r.facts, evidence: [...ev] };
  };
  const tagOf = (id: string) => byId.get(id)?.hypothesis;

  const sentences: AnswerItem[] = [];
  (Array.isArray(reply.sentences) ? reply.sentences : []).forEach((s, i) => {
    const it = item(asObj(s).text, `sentences[${i}]`, asObj(s).evidence, true);
    if (!it) return;
    const bad = it.facts.map((id) => ({ id, h: tagOf(id) })).find((x) => x.h && statusOf.has(x.h) && statusOf.get(x.h) !== "supported");
    if (bad) { repairs.push(`sentences[${i}] dropped: it cites ${bad.id}, a fact of ${bad.h}, which is ${statusOf.get(bad.h!)}, not a supported cause`); return; }
    sentences.push(it);
  });
  if (sentences.length === 0 && errors.length === 0) errors.push("sentences: no usable sentence left; write 4 to 6 sentences about the supported causes, each with at least one {F#} placeholder");

  const ruledOut: RuledOutItem[] = [];
  (Array.isArray(reply.ruledOut) ? reply.ruledOut : []).forEach((r, i) => {
    const o = asObj(r);
    const h = typeof o.hypothesis === "string" ? resolveHypothesis(o.hypothesis, hyps) : null;
    if (!h || h.status !== "ruled_out") { repairs.push(`ruledOut[${i}] dropped: ${String(o.hypothesis)} is ${h ? h.status : "not a tested hypothesis"}, not ruled_out`); return; }
    const it = item(o.text, `ruledOut[${i}]`, o.evidence, true);
    if (!it) return;
    if (it.facts.some((id) => { const t = tagOf(id); return t && statusOf.get(t) === "supported"; })) { repairs.push(`ruledOut[${i}] dropped: it cites a fact of a supported hypothesis`); return; }
    ruledOut.push({ ...it, hypothesis: h.id });
  });

  const recText = asObj(reply.recommendation).text;
  const rec = typeof recText === "string" && recText.trim() ? item(recText, "recommendation", asObj(reply.recommendation).evidence) : null;

  let headline = "";
  if (typeof reply.headline === "string" && reply.headline.trim()) {
    const r = renderPlaceholders(reply.headline, byId, "headline");
    repairs.push(...r.repairs);
    errors.push(...r.errors.filter((e) => !/no placeholder/.test(e)));
    headline = r.text;
  }
  return { answer: { headline, sentences, ruledOut, recommendation: rec ?? { text: "", facts: [], evidence: [] } }, repairs, errors };
}

// ---- verifier findings that can be fixed by leaving something out (instead of a corrective round trip to the model)
const DROPPABLE_SENTENCE = /^(presents H\d+ .* as a cause|cites F\d+ \(H\d+\), but|mentions ruling something out)/;
const DROPPABLE_RULED_OUT = /^(H\d+ \(.*\) is (supported|inconclusive), not ruled_out|cites F\d+ \(H\d+\), which belongs to a supported hypothesis|the hypothesis ".*" is not one of the tested hypotheses)/;

/** If every verifier error is a status contradiction in a sentence or a ruled-out item, drop those entries (keeping at least two sentences) and say so. null: not fixable this way. */
export function dropContradictions(answer: Answer, errors: VerifyError[]): { answer: Answer; notes: string[] } | null {
  if (errors.length === 0 || !errors.every((e) => (e.part === "sentences" && DROPPABLE_SENTENCE.test(e.reason)) || (e.part === "ruledOut" && DROPPABLE_RULED_OUT.test(e.reason)))) return null;
  const badSentences = new Set(errors.filter((e) => e.part === "sentences").map((e) => e.index));
  const badRuled = new Set(errors.filter((e) => e.part === "ruledOut").map((e) => e.index));
  if (answer.sentences.length - badSentences.size < 2) return null;
  const notes = [...badSentences].sort().map((i) => `sentences[${i}] dropped: ${errors.find((e) => e.part === "sentences" && e.index === i)!.reason}`)
    .concat([...badRuled].sort().map((i) => `ruledOut[${i}] dropped: ${errors.find((e) => e.part === "ruledOut" && e.index === i)!.reason}`));
  return { answer: { ...answer, sentences: answer.sentences.filter((_, i) => !badSentences.has(i)), ruledOut: answer.ruledOut.filter((_, i) => !badRuled.has(i)) }, notes };
}
