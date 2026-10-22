// Plain-text rendering of the trust ledger and of a recall, for scripts/note.ts and the demo. Pure.
import type { LedgerEntry } from "../../vendor/meterless/hmem/reference/src/index.ts";
import type { Recall, RecalledMemory } from "./memory.ts";

const changed = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): string[] =>
  Object.keys(b).filter((k) => k !== "embedding" && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
const r2 = (x: unknown): string => (typeof x === "number" ? String(Math.round(x * 100) / 100) : String(x));
const short = (s: unknown, n = 90): string => { const t = typeof s === "string" ? s : JSON.stringify(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function detail(e: LedgerEntry): string {
  const n = e.newState as Record<string, any> | undefined, p = e.previousState as Record<string, any> | undefined;
  if (e.action === "create" && n) return `${n.layer} memory, source ${n.source}, confidence ${n.confidence}, domain ${n.domain}; ${short(n.content)}${n.provenance?.refs?.length ? `; provenance refs: ${n.provenance.refs.join(", ")}` : ""}`;
  if (e.action === "update") return `changed ${changed(p, n).map((k) => `${k}${k === "confidence" ? ` ${r2(p?.[k])} -> ${r2(n?.[k])}` : ""}`).join(", ") || "nothing"}`;
  if (e.action === "read") return `recalled for the query ${short(e.details?.query, 120)}`;
  if (e.action === "feedback") return `${e.details?.kind} (${(e.details?.delta as number) >= 0 ? "+" : ""}${e.details?.delta}), confidence ${r2(p?.confidence)} -> ${r2(n?.confidence)}`;
  return short(e.details ?? "");
}

export function renderAudit(id: string, entries: readonly LedgerEntry[]): string {
  if (!entries.length) return `No ledger entries for ${id}.`;
  return [`Trust ledger of ${id} (H-MEM, append-only; ${entries.length} entries)`, ...entries.map((e) => `  ${new Date(e.timestamp).toISOString()}  ${e.action.padEnd(9)} by ${e.actor.padEnd(14)} ${detail(e)}`)].join("\n");
}

export function renderMemory(m: RecalledMemory): string {
  return `${m.id} [${m.origin}${m.site ? `, ${m.site}` : ""}${m.validFrom ? `, from ${m.validFrom}` : ""}] ${m.layer}, confidence ${m.confidence}, learned ${m.learnedAt.slice(0, 10)}: ${m.text}`;
}

export function renderRecall(r: Recall): string {
  return [`Recall for ${JSON.stringify(r.query)}${r.site ? ` (site ${r.site})` : ""}: ${r.memories.length} memor${r.memories.length === 1 ? "y" : "ies"}; embeddings via ${r.embed.route} in ${r.embed.ms} ms${r.embed.fallback ? ` (${r.embed.fallback})` : ""}`,
    `  trace: ${r.trace.retrievalReason}; strategy ${r.trace.strategy}`, ...r.memories.map((m) => `  score ${m.relevance.toFixed(3)}  ${renderMemory(m)}`)].join("\n");
}
