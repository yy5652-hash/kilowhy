// H5 timing_shift: did usage move between cheap and dear slots? Decision on the exact timing effect T of the decomposition.
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { bandShares } from "./analysis.ts";
import { loadSlots } from "./context.ts";
import { BAND_NAMES } from "../bands.ts";
import { gbp, metricMap, pctText, result, round, signed, signedGbp, unavailable } from "./util.ts";

/** supported if |T| >= 10% of |dC|, else ruled_out (binary, as in the spec). */
export function decideH5(timingPence: number, deltaPence: number): { status: Status; share: number } {
  if (deltaPence === 0) return { status: "inconclusive", share: 0 };
  const share = Math.abs(timingPence) / Math.abs(deltaPence);
  return { status: share >= T.H5_SHARE ? "supported" : "ruled_out", share };
}

export const H5: Hypothesis = {
  id: "H5", name: "timing_shift", title: "Timing shift",
  description: "Did usage move to dearer or cheaper times of day? Timing effect T (new usage shape at new prices) as a share of the change, plus kWh share per time band A vs B.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok || !d.result) return unavailable("H5", "timing_shift", d.error ?? "decomposition unavailable");
    const r = d.result;
    const { evidence: ev, aligned } = await loadSlots(ctx, "H5", `kWh share per time band and timing effect (${ctx.scope.label})`);
    const g = decideH5(r.timing, r.deltaTotal);
    const sa = bandShares(aligned.A), sb = bandShares(aligned.B);
    const m: Record<string, [number | string | boolean | null, string]> = { timing_T: [gbp(r.timing), "GBP"], timing_share_of_delta: [g.share, "ratio"] };
    const bands: Record<string, { A: number; B: number; pp: number }> = {};
    for (const k of BAND_NAMES) { bands[k] = { A: sa[k], B: sb[k], pp: (sb[k] - sa[k]) * 100 }; m[`kwh_share_${k}_A`] = [sa[k], "ratio"]; m[`kwh_share_${k}_B`] = [sb[k], "ratio"]; }
    m.peak_share_change_pp = [bands.peak.pp, "pp"];
    ctx.evidence.addMetrics(ev.id, metricMap(m));
    const biggest = BAND_NAMES.reduce((best, k) => (Math.abs(bands[k].pp) > Math.abs(bands[best].pp) ? k : best), BAND_NAMES[0]);
    return result("H5", "timing_shift", g.status,
      `T ${signedGbp(r.timing)} = ${pctText(g.share)} of change; peak-band kWh share ${signed(bands.peak.pp, 1)} pp; largest band move ${biggest} ${signed(bands[biggest].pp, 1)} pp`,
      { T_gbp: gbp(r.timing), T_share_of_delta: round(g.share, 4), peak_share_change_pp: round(bands.peak.pp, 3), largest_band_move: biggest, largest_band_move_pp: round(bands[biggest].pp, 3) },
      [d.evidenceId, ev.id], [`rule: |T| >= ${T.H5_SHARE * 100}% of |change| (supported), else ruled out`], { bands });
  },
};
