// The deterministic data work of one investigation for a fixed scope: prefetch every query in parallel, build the decomposition, run ALL catalog
// hypotheses and both recommendations. Hypotheses run one after another over the prefetched (cached) results, so evidence ids E1.. are the same
// on every run. Nothing here calls an LLM.
import type { DataLayer } from "./data.ts";
import { EvidenceStore } from "./evidence.ts";
import { HYPOTHESIS_IDS, buildContext, runHypothesis } from "./hypotheses/index.ts";
import type { HypCtx, HypothesisResult } from "./hypotheses/types.ts";
import { recommend, recommendTariff, type Recommendation, type TariffComparison } from "./recommend.ts";
import type { DateWindow } from "./windows.ts";
import { evidenceEvent, timed, type Emit } from "./agent_events.ts";

export interface ScopeRun { ctx: HypCtx; results: HypothesisResult[]; loadShift: Recommendation | null; tariff: TariffComparison | null; notes: string[] }

export async function runScope(a: { data: DataLayer; siteIds: string[]; label: string; windowA: DateWindow; windowB: DateWindow; emit: Emit; timings: Record<string, number> }): Promise<ScopeRun> {
  const { data, emit, timings } = a;
  const notes: string[] = [];
  const evidence = new EvidenceStore();
  evidence.onAdd = (e) => emit(evidenceEvent(e));
  const windows = { A: a.windowA, B: a.windowB };
  const ctx = await timed(emit, timings, "data", async () => {
    await data.prefetch?.({ sites: a.siteIds, windows });
    return buildContext({ data, scope: { label: a.label, sites: a.siteIds }, windowA: a.windowA, windowB: a.windowB, evidence });
  });
  const results: HypothesisResult[] = [];
  if (!ctx.decomposition.ok) return { ctx, results, loadShift: null, tariff: null, notes };
  await timed(emit, timings, "hypotheses", async () => {
    for (const id of HYPOTHESIS_IDS) {
      const r = await runHypothesis(id, ctx);
      results.push(r);
      emit({ type: "hypothesis", id: r.id, name: r.name, status: r.status });
    }
  });
  const loadShift = await timed(emit, timings, "recommend", () => recommend(ctx).catch((e) => { notes.push(`recommend: ${e instanceof Error ? e.message : e}`); return null; }));
  const tariff = await recommendTariff(ctx).catch((e) => { notes.push(`tariff: ${e instanceof Error ? e.message : e}`); return null; });
  return { ctx, results, loadShift, tariff, notes };
}
