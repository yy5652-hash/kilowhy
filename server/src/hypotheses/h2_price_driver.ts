// H2 price_driver_generation: is the price move explained by the generation mix (less wind, more gas / imports)?
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { bandMeans, meanOf } from "./analysis.ts";
import { loadSlots } from "./context.ts";
import { pearson } from "../stats.ts";
import { fin, metricMap, result, round, signed, unavailable } from "./util.ts";

/** supported: gas up >= 3 pp or wind down >= 3 pp, AND corr(price, wind) in B <= -0.3, AND the price level actually rose (nothing to explain otherwise). */
export function decideH2(i: { dGasPp: number; dWindPp: number; corr: number | null; priceLevelRose: boolean }): Status {
  const mixMoved = i.dGasPp >= T.H2_GAS_PP || i.dWindPp <= -T.H2_WIND_PP;
  const corrOk = i.corr !== null && i.corr <= T.H2_CORR;
  if (!mixMoved) return "ruled_out";
  if (mixMoved && corrOk && i.priceLevelRose) return "supported";
  return "inconclusive";
}

export const H2: Hypothesis = {
  id: "H2", name: "price_driver_generation", title: "Price driver: generation mix",
  description: "Does the generation mix explain the price move? Mean wind, gas and import share A vs B and the per-slot correlation of price with wind share in window B.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok || !d.result) return unavailable("H2", "price_driver_generation", d.error ?? "decomposition unavailable");
    const { evidence: ev, aligned } = await loadSlots(ctx, "H2", `Generation mix and price, A vs B (${ctx.scope.label})`);
    const mean3 = (slots: typeof aligned.A) => ({ wind: meanOf(slots, (s) => s.windPct), gas: meanOf(slots, (s) => s.gasPct), imports: meanOf(slots, (s) => s.importsPct) });
    const a = mean3(aligned.A), b = mean3(aligned.B);
    if (a.wind === null || b.wind === null || a.gas === null || b.gas === null) return unavailable("H2", "price_driver_generation", "carbon-intensity generation mix missing for the windows", [ev.id]);
    const withWind = aligned.B.filter((s) => s.windPct !== null);
    const corr = pearson(withWind.map((s) => s.p), withWind.map((s) => s.windPct as number));
    const dWind = b.wind - a.wind, dGas = b.gas - a.gas, dImp = (b.imports ?? 0) - (a.imports ?? 0);
    const priceLevelRose = d.result.price > 0;
    const status = decideH2({ dGasPp: dGas, dWindPp: dWind, corr, priceLevelRose });
    const pa = bandMeans(aligned.A, (s) => s.p).peak, pb = bandMeans(aligned.B, (s) => s.p).peak;
    const wa = bandMeans(aligned.A, (s) => s.windPct).peak, wb = bandMeans(aligned.B, (s) => s.windPct).peak;
    const peakPricePct = pa !== null && pb !== null && Math.abs(pa) > 0.5 ? (pb - pa) / Math.abs(pa) : null;
    ctx.evidence.addMetrics(ev.id, metricMap({
      wind_A: [a.wind, "%"], wind_B: [b.wind, "%"], gas_A: [a.gas, "%"], gas_B: [b.gas, "%"], imports_A: [a.imports, "%"], imports_B: [b.imports, "%"],
      delta_wind_pp: [dWind, "pp"], delta_gas_pp: [dGas, "pp"], delta_imports_pp: [dImp, "pp"], corr_price_wind_B: [corr, "r"],
      peak_price_pct: [peakPricePct, "ratio"], peak_wind_A: [wa, "%"], peak_wind_B: [wb, "%"],
    }));
    const peakNote = peakPricePct !== null && wa !== null && wb !== null ? `peak 16-19 local: price ${signed(peakPricePct * 100, 0)}% while wind ${round(wa, 1)} -> ${round(wb, 1)}%` : "peak band comparison unavailable";
    return result("H2", "price_driver_generation", status,
      `wind ${signed(dWind, 1)} pp, gas ${signed(dGas, 1)} pp, imports ${signed(dImp, 1)} pp; corr(price, wind) in B = ${corr === null ? "n/a" : corr.toFixed(2)}`,
      { delta_wind_pp: round(dWind, 2), delta_gas_pp: round(dGas, 2), delta_imports_pp: round(dImp, 2), corr_price_wind_B: fin(corr) === null ? null : round(corr as number, 3), price_level_rose: priceLevelRose, peak_price_pct: peakPricePct === null ? null : round(peakPricePct, 4) },
      [ev.id], [peakNote, `rule: gas >= +${T.H2_GAS_PP} pp or wind <= -${T.H2_WIND_PP} pp, and corr <= ${T.H2_CORR}; only counts as the explanation of a price rise (L > 0)`]);
  },
};
