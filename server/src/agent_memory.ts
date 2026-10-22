// H-MEM in the agent loop: recall at the start (one query per site in scope: "<site name>: <question>"), M# facts, the report of what was recalled and written.
import type { Emit } from "./agent_events.ts";
import type { MemoryReport } from "./agent_types.ts";
import type { Answer } from "./verifier.ts";
import type { Fact } from "./facts.ts";
import type { KilowhyMemory, Recall } from "./memory.ts";
import type { WrittenMemory } from "./memory_confirm.ts";
import type { SiteRef } from "./worldmodel_resolve.ts";

/** Recalls for every site in scope (in parallel) and merges: a memory keeps its best relevance, the best RECALL k remain. Never throws: no recall means no memory facts. */
export async function recallFor(memory: KilowhyMemory, question: string, siteIds: string[], known: SiteRef[], emit: Emit, k = 5): Promise<Recall | null> {
  try {
    const parts = await Promise.all(siteIds.map((id) => memory.recall(`${known.find((s) => s.id === id)?.name ?? id}: ${question}`, { site: id, k })));
    const best = new Map<string, Recall["memories"][number]>();
    for (const m of parts.flatMap((p) => p.memories)) if (!best.has(m.id) || best.get(m.id)!.relevance < m.relevance) best.set(m.id, m);
    const memories = [...best.values()].sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id)).slice(0, k);
    const first = parts[0];
    if (!first) return null;
    const recall: Recall = { query: parts.map((p) => p.query).join(" | "), memories, context: parts.map((p) => p.context).filter(Boolean).join("\n"), trace: first.trace, embed: { route: first.embed.route, ms: Math.max(...parts.map((p) => p.embed.ms)), ...(first.embed.fallback ? { fallback: first.embed.fallback } : {}) } };
    emit({ type: "memory", action: "recall", query: recall.query, count: memories.length, ids: memories.map((m) => m.id), route: recall.embed.route, ms: recall.embed.ms });
    return recall;
  } catch { return null; }
}

const cites = (a: Answer, id: string): number => [...a.sentences, ...a.ruledOut, a.recommendation].filter((it) => it.facts.includes(id)).length + (a.headline.includes(`{${id}}`) ? 1 : 0);

export function memoryReport(recall: Recall | null, memFacts: Fact[], answer: Answer, written: WrittenMemory[]): MemoryReport {
  return {
    query: recall?.query ?? "", embedRoute: recall?.embed.route ?? "none", recallMs: recall?.embed.ms ?? 0,
    recalled: memFacts.map((f) => ({ id: f.memory!.id, factId: f.id, relevance: Number((f.memory!.relevance).toFixed(4)), origin: f.memory!.origin, site: f.memory!.site, learnedAt: f.memory!.learnedAt, text: String(f.value), citedIn: cites(answer, f.id) })),
    written: written.map((w) => ({ id: w.id, hypothesis: w.hypothesis, text: w.text, skipped: w.skipped })),
  };
}
