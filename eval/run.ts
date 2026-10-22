// Runs the decomposition, all hypotheses and the recommendation on a scenario through the injectable data layer (no Zetaris), and scores the outcome.
// Meter kWh are SAMPLE data; prices, carbon and temperatures are the real snapshot. Nothing here changes a threshold.
import { WINDOW_A, WINDOW_B } from "../server/src/windows.ts";
import { buildContext, runAll, THRESHOLDS } from "../server/src/hypotheses/index.ts";
import type { HypCtx, HypothesisResult } from "../server/src/hypotheses/types.ts";
import { recommend, type Recommendation } from "../server/src/recommend.ts";
import { buildBaseline, EVAL_SITE_ID, type Baseline } from "./baseline.ts";
import { scenarioLayer } from "./layer.ts";
import { truthOf, type Truth } from "./oracle.ts";
import { applyPlants, type Planted } from "./plants.ts";
import type { RealWindows } from "./real.ts";
import type { Scenario } from "./scenarios.ts";

export interface DecompositionCheck {
  ok: boolean; error?: string;
  deltaGbp: number; volumeGbp: number; priceGbp: number; timingGbp: number; standingGbp: number;
  identityErrorPence: number;        // |V+L+T+S - dC| in pence, plain float sum (the spec bound is 1 pence = 0.01 GBP)
  identityOk: boolean;
  compensatedErrorPence: number;     // the same with the library's compensated sum
  slotsKept: number; slotsExpected: number;
  trueDeltaGbp: number;              // the oracle's independent bill change on the full true series
}
export interface RecCheck { ok: boolean; shiftedKwh: number; savedGbp: number; daysShifted: number; found: boolean; expectedFound: boolean; match: boolean; text: string }
export interface ScenarioRun {
  scenario: Scenario; truth: Truth; planted: Planted;
  decomposition: DecompositionCheck;
  results: HypothesisResult[];
  recommendation: RecCheck;
  evidenceRecords: number;
}

/** The recommendation "finds flexible peak-band load" when it shifts at least this many kWh in total (fixed before the runs; half of one day at the 10 kWh/day cap). */
export const REC_FOUND_KWH = 5;

const pence = (x: number): number => Math.round(x * 1000) / 1000;
const gbp = (x: number): number => Math.round(x) / 100;

export async function runScenario(real: RealWindows, scenario: Scenario, base: Baseline = buildBaseline(real)): Promise<ScenarioRun> {
  const planted = applyPlants(base, scenario.plants);
  const truth = truthOf(planted, real.slots.map((s) => s.p));
  const layer = scenarioLayer(real, planted);
  const ctx: HypCtx = await buildContext({ data: layer.data, scope: { label: EVAL_SITE_ID, sites: [EVAL_SITE_ID] }, windowA: WINDOW_A, windowB: WINDOW_B });
  const d = ctx.decomposition, r = d.result;
  const decomposition: DecompositionCheck = r
    ? {
      ok: true, deltaGbp: gbp(r.deltaTotal), volumeGbp: gbp(r.volume), priceGbp: gbp(r.price), timingGbp: gbp(r.timing), standingGbp: gbp(r.standing),
      identityErrorPence: pence(Math.abs(r.volume + r.price + r.timing + r.standing - r.deltaTotal)), compensatedErrorPence: r.identityError,
      identityOk: Math.abs(r.volume + r.price + r.timing + r.standing - r.deltaTotal) < 1, slotsKept: d.aligned.kept, slotsExpected: d.aligned.expected, trueDeltaGbp: gbp(truth.deltaC),
    }
    : { ok: false, error: d.error, deltaGbp: NaN, volumeGbp: NaN, priceGbp: NaN, timingGbp: NaN, standingGbp: NaN, identityErrorPence: NaN, compensatedErrorPence: NaN, identityOk: false, slotsKept: d.aligned.kept, slotsExpected: d.aligned.expected, trueDeltaGbp: gbp(truth.deltaC) };
  const results = await runAll(ctx);
  const rec: Recommendation = await recommend(ctx);
  const found = rec.ok && rec.total.shiftedKwh >= REC_FOUND_KWH;
  const recommendation: RecCheck = { ok: rec.ok, shiftedKwh: Math.round(rec.total.shiftedKwh * 10) / 10, savedGbp: rec.total.savedGbp, daysShifted: rec.total.daysShifted, found, expectedFound: scenario.flexiblePeak, match: found === scenario.flexiblePeak, text: rec.text };
  return { scenario, truth, planted, decomposition, results, recommendation, evidenceRecords: ctx.evidence.list().length };
}

export async function runScenarios(real: RealWindows, scenarios: Scenario[]): Promise<ScenarioRun[]> {
  const base = buildBaseline(real);
  const out: ScenarioRun[] = [];
  for (const s of scenarios) out.push(await runScenario(real, s, base));
  return out;
}

export { THRESHOLDS };
