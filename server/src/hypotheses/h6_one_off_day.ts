// H6 one_off_day: does a single day carry a large share of the change? topDayShare over the day-by-day change in cost (B day i minus A day i).
// Decision as in the spec (largest day in the direction of the total change). The largest day in the OPPOSITE direction
// (typically an abnormal baseline day that inflated window A) is reported next to it as an extra metric; it does not change the status.
import { dailyDeltaCost, topDayShare, sum, type DayDelta } from "../decompose.ts";
import { addDays } from "../bands.ts";
import { mean } from "../stats.ts";
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { dayStats, zScore } from "./analysis.ts";
import { loadSlots } from "./context.ts";
import { dailyPoints, fitWeather } from "./weather.ts";
import { fetchMeta, gbp, metricMap, pctText, result, round, signedGbp, unavailable } from "./util.ts";

/** supported if share >= 25%; ruled_out below half of that; else inconclusive. */
export function decideH6(share: number, flag?: string): Status {
  if (flag) return "inconclusive";
  if (share >= T.H6_SHARE) return "supported";
  return share < T.H6_SHARE * T.NEAR_MISS_FRACTION ? "ruled_out" : "inconclusive";
}

/** The day that works hardest AGAINST the direction of the total change (e.g. an abnormal baseline day); null if every day moves with the total. share is negative. */
export function oppositeDay(days: DayDelta[]): { date: string | null; deltaPence: number; share: number } {
  const total = sum(days.map((d) => d.deltaPence));
  if (days.length === 0 || total === 0) return { date: null, deltaPence: 0, share: 0 };
  const dir = total < 0 ? -1 : 1;
  let w = days[0];
  for (const x of days) if (x.deltaPence * dir < w.deltaPence * dir) w = x;
  return w.deltaPence * dir < 0 ? { date: w.date, deltaPence: w.deltaPence, share: w.deltaPence / total } : { date: null, deltaPence: 0, share: 0 };
}

export interface DriverCandidate { kind: string; label: string; z: number }
/** Names what made the day unusual: the largest standardised deviation among usage, price and weather on the B day and its A partner. */
export function nameDriver(c: DriverCandidate[]): DriverCandidate | null {
  const usable = c.filter((x) => Number.isFinite(x.z));
  if (!usable.length) return null;
  return usable.reduce((best, x) => (Math.abs(x.z) > Math.abs(best.z) ? x : best));
}

export const H6: Hypothesis = {
  id: "H6", name: "one_off_day", title: "One-off day",
  description: "Is the change concentrated in one day? Share of the total change contributed by the single largest day (B day vs the aligned A day), with that day's kWh, price and heating degree days compared with the window means.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok || !d.result || !d.windowA || !d.windowB) return unavailable("H6", "one_off_day", d.error ?? "decomposition unavailable");
    if (d.aligned.kept !== d.aligned.expected) return unavailable("H6", "one_off_day", "slots are missing, so day-by-day pairing is not possible");
    const { evidence: ev, aligned } = await loadSlots(ctx, "H6", `Day-by-day change in cost (${ctx.scope.label})`);
    const deltas = dailyDeltaCost(d.windowA, d.windowB);
    const top = topDayShare(deltas);
    const opp = oppositeDay(deltas);
    const status = decideH6(top.share, top.flag);
    const daily = await ctx.data.daily({ sites: ctx.sites, windows: { A: ctx.windowA, B: ctx.windowB } }, fetchMeta(ctx, "H6", `Daily mean temperature (${ctx.scope.label})`));
    const hdd = new Map(dailyPoints(daily.rows, ctx.sites, ctx.windowA, ctx.windowB).points.map((p) => [p.date, p.hdd]));
    const hddIn = (w: { from: string; toExclusive: string }) => [...hdd].filter(([k]) => k >= w.from && k < w.toExclusive).map(([, v]) => v);
    const hddA = hddIn(ctx.windowA), hddB = hddIn(ctx.windowB);
    const hddMeanA = hddA.length ? mean(hddA) : null, hddMeanB = hddB.length ? mean(hddB) : null;
    const dsA = dayStats(aligned.A), dsB = dayStats(aligned.B);
    const describe = (dateB: string | null) => {
      if (!dateB) return null;
      const dateA = addDays(dateB, -ctx.windowA.days);
      const a = dsA.find((x) => x.date === dateA), b = dsB.find((x) => x.date === dateB);
      if (!a || !b) return null;
      const cand: DriverCandidate[] = [];
      const push = (kind: string, label: string, z: number | null) => { if (z !== null) cand.push({ kind, label, z }); };
      push("usage_B", `usage on ${dateB} (window B)`, zScore(b.kwh, dsB.map((x) => x.kwh)));
      push("usage_A", `usage on baseline day ${dateA} (window A)`, zScore(a.kwh, dsA.map((x) => x.kwh)));
      push("price_B", `average price on ${dateB} (window B)`, zScore(b.meanP, dsB.map((x) => x.meanP)));
      push("price_A", `average price on baseline day ${dateA} (window A)`, zScore(a.meanP, dsA.map((x) => x.meanP)));
      const hb = hdd.get(dateB), ha = hdd.get(dateA);
      if (hb !== undefined && hddB.length > 3) push("weather_B", `heating degree days on ${dateB} (window B)`, zScore(hb, hddB));
      if (ha !== undefined && hddA.length > 3) push("weather_A", `heating degree days on baseline day ${dateA} (window A)`, zScore(ha, hddA));
      return { dateA, dateB, a, b, driver: nameDriver(cand), ranked: [...cand].sort((x, y) => Math.abs(y.z) - Math.abs(x.z)).slice(0, 3), meanKwhA: mean(dsA.map((x) => x.kwh)), meanKwhB: mean(dsB.map((x) => x.kwh)), meanPA: mean(dsA.map((x) => x.meanP)), meanPB: mean(dsB.map((x) => x.meanP)) };
    };
    const t = describe(top.date), o = describe(opp.date);
    // informational: the most unusual day by weather- and weekday-adjusted daily kWh (does not depend on the cost-share rule or on which window the day is in)
    const wfit = fitWeather(dailyPoints(daily.rows, ctx.sites, ctx.windowA, ctx.windowB).points);
    let anomaly: { date: string; excessKwh: number; z: number } | null = null;
    if (wfit.ok && wfit.model.sigma > 1e-9) for (const [date, dg] of wfit.model.diagnostics) if (dg && (!anomaly || Math.abs(dg.z) > Math.abs(anomaly.z))) anomaly = { date, excessKwh: dg.excessLoo, z: dg.z };
    const driverText = (x: ReturnType<typeof describe>) => (x?.driver ? `${x.driver.label} is ${round(Math.abs(x.driver.z), 1)} sd ${x.driver.z > 0 ? "above" : "below"} its window mean` : "no standout driver");
    const m: Record<string, [number | string | boolean | null, string]> = {
      top_day_share: [top.share, "ratio"], top_day_delta: [gbp(top.deltaPence), "GBP"], total_change: [gbp(top.totalPence), "GBP"], top_day: [top.date, "date"],
      opposite_day: [opp.date, "date"], opposite_day_share: [opp.share, "ratio"], opposite_day_delta: [gbp(opp.deltaPence), "GBP"],
    };
    if (t) { m.kwh_day_B = [t.b.kwh, "kWh"]; m.kwh_mean_B = [t.meanKwhB, "kWh"]; m.kwh_day_A = [t.a.kwh, "kWh"]; m.kwh_mean_A = [t.meanKwhA, "kWh"]; m.price_day_B = [t.b.meanP, "p/kWh"]; m.price_mean_B = [t.meanPB, "p/kWh"]; m.hdd_day_B = [hdd.get(t.dateB) ?? null, "HDD"]; m.hdd_mean_B = [hddMeanB, "HDD"]; m.hdd_mean_A = [hddMeanA, "HDD"]; m.driver = [t.driver?.kind ?? null, "kind"]; }
    if (anomaly) { m.anomalous_day = [anomaly.date, "date"]; m.anomalous_day_excess_kwh = [anomaly.excessKwh, "kWh"]; m.anomalous_day_z = [anomaly.z, "sd"]; }
    if (o) { m.opposite_kwh_day = [o.a.kwh, "kWh"]; m.opposite_driver = [o.driver?.kind ?? null, "kind"]; }
    ctx.evidence.addMetrics(ev.id, metricMap(m));
    ctx.evidence.addMetrics(daily.evidence.id, metricMap({ days_with_temperature: [hdd.size, "days"] }));
    const notes = [`rule: top day >= ${T.H6_SHARE * 100}% of the total change (largest day in the direction of the change)`];
    if (t) notes.push(`top day ${t.dateB} (partner baseline day ${t.dateA}): ${driverText(t)}${t.ranked.length > 1 ? `; also: ${t.ranked.slice(1).map((c) => `${c.label} ${round(c.z, 1)} sd`).join(", ")}` : ""}`);
    if (anomaly) notes.push(`most unusual day by weather- and weekday-adjusted daily kWh: ${anomaly.date}, ${anomaly.excessKwh >= 0 ? "+" : ""}${round(anomaly.excessKwh, 1)} kWh vs the model (${round(Math.abs(anomaly.z), 1)} sd)`);
    if (o && opp.date) notes.push(`largest day against the direction of the change: ${opp.date} (${signedGbp(opp.deltaPence)}, ${pctText(Math.abs(opp.share))} of the total); ${driverText(o)}`);
    return result("H6", "one_off_day", status,
      top.date ? `top day ${top.date} = ${pctText(top.share)} of change (${signedGbp(top.deltaPence)}); ${driverText(t)}` : "no days",
      { top_day: top.date, top_day_share: round(top.share, 4), top_day_delta_gbp: gbp(top.deltaPence), driver: t?.driver?.kind ?? null, opposite_day: opp.date, opposite_day_share: round(opp.share, 4), opposite_driver: o?.driver?.kind ?? null, anomalous_day: anomaly?.date ?? null, anomalous_day_z: anomaly ? round(anomaly.z, 2) : null, anomalous_day_excess_kwh: anomaly ? round(anomaly.excessKwh, 2) : null },
      [d.evidenceId, ev.id, daily.evidence.id], notes, { top, opposite: opp, topDriver: t?.driver ?? null, oppositeDriver: o?.driver ?? null, anomaly });
  },
};
