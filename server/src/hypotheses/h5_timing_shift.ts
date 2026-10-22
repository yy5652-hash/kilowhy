// H5 timing_shift: did usage move between cheap and dear slots? Decision on the exact timing effect T of the decomposition.
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { bandShares } from "./analysis.ts";
import { loadSlots } from "./context.ts";
import { BAND_NAMES } from "../bands.ts";
import { analyseSchedule, type ScheduleShift } from "./schedule_shift.ts";
import { fetchMeta, gbp, metricMap, pctText, result, round, signed, signedGbp, unavailable } from "./util.ts";

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
    const { evidence: ev, aligned, rows } = await loadSlots(ctx, "H5", `kWh share per time band and timing effect (${ctx.scope.label})`);
    const ops = await ctx.data.opsLog({ sites: ctx.sites }, fetchMeta(ctx, "H5", `ops_log events (${ctx.scope.label})`));
    const g = decideH5(r.timing, r.deltaTotal);
    const sa = bandShares(aligned.A), sb = bandShares(aligned.B);
    const m: Record<string, [number | string | boolean | null, string]> = { timing_T: [gbp(r.timing), "GBP"], timing_share_of_delta: [g.share, "ratio"] };
    const bands: Record<string, { A: number; B: number; pp: number }> = {};
    for (const k of BAND_NAMES) { bands[k] = { A: sa[k], B: sb[k], pp: (sb[k] - sa[k]) * 100 }; m[`kwh_share_${k}_A`] = [sa[k], "ratio"]; m[`kwh_share_${k}_B`] = [sb[k], "ratio"]; }
    m.peak_share_change_pp = [bands.peak.pp, "pp"];
    // schedule shift (extra metric): per site, a band whose kWh share moved >= 10 pp between the windows, with a change-point date and the nearest ops_log event
    const candidates: ScheduleShift[] = ctx.sites.map((s) => analyseSchedule(rows.filter((r) => r.site === s), ops.rows)).filter((x): x is ScheduleShift => x !== null)
      .sort((x, y) => Math.abs(y.deltaPp) - Math.abs(x.deltaPp));
    const shifts = candidates.filter((x) => x.detected);
    const top = shifts[0], cand = candidates[0];
    const evText = (x: ScheduleShift) => (x.nearestEvent ? `${x.nearestEvent.eventId} (${x.nearestEvent.date}, ${x.nearestEvent.daysOff >= 0 ? "+" : ""}${x.nearestEvent.daysOff} d): ${x.nearestEvent.description}` : null);
    m.schedule_shift_detected = [shifts.length > 0, "flag"];
    m.schedule_shift_sites = [shifts.map((x) => x.site).join(",") || null, "sites"];
    if (top) {
      m.schedule_shift_site = [top.site, "site"]; m.schedule_shift_band = [top.band, "band"]; m.schedule_shift_delta_pp = [top.deltaPp, "pp"];
      m.schedule_shift_change_point = [top.changePoint, "date"]; m.schedule_shift_event = [evText(top), "text"];
    }
    if (cand) { // largest band move of any site, whether or not it reaches the threshold
      m.schedule_candidate_site = [cand.site, "site"]; m.schedule_candidate_band = [cand.band, "band"]; m.schedule_candidate_delta_pp = [cand.deltaPp, "pp"];
      m.schedule_candidate_change_point = [cand.changePoint, "date"]; m.schedule_candidate_event = [evText(cand), "text"]; m.schedule_shift_threshold_pp = [T.H5_SHIFT_PP, "pp"];
    }
    ctx.evidence.addMetrics(ev.id, metricMap(m));
    ctx.evidence.addMetrics(ops.evidence.id, metricMap({ events_in_scope: [ops.rows.length, "events"], schedule_shifts_with_event: [shifts.filter((x) => x.nearestEvent).length, "shifts"] }));
    const biggest = BAND_NAMES.reduce((best, k) => (Math.abs(bands[k].pp) > Math.abs(bands[best].pp) ? k : best), BAND_NAMES[0]);
    const notes = [`rule: |T| >= ${T.H5_SHARE * 100}% of |change| (supported), else ruled out`];
    for (const x of shifts) {
      const when = x.changePoint ? ` from ${x.changePoint}` : "";
      const ev_ = x.nearestEvent ? `, near ops_log ${x.nearestEvent.eventId} (${x.nearestEvent.date}, ${x.nearestEvent.daysOff >= 0 ? "+" : ""}${x.nearestEvent.daysOff} d) "${x.nearestEvent.description}"` : ", no ops_log event within +-" + T.H5_EVENT_DAYS + " days";
      notes.push(`schedule shift detected at ${x.site}: ${x.band} band kWh share ${round(x.shareA * 100, 1)}% -> ${round(x.shareB * 100, 1)}% (${signed(x.deltaPp, 1)} pp)${when}${ev_}; ${g.status === "supported" ? "it also changed cost" : "it did not change cost materially"} (T = ${pctText(g.share)} of the change)`);
    }
    if (!top && cand) notes.push(`no schedule shift at the ${T.H5_SHIFT_PP} pp threshold; largest band move ${cand.site} ${cand.band} ${signed(cand.deltaPp, 1)} pp${cand.changePoint ? `, change point ${cand.changePoint}` : ""}${cand.nearestEvent ? ` near ops_log ${cand.nearestEvent.eventId} "${cand.nearestEvent.description}"` : ""} (below threshold, shown for information)`);
    return result("H5", "timing_shift", g.status,
      `T ${signedGbp(r.timing)} = ${pctText(g.share)} of change; peak-band kWh share ${signed(bands.peak.pp, 1)} pp; largest band move ${biggest} ${signed(bands[biggest].pp, 1)} pp${top ? `; schedule shift at ${top.site} (${top.band} ${signed(top.deltaPp, 1)} pp${top.changePoint ? ` from ${top.changePoint}` : ""})` : ""}`,
      { T_gbp: gbp(r.timing), T_share_of_delta: round(g.share, 4), peak_share_change_pp: round(bands.peak.pp, 3), largest_band_move: biggest, largest_band_move_pp: round(bands[biggest].pp, 3),
        schedule_shift_detected: shifts.length > 0, schedule_shift_sites: shifts.map((x) => x.site).join(",") || null, schedule_shift_band: top?.band ?? null, schedule_shift_delta_pp: top ? round(top.deltaPp, 2) : null, schedule_shift_change_point: top?.changePoint ?? null, schedule_shift_event_id: top?.nearestEvent?.eventId ?? null,
        schedule_candidate_site: cand?.site ?? null, schedule_candidate_band: cand?.band ?? null, schedule_candidate_delta_pp: cand ? round(cand.deltaPp, 2) : null, schedule_candidate_change_point: cand?.changePoint ?? null, schedule_candidate_event_id: cand?.nearestEvent?.eventId ?? null },
      [d.evidenceId, ev.id, ops.evidence.id], notes, { bands, scheduleShifts: shifts, scheduleCandidates: candidates });
  },
};
