// Truth labels re-derived from the plant definitions and the oracle's arithmetic (eval/oracle.ts), to check the literal `expected` maps in scenarios.ts.
// The margins keep a label away from its decision threshold: estimated quantities (H3, H4, H11) need 1.5x the threshold to be "supported" and <= 0.5x to be
// "ruled out"; exact arithmetic (H5, H6) uses +-10% / the rule's own inconclusive band. A quantity between the margins gives null (not scored).
import { THRESHOLDS as T } from "../server/src/hypotheses/thresholds.ts";
import { ANOMALY_MIN_KWH, type Truth } from "./oracle.ts";
import type { Plant } from "./plants.ts";
import type { Expect, Scored } from "./scenarios.ts";

export type Labels = Record<Scored, Expect | null>;
const has = (plants: Plant[], kind: Plant["kind"]) => plants.some((p) => p.kind === kind);

export function deriveLabels(plants: Plant[], t: Truth): Labels {
  const band = (v: number, hi: number, lo: number): Expect | null => (v >= hi ? "supported" : v <= lo ? "ruled_out" : null);
  const gapped = has(plants, "gap");
  return {
    H3: band(t.share.weather, 1.5 * T.H3_SHARE, 0.5 * T.H3_SHARE),
    H4: has(plants, "step") ? band(t.share.operational, 1.5 * T.H4_SHARE, 0.5 * T.H4_SHARE) : "ruled_out",
    H5: band(t.share.timing, 1.1 * T.H5_SHARE, 0.9 * T.H5_SHARE),
    H6: gapped ? null : band(t.share.topDay, 1.1 * T.H6_SHARE, T.NEAR_MISS_FRACTION * T.H6_SHARE),
    H7: has(plants, "zero_run") || has(plants, "flatline") || gapped ? "supported" : "ruled_out",
    H8: has(plants, "standing") ? "supported" : "ruled_out",
    H9: gapped ? "supported" : "ruled_out",
    H11: t.anomalousDays.length > 0 ? "supported" : "ruled_out",
  };
}

/** Hypotheses labelled "supported" whose cause is real data rather than a planted cause. */
export function deriveReal(plants: Plant[], t: Truth, labels: Labels): Scored[] {
  const out: Scored[] = [];
  if (labels.H3 === "supported" && !has(plants, "heating")) out.push("H3");
  const plantedDays = new Set(plants.filter((p): p is Extract<Plant, { kind: "fault_day" }> => p.kind === "fault_day").map((p) => p.date));
  if (labels.H6 === "supported" && !plantedDays.has(t.topDay.date)) out.push("H6");
  return out;
}
export { ANOMALY_MIN_KWH };
