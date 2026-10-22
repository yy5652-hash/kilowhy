// Markovian (Meterless engine, vendor/meterless/markovian): the LLM part of an investigation as a chain of bounded chunks run by the engine's orchestrator.
//   chunk 1   plan       the plan call (it starts at once and overlaps the data work, as in the plain loop; the chain adopts it here)
//   chunk 2+  interpret  the results of the hypotheses, a batch at a time (default 5, see BATCH_SIZE); each chunk reads only its batch plus the carryover
//   chunk n   narrative  the answer, written from the carryover and the facts it cites
//   chunk n+1 verify     the verifier; on a rejection the next narrative chunk gets the errors through the carryover, up to maxCorrections times
// Between chunks only a compact JSON state travels (markovian_state.ts), kept inside the engine's carryover budget. The generator is the provider through askJson
// (deadlines, hedging and the labelled fallback as in the plain loop). The deterministic results (hypotheses, evidence, facts) are computed before the chain and are
// identical to the plain loop's; only the prose can differ. Tokens per chunk, with the naive full-history estimate, are in the report (markovian_log.ts).
import { markovianLib } from "./engines.ts";
import { askJson, correctiveMessage, type LlmEnv } from "./agent_llm.ts";
import { narrateCheck, narrateDraft, type NarrateOutcome, type NarrativeDraft } from "./agent_narrate.ts";
import { narrativeMessages, offHypotheses, relevantFacts, planMessages, type NarrativeInput } from "./agent_prompts.ts";
import type { Fact } from "./facts.ts";
import type { HypothesisResult } from "./hypotheses/types.ts";
import type { Plan } from "./agent_types.ts";
import type { VerifyCtx, HypInfo } from "./verifier.ts";
import { checkReadings, chunkFacts, interpretMessages, INTERPRET_MAX_TOKENS, narrativeChunkMessages } from "./markovian_prompts.ts";
import { STATUS_CODE, estimateTokens, fitState, newState, parseState, serialize, clean, type ChainState } from "./markovian_state.ts";
import { chunkTokens, messageTokens, tapChat, totalsOf, withNaive, type ChainTotals, type ChunkKind, type ChunkLog, type Tape } from "./markovian_log.ts";
import type { Emit } from "./agent_events.ts";

export const CHAIN_CONFIG = { chunkSize: 4000, maxChunks: 16, carryoverTokens: 800, overlapTokens: 0 } as const;   // carryover 800 tokens = 3,200 characters of JSON
// The spec asks for batches of 3. Measured on the live stack (scripts/markovian_latency.ts, eval/latency/markovian_d3.json, 5 runs per setting): an interpret call takes 6-12 s through
// Nightshift (the labelled NVIDIA call joins after 8 s), so batches of 3 (three chunks) cost 19-31 s per question, mean 25 s, and on cold first runs the chain finished about 40 s after the
// plain loop. Batches of 5 (two chunks) cost 20-28 s, mean 23 s, about 25 s after the plain loop. The default is therefore the coarser 5; batchSize 3 stays an option (markovian.batchSize).
export const BATCH_SIZE = 5;
export const INTERPRET_DEADLINE_MS = 20_000, INTERPRET_HEDGE_MS = 8_000;   // an interpret chunk is an enrichment: after 8 s the labelled NVIDIA call joins, after 20 s the chunk goes on without its readings

export interface ChainArgs {
  env: LlmEnv;
  question: string; type: NarrativeInput["type"]; scopeText: string; scopeName: string; windows: string;
  facts: Fact[]; hyps: HypInfo[]; results: HypothesisResult[]; titles: Record<string, string>;
  plan: Plan; planTape: Tape; planMemories?: string;
  focusDates: string[]; hasRecommendation: boolean; vctx: VerifyCtx; emphasis: string[];
  maxCorrections: number; deadlineMs: number; hedgeAfterMs: number; directRetryBeforeMs?: number;
  batchSize?: number; historyDir?: string; emit?: Emit;
}
export interface MarkovianReport {
  engine: "markovian"; reference: string; config: { chunkSize: number; maxChunks: number; carryoverTokens: number; batchSize: number };
  status: string; chunks: ChunkLog[]; totals: ChainTotals; finalState: ChainState | null; carryoverShrunk: string[]; notes: string[];
}
export interface ChainResult { narration: NarrateOutcome; report: MarkovianReport }

/** The tests an interpret chunk reads: supported and ruled-out ones that matter for the question, in plan order; the data checks H7 and H9 are routine and need no reading. */
export function interpretTargets(hyps: HypInfo[], plan: string[], type: NarrativeInput["type"]): string[] {
  const rank = (id: string) => { const i = plan.indexOf(id); return i < 0 ? 99 : i; };
  return hyps.filter((h) => h.status !== "inconclusive" && !offHypotheses(type).includes(h.id) && !["H7", "H9"].includes(h.id)).map((h) => h.id).sort((x, y) => rank(x) - rank(y) || Number(x.slice(1)) - Number(y.slice(1)));
}
const batches = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const shortErrors = (errors: string[]): string[] => errors.slice(0, 3).map((e) => clean(e).slice(0, 160));
const FINAL = "[TASK_COMPLETE]";

export async function runMarkovianChain(a: ChainArgs): Promise<ChainResult> {
  const notes: string[] = [], logs: Omit<ChunkLog, "naiveInputTokens">[] = [], shrunkAll: string[] = [];
  const cfg = { ...CHAIN_CONFIG };
  const batchSize = Math.max(1, a.batchSize ?? BATCH_SIZE);
  const engine = new markovianLib.Markovian({ chunkConfig: cfg, historyDir: a.historyDir });
  const groups = batches(interpretTargets(a.hyps, a.plan.hypotheses, a.type), batchSize);
  const out: NarrateOutcome = { answer: null, attempts: 0, repairs: [], history: [], lastErrors: [], lastDetail: [] };
  let authoritative: ChainState | null = null;               // the same state kept in memory; used only if the engine hands back a state that does not parse
  let draft: NarrativeDraft | null = null;
  let directTried = false, narrativeStart = 0;

  /** Display text + the state checkpoint the engine will hand to the next chunk (shrunk to the carryover budget first). */
  const checkpoint = (display: string, s: ChainState): { text: string; state: string } => {
    const fit = fitState(s, cfg.carryoverTokens * 4);
    shrunkAll.push(...fit.shrunk.map((x) => `after ${s.done.at(-1) ?? "start"}: ${x}`));
    authoritative = fit.state;
    return { text: `${display}\n[STATE_CHECKPOINT]\n${fit.text}`, state: fit.text };
  };
  const record = (id: number, kind: ChunkKind, label: string, ms: number, tape: Tape, carryoverIn: string, carryoverOut: string, inPrompt: boolean, note?: string) => {
    const l: Omit<ChunkLog, "naiveInputTokens"> = { id, kind, label, ms, carryoverIn: estimateTokens(carryoverIn), carryoverOut: estimateTokens(carryoverOut), ...chunkTokens(tape, inPrompt ? estimateTokens(carryoverIn) : 0), ...(note ? { note } : {}) };
    logs.push(l);
    a.emit?.({ type: "chunk", id, kind, label, ms, llmCalls: l.llmCalls, inputTokens: l.inputTokens.estimated, outputTokens: l.outputTokens.estimated, carryoverTokens: l.carryoverOut, route: l.route });
  };
  const chunkEnv = (tape: Tape): LlmEnv => ({ ...a.env, chat: tapChat(a.env.chat, tape) });

  const stepFn = async ({ carryover, step }: { carryover: string; step: number }): Promise<{ content: string }> => {
    const id = step + 1;
    const parsed = carryover ? parseState(carryover) : null;
    if (carryover && !parsed) notes.push(`chunk ${id}: the carryover did not parse; the copy kept in memory was used`);
    const s: ChainState = parsed ?? authoritative ?? newState({
      q: a.question, type: a.type, scope: a.scopeName, win: a.windows, plan: a.plan.hypotheses, mem: a.facts.filter((f) => f.memory).map((f) => f.id),
      hyp: Object.fromEntries(a.hyps.map((h) => [h.id, STATUS_CODE[h.status] ?? "i"])), ev: Object.fromEntries(a.results.map((r) => [r.id, r.evidence.slice(0, 4)])),
    });
    const start = performance.now(), took = () => Math.round(performance.now() - start);

    // ---- chunk 1: the plan (its call was started at the very beginning; here its outcome becomes the first state)
    if (s.next === "plan") {
      const next: ChainState = { ...s, done: ["plan"], next: groups.length ? "interpret 1" : "narrative", open: groups.length ? ["interpret", "narrative", "verify"] : ["narrative", "verify"] };
      const cp = checkpoint(a.plan.source === "llm" ? `plan: ${a.plan.hypotheses.slice(0, 6).join(" ")} first` : `plan: default order (${a.plan.rationale})`, next);
      record(id, "plan", "plan", a.planTape.reduce((m, t) => m + t.ms, 0), a.planTape, "", cp.state, false, a.plan.source === "llm" ? undefined : a.plan.rationale);
      return { content: cp.text };
    }

    // ---- interpret chunks: a batch of test results in, plain readings out
    const im = s.next.match(/^interpret (\d+)$/);
    if (im) {
      const b = Number(im[1]), ids = groups[b - 1] ?? [];
      const label = `interpret ${b}/${groups.length} (${ids.join(", ")})`;
      const tape: Tape = [], stateText = serialize(s);
      const r = await askJson(chunkEnv(tape), label, "auto", interpretMessages({ question: a.question, scopeText: a.scopeText, state: stateText, ids, label: `${b} of ${groups.length}`, hyps: a.hyps, titles: a.titles, facts: a.facts }), checkReadings(ids),
        { maxTokens: INTERPRET_MAX_TOKENS, deadlineMs: INTERPRET_DEADLINE_MS, hedgeAfterMs: INTERPRET_HEDGE_MS, retryTransient: true });
      const read = { ...s.read };
      let note: string | undefined;
      if (r.value) { for (const x of r.value.readings) read[x.id] = x.reading; if (r.value.dropped.length) note = `readings dropped: ${r.value.dropped.join("; ")}`; } else note = `no readings: ${r.error}`;
      if (note) notes.push(`${label}: ${note}`);
      const more = b < groups.length;
      const next: ChainState = { ...s, read, done: [...s.done, `interpret ${b}/${groups.length}`], next: more ? `interpret ${b + 1}` : "narrative", open: more ? ["interpret", "narrative", "verify"] : ["narrative", "verify"] };
      const cp = checkpoint(`${label}: ${r.value ? r.value.readings.length : 0} readings`, next);
      record(id, "interpret", label, took(), tape, stateText, cp.state, true, note);
      return { content: cp.text };
    }

    // ---- narrative chunk: a draft from the carryover and the facts it cites; a later one corrects a rejected draft
    if (s.next === "narrative") {
      const attempt = s.att + 1, label = attempt === 1 ? "narrative" : `narrative (correction ${attempt - 1})`;
      if (attempt === 1) narrativeStart = performance.now();
      const tape: Tape = [], stateText = serialize(s);
      const input: NarrativeInput = { question: a.question, type: a.type, scopeText: a.scopeText, facts: chunkFacts(a.facts, a.hyps, a.emphasis, a.type, s), hypotheses: a.hyps.filter((h) => !offHypotheses(a.type).includes(h.id)), titles: a.titles, focusDates: a.focusDates, hasRecommendation: a.hasRecommendation };
      const base = narrativeChunkMessages(input, stateText);
      const previous = draft ? (draft.value ? JSON.stringify(draft.value) : draft.rawText ?? "") : "";
      const messages = attempt === 1 ? base : [...base, { role: "assistant" as const, content: previous.slice(0, 3000) }, { role: "user" as const, content: correctiveMessage(out.lastErrors) }];
      out.attempts = attempt;
      draft = await narrateDraft({ env: chunkEnv(tape), messages, step: label, deadlineMs: a.deadlineMs, hedgeAfterMs: a.hedgeAfterMs, allowDirect: !directTried && performance.now() - narrativeStart < (a.directRetryBeforeMs ?? 40_000) });
      directTried ||= draft.directTried;
      const next: ChainState = { ...s, att: attempt, done: [...s.done, label], next: "verify", open: ["verify"] };
      const cp = checkpoint(`${label}: ${draft.value ? "draft written" : `no draft (${draft.error})`}`, next);
      record(id, "narrative", label, took(), tape, stateText, cp.state, true, draft.value ? undefined : draft.error);
      return { content: cp.text };
    }

    // ---- verify chunk (code only): render the placeholders and run the verifier; on a rejection the errors travel on in the carryover
    if (s.next === "verify") {
      const attempt = s.att;
      const c = draft?.value ? narrateCheck(draft.value, a.facts, a.vctx) : null;
      if (c?.answer) {
        out.answer = c.answer; out.repairs = c.repairs; out.lastErrors = []; out.lastDetail = [];
        record(id, "verify", "verify (passed)", took(), [], "", "", false);
        return { content: `verify: passed after ${attempt} narrative draft(s)\n${FINAL}` };
      }
      const errors = c ? c.errors : [draft && !draft.value ? draft.error : "no draft"];
      out.lastErrors = errors; out.lastDetail = c ? c.detail : [];
      out.history.push({ attempt, errors, repairs: c ? c.rejectedRepairs : [] });
      // as in the plain loop: a provider that returned nothing at all will not do better on a retry; a reply that could not be used or verified gets a correction
      const retry = attempt < 1 + a.maxCorrections && (c !== null || draft?.rawText !== undefined);
      if (!retry) { record(id, "verify", "verify (failed)", took(), [], "", "", false, errors[0]); return { content: `verify: rejected, no correction left\n${FINAL}` }; }
      const next: ChainState = { ...s, done: [...s.done, `verify ${attempt}`], next: "narrative", err: shortErrors(errors), open: ["narrative", "verify"] };
      const cp = checkpoint(`verify: rejected (${errors.length} problem${errors.length === 1 ? "" : "s"}), correcting`, next);
      record(id, "verify", `verify (rejected ${attempt})`, took(), [], "", cp.state, false, errors[0]);
      return { content: cp.text };
    }
    return { content: `done\n${FINAL}` };
  };

  const run = await engine.run({ goal: a.question, reflect: false, stepFn });
  if (run.status !== "completed") notes.push(`the chain ended with status ${run.status}${run.error ? `: ${run.error}` : ""}`);
  const emphasisFacts = relevantFacts(a.facts, a.hyps, a.emphasis, a.type);
  const plainPrompt = messageTokens(planMessages({ question: a.question, memories: a.planMemories })) +
    messageTokens(narrativeMessages({ question: a.question, type: a.type, scopeText: a.scopeText, facts: emphasisFacts, hypotheses: a.hyps.filter((h) => !offHypotheses(a.type).includes(h.id)), titles: a.titles, focusDates: a.focusDates, hasRecommendation: a.hasRecommendation }));
  const chunks = withNaive(logs);
  const ref = { totalTokensUsed: run.totalTokensUsed, tokensSaved: run.totalTokensSaved, efficiencyPercent: Math.round(run.efficiencyPercent * 10) / 10, label: "the engine's own run accounting: tokens of the chunks' display text (estimated, chars/4) against its configured carryover" };
  return {
    narration: out,
    report: {
      engine: "markovian", reference: "vendor/meterless/markovian (Apache-2.0)", config: { chunkSize: cfg.chunkSize, maxChunks: cfg.maxChunks, carryoverTokens: cfg.carryoverTokens, batchSize },
      status: run.status, chunks, totals: totalsOf(chunks, plainPrompt, ref), finalState: authoritative, carryoverShrunk: shrunkAll, notes,
    },
  };
}
