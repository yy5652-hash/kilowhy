// Schedule-shift detection for H5 (informational; the H5 status stays cost-based).
// A site's schedule has shifted when one local band's share of kWh moves by >= 10 pp between window A and window B.
// Change point: split of the site's daily band-share series (UTC days, complete days only) into two segments with the largest
// difference of means, each segment at least 5 days; the first day of the second segment is the change-point date.
// The nearest ops_log event of that site within +-3 days of the change point is attached if there is one.
import { BAND_NAMES, bandOf, type Band } from "../bands.ts";
import type { OpsEvent, SlotRow } from "../data.ts";
import { sum } from "../decompose.ts";
import { mean } from "../stats.ts";
import { THRESHOLDS as T } from "./thresholds.ts";

export interface ScheduleShift {
  site: string; band: Band;
  detected: boolean;                                             // |deltaPp| >= 10 pp; false = largest band move of the site, below the threshold (reported as a candidate only)
  shareA: number; shareB: number; deltaPp: number;              // kWh share of the band in each window and the change in pp
  bandsOverThreshold: Band[];
  changePoint: string | null;                                    // first day of the new regime
  meanBefore: number | null; meanAfter: number | null;          // mean daily share of the band either side of the change point
  nearestEvent: { eventId: string; date: string; daysOff: number; description: string } | null;
}

export interface Point { date: string; value: number }
/** Split with the largest |mean(after) - mean(before)|; ties go to the earliest date; null if the series is too short for two segments. */
export function changePoint(series: Point[], minSegment: number = T.H5_SEGMENT_MIN_DAYS): { date: string; meanBefore: number; meanAfter: number; diff: number } | null {
  const n = series.length;
  if (n < 2 * minSegment) return null;
  let best: { date: string; meanBefore: number; meanAfter: number; diff: number } | null = null;
  for (let i = minSegment; i <= n - minSegment; i++) {
    const mb = mean(series.slice(0, i).map((p) => p.value)), ma = mean(series.slice(i).map((p) => p.value));
    if (!best || Math.abs(ma - mb) > Math.abs(best.diff) + 1e-12) best = { date: series[i].date, meanBefore: mb, meanAfter: ma, diff: ma - mb };
  }
  return best;
}

/** Daily share of the site's kWh falling in `band`, for UTC days with all 48 slots. */
export function dailyBandShare(rows: SlotRow[], band: Band): Point[] {
  const byDay = new Map<string, SlotRow[]>();
  for (const r of rows) { const d = r.ts.slice(0, 10); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r); }
  const out: Point[] = [];
  for (const [date, rs] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (rs.length !== T.SLOTS_PER_DAY) continue;
    const tot = sum(rs.map((r) => r.kwh));
    if (tot > 0) out.push({ date, value: sum(rs.filter((r) => bandOf(r.ts) === band).map((r) => r.kwh)) / tot });
  }
  return out;
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

export function nearestEvent(site: string, date: string, events: OpsEvent[], within: number = T.H5_EVENT_DAYS): ScheduleShift["nearestEvent"] {
  let best: ScheduleShift["nearestEvent"] = null;
  for (const e of events) {
    if (e.siteId !== site) continue;
    const off = daysBetween(date, e.eventDate);
    if (Math.abs(off) > within) continue;
    if (!best || Math.abs(off) < Math.abs(best.daysOff) || (Math.abs(off) === Math.abs(best.daysOff) && off < best.daysOff)) best = { eventId: e.eventId, date: e.eventDate, daysOff: off, description: e.description };
  }
  return best;
}

/** One site's slots (both windows) -> the band with the largest A-to-B share move, with its change point and nearest event; `detected` says whether the move reaches 10 pp. */
export function analyseSchedule(rows: SlotRow[], events: OpsEvent[]): ScheduleShift | null {
  const site = rows[0]?.site;
  if (!site) return null;
  const share = (win: "A" | "B"): Record<Band, number> => {
    const rs = rows.filter((r) => r.win === win), tot = sum(rs.map((r) => r.kwh));
    return Object.fromEntries(BAND_NAMES.map((b) => [b, tot > 0 ? sum(rs.filter((r) => bandOf(r.ts) === b).map((r) => r.kwh)) / tot : 0])) as Record<Band, number>;
  };
  const a = share("A"), b = share("B");
  const delta = Object.fromEntries(BAND_NAMES.map((k) => [k, (b[k] - a[k]) * 100])) as Record<Band, number>;
  const over = BAND_NAMES.filter((k) => Math.abs(delta[k]) >= T.H5_SHIFT_PP);
  const band = BAND_NAMES.reduce((best, k) => (Math.abs(delta[k]) > Math.abs(delta[best]) ? k : best), BAND_NAMES[0]);
  const cp = changePoint(dailyBandShare(rows, band));
  return {
    site, band, detected: over.length > 0, shareA: a[band], shareB: b[band], deltaPp: delta[band], bandsOverThreshold: over,
    changePoint: cp?.date ?? null, meanBefore: cp?.meanBefore ?? null, meanAfter: cp?.meanAfter ?? null,
    nearestEvent: cp ? nearestEvent(site, cp.date, events) : null,
  };
}

/** Same as analyseSchedule, but null unless a band moved >= 10 pp. */
export function detectScheduleShift(rows: SlotRow[], events: OpsEvent[]): ScheduleShift | null {
  const x = analyseSchedule(rows, events);
  return x && x.detected ? x : null;
}
