// The Kilowhy agent loop (spec section 13): intent -> decomposition -> plan -> run -> facts -> narrative -> verify -> recommend -> output.
// The LLM (Meterless Nightshift, labelled NVIDIA fallback) classifies the question, orders the tests and writes prose around {F#} placeholders;
// every number comes from Zetaris queries and deterministic code, code substitutes the figures, and a verifier checks the rendered prose against
// the facts table. If the model cannot produce a verified narrative, a template built from the same facts is used (mode "template").
// Latency (D2e): the plan call, the intent call and the data work start together; all hypotheses always run over prefetched queries.
// Meter kWh are SAMPLE data.
import { chat as providerChat } from "./provider.ts";
import { createZetarisData, type DataLayer, type ZSql } from "./data.ts";
import { KilowhyWorld } from "./worldmodel.ts";
import type { KilowhyMemory, Recall } from "./memory.ts";
import { memoryFacts, memorySnippets } from "./memory_facts.ts";
import { confirmCauses, type WrittenMemory } from "./memory_confirm.ts";
import { memoryReport, recallFor } from "./agent_memory.ts";
import { runMarkovianChain } from "./investigate_markovian.ts";
import { tapChat, type Tape } from "./markovian_log.ts";
import { appendTokenLog } from "./markovian_file.ts";
import { CATALOG, HYPOTHESIS_IDS } from "./hypotheses/index.ts";
import type { HypothesisId } from "./hypotheses/types.ts";
import { WINDOW_A, WINDOW_B, type DateWindow } from "./windows.ts";
import { addDays } from "./bands.ts";
import { buildFacts, type Fact } from "./facts.ts";
import { errorLine, resolveHypothesis, verifyAnswer, type Answer, type AnswerItem, type HypInfo, type VerifyCtx } from "./verifier.ts";
import { askJson, type ChatFn, type LlmEnv, type ReasoningControl } from "./agent_llm.ts";
import { INTENT_MAX_TOKENS, PLAN_MAX_TOKENS, checkIntent, offHypotheses, checkPlan, intentMessages, narrativeMessages, planMessages, relevantFacts } from "./agent_prompts.ts";
import { datesIn, fallbackIntentType, type SiteRef } from "./agent_sites.ts";
import { guessSites, resolveScope } from "./agent_scope.ts";
import { runExtraSql } from "./agent_extra.ts";
import { runScope, type ScopeRun } from "./agent_run.ts";
import { narrate, type NarrateOutcome } from "./agent_narrate.ts";
import { templateAnswer } from "./agent_template.ts";
import { safeEmit, timed, type ProgressEvent } from "./agent_events.ts";
import { DEFAULT_REASONING } from "./agent_reasoning.ts";
import { SAMPLE_NOTE, type ClarificationResult, type DecompositionSummary, type InvestigateOutcome, type Intent, type IntentType, type InvestigationResult, type LlmCall, type Plan, type Timings, type Verification } from "./agent_types.ts";

export interface InvestigateOpts {
  zsql?: ZSql;                    // Zetaris runner: needed for the planner's extra SQL and, without `data`, to build the data layer
  data?: DataLayer;               // default: createZetarisData(zsql)
  engine?: "markovian" | "plain"; // how the LLM part runs: Markovian chunks (plan, interpret batches, narrative, verify; the default) or the single plan + narrative loop
  markovian?: { batchSize?: number; logPath?: string; historyDir?: string };   // hypotheses per interpret chunk (default 5, see BATCH_SIZE in investigate_markovian.ts); logPath: where the per-chunk token log is appended (default: not written); historyDir: the engine's own run history
  memory?: KilowhyMemory;         // H-MEM: recalled at the start (M# facts, plan prompt), confirmed causes written at the end; default: no memory
  world?: KilowhyWorld;           // the World Model (sites, aliases, ops_log events); default: a new in-memory one, ingested from `data` at the start
  chat?: ChatFn;                  // default: the Meterless/NVIDIA provider
  site?: string;                  // restrict to one site (id or name); overrides the sites found in the question
  windowA?: DateWindow; windowB?: DateWindow;
  maxCorrections?: number;        // corrective narrative retries after a failed verification (default 2)
  reasoning?: ReasoningControl;   // how to ask the model not to think out loud (default: the measured setting in agent_reasoning.ts)
  deadlinesMs?: { intent?: number; plan?: number; narrative?: number };   // per-attempt hard deadline; a Meterless attempt past it goes to the labelled fallback
  hedgeAfterMs?: { intent?: number; plan?: number; narrative?: number }; // if Meterless is still running after this long, the labelled NVIDIA call starts alongside it
  planGraceMs?: number;           // how long past the data work and the intent the narrative waits for the plan before using the default emphasis (default 4000)
  onEvent?: (e: ProgressEvent) => void;    // live progress: steps, evidence, hypotheses, LLM routes
  onProgress?: (step: string) => void;     // convenience: the name of every step as it starts
}

export const DEADLINES_MS = { intent: 20_000, plan: 30_000, narrative: 45_000 } as const;
// Through Meterless the narrative takes 14-37 s (the model writes its reasoning as text first and often hits the token cap), NVIDIA direct with thinking off 3-9 s (docs/latency.md).
// Nightshift is the primary provider (hackathon Power rule), so every step gives it a real head start; the labelled NVIDIA call only joins when Nightshift is slow or failing.
export const HEDGE_AFTER_MS = { intent: 15_000, plan: 15_000, narrative: 35_000 } as const;
export const PLAN_GRACE_MS = 4_000;   // the plan only orders the tests, so a late plan never holds up the narrative for long
const DEFAULT_EMPHASIS: Record<IntentType, HypothesisId[]> = {
  why_cost_change: ["H1", "H2", "H3", "H4", "H5", "H6", "H11"], why_spike_day: ["H6", "H11", "H4", "H3", "H1"],
  why_emissions: ["H10", "H3", "H4", "H5"], what_to_change: ["H1", "H5", "H3", "H4"],
};
const ONE_LINE = (s: string) => s.replace(/\s+/g, " ").trim();
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Sorts ids numerically, removes duplicates, and adds the evidence of every cited fact so each sentence is traceable to its source queries. */
export function normalizeAnswer(a: Answer, facts: Fact[], hyps: HypInfo[]): Answer {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const order = (x: string) => (x[0] === "M" ? 1e6 : 0) + (Number(x.slice(1)) || 0);
  const fix = <T extends AnswerItem>(it: T): T => {
    const fs = [...new Set(it.facts)].filter((id) => byId.has(id)).sort((x, y) => order(x) - order(y));
    const es = [...new Set([...it.evidence, ...fs.map((id) => byId.get(id)!.evidence)])].filter(Boolean).sort((x, y) => order(x) - order(y));   // a remembered note (M#) has no evidence of its own
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
  const toEvents = safeEmit(opts.onEvent);
  const toProgress = safeEmit((e) => { if (e.type === "step" && e.status === "started") opts.onProgress?.(e.step); });
  const emit = (e: ProgressEvent) => { toEvents(e); toProgress(e); };
  const env: LlmEnv = { chat: opts.chat ?? providerChat, calls, reasoning: opts.reasoning ?? DEFAULT_REASONING, onCall: (call) => emit({ type: "llm", call }) };
  const deadline = { ...DEADLINES_MS, ...(opts.deadlinesMs ?? {}) };
  const hedge = { ...HEDGE_AFTER_MS, ...(opts.hedgeAfterMs ?? {}) };
  const windowA = opts.windowA ?? WINDOW_A, windowB = opts.windowB ?? WINDOW_B;
  const data = opts.data ?? (opts.zsql ? createZetarisData(opts.zsql) : null);
  if (!data) throw new Error("investigate needs opts.data or opts.zsql");
  const total = () => Math.round(performance.now() - t0);
  const clarify = (text: string, known: SiteRef[]): ClarificationResult => ({ question, clarification: text, knownSites: known, llmCalls: [...calls], timings: { ...timings, total: total() } });

  // The plan sees only the question (and, with H-MEM, the notes recalled for the sites it mentions), so its call starts at once without memory and right after the recall with it; either way it overlaps the data work.
  const planTape: Tape = [], planEnv: LlmEnv = { ...env, chat: tapChat(env.chat, planTape) };   // the plan call's messages and usage, for the chain's first chunk
  let planMem = "";
  const startPlan = (memories = "") =>
    timed(emit, timings, "plan", () => askJson(planEnv, "plan", "deep", planMessages({ question, memories }), checkPlan, { maxTokens: PLAN_MAX_TOKENS, deadlineMs: deadline.plan, hedgeAfterMs: hedge.plan }));
  const earlyPlanP = opts.memory ? null : startPlan();
  earlyPlanP?.catch(() => {});

  // ---- 1. sites and intent; data work starts on the scope the question text implies, without waiting for the model
  const world = opts.world ?? KilowhyWorld.create();
  const known: SiteRef[] = await timed(emit, timings, "sites", async () => { await world.ingest(data); return world.sites(); });
  const intentP = timed(emit, timings, "intent", () => askJson(env, "intent", "auto", intentMessages(question, known), checkIntent, { maxTokens: INTENT_MAX_TOKENS, deadlineMs: deadline.intent, hedgeAfterMs: hedge.intent }));
  const guess = guessSites(question, known, opts.site);
  const label = (ids: string[]) => (ids.length === known.length ? "ALL" : ids.join("+"));
  let recall: Recall | null = null;
  const recallP = opts.memory ? recallFor(opts.memory, question, guess, known, emit) : null;
  const planP = earlyPlanP ?? recallP!.then((r) => { recall = r; planMem = memorySnippets(memoryFacts(r, guess)); return startPlan(planMem); });
  planP.catch(() => {});
  const specTimings: Record<string, number> = {};
  const specP = runScope({ data, siteIds: guess, label: label(guess), windowA, windowB, emit, timings: specTimings, world });
  specP.catch(() => {});

  const ir = await intentP;
  let intent: Intent;
  if (ir.value) intent = { ...ir.value, source: "llm" };
  else { notes.push(`intent: model output unusable (${ir.error}); keyword rules used`); intent = { type: fallbackIntentType(question), requestedSites: [], dates: datesIn(question), source: "fallback" }; }
  if (!intent.dates.length) intent.dates = datesIn(question);
  const scope = resolveScope(question, intent, known, windowA, windowB, opts.site);
  if (!scope.ok) return clarify(scope.clarification, known);
  notes.push(...scope.notes);

  // ---- 2 + 4. decomposition and all hypotheses (reusing the speculative run when the scope matches)
  let run: ScopeRun;
  if (sameIds(scope.siteIds, guess)) { run = await specP; for (const [k, ms] of Object.entries(specTimings)) timings[k] = (timings[k] ?? 0) + ms; }
  else {
    notes.push(`scope changed from ${label(guess)} to ${scope.label} after the intent; the data work was redone`);
    emit({ type: "reset", reason: `scope is ${scope.label}` });
    run = await runScope({ data, siteIds: scope.siteIds, label: scope.label, windowA, windowB, emit, timings, world });
  }
  const { ctx, results, loadShift, tariff } = run;
  notes.push(...run.notes);
  const dec = ctx.decomposition;
  if (!dec.ok || !dec.result) return clarify(`I could not compare the two windows for ${scope.label}: ${dec.error ?? "the decomposition failed"}.`, known);
  const evidence = ctx.evidence;

  // ---- 3. plan: the model orders the tests (emphasis) and may add one query; code already ran every hypothesis
  const LATE = Symbol("late");
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const planned = await Promise.race([planP, new Promise<typeof LATE>((r) => { graceTimer = setTimeout(() => r(LATE), opts.planGraceMs ?? PLAN_GRACE_MS); })]).finally(() => clearTimeout(graceTimer));
  const late = planned === LATE;
  const pr = late ? { value: null, error: "the plan had not arrived when the data and the intent were ready" } : (planned as Awaited<typeof planP>);
  if (!pr.value) notes.push(late ? `plan: not back within ${(opts.planGraceMs ?? PLAN_GRACE_MS) / 1000} s of the data being ready; default emphasis used and the late plan dropped` : `plan: model output unusable (${pr.error}); default emphasis used`);
  const proposed = pr.value?.hypotheses ?? [];
  const isCatalog = (h: string): h is HypothesisId => (HYPOTHESIS_IDS as readonly string[]).includes(h);
  const dropped = [...new Set(proposed.filter((h) => !isCatalog(h)))];
  if (dropped.length) notes.push(`plan: dropped ids outside the catalog: ${dropped.join(", ")}`);
  const listed = [...new Set(proposed.filter(isCatalog))];
  const base = pr.value ? listed : DEFAULT_EMPHASIS[intent.type];
  const added = HYPOTHESIS_IDS.filter((h) => !base.includes(h));
  const extraSql = await timed(emit, timings, "extraSql", () => runExtraSql(pr.value?.extraSql ?? [], opts.zsql, evidence));
  const plan: Plan = { hypotheses: [...base, ...added], added, dropped, extraSql, rationale: pr.value ? "ordered by the model" : late ? "default order (the model's plan arrived too late)" : "default order (the model's plan was unusable)", source: pr.value ? "llm" : "default" };

  // ---- 5. facts (+ the M# facts of the memories H-MEM recalled; a final scope that differs from the first guess gets its own recall)
  if (recallP) {
    recall = await recallP;
    if (!sameIds(scope.siteIds, guess)) { recall = await recallFor(opts.memory!, question, scope.siteIds, known, emit); notes.push(`memory recalled again for ${scope.label}: the scope changed after the intent`); }
  }
  const memFacts = memoryFacts(recall, scope.siteIds);
  const siteNames = Object.fromEntries(known.map((s) => [s.id, s.name]));
  const facts = [...(await timed(emit, timings, "facts", async () => buildFacts({
    scope: ctx.scope, siteNames, windowA, windowB, decomposition: dec, results, evidence, rec: loadShift, tariff,
    extras: extraSql.filter((x) => x.status === "ran" && x.evidence).map((x) => ({ purpose: x.purpose, evidence: x.evidence!, rows: x.rows ?? 0 })),
  }))), ...memFacts];
  const rank = (id: string) => plan.hypotheses.indexOf(id as HypothesisId);
  const hyps: HypInfo[] = results.map((x) => ({ id: x.id, name: x.name, status: x.status })).sort((x, y) => rank(x.id) - rank(y.id));
  const vctx: VerifyCtx = { facts, evidenceIds: evidence.list().map((e) => e.id), hypotheses: hyps, requireRecommendation: facts.some((f) => f.hypothesis === "REC") };

  // ---- 6 + verify: placeholder narrative with up to 2 corrective retries, else the template
  const titles = Object.fromEntries(CATALOG.map((c) => [c.id as string, c.title]));
  const scopeText = `${scope.siteIds.map((s) => `${s} ${siteNames[s]}`).join("; ")}; window A ${windowA.from} to ${addDays(windowA.toExclusive, -1)} (baseline), window B ${windowB.from} to ${addDays(windowB.toExclusive, -1)} (current)`;
  const engineName = opts.engine ?? "markovian";
  let nr: NarrateOutcome, markovian: Awaited<ReturnType<typeof runMarkovianChain>>["report"] | undefined;
  if (engineName === "markovian") {
    const chain = await timed(emit, timings, "narrative", () => runMarkovianChain({
      env, question, type: intent.type, scopeText, scopeName: scope.label === "ALL" ? "ALL" : scope.siteIds.map((s) => `${s} ${siteNames[s]}`).join("; "),
      windows: `A ${windowA.from}..${addDays(windowA.toExclusive, -1)} | B ${windowB.from}..${addDays(windowB.toExclusive, -1)}`,
      facts, hyps, results, titles, plan, planTape, planMemories: planMem, focusDates: intent.dates, hasRecommendation: vctx.requireRecommendation === true, vctx, emphasis: base.slice(0, 6),
      maxCorrections: opts.maxCorrections ?? 2, deadlineMs: deadline.narrative, hedgeAfterMs: hedge.narrative, batchSize: opts.markovian?.batchSize, historyDir: opts.markovian?.historyDir, emit,
    }));
    nr = chain.narration; markovian = chain.report;
  } else {
    const messages = narrativeMessages({ question, type: intent.type, scopeText, facts: relevantFacts(facts, hyps, base.slice(0, 6), intent.type), hypotheses: hyps.filter((h) => !offHypotheses(intent.type).includes(h.id)), titles, focusDates: intent.dates, hasRecommendation: vctx.requireRecommendation === true });
    nr = await timed(emit, timings, "narrative", () => narrate({ env, messages, facts, vctx, maxCorrections: opts.maxCorrections ?? 2, deadlineMs: deadline.narrative, hedgeAfterMs: hedge.narrative }));
  }
  let answer: Answer;
  let verification: Verification;
  if (nr.answer) {
    answer = normalizeAnswer(nr.answer, facts, hyps);
    verification = { passed: true, attempts: nr.attempts, errors: [], errorDetail: [], history: nr.history, repairs: nr.repairs, mode: "llm" };
  } else {
    answer = await timed(emit, timings, "template", async () => normalizeAnswer(templateAnswer(facts, hyps, intent.type), facts, hyps));
    const tv = verifyAnswer(answer, vctx);
    verification = { passed: tv.passed, attempts: nr.attempts, errors: [...nr.lastErrors, ...tv.errors.map((e) => `template: ${errorLine(e)}`)], errorDetail: [...nr.lastDetail, ...tv.errors], history: nr.history, repairs: [], mode: "template" };
  }
  const decomposition: DecompositionSummary = { ok: dec.ok, error: dec.error, result: dec.result, standing: dec.standing, vatRate: dec.vatRate, evidenceId: dec.evidenceId, contractEvidenceId: dec.contractEvidenceId, warnings: dec.warnings, slotsAligned: dec.aligned.kept, slotsExpected: dec.aligned.expected };
  const out: InvestigationResult = {
    question, intent, scope: { label: scope.label, sites: scope.siteIds.map((id) => ({ id, name: siteNames[id] })), windowA, windowB }, decomposition, plan, results, evidence: evidence.list(), facts,
    recommendation: { loadShift, tariff }, answer, verification, llmCalls: [...calls], timings, notes, sampleDataNote: SAMPLE_NOTE, engine: engineName, ...(markovian ? { markovian } : {}),
  };
  // ---- H-MEM: the supported causes are written to memory with their provenance (after the answer, so the answer never waits on a failed write)
  if (opts.memory) {
    let written: WrittenMemory[] = [];
    try { written = await timed(emit, timings, "memory", () => confirmCauses(opts.memory!, out)); } catch (e) { notes.push(`memory write failed: ${e instanceof Error ? e.message : e}`); }
    emit({ type: "memory", action: "write", written: written.filter((w) => !w.skipped).map((w) => ({ id: w.id, hypothesis: w.hypothesis })), skipped: written.filter((w) => w.skipped).length });
    out.memory = memoryReport(recall, memFacts, answer, written);
  }
  timings.total = total();
  if (markovian && opts.markovian?.logPath) {
    try { appendTokenLog(opts.markovian.logPath, { at: new Date().toISOString(), question, scope: scope.label, verificationMode: verification.mode, narrativeAttempts: verification.attempts, totalMs: timings.total, timings: { ...timings }, report: markovian }); }
    catch (e) { notes.push(`token log not written: ${e instanceof Error ? e.message : e}`); }
  }
  emit({ type: "done", totalMs: timings.total });
  return out;
}
