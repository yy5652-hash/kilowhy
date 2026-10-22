// Scoring of scenario runs against the expected statuses. "Supported" is the positive class.
//   true positive   expected supported, got supported        false positive  expected ruled_out, got supported
//   false negative  expected supported, got ruled_out OR inconclusive (a hedge is not a detection)
//   hedged          expected ruled_out, got inconclusive (counted as a negative for precision, but not an exact match)
import { THRESHOLDS as T } from "../server/src/hypotheses/thresholds.ts";
import type { HypothesisResult, Status } from "../server/src/hypotheses/types.ts";
import type { ScenarioRun } from "./run.ts";
import { REFERENCE, SCORED, type Expect, type Scored } from "./scenarios.ts";

export type Outcome = "tp" | "fn_missed" | "fn_hedged" | "fp" | "tn" | "tn_hedged";
export const isMatch = (o: Outcome): boolean => o === "tp" || o === "tn";

export function outcomeOf(expected: Expect, got: Status): Outcome {
  if (expected === "supported") return got === "supported" ? "tp" : got === "ruled_out" ? "fn_missed" : "fn_hedged";
  return got === "supported" ? "fp" : got === "ruled_out" ? "tn" : "tn_hedged";
}

export interface Statistic { name: string; text: string; value: number | string | null; threshold: string }
const pct = (x: unknown): string => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "n/a");
const num = (x: unknown, d = 1): string => (typeof x === "number" ? x.toFixed(d) : "n/a");

/** The measured statistic behind a verdict, next to the threshold of its rule (thresholds are read from thresholds.ts, never copied). */
export function statisticOf(r: HypothesisResult): Statistic {
  const s = r.summary;
  switch (r.id) {
    case "H1": return { name: "L share of change", value: s.L_share_of_delta as number, threshold: `>= ${pct(T.H1_SHARE)}`, text: `L = ${pct(s.L_share_of_delta)} of the change (rule: supported at >= ${pct(T.H1_SHARE)})` };
    case "H2": return { name: "corr(price, wind) in B", value: s.corr_price_wind_B as number, threshold: `<= ${T.H2_CORR} with gas >= +${T.H2_GAS_PP} pp or wind <= -${T.H2_WIND_PP} pp`, text: `corr ${num(s.corr_price_wind_B, 2)}, gas ${num(s.delta_gas_pp)} pp, wind ${num(s.delta_wind_pp)} pp` };
    case "H3": return { name: "weather share of change", value: s.v_weather_share as number, threshold: `>= ${pct(T.H3_SHARE)} and beta t >= ${T.H3_T}`, text: `weather = ${pct(s.v_weather_share)} of the change (rule >= ${pct(T.H3_SHARE)}), beta t = ${num(s.beta_t)} (rule >= ${T.H3_T})` };
    case "H4": return { name: "operational share of change", value: s.v_operational_share as number, threshold: `>= ${pct(T.H4_SHARE)} with an event step (abs t >= ${T.H4_T}); ruled out below ${pct(T.H4_SHARE * T.NEAR_MISS_FRACTION)}`, text: `V_op = ${pct(s.v_operational_share)} of the change (rule >= ${pct(T.H4_SHARE)} and an event step; ruled out below ${pct(T.H4_SHARE * T.NEAR_MISS_FRACTION)}), events with a step: ${s.steps}` };
    case "H5": return { name: "timing share of change", value: s.T_share_of_delta as number, threshold: `>= ${pct(T.H5_SHARE)}`, text: `T = ${pct(s.T_share_of_delta)} of the change (rule >= ${pct(T.H5_SHARE)})` };
    case "H6": return { name: "largest-day share of change", value: s.top_day_share as number, threshold: `>= ${pct(T.H6_SHARE)}; ruled out below ${pct(T.H6_SHARE * T.NEAR_MISS_FRACTION)}`, text: `top day ${s.top_day ?? "n/a"} = ${pct(s.top_day_share)} of the change (rule >= ${pct(T.H6_SHARE)}; ruled out below ${pct(T.H6_SHARE * T.NEAR_MISS_FRACTION)})` };
    case "H7": return { name: "faults found", value: (s.zero_runs as number) + (s.flatlines as number) + (s.duplicate_timestamps as number) + (s.days_not_48_slots as number), threshold: `>= 1 (zero run >= ${T.H7_ZERO_RUN_SLOTS}, flatline >= ${T.H7_FLATLINE_SLOTS}, short day)`, text: `${s.zero_runs} zero run(s), ${s.flatlines} flatline(s), ${s.duplicate_timestamps} duplicate ts, ${s.days_not_48_slots} short day(s)` };
    case "H8": return { name: "standing charge A -> B", value: `${s.standing_A_p_per_day} -> ${s.standing_B_p_per_day}`, threshold: "any change of product, tariff or standing charge", text: `standing ${s.standing_A_p_per_day} -> ${s.standing_B_p_per_day} p/day, product ${s.product_A} -> ${s.product_B}` };
    case "H9": return { name: "site-windows with a gap", value: s.site_windows_with_gap as number, threshold: `>= 1 (rows != ${s.expected_rows_per_window})`, text: `${s.site_windows_with_gap} of ${s.site_windows_checked} site-windows incomplete` };
    case "H10": return { name: "emissions change", value: s.delta_kg as number, threshold: `a component >= ${pct(T.H10_SHARE)}`, text: `emissions ${num(s.delta_kg)} kgCO2e` };
    case "H11": return { name: "largest |z| of a site-day", value: s.max_abs_z as number, threshold: `>= ${T.H11_Z}`, text: `largest |z| ${num(s.max_abs_z)} (rule >= ${T.H11_Z}), ${s.n_flagged} flagged` };
  }
}

export interface Pair { scenario: number; id: Scored; expected: Expect; got: Status; outcome: Outcome; planted: boolean; stat: Statistic; headline: string }
export interface Tally { tp: number; fp: number; fn: number; tn: number; hedged: number; fnHedged: number; precision: number | null; recall: number | null; f1: number | null; n: number }

export function tally(pairs: Pair[]): Tally {
  const c = (o: Outcome) => pairs.filter((p) => p.outcome === o).length;
  const tp = c("tp"), fp = c("fp"), fnH = c("fn_hedged"), fn = c("fn_missed") + fnH, tn = c("tn"), hedged = c("tn_hedged");
  const precision = tp + fp ? tp / (tp + fp) : null, recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, tn, hedged, fnHedged: fnH, precision, recall, f1, n: pairs.length };
}

export function pairsOf(runs: ScenarioRun[]): Pair[] {
  const out: Pair[] = [];
  for (const run of runs) for (const id of SCORED) {
    const expected = run.scenario.expected[id], r = run.results.find((x) => x.id === id);
    if (expected === null || !r) continue;
    out.push({ scenario: run.scenario.n, id, expected, got: r.status, outcome: outcomeOf(expected, r.status), planted: expected === "supported" && !run.scenario.real.includes(id), stat: statisticOf(r), headline: r.headline });
  }
  return out;
}

/** Reference statuses of the real-data hypotheses: the status measured on scenario 1 (nothing planted); the other scenarios are compared with it. */
export function references(runs: ScenarioRun[]): { ref: Record<string, Status>; rows: { scenario: number; id: string; ref: Status; got: Status; same: boolean; stat: Statistic }[] } {
  const first = runs.find((r) => r.scenario.n === 1) ?? runs[0];
  const ref = Object.fromEntries(REFERENCE.map((id) => [id, first.results.find((x) => x.id === id)!.status])) as Record<string, Status>;
  const rows = runs.flatMap((run) => REFERENCE.map((id) => { const r = run.results.find((x) => x.id === id)!; return { scenario: run.scenario.n, id, ref: ref[id], got: r.status, same: r.status === ref[id], stat: statisticOf(r) }; }));
  return { ref, rows };
}
