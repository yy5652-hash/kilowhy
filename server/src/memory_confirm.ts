// confirmCauses: after an investigation, the causes the tests supported are written to H-MEM as agent memories with their provenance
// (evidence ids, the Zetaris run ids of that evidence, the Nightshift receipt ids of the run). The text is qualitative on purpose (which cause, where, which windows):
// figures live in the evidence, so a recalled memory can never present an old number as a current one. Writing the same cause for the same windows again is a no-op.
import type { InvestigationResult } from "./agent_types.ts";
import { CATALOG } from "./hypotheses/index.ts";
import { addDays } from "./bands.ts";
import type { KilowhyMemory } from "./memory.ts";

export interface WrittenMemory { id: string; hypothesis: string; text: string; site?: string; skipped: boolean }
const NOT_CAUSES = new Set(["H7", "H9"]);   // data checks: "supported" there means a data problem was found, not a reason the bill changed

export async function confirmCauses(memory: KilowhyMemory, r: InvestigationResult): Promise<WrittenMemory[]> {
  const { windowA: a, windowB: b } = r.scope;
  const where = r.scope.sites.length === 1 ? `${r.scope.sites[0].name} (${r.scope.sites[0].id})` : r.scope.sites.length === 3 && r.scope.label === "ALL" ? "all sites" : r.scope.sites.map((s) => `${s.name} (${s.id})`).join(" and ");
  const site = r.scope.sites.length === 1 ? r.scope.sites[0].id : undefined;
  const span = `window A ${a.from} to ${addDays(a.toExclusive, -1)} and window B ${b.from} to ${addDays(b.toExclusive, -1)}`;
  const receipts = [...new Set(r.llmCalls.map((c) => c.route?.receiptId).filter((x): x is string => !!x))];
  const out: WrittenMemory[] = [];
  const pending: Promise<unknown>[] = [];
  for (const h of r.results.filter((x) => x.status === "supported" && !NOT_CAUSES.has(x.id))) {
    const key = `cause:${r.scope.label}:${h.id}:${a.from}:${b.from}`;
    const title = CATALOG.find((c) => c.id === h.id)?.title ?? h.name;
    const text = `${title} (${h.id}) was a supported cause of the change in the electricity ${h.id === "H10" ? "emissions" : "bill"} at ${where} between ${span}.`;
    if (memory.findByKey(key)) { out.push({ id: memory.findByKey(key)!.id, hypothesis: h.id, text, site, skipped: true }); continue; }
    const zetarisRunIds = [...new Set(r.evidence.filter((e) => h.evidence.includes(e.id)).map((e) => e.zetarisRunId))];
    const p = memory.remember(text, { source: "agent", site, key, evidence: h.evidence, zetarisRunIds, receiptIds: receipts, label: `${h.id} supported in investigation "${r.question.slice(0, 80)}"` });
    pending.push(p);
    out.push({ id: "", hypothesis: h.id, text, site, skipped: false });
    p.then((rec) => { const w = out.find((x) => x.id === "" && x.hypothesis === h.id); if (w) w.id = rec.id; }).catch(() => {});
  }
  await Promise.allSettled(pending);
  return out.filter((w) => w.id);
}
