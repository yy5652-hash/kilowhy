// Small helpers shared by the hypotheses.
import type { HypCtx, HypothesisId, HypothesisResult, Status, SummaryValue } from "./types.ts";
import type { FetchMeta } from "../data.ts";
import type { MetricValue } from "../evidence.ts";
import { THRESHOLDS } from "./thresholds.ts";

export const gbp = (pence: number): number => Math.round(pence) / 100;
export const round = (x: number, d = 2): number => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : NaN);
export const fin = (x: number | null | undefined): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
export const pctText = (x: number, d = 0): string => `${(x * 100).toFixed(d)}%`;
export const signed = (x: number, d = 2): string => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(d)}`;
export const signedGbp = (pence: number): string => `${pence >= 0 ? "+" : "-"}£${Math.abs(pence / 100).toFixed(2)}`;
export const metricMap = (m: Record<string, [MetricValue["value"], string]>): Record<string, MetricValue> =>
  Object.fromEntries(Object.entries(m).map(([k, [value, unit]]) => [k, { value, unit }]));

export const fetchMeta = (ctx: HypCtx, hypothesisId: string, title: string): FetchMeta => ({ store: ctx.evidence, hypothesisId, title });

/** Decision for an effect that must reach `threshold` x |dC| in the direction of dC. */
export function gradeEffect(effectPence: number, deltaPence: number, threshold: number): { status: Status; share: number; signedEffect: number } {
  const dir = Math.sign(deltaPence);
  if (dir === 0) return { status: "inconclusive", share: 0, signedEffect: 0 };
  const signedEffect = effectPence * dir;
  const share = Math.abs(effectPence) / Math.abs(deltaPence);
  if (signedEffect > 0 && share >= threshold) return { status: "supported", share, signedEffect };
  if (signedEffect <= 0 || share < threshold * THRESHOLDS.NEAR_MISS_FRACTION) return { status: "ruled_out", share, signedEffect };
  return { status: "inconclusive", share, signedEffect };
}

export function result(id: HypothesisId, name: string, status: Status, headline: string, summary: Record<string, SummaryValue>, evidence: string[], notes: string[] = [], details?: Record<string, unknown>): HypothesisResult {
  return { id, name, status, headline, summary, evidence: [...new Set(evidence)], notes, ...(details ? { details } : {}) };
}

export function unavailable(id: HypothesisId, name: string, why: string, evidence: string[] = []): HypothesisResult {
  return result(id, name, "inconclusive", `not testable: ${why}`, { reason: why }, evidence, [why]);
}
