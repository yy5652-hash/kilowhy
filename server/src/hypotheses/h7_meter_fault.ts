// H7 meter_fault: zero runs >= 4 slots, flatlines >= 12 identical non-zero readings, duplicate timestamps, days without 48 slots.
// Found by ONE Zetaris query (window functions over meter_hh); ruled_out when none exist.
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import type { QualityRow } from "../data.ts";
import { fetchMeta, metricMap, result } from "./util.ts";

export interface H7Counts { zeroRuns: number; flatlines: number; duplicates: number; shortDays: number; sitesWithRows: number; sitesExpected: number }
export function decideH7(c: H7Counts): Status {
  if (c.sitesWithRows < c.sitesExpected) return "inconclusive"; // a site without any meter rows cannot be certified clean
  return c.zeroRuns + c.flatlines + c.duplicates + c.shortDays > 0 ? "supported" : "ruled_out";
}

export const H7: Hypothesis = {
  id: "H7", name: "meter_fault", title: "Meter fault",
  description: "Is the change a metering artefact? Looks for runs of zero readings (>= 4 slots), flatlines (>= 12 identical non-zero), duplicate timestamps and days without 48 half-hours.",
  async run(ctx) {
    const f = await ctx.data.quality({ sites: ctx.sites, windows: { A: ctx.windowA, B: ctx.windowB } }, fetchMeta(ctx, "H7", `Meter quality checks (${ctx.scope.label})`));
    const rows: QualityRow[] = f.rows;
    const of = (c: string) => rows.filter((r) => r.check === c);
    const counts: H7Counts = {
      zeroRuns: of("zero_run").length, flatlines: of("flatline").length, duplicates: of("duplicate_ts").length, shortDays: of("slots_per_day").length,
      sitesWithRows: new Set(of("rows").map((r) => r.site)).size, sitesExpected: ctx.sites.length,
    };
    const status = decideH7(counts);
    ctx.evidence.addMetrics(f.evidence.id, metricMap({ zero_runs: [counts.zeroRuns, "runs"], flatlines: [counts.flatlines, "runs"], duplicate_timestamps: [counts.duplicates, "timestamps"], days_not_48_slots: [counts.shortDays, "days"], sites_checked: [counts.sitesWithRows, "sites"], zero_run_min_slots: [T.H7_ZERO_RUN_SLOTS, "slots"], flatline_min_slots: [T.H7_FLATLINE_SLOTS, "slots"] }));
    const issues = rows.filter((r) => r.check !== "rows");
    const notes = [`rule: zero run >= ${T.H7_ZERO_RUN_SLOTS} slots, flatline >= ${T.H7_FLATLINE_SLOTS} identical non-zero readings, duplicate ts, days != ${T.SLOTS_PER_DAY} slots; ruled out if none`];
    for (const i of issues.slice(0, 10)) notes.push(`${i.check} ${i.site} ${i.start} .. ${i.end} (${i.n}${i.value !== null ? ` x ${i.value} kWh` : ""})`);
    if (status === "supported") notes.push("faults were found; their effect on the bill change is not quantified here");
    return result("H7", "meter_fault", status,
      status === "ruled_out" ? `no zero runs, flatlines, duplicate timestamps or short days in ${counts.sitesWithRows} site(s)` : status === "supported" ? `${counts.zeroRuns} zero run(s), ${counts.flatlines} flatline(s), ${counts.duplicates} duplicate ts, ${counts.shortDays} short day(s)` : "some sites have no meter rows",
      { zero_runs: counts.zeroRuns, flatlines: counts.flatlines, duplicate_timestamps: counts.duplicates, days_not_48_slots: counts.shortDays, sites_checked: counts.sitesWithRows },
      [f.evidence.id], notes, { issues });
  },
};
