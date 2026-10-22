// Recalled memories as M# facts of the facts table, and as snippets for the plan prompt. Pure.
// An M# fact is data, not Zetaris evidence: it has no E# (evidence ""), so a sentence can cite it only next to a fact that does, and its display carries the note, who wrote it and when.
import type { Fact } from "./facts.ts";
import type { Recall, RecalledMemory } from "./memory.ts";

const who = (m: RecalledMemory): string => (m.origin === "user" ? "your note" : "earlier investigation");
const day = (iso: string): string => iso.slice(0, 10);

/** One M# fact per recalled memory, best match first, limited to memories of the scope's sites (or of no site). */
export function memoryFacts(recall: Recall | null, scopeSiteIds: string[]): Fact[] {
  if (!recall) return [];
  const seen = new Set<string>();
  return recall.memories.filter((m) => (!m.site || scopeSiteIds.includes(m.site)) && !seen.has(m.id) && seen.add(m.id)).map((m, i) => ({
    id: `M${i + 1}`, key: `memory_${i + 1}`,
    label: `Remembered ${m.origin === "user" ? "note from the owner" : "finding of an earlier investigation"}${m.site ? ` about ${m.site}` : ""}${m.validFrom ? `, applies from ${m.validFrom}` : ""} (H-MEM ${m.id})`,
    value: m.text, unit: "text", display: `"${m.text}" (${who(m)}, ${day(m.learnedAt)})`, evidence: "",
    memory: { id: m.id, origin: m.origin, site: m.site, learnedAt: m.learnedAt, validFrom: m.validFrom, confidence: m.confidence, relevance: m.relevance },
  }));
}

/** The lines the plan prompt shows under "remembered notes". Empty string when nothing was recalled. */
export function memorySnippets(facts: Fact[]): string {
  return facts.filter((f) => f.memory).map((f) => `- ${f.id} (${f.memory!.origin === "user" ? "owner's note" : "earlier finding"}, ${day(f.memory!.learnedAt)}${f.memory!.site ? `, ${f.memory!.site}` : ""}): ${f.value}`).join("\n");
}
