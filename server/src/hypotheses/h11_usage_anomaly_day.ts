// H11 usage_anomaly_day: is any single site-day unusual for its weather and weekday? Same adjusted daily model as H4
// (pooled OLS per site: daily kWh ~ HDD + window dummy + weekday dummies). z = standardised residual e / (sigma sqrt(1-h)), per site-day over A and B;
// the expected kWh is the model's prediction without that day (leave-one-out), so a spike cannot pull its own expectation towards itself.
// Supported if any |z| >= 4. Each flagged day is reported with its kWh against the expected kWh and any ops_log event of that site on that date.
import type { OpsEvent } from "../data.ts";
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { dailyPoints, fitWeather, type DayPoint } from "./weather.ts";
import { addWorldEvents, fetchMeta, metricMap, result, round, unavailable } from "./util.ts";

export interface DayAnomaly {
  site: string; date: string; win: "A" | "B"; kwh: number; expected: number; residual: number; z: number;
  event: { eventId: string; description: string } | null;     // ops_log event of this site dated this day
}
export interface AnomalyScan { all: DayAnomaly[]; flagged: DayAnomaly[]; failedSites: string[]; maxAbsZ: number | null; siteDays: number }

/** Standardised residuals of every site-day, from one regression per site. */
export function scanAnomalies(perSite: { site: string; points: DayPoint[] }[], events: OpsEvent[], zMin: number = T.H11_Z): AnomalyScan {
  const all: DayAnomaly[] = [];
  const failedSites: string[] = [];
  for (const { site, points } of perSite) {
    const fit = fitWeather(points);
    if (!fit.ok || !(fit.model.sigma > 1e-9)) { failedSites.push(site); continue; }
    for (const p of points) {
      const dg = fit.model.diagnostics.get(p.date);
      if (!dg) continue; // leverage ~1: the model cannot say anything about this day
      const ev = events.find((e) => e.siteId === site && e.eventDate === p.date);
      all.push({ site, date: p.date, win: p.win, kwh: p.kwh, expected: dg.expectedLoo, residual: dg.excessLoo, z: dg.z, event: ev ? { eventId: ev.eventId, description: ev.description } : null });
    }
  }
  all.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return { all, flagged: all.filter((a) => Math.abs(a.z) >= zMin), failedSites, maxAbsZ: all.length ? Math.abs(all[0].z) : null, siteDays: all.length };
}

/** supported if any |z| >= 4; ruled_out if none and every site could be modelled; else inconclusive. */
export function decideH11(scan: Pick<AnomalyScan, "flagged" | "failedSites" | "siteDays">): Status {
  if (scan.flagged.length > 0) return "supported";
  return scan.failedSites.length === 0 && scan.siteDays > 0 ? "ruled_out" : "inconclusive";
}

const describe = (a: DayAnomaly) => `${a.site} ${a.date}: ${round(a.kwh, 1)} kWh vs ${round(a.expected, 1)} expected (z ${round(a.z, 1)})${a.event ? `; ops_log ${a.event.eventId} "${a.event.description}"` : "; no ops_log event on that date"}`;

export const H11: Hypothesis = {
  id: "H11", name: "usage_anomaly_day", title: "Unusual usage day",
  description: "Is any single site-day far from what its weather and weekday predict? Standardised residuals of daily kWh (same adjusted model as the operational-change test); flags |z| >= 4 and cites any ops_log event of that site on that date.",
  async run(ctx) {
    const win = { A: ctx.windowA, B: ctx.windowB };
    const daily = await ctx.data.daily({ sites: ctx.sites, windows: win }, fetchMeta(ctx, "H11", `Daily kWh and mean temperature (${ctx.scope.label})`));
    const ops = await ctx.data.opsLog({ sites: ctx.sites }, fetchMeta(ctx, "H11", `ops_log events (${ctx.scope.label})`));
    addWorldEvents(ctx, ops.evidence.id);
    const scan = scanAnomalies(ctx.sites.map((site) => ({ site, points: dailyPoints(daily.rows, [site], ctx.windowA, ctx.windowB).points })), ops.rows);
    if (scan.siteDays === 0) return unavailable("H11", "usage_anomaly_day", `weather model failed for ${scan.failedSites.join(", ") || "all sites"}`, [daily.evidence.id, ops.evidence.id]);
    const status = decideH11(scan);
    const shown = scan.flagged.length ? scan.flagged.slice(0, 5) : scan.all.slice(0, 1);
    const m: Record<string, [number | string | boolean | null, string]> = {
      max_abs_z: [scan.maxAbsZ, "sd"], z_threshold: [T.H11_Z, "sd"], site_days_tested: [scan.siteDays, "site-days"], n_flagged: [scan.flagged.length, "site-days"], sites_not_modelled: [scan.failedSites.length, "sites"],
    };
    shown.forEach((a, i) => {
      const k = `anomaly_${i + 1}`;
      m[`${k}_site`] = [a.site, "site"]; m[`${k}_day`] = [a.date, "date"]; m[`${k}_kwh`] = [a.kwh, "kWh"]; m[`${k}_expected_kwh`] = [a.expected, "kWh"]; m[`${k}_z`] = [a.z, "sd"];
      m[`${k}_ops_event`] = [a.event ? `${a.event.eventId}: ${a.event.description}` : null, "text"];
    });
    ctx.evidence.addMetrics(daily.evidence.id, metricMap(m));
    ctx.evidence.addMetrics(ops.evidence.id, metricMap({ events_in_scope: [ops.rows.length, "events"], flagged_days_with_event: [scan.flagged.filter((a) => a.event).length, "days"] }));
    const top = shown[0];
    const notes = [`rule: any site-day with |z| >= ${T.H11_Z} (z = standardised residual of the adjusted daily-kWh model, per site)`];
    for (const a of shown) notes.push(describe(a));
    if (scan.failedSites.length) notes.push(`not modelled: ${scan.failedSites.join(", ")}`);
    return result("H11", "usage_anomaly_day", status,
      scan.flagged.length ? `${scan.flagged.length} unusual site-day(s); largest ${describe(top)}` : `no site-day beyond ${T.H11_Z} sd (largest |z| ${round(scan.maxAbsZ ?? NaN, 1)}: ${top ? `${top.site} ${top.date}` : "n/a"})`,
      { max_abs_z: round(scan.maxAbsZ ?? NaN, 2), n_flagged: scan.flagged.length, site_days_tested: scan.siteDays, top_site: top?.site ?? null, top_day: top?.date ?? null, top_kwh: top ? round(top.kwh, 2) : null, top_expected_kwh: top ? round(top.expected, 2) : null, top_z: top ? round(top.z, 2) : null, top_ops_event: top?.event ? `${top.event.eventId}: ${top.event.description}` : null },
      [daily.evidence.id, ops.evidence.id], notes, { flagged: scan.flagged, largest: scan.all.slice(0, 5), failedSites: scan.failedSites });
  },
};
