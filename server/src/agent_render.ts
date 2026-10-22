// Plain-text rendering of an investigation for the CLI: the answer with [E#] markers, the ruled-out list, the recommendation,
// the verification mode and the LLM route (model + latency) of every step. Pure.
import type { InvestigateOutcome, InvestigationResult, LlmCall } from "./agent_types.ts";
import { isClarification } from "./agent_types.ts";
import type { AnswerItem } from "./verifier.ts";

const marks = (ids: string[]): string => ids.map((e) => `[${e}]`).join("");
/** Word-wraps `text` to `width` columns; continuation lines are indented by `indent`. */
export const wrap = (text: string, width = 100, indent = ""): string => {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + w).length > width) { lines.push(line); line = indent + w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.join("\n");
};
const sentence = (it: AnswerItem, prefix: string): string => `${prefix}${wrap(`${it.text} ${marks(it.evidence)}`, 100 - prefix.length, " ".repeat(prefix.length))}`;

export function routeLine(c: LlmCall): string {
  if (!c.route) return `${c.step}: FAILED ${c.error ?? ""}`.trim();
  const r = c.route;
  const model = r.routedModel ?? r.requestedModel;
  return `${c.step}: ${model}${r.label ? ` (${r.label})` : ""} via ${r.provider}, ${(r.latencyMs / 1000).toFixed(1)} s${c.wallMs !== undefined && c.wallMs > r.latencyMs + 500 ? ` (${(c.wallMs / 1000).toFixed(1)} s wall)` : ""}${r.raceWidth ? `, race of ${r.raceWidth}` : ""}${r.fromCache ? ", from Nightshift cache" : ""}${r.fallbackReason ? " [fallback: " + r.fallbackReason.slice(0, 80) + "]" : ""}`;
}

/** H-MEM: what was recalled (each recalled memory is an M# fact) and which causes were written back. */
export function memoryLines(m: NonNullable<InvestigationResult["memory"]>): string[] {
  const lines = [`H-MEM: ${m.recalled.length} recalled for ${JSON.stringify(m.query.slice(0, 90))} (embeddings via ${m.embedRoute}, ${m.recallMs} ms); ${m.written.filter((w) => !w.skipped).length} written, ${m.written.filter((w) => w.skipped).length} already known`];
  for (const r of m.recalled) lines.push(`  ${r.factId} = ${r.id} [${r.origin}${r.site ? `, ${r.site}` : ""}] score ${r.relevance.toFixed(3)}, cited in ${r.citedIn} answer item(s): ${r.text.slice(0, 110)}`);
  for (const w of m.written.filter((x) => !x.skipped)) lines.push(`  wrote ${w.id} (${w.hypothesis}): ${w.text.slice(0, 110)}`);
  return lines;
}

/** Markovian: one line per chunk with its estimated input tokens, the naive full-history estimate, the carryover, and the totals. */
export function chainLines(c: NonNullable<InvestigationResult["markovian"]>): string[] {
  const t = c.totals, tok = (x: { estimated: number; measured: number | null }) => `${x.estimated}${x.measured !== null ? ` (measured ${x.measured})` : ""}`;
  return [`Markovian chain (${c.chunks.length} chunks, status ${c.status}; carryover bound ${c.config.carryoverTokens} tokens; tokens estimated = chars/4 unless marked measured):`,
    ...c.chunks.map((k) => `  ${String(k.id).padStart(2)} ${k.label.padEnd(36)} ${(k.ms / 1000).toFixed(1).padStart(5)} s  in ${tok(k.inputTokens).padStart(6)}  naive ${String(k.naiveInputTokens).padStart(6)}  carryover ${k.carryoverIn}->${k.carryoverOut}${k.note ? `  [${k.note.slice(0, 70)}]` : ""}`),
    `  total input: chain ${t.markovianInputEstimated} vs naive full history ${t.naiveInputEstimated} (${t.savedPercentEstimated}% less, estimated); the plain loop's plan + narrative prompt: ${t.plainLoopInputEstimated}${t.markovianInputMeasured !== null ? `; measured by the provider: ${t.markovianInputMeasured}` : ""}`];
}

export function renderAnswer(o: InvestigationResult): string {
  const a = o.answer, v = o.verification;
  const out: string[] = [];
  out.push(`Q: ${o.question}`);
  out.push(`Scope ${o.scope.label} (${o.scope.sites.map((s) => `${s.id} ${s.name}`).join("; ")}); window A ${o.scope.windowA.from}..${o.scope.windowB.from} vs window B ${o.scope.windowB.from}..${o.scope.windowB.toExclusive} (end exclusive)`);
  out.push(`NOTE: ${o.sampleDataNote}`, "");
  out.push(wrap(a.headline, 100), "");
  a.sentences.forEach((s, i) => out.push(sentence(s, `${i + 1}. `)));
  if (a.ruledOut.length) { out.push("", "Ruled out:"); for (const r of a.ruledOut) out.push(sentence(r, `  - ${r.hypothesis}: `)); }
  out.push("", a.recommendation.text ? "Recommendation:" : "Recommendation: none available");
  if (a.recommendation.text) out.push(sentence(a.recommendation, "  "));
  out.push("", `Verification: ${v.passed ? "PASSED" : "FAILED"}, mode ${v.mode}, ${v.attempts} narrative attempt(s)${v.errors.length ? `; ${v.mode === "template" ? "model attempts failed with" : "errors"}: ${v.errors.slice(0, 4).join(" | ").slice(0, 400)}` : ""}`);
  out.push(`Plan (${o.plan.source}): ${o.plan.hypotheses.join(", ")}${o.plan.added.length ? ` (added by code: ${o.plan.added.join(", ")})` : ""}${o.plan.extraSql.length ? `; extra SQL: ${o.plan.extraSql.map((x) => x.status).join(", ")}` : ""}`);
  if (o.memory) out.push(...memoryLines(o.memory));
  if (o.markovian) out.push(...chainLines(o.markovian));
  out.push("LLM routes:", ...o.llmCalls.map((c) => `  ${routeLine(c)}`));
  out.push(`Timings (ms): ${Object.entries(o.timings).map(([k, ms]) => `${k} ${ms}`).join(", ")} [plan, intent and data run concurrently, so steps overlap]`);
  if (o.notes.length) out.push(`Notes: ${o.notes.join(" | ")}`);
  return out.join("\n");
}

export function renderOutcome(o: InvestigateOutcome): string {
  if (!isClarification(o)) return renderAnswer(o);
  return [`Q: ${o.question}`, wrap(`I need one more detail: ${o.clarification}`, 100), "LLM routes:", ...o.llmCalls.map((c) => `  ${routeLine(c)}`)].join("\n");
}
