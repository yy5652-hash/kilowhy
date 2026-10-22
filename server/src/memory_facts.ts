// Recalled memories as M# facts of the facts table, and as snippets for the plan prompt. Pure.
// An M# fact is data, not Zetaris evidence: it has no E# (evidence ""), so a sentence can cite it only next to a fact that does, and its display carries the note, who wrote it and when.
import type { Fact } from "./facts.ts";
import type { Recall, RecalledMemory } from "./memory.ts";

const who = (m: RecalledMemory): string => (m.origin === "user" ? "your note" : "earlier investigation");
const day = (iso: string): string => iso.slice(0, 10);

/**
 * One M# fact per recalled memory, best match first, limited to memories of the scope's sites (or of no site). A cause the agent confirmed for exactly these two windows is left out:
 * the investigation under way derives it again from the data, so it would only repeat itself; causes confirmed for other windows are real history and stay.
 */
export function memoryFacts(recall: Recall | null, scopeSiteIds: string[], windows?: { a: string; b: string }): Fact[] {
  if (!recall) return [];
  const seen = new Set<string>();
  const sameWindows = (m: RecalledMemory) => !!windows && !!m.key && m.key.endsWith(`:${windows.a}:${windows.b}`);
  return recall.memories.filter((m) => (!m.site || scopeSiteIds.includes(m.site)) && !sameWindows(m) && !seen.has(m.id) && seen.add(m.id)).map((m, i) => ({
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

const STOP = new Set(["this", "that", "with", "from", "their", "there", "which", "would", "about", "after", "before", "have", "were", "will", "into", "than", "then", "also"]);
const contentWords = (t: string): Set<string> => new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
const EVENT_TEXT = /^(event_\d+|schedule_event|spike_\d+_event)$/;

/**
 * Links a remembered note to the logged-event facts that talk about the same thing (two or more shared content words, e.g. "oven", "schedule", "moved"): the M# fact's label then says
 * "bears on F53", the prompt keeps those facts in view, and the narrative can put the note next to the change it explains. Deterministic; the model decides whether to use it.
 */
export function linkNotes(memFacts: Fact[], facts: Fact[], hyps: { id: string; status: string }[]): Fact[] {
  const shown = new Set(hyps.filter((h) => h.status !== "inconclusive").map((h) => h.id));   // facts of an inconclusive test never reach the narrative, so a note is not tied to them
  const subjects = facts.filter((f) => !f.memory && f.unit === "text" && typeof f.value === "string" && EVENT_TEXT.test(f.key) && !!f.hypothesis && shown.has(f.hypothesis));
  return memFacts.map((m) => {
    const mine = contentWords(String(m.value));
    const bearsOn = subjects.filter((s) => [...contentWords(String(s.value))].filter((w) => mine.has(w)).length >= 2).map((s) => s.id);
    return bearsOn.length ? { ...m, label: `${m.label}; bears on ${bearsOn.join(", ")} (same subject)`, memory: { ...m.memory!, bearsOn } } : m;
  });
}
