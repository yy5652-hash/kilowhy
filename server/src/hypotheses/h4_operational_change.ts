// H4 operational_change: V_operational = V - V_weather (the part of the volume effect that weather does not explain),
// then a before/after step test on daily kWh around every ops_log event of the scope's sites (Welch t).
// Daily kWh are first adjusted for weather (beta*HDD) and weekday using the site's own pooled regression (H3 design);
// without that, the October cold snap would look like a step at every event. The unadjusted t is reported too.
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { dailyPoints, fitWeather } from "./weather.ts";
import { weatherVolume } from "./h3_weather_volume.ts";
import { loadSlots } from "./context.ts";
import { bandShares } from "./analysis.ts";
import { BAND_NAMES, localDate, type Band } from "../bands.ts";
import { welch } from "../stats.ts";
import type { OpsEvent } from "../data.ts";
import type { SlotRow } from "../data.ts";
import type { DayPoint } from "./weather.ts";
import { addWorldEvents, fetchMeta, gbp, metricMap, pctText, result, round, signedGbp, unavailable } from "./util.ts";

export interface EventTest {
  eventId: string; siteId: string; date: string; description: string;
  testable: boolean; reason?: string;
  nBefore: number; nAfter: number;
  diffKwhPerDay: number | null; tAdjusted: number | null; tRaw: number | null; df: number | null;
  profileShift: { band: Band; pp: number } | null;     // largest change of a band's kWh share around the event (informational, not part of the decision)
}

export interface H4Input { vOperationalPence: number; deltaPence: number; events: Pick<EventTest, "testable" | "tAdjusted">[] }
/** supported: |V_op| >= 10% of |dC| and some event has |t| >= 2. ruled_out: |V_op| below half the threshold. else inconclusive (an unexplained operational shift, or a weak one). */
export function decideH4(i: H4Input): { status: Status; share: number; eventFound: boolean } {
  const share = i.deltaPence === 0 ? 0 : Math.abs(i.vOperationalPence) / Math.abs(i.deltaPence);
  const eventFound = i.events.some((e) => e.testable && e.tAdjusted !== null && Math.abs(e.tAdjusted) >= T.H4_T);
  if (i.deltaPence === 0) return { status: "inconclusive", share, eventFound };
  if (share >= T.H4_SHARE && eventFound) return { status: "supported", share, eventFound };
  if (share < T.H4_SHARE * T.NEAR_MISS_FRACTION) return { status: "ruled_out", share, eventFound };
  return { status: "inconclusive", share, eventFound };
}

/** Welch step test of weather/weekday-adjusted daily kWh before (< date) vs after (>= date) an event, for the event's site. */
export function testEvent(ev: OpsEvent, points: DayPoint[]): EventTest {
  const base: EventTest = { eventId: ev.eventId, siteId: ev.siteId, date: ev.eventDate, description: ev.description, testable: false, nBefore: 0, nAfter: 0, diffKwhPerDay: null, tAdjusted: null, tRaw: null, df: null, profileShift: null };
  const before = points.filter((p) => p.date < ev.eventDate), after = points.filter((p) => p.date >= ev.eventDate);
  base.nBefore = before.length; base.nAfter = after.length;
  if (before.length < T.H4_MIN_DAYS_PER_SIDE || after.length < T.H4_MIN_DAYS_PER_SIDE) return { ...base, reason: `fewer than ${T.H4_MIN_DAYS_PER_SIDE} days on one side of ${ev.eventDate}` };
  const fit = fitWeather(points);
  if (!fit.ok) return { ...base, reason: `weather regression failed (${fit.error})` };
  const adj = (ps: DayPoint[]) => ps.map((p) => fit.model.adjust(p));
  const w = welch(adj(before), adj(after)), raw = welch(before.map((p) => p.kwh), after.map((p) => p.kwh));
  if (!w.ok) return { ...base, reason: w.message };
  return { ...base, testable: true, diffKwhPerDay: w.diff, tAdjusted: w.t, tRaw: raw.ok ? raw.t : null, df: w.df };
}

/** Largest change in a band's kWh share (percentage points) between the slots before and from the event date, using one site's slots. */
export function profileShift(rows: SlotRow[], siteId: string, date: string): { band: Band; pp: number } | null {
  const toAgg = (rs: SlotRow[]) => rs.map((r) => ({ ts: r.ts, kwh: r.kwh, p: r.p, intensity: r.intensity, windPct: r.windPct, gasPct: r.gasPct, importsPct: r.importsPct }));
  const mine = rows.filter((r) => r.site === siteId);
  const before = mine.filter((r) => localDate(r.ts) < date), after = mine.filter((r) => localDate(r.ts) >= date);
  if (before.length < 48 * T.H4_MIN_DAYS_PER_SIDE || after.length < 48 * T.H4_MIN_DAYS_PER_SIDE) return null;
  const sb = bandShares(toAgg(before)), sa = bandShares(toAgg(after));
  let best: { band: Band; pp: number } | null = null;
  for (const b of BAND_NAMES) { const pp = (sa[b] - sb[b]) * 100; if (!best || Math.abs(pp) > Math.abs(best.pp)) best = { band: b, pp }; }
  return best;
}

export const H4: Hypothesis = {
  id: "H4", name: "operational_change", title: "Operational change",
  description: "Is the non-weather volume change explained by a logged event (ops_log)? V_operational = V - V_weather, then a Welch before/after step test of weather-adjusted daily kWh around each event of the scope's sites.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok || !d.result) return unavailable("H4", "operational_change", d.error ?? "decomposition unavailable");
    const r = d.result;
    const win = { A: ctx.windowA, B: ctx.windowB };
    const daily = await ctx.data.daily({ sites: ctx.sites, windows: win }, fetchMeta(ctx, "H4", `Daily kWh and mean temperature (${ctx.scope.label})`));
    const ops = await ctx.data.opsLog({ sites: ctx.sites }, fetchMeta(ctx, "H4", `ops_log events (${ctx.scope.label})`));
    addWorldEvents(ctx, ops.evidence.id);
    const total = fitWeather(dailyPoints(daily.rows, ctx.sites, ctx.windowA, ctx.windowB).points);
    if (!total.ok) return unavailable("H4", "operational_change", `weather regression failed (${total.error})`, [daily.evidence.id]);
    const vW = weatherVolume(total.model, r.pbarA), vOp = r.volume - vW;
    const slots = await loadSlots(ctx, "H4", `Half-hourly kWh around events (${ctx.scope.label})`);
    const events: EventTest[] = ops.rows.map((e) => {
      const t = testEvent(e, dailyPoints(daily.rows, [e.siteId], ctx.windowA, ctx.windowB).points);
      return { ...t, profileShift: profileShift(slots.rows, e.siteId, e.eventDate) };
    });
    const g = decideH4({ vOperationalPence: vOp, deltaPence: r.deltaTotal, events });
    const em: Record<string, [number | string | boolean | null, string]> = {};
    for (const e of events) {
      em[`event_${e.eventId}_t_adjusted`] = [e.tAdjusted, "t"]; em[`event_${e.eventId}_t_raw`] = [e.tRaw, "t"]; em[`event_${e.eventId}_diff`] = [e.diffKwhPerDay, "kWh/day"];
      if (e.profileShift) em[`event_${e.eventId}_profile_shift_pp`] = [e.profileShift.pp, "pp"];
    }
    ctx.evidence.addMetrics(daily.evidence.id, metricMap({ v_weather: [gbp(vW), "GBP"], v_operational: [gbp(vOp), "GBP"], v_operational_share: [g.share, "ratio"], ...em }));
    ctx.evidence.addMetrics(ops.evidence.id, metricMap({ events_in_scope: [events.length, "events"], events_with_step: [events.filter((e) => e.testable && Math.abs(e.tAdjusted ?? 0) >= T.H4_T).length, "events"] }));
    ctx.evidence.addMetrics(slots.evidence.id, metricMap({ slots_used: [slots.rows.length, "slots"], ...Object.fromEntries(events.filter((e) => e.profileShift).map((e) => [`event_${e.eventId}_profile_shift_pp`, [e.profileShift!.pp, `pp of kWh share, ${e.profileShift!.band} band`]])) }));
    const found = events.filter((e) => e.testable && e.tAdjusted !== null && Math.abs(e.tAdjusted) >= T.H4_T);
    const notes = [`rule: |V_op| >= ${T.H4_SHARE * 100}% of |change| and an event with |t| >= ${T.H4_T} (Welch, weather- and weekday-adjusted daily kWh)`];
    for (const e of events) notes.push(`${e.eventId} ${e.siteId} ${e.date} "${e.description}": ${e.testable ? `step ${round(e.diffKwhPerDay ?? NaN, 2)} kWh/day, t ${round(e.tAdjusted ?? NaN, 2)} (raw t ${round(e.tRaw ?? NaN, 2)}), n ${e.nBefore}/${e.nAfter}` : `not testable (${e.reason})`}${e.profileShift ? `; intraday profile: ${e.profileShift.band} share ${round(e.profileShift.pp, 1)} pp` : ""}`);
    return result("H4", "operational_change", g.status,
      `V_op ${signedGbp(vOp)} = ${pctText(g.share)} of change; events with a daily-kWh step: ${found.length ? found.map((e) => `${e.eventId} (t ${round(e.tAdjusted ?? NaN, 1)})`).join(", ") : "none"} of ${events.length}`,
      { v_operational_gbp: gbp(vOp), v_weather_gbp: gbp(vW), v_operational_share: round(g.share, 4), events_in_scope: events.length, events_with_step: found.length, steps: found.map((e) => e.eventId).join(",") || "none" },
      [d.evidenceId, daily.evidence.id, ops.evidence.id, slots.evidence.id], notes, { events });
  },
};
