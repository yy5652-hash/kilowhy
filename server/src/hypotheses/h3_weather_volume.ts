// H3 weather_volume: how much of the bill change is cold weather? Pooled OLS over A+B:
//   daily kWh = alpha + beta*HDD + gamma*[window B] + weekday dummies;  V_weather = beta * (sum HDD_B - sum HDD_A) * Pbar_A.
// The window dummy keeps operational level shifts out of beta, so beta comes from day-to-day weather variation only.
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { dailyPoints, fitWeather, type WeatherModel } from "./weather.ts";
import { fetchMeta, gbp, metricMap, pctText, result, round, signed, signedGbp, unavailable } from "./util.ts";

export interface H3Input { beta: number; t: number; vWeatherPence: number; deltaPence: number }
/** supported: beta > 0, t >= 2, V_weather >= 10% of |dC| (in the direction of dC). ruled_out: beta <= 0 or V_weather below half the threshold. else inconclusive. */
export function decideH3(i: H3Input): { status: Status; share: number } {
  const dir = Math.sign(i.deltaPence);
  if (dir === 0) return { status: "inconclusive", share: 0 };
  const signedV = i.vWeatherPence * dir, share = Math.abs(i.vWeatherPence) / Math.abs(i.deltaPence);
  if (i.beta > 0 && i.t >= T.H3_T && signedV > 0 && share >= T.H3_SHARE) return { status: "supported", share };
  if (i.beta <= 0 || signedV <= 0 || share < T.H3_SHARE * T.NEAR_MISS_FRACTION) return { status: "ruled_out", share };
  return { status: "inconclusive", share };
}

export function weatherVolume(model: WeatherModel, pbarA: number): number {
  return model.beta * (model.sumHddB - model.sumHddA) * pbarA;
}

export const H3: Hypothesis = {
  id: "H3", name: "weather_volume", title: "Weather-driven volume",
  description: "How much of the change is cold weather? Pooled regression of daily kWh on heating degree days (base 15.5 C) with a window dummy and weekday dummies; weather volume cost = beta x change in HDD x baseline price.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok || !d.result) return unavailable("H3", "weather_volume", d.error ?? "decomposition unavailable");
    const f = await ctx.data.daily({ sites: ctx.sites, windows: { A: ctx.windowA, B: ctx.windowB } }, fetchMeta(ctx, "H3", `Daily kWh and mean temperature (${ctx.scope.label})`));
    const { points, dropped } = dailyPoints(f.rows, ctx.sites, ctx.windowA, ctx.windowB);
    const fit = fitWeather(points);
    if (!fit.ok) return unavailable("H3", "weather_volume", `weather regression failed (${fit.error})`, [f.evidence.id]);
    const m = fit.model, r = d.result;
    const vW = weatherVolume(m, r.pbarA);
    const g = decideH3({ beta: m.beta, t: m.t, vWeatherPence: vW, deltaPence: r.deltaTotal });
    ctx.evidence.addMetrics(f.evidence.id, metricMap({
      beta: [m.beta, "kWh/HDD"], beta_se: [m.se, "kWh/HDD"], beta_t: [m.t, "t"], r2: [m.r2, "r2"], n_days: [m.n, "days"], window_shift_gamma: [m.gamma, "kWh/day"],
      sum_hdd_A: [m.sumHddA, "HDD"], sum_hdd_B: [m.sumHddB, "HDD"], v_weather: [gbp(vW), "GBP"], v_weather_share: [g.share, "ratio"], days_dropped: [dropped, "days"],
    }));
    return result("H3", "weather_volume", g.status,
      `beta ${round(m.beta)} kWh/HDD (t ${round(m.t, 1)}, r2 ${round(m.r2)}), sum HDD ${round(m.sumHddA, 1)} -> ${round(m.sumHddB, 1)}: weather ${signedGbp(vW)} = ${pctText(g.share)} of change`,
      { beta_kwh_per_hdd: round(m.beta, 4), beta_se: round(m.se, 4), beta_t: round(m.t, 3), r2: round(m.r2, 4), n_days: m.n, sum_hdd_A: round(m.sumHddA, 3), sum_hdd_B: round(m.sumHddB, 3), v_weather_gbp: gbp(vW), v_weather_share: round(g.share, 4), window_shift_kwh_per_day: round(m.gamma, 3), days_dropped: dropped },
      [d.evidenceId, f.evidence.id],
      [`rule: beta > 0, t >= ${T.H3_T}, V_weather >= ${T.H3_SHARE * 100}% of |change|`, `window B vs A level shift after weather and weekday: ${signed(m.gamma, 2)} kWh/day`]);
  },
};
