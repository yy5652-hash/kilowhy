// H1 price_level: did the half-hourly prices themselves change? Decision on the exact price-level effect L of the decomposition.
import { BAND_NAMES } from "../bands.ts";
import type { Hypothesis } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { bandMeans } from "./analysis.ts";
import { loadSlots } from "./context.ts";
import { gbp, gradeEffect, metricMap, pctText, result, round, signedGbp, unavailable } from "./util.ts";

export const decideH1 = (L: number, deltaC: number) => gradeEffect(L, deltaC, T.H1_SHARE);

export const H1: Hypothesis = {
  id: "H1", name: "price_level", title: "Price level",
  description: "Did unit prices rise? Price-level effect L (window-B prices on the window-A usage shape) as a share of the bill change, plus average price per time band A vs B.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok || !d.result) return unavailable("H1", "price_level", d.error ?? "decomposition unavailable");
    const r = d.result;
    const { evidence: ev, aligned } = await loadSlots(ctx, "H1", `Price level A vs B (${ctx.scope.label})`);
    const g = decideH1(r.price, r.deltaTotal);
    const a = bandMeans(aligned.A, (s) => s.p), b = bandMeans(aligned.B, (s) => s.p);
    const bands: Record<string, { A: number | null; B: number | null; pct: number | null }> = {};
    const m: Record<string, [number | string | boolean | null, string]> = {
      L: [gbp(r.price), "GBP"], delta_total: [gbp(r.deltaTotal), "GBP"], L_share_of_delta: [g.share, "ratio"],
      avg_price_A: [r.pbarA, "p/kWh"], avg_price_B_on_A_shape: [r.pbarBStar, "p/kWh"], avg_price_B: [r.pbarB, "p/kWh"],
    };
    for (const k of BAND_NAMES) {
      const pa = a[k], pb = b[k];
      const pct = pa !== null && pb !== null && Math.abs(pa) > 0.5 ? (pb - pa) / Math.abs(pa) : null;
      bands[k] = { A: pa, B: pb, pct };
      m[`price_${k}_A`] = [pa, "p/kWh"]; m[`price_${k}_B`] = [pb, "p/kWh"]; m[`price_${k}_pct`] = [pct, "ratio"];
    }
    ctx.evidence.addMetrics(ev.id, metricMap(m));
    const peak = bands.peak;
    return result("H1", "price_level", g.status,
      `L ${signedGbp(r.price)} = ${pctText(g.share)} of change ${signedGbp(r.deltaTotal)}; avg price on A shape ${round(r.pbarA)} -> ${round(r.pbarBStar)} p/kWh`,
      { L_gbp: gbp(r.price), delta_total_gbp: gbp(r.deltaTotal), L_share_of_delta: round(g.share, 4), avg_price_A_p: round(r.pbarA, 3), avg_price_B_on_A_shape_p: round(r.pbarBStar, 3), peak_price_pct: peak.pct === null ? null : round(peak.pct, 4) },
      [d.evidenceId, ev.id], [`rule: supported if L has the direction of the change and |L| >= ${T.H1_SHARE * 100}% of |change|`], { bands });
  },
};
