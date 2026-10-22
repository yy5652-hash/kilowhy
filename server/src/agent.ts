// The Kilowhy agent loop (spec section 13): intent -> decomposition -> plan -> run -> facts -> narrative -> verify -> recommend -> output.
// The LLM (Meterless Nightshift, labelled NVIDIA fallback) classifies the question, picks tests and writes prose; every number comes from Zetaris queries
// and deterministic code, and a verifier checks the prose against the facts table. If the model cannot produce a verified narrative, a template built
// from the same facts is used (mode "template"). Meter kWh are SAMPLE data.
import { chat as providerChat } from "./provider.ts";
import { createZetarisData, type DataLayer, type ZSql } from "./data.ts";
import { EvidenceStore } from "./evidence.ts";
import { CATALOG, HYPOTHESIS_IDS, buildContext, runHypothesis } from "./hypotheses/index.ts";
import type { HypothesisId, HypothesisResult } from "./hypotheses/types.ts";
import { recommend, recommendTariff } from "./recommend.ts";
import { WINDOW_A, WINDOW_B, type DateWindow } from "./windows.ts";
import { addDays } from "./bands.ts";
import { fmtGbp, fmtKwh, fmtPkwh } from "./facts_format.ts";
import { buildFacts, type Fact } from "./facts.ts";
import { errorLine, resolveHypothesis, verifyAnswer, type Answer, type AnswerItem, type HypInfo, type VerifyCtx, type VerifyError } from "./verifier.ts";
import { askJson, correctiveMessage, type ChatFn, type LlmEnv } from "./agent_llm.ts";
import { checkIntent, checkNarrative, checkPlan, intentMessages, narrativeMessages, planMessages } from "./agent_prompts.ts";
import { appearsIn, isAllRequest, datesIn, fallbackIntentType, mentionedSites, resolveSite, unknownNumberedSites, type SiteRef } from "./agent_sites.ts";
import { runExtraSql } from "./agent_extra.ts";
import { templateAnswer } from "./agent_template.ts";
import { SAMPLE_NOTE, type ClarificationResult, type DecompositionSummary, type InvestigateOutcome, type Intent, type IntentType, type InvestigationResult, type LlmCall, type Plan, type Timings, type Verification } from "./agent_types.ts";
import type { ChatMessage } from "./provider_shared.ts";

export interface InvestigateOpts {
  zsql?: ZSql;                    // Zetaris runner: needed for the planner's extra SQL and, without `data`, to build the data layer
  data?: DataLayer;               // default: createZetarisData(zsql)
  chat?: ChatFn;                  // default: the Meterless/NVIDIA provider
  site?: string;                  // restrict to one site (id or name); overrides the sites found in the question
  windowA?: DateWindow; windowB?: DateWindow;
  maxCorrections?: number;        // corrective narrative retries after a failed verification (default 2)
  onProgress?: (message: string) => void;
}

const DATA_CHECKS: HypothesisId[] = ["H7", "H8", "H9"];
const NEEDED_BY: Record<IntentType, HypothesisId[]> = { why_cost_change: [], why_spike_day: ["H6", "H11"], why_emissions: ["H10"], what_to_change: [] };
const DEFAULT_PLAN: Record<IntentType, HypothesisId[]> = {
  why_cost_change: ["H1", "H2", "H3", "H4", "H5", "H6", "H11"], why_spike_day: ["H6", "H11", "H4", "H3", "H1"],
  why_emissions: ["H10", "H3", "H4", "H5"], what_to_change: ["H1", "H5", "H3", "H4"],
};
const ONE_LINE = (s: string) => s.replace(/\s+/g, " ").trim();

function clarification(question: string, text: string, sites: SiteRef[], calls: LlmCall[], timings: Timings, t0: number): ClarificationResult {
  return { question, clarification: text, knownSites: sites, llmCalls: calls, timings: { ...timings, total: Math.round(performance.now() - t0) } };
}

/** Sorts ids numerically, removes duplicates, and adds the evidence of every cited fact so each sentence is traceable to its source queries. */
export function normalizeAnswer(a: Answer, facts: Fact[], hyps: HypInfo[]): Answer {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const order = (x: string) => Number(x.slice(1)) || 0;
  const fix = <T extends AnswerItem>(it: T): T => {
    const fs = [...new Set(it.facts)].filter((id) => byId.has(id)).sort((x, y) => order(x) - order(y));
    const es = [...new Set([...it.evidence, ...fs.map((id) => byId.get(id)!.evidence)])].sort((x, y) => order(x) - order(y));
    return { ...it, text: ONE_LINE(it.text), facts: fs, evidence: es };
  };
  return {
    headline: ONE_LINE(a.headline), sentences: a.sentences.map(fix),
    ruledOut: a.ruledOut.map((r) => fix({ ...r, hypothesis: resolveHypothesis(r.hypothesis, hyps)?.id ?? r.hypothesis })),
    recommendation: fix(a.recommendation),
  };
}

export async function investigate(question: string, opts: InvestigateOpts = {}): Promise<InvestigateOutcome> {
  const t0 = performance.now();
  const timings: Timings = { total: 0 };
  const calls: LlmCall[] = [];
  const notes: string[] = [];
  const env: LlmEnv = { chat: opts.chat ?? providerChat, calls };
  const progress = opts.onProgress ?? (() => {});
  const lap = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { const s = performance.now(); try { return await fn(); } finally { timings[name] = Math.round((timings[name] ?? 0) + performance.now() - s); } };
  const windowA = opts.windowA ?? WINDOW_A, windowB = opts.windowB ?? WINDOW_B;
  const data = opts.data ?? (opts.zsql ? createZetarisData(opts.zsql) : null);
  if (!data) throw new Error("investigate needs opts.data or opts.zsql");

  // ---- 1. intent: the model classifies; code resolves entities and never invents a site
  const info = data.siteInfo ? await data.siteInfo() : (await data.siteIds()).map((id) => ({ id, name: id }));
  const known: SiteRef[] = info.map((s) => ({ id: s.id, name: s.name || s.id }));
  progress("intent");
  const ir = await lap("intent", () => askJson(env, "intent", "auto", intentMessages(question, known), checkIntent));
  let intent: Intent;
  if (ir.value) intent = { ...ir.value, source: "llm" };
  else { notes.push(`intent: model output unusable (${ir.error}); keyword rules used`); intent = { type: fallbackIntentType(question), requestedSites: [], dates: datesIn(question), source: "fallback" }; }
  if (!intent.dates.length) intent.dates = datesIn(question);

  const requested = opts.site ? [opts.site] : intent.requestedSites;
  const ids = new Set<string>();
  const listing = () => known.map((s) => `${s.id} (${s.name})`).join(", ");
  for (const r of requested) {
    const res = resolveSite(r, known);
    if (res.ok) res.ids.forEach((id) => ids.add(id));
    else if (opts.site || appearsIn(r, question)) {
      return clarification(question, res.ambiguous.length > 1 ? `"${r}" matches several sites (${res.ambiguous.join(", ")}). Which one do you mean? Sites: ${listing()}.` : `I could not find a site called "${r}". Which one do you mean? Sites: ${listing()}.`, known, calls, timings, t0);
    } else notes.push(`ignored site "${r}" proposed by the model: it does not appear in the question`);
  }
  const unknownNumbered = opts.site ? [] : unknownNumberedSites(question, known);
  if (unknownNumbered.length) return clarification(question, `I could not find "${unknownNumbered[0]}". Which one do you mean? Sites: ${listing()}.`, known, calls, timings, t0);
  if (!opts.site) mentionedSites(question, known).forEach((id) => ids.add(id));
  const everySite = ids.size === 0 || requested.some(isAllRequest);
  const siteIds = everySite ? known.map((s) => s.id) : known.map((s) => s.id).filter((id) => ids.has(id));
  const label = siteIds.length === known.length ? "ALL" : siteIds.join("+");
  const outside = intent.dates.filter((d) => d < windowA.from || d >= windowB.toExclusive);
  if (outside.length) return clarification(question, `I only have meter data from ${windowA.from} to ${addDays(windowB.toExclusive, -1)}, so I cannot look at ${outside.join(", ")}. Which day in that range do you mean?`, known, calls, timings, t0);

  // ---- 2. decomposition (deterministic, always)
  progress("decomposition");
  const evidence = new EvidenceStore();
  const ctx = await lap("decomposition", () => buildContext({ data, scope: { label, sites: siteIds }, windowA, windowB, evidence }));
  const dec = ctx.decomposition;
  if (!dec.ok || !dec.result) return clarification(question, `I could not compare the two windows for ${label}: ${dec.error ?? "the decomposition failed"}.`, known, calls, timings, t0);
  const r = dec.result;
  const summary = `bill change ${fmtGbp(r.deltaTotal / 100)} = volume ${fmtGbp(r.volume / 100)} + price level ${fmtGbp(r.price / 100)} + timing ${fmtGbp(r.timing / 100)} + standing charge ${fmtGbp(r.standing / 100)}; usage ${fmtKwh(r.QA)} -> ${fmtKwh(r.QB)}; average price ${fmtPkwh(r.pbarA)} -> ${fmtPkwh(r.pbarB)}`;

  // ---- 3. plan: the model picks catalog ids and optional SQL; code adds the data checks and what the question type needs
  progress("plan");
  const pr = await lap("plan", () => askJson(env, "plan", "deep", planMessages({ question, type: intent.type, scopeLabel: label, summary }), checkPlan));
  const proposed = pr.value?.hypotheses ?? [];
  if (!pr.value) notes.push(`plan: model output unusable (${pr.error}); default plan used`);
  const valid = [...new Set(proposed.filter((h): h is HypothesisId => (HYPOTHESIS_IDS as readonly string[]).includes(h)))];
  const dropped = [...new Set(proposed.filter((h) => !(HYPOTHESIS_IDS as readonly string[]).includes(h)))];
  if (dropped.length) notes.push(`plan: dropped ids outside the catalog: ${dropped.join(", ")}`);
  const base = pr.value ? valid : DEFAULT_PLAN[intent.type];
  const added = [...NEEDED_BY[intent.type], ...DATA_CHECKS].filter((h) => !base.includes(h));
  const order = [...base, ...added];

  // ---- 4. run the hypotheses and the extra SQL; every query becomes evidence
  const results: HypothesisResult[] = [];
  await lap("hypotheses", async () => { for (const id of order) { progress(`test ${id}`); results.push(await runHypothesis(id, ctx)); } });
  const extraSql = await lap("extraSql", () => runExtraSql(pr.value?.extraSql ?? [], opts.zsql, evidence));
  const plan: Plan = { hypotheses: order, added, dropped, extraSql, rationale: ONE_LINE(pr.value?.rationale ?? "default plan (the model's plan was unusable)"), source: pr.value ? "llm" : "default" };

  // ---- 7 (computed before the facts). recommendation: counterfactual load shift and flat-tariff comparison
  progress("recommend");
  const loadShift = await lap("recommend", () => recommend(ctx).catch((e) => { notes.push(`recommend: ${e instanceof Error ? e.message : e}`); return null; }));
  const tariff = await lap("recommendTariff", () => recommendTariff(ctx).catch((e) => { notes.push(`tariff: ${e instanceof Error ? e.message : e}`); return null; }));

  // ---- 5. facts
  const siteNames = Object.fromEntries(known.map((s) => [s.id, s.name]));
  const facts = await lap("facts", async () => buildFacts({
    scope: ctx.scope, siteNames, windowA, windowB, decomposition: dec, results, evidence, rec: loadShift, tariff,
    extras: extraSql.filter((x) => x.status === "ran" && x.evidence).map((x) => ({ purpose: x.purpose, evidence: x.evidence!, rows: x.rows ?? 0 })),
  }));
  const hyps: HypInfo[] = results.map((x) => ({ id: x.id, name: x.name, status: x.status }));
  const vctx: VerifyCtx = { facts, evidenceIds: evidence.list().map((e) => e.id), hypotheses: hyps, requireRecommendation: facts.some((f) => f.hypothesis === "REC") };

  // ---- 6 + verify: narrative with up to 2 corrective retries, else the template
  progress("narrative");
  const titles = Object.fromEntries(CATALOG.map((c) => [c.id as string, c.title]));
  const scopeText = `${siteIds.map((s) => `${s} ${siteNames[s]}`).join("; ")}; window A ${windowA.from} to ${addDays(windowA.toExclusive, -1)} (baseline), window B ${windowB.from} to ${addDays(windowB.toExclusive, -1)} (current)`;
  const baseMessages = narrativeMessages({ question, type: intent.type, scopeText, facts, hypotheses: hyps, titles, focusDates: intent.dates, hasRecommendation: vctx.requireRecommendation === true });
  let messages: ChatMessage[] = baseMessages;
  let attempts = 0, answer: Answer | null = null;
  let lastErrors: string[] = [], lastDetail: VerifyError[] = [];
  const history: Verification["history"] = [];
  const maxAttempts = 1 + (opts.maxCorrections ?? 2);
  await lap("narrative", async () => {
    while (attempts < maxAttempts && !answer) {
      attempts++;
      const step = attempts === 1 ? "narrative" : `narrative (correction ${attempts - 1})`;
      const nr = await askJson(env, step, "deep", messages, checkNarrative);
      if (!nr.value) {
        lastErrors = [nr.error ?? "unusable narrative"]; lastDetail = [];
        history.push({ attempt: attempts, errors: lastErrors });
        if (nr.rawText === undefined) break;                       // the provider itself failed: another try would fail the same way
        messages = [...baseMessages, { role: "assistant", content: nr.rawText.slice(0, 3000) }, { role: "user", content: correctiveMessage(lastErrors) }];
        continue;
      }
      const v = verifyAnswer(nr.value, vctx);
      if (v.passed) { answer = nr.value; lastErrors = []; lastDetail = []; break; }
      lastErrors = v.errors.map(errorLine); lastDetail = v.errors;
      history.push({ attempt: attempts, errors: lastErrors });
      messages = [...baseMessages, { role: "assistant", content: JSON.stringify(nr.value) }, { role: "user", content: correctiveMessage(lastErrors) }];
    }
  });
  let verification: Verification;
  if (answer) {
    answer = normalizeAnswer(answer, facts, hyps);
    verification = { passed: true, attempts, errors: [], errorDetail: [], history, mode: "llm" };
  } else {
    const t = normalizeAnswer(templateAnswer(facts, hyps, intent.type), facts, hyps);
    const tv = verifyAnswer(t, vctx);
    answer = t;
    verification = { passed: tv.passed, attempts, errors: [...lastErrors, ...tv.errors.map((e) => `template: ${errorLine(e)}`)], errorDetail: [...lastDetail, ...tv.errors], history, mode: "template" };
  }
  timings.total = Math.round(performance.now() - t0);

  const decomposition: DecompositionSummary = { ok: dec.ok, error: dec.error, result: dec.result, standing: dec.standing, vatRate: dec.vatRate, evidenceId: dec.evidenceId, contractEvidenceId: dec.contractEvidenceId, warnings: dec.warnings, slotsAligned: dec.aligned.kept, slotsExpected: dec.aligned.expected };
  const out: InvestigationResult = {
    question, intent, scope: { label, sites: siteIds.map((id) => ({ id, name: siteNames[id] })), windowA, windowB }, decomposition, plan, results, evidence: evidence.list(), facts,
    recommendation: { loadShift, tariff }, answer, verification, llmCalls: calls, timings, notes, sampleDataNote: SAMPLE_NOTE,
  };
  return out;
}
