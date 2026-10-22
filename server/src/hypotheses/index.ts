// Hypothesis catalog and runner. The catalog (id, title, one-line description) is what the LLM planner sees; code applies the decision rules.
import type { Hypothesis, HypCtx, HypothesisId, HypothesisResult } from "./types.ts";
import { result } from "./util.ts";
import { H1 } from "./h1_price_level.ts";
import { H2 } from "./h2_price_driver.ts";
import { H3 } from "./h3_weather_volume.ts";
import { H4 } from "./h4_operational_change.ts";
import { H5 } from "./h5_timing_shift.ts";
import { H6 } from "./h6_one_off_day.ts";
import { H7 } from "./h7_meter_fault.ts";
import { H8 } from "./h8_tariff_change.ts";
import { H9 } from "./h9_data_gap.ts";
import { H10 } from "./h10_carbon.ts";

export const HYPOTHESES: readonly Hypothesis[] = [H1, H2, H3, H4, H5, H6, H7, H8, H9, H10];
export const CATALOG: readonly { id: HypothesisId; name: string; title: string; description: string }[] = HYPOTHESES.map((h) => ({ id: h.id, name: h.name, title: h.title, description: h.description }));
export const HYPOTHESIS_IDS: readonly HypothesisId[] = HYPOTHESES.map((h) => h.id);

/** Runs one hypothesis. A failing data fetch becomes an inconclusive result carrying the error, never an exception. */
export async function runHypothesis(id: HypothesisId, ctx: HypCtx): Promise<HypothesisResult> {
  const h = HYPOTHESES.find((x) => x.id === id);
  if (!h) throw new Error(`unknown hypothesis ${id}`);
  try {
    return await h.run(ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result(h.id, h.name, "inconclusive", `error: ${msg.slice(0, 160)}`, { error: msg.slice(0, 300) }, [], [`error while testing: ${msg.slice(0, 300)}`]);
  }
}

export async function runAll(ctx: HypCtx, ids: readonly HypothesisId[] = HYPOTHESIS_IDS): Promise<HypothesisResult[]> {
  const out: HypothesisResult[] = [];
  for (const id of ids) out.push(await runHypothesis(id, ctx));
  return out;
}

export { buildContext } from "./context.ts";
export { THRESHOLDS } from "./thresholds.ts";
export type { HypCtx, HypothesisId, HypothesisResult, Hypothesis, Scope, Status } from "./types.ts";
