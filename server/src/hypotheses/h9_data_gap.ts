// H9 data_gap: joined meter x price rows per site per window must equal days x 48 (1344 for 28 days); carbon coverage is reported alongside.
import type { Hypothesis, Status } from "./types.ts";
import type { CoverageRow } from "../data.ts";
import { slotsInWindow } from "../windows.ts";
import { fetchMeta, metricMap, result } from "./util.ts";

export interface Gap { site: string; win: "A" | "B"; expected: number; nMeter: number; nPriced: number; nCarbon: number }
/** One entry per site and window (a missing row counts as 0 rows). */
export function coverageGaps(rows: CoverageRow[], sites: string[], expected: { A: number; B: number }): { all: Gap[]; gaps: Gap[]; carbonGaps: Gap[] } {
  const all: Gap[] = [];
  for (const site of sites) for (const win of ["A", "B"] as const) {
    const r = rows.find((x) => x.site === site && x.win === win);
    all.push({ site, win, expected: expected[win], nMeter: r?.nMeter ?? 0, nPriced: r?.nPriced ?? 0, nCarbon: r?.nCarbon ?? 0 });
  }
  return { all, gaps: all.filter((g) => g.nPriced !== g.expected || g.nMeter !== g.expected), carbonGaps: all.filter((g) => g.nCarbon !== g.expected) };
}
export const decideH9 = (gapCount: number): Status => (gapCount > 0 ? "supported" : "ruled_out");

export const H9: Hypothesis = {
  id: "H9", name: "data_gap", title: "Data gap",
  description: "Is data missing? Counts joined meter x price half-hours per site and window against the expected 1344 (28 days x 48), and meter x carbon coverage.",
  async run(ctx) {
    const f = await ctx.data.coverage({ sites: ctx.sites, windows: { A: ctx.windowA, B: ctx.windowB } }, fetchMeta(ctx, "H9", `Joined meter x price rows per site and window (${ctx.scope.label})`));
    const { all, gaps, carbonGaps } = coverageGaps(f.rows, ctx.sites, { A: slotsInWindow(ctx.windowA), B: slotsInWindow(ctx.windowB) });
    const status = decideH9(gaps.length);
    ctx.evidence.addMetrics(f.evidence.id, metricMap({
      expected_rows_per_window: [slotsInWindow(ctx.windowA), "slots"], site_windows_checked: [all.length, "site-windows"], site_windows_with_gap: [gaps.length, "site-windows"],
      missing_price_or_meter_slots: [gaps.reduce((s, g) => s + Math.abs(g.expected - Math.min(g.nMeter, g.nPriced)), 0), "slots"], site_windows_with_carbon_gap: [carbonGaps.length, "site-windows"],
    }));
    const notes = [`rule: every site-window must have exactly ${slotsInWindow(ctx.windowA)} meter rows joined to a price; ruled out if complete`];
    for (const g of gaps) notes.push(`${g.site} window ${g.win}: ${g.nMeter} meter rows, ${g.nPriced} priced (expected ${g.expected})`);
    if (carbonGaps.length) notes.push(`carbon-intensity coverage incomplete in ${carbonGaps.length} site-window(s); H10 may be affected`);
    return result("H9", "data_gap", status,
      status === "ruled_out" ? `complete: ${all.length} site-window(s) all have ${slotsInWindow(ctx.windowA)} priced half-hours` : `${gaps.length} of ${all.length} site-windows have missing or extra rows`,
      { site_windows_checked: all.length, site_windows_with_gap: gaps.length, carbon_gaps: carbonGaps.length, expected_rows_per_window: slotsInWindow(ctx.windowA) },
      [f.evidence.id], notes, { gaps });
  },
};
