// Facts that come from the hypothesis library (H1..H11). Values are read from the metrics the hypotheses stored on their evidence records
// (so every fact traces to an E#), plus the structured `details` for text such as ops_log descriptions. A hypothesis that did not run yields no facts.
import type { FactsInput, FactTable } from "./facts.ts";
import type { EvidenceStore } from "./evidence.ts";
import type { EventTest } from "./hypotheses/h4_operational_change.ts";
import type { DayAnomaly } from "./hypotheses/h11_usage_anomaly_day.ts";
import type { ScheduleShift } from "./hypotheses/schedule_shift.ts";
import type { HypothesisId, HypothesisResult } from "./hypotheses/types.ts";

interface Ref { value: number | string | boolean; evidence: string }
/** First evidence record of hypothesis `hyp` that holds a non-null metric `name`. */
function ref(store: EvidenceStore, hyp: string, name: string): Ref | null {
  for (const e of store.list()) {
    const m = e.hypothesisId === hyp ? e.metrics[name] : undefined;
    if (m && m.value !== null && m.value !== undefined) return { value: m.value, evidence: e.id };
  }
  return null;
}
const pctOf = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);
const asNum = (r: Ref | null): number | null => (r && typeof r.value === "number" ? r.value : null);

type Adder = (key: string, label: string, hyp: HypothesisId, metric: string, unit: string, scale?: number) => Ref | null;

function h1h2h3h4(t: FactTable, i: FactsInput, has: (id: HypothesisId) => HypothesisResult | undefined, add: Adder): void {
  if (has("H1")) {
    add("price_peak_A", "Average unit price in the 16:00-19:00 peak band, window A", "H1", "price_peak_A", "p/kWh");
    add("price_peak_B", "Average unit price in the 16:00-19:00 peak band, window B", "H1", "price_peak_B", "p/kWh");
    add("price_peak_pct", "Change in the average peak-band unit price", "H1", "price_peak_pct", "%", 100);
  }
  if (has("H2")) {
    add("wind_A", "Wind share of generation, window A", "H2", "wind_A", "%");
    add("wind_B", "Wind share of generation, window B", "H2", "wind_B", "%");
    add("gas_A", "Gas share of generation, window A", "H2", "gas_A", "%");
    add("gas_B", "Gas share of generation, window B", "H2", "gas_B", "%");
    add("delta_wind_pp", "Change in the wind share of generation", "H2", "delta_wind_pp", "pp");
    add("delta_gas_pp", "Change in the gas share of generation", "H2", "delta_gas_pp", "pp");
    add("corr_price_wind_B", "Correlation of half-hourly price with wind share in window B (negative: less wind, dearer power)", "H2", "corr_price_wind_B", "r");
  }
  if (has("H3")) {
    add("hdd_A", "Heating degree days in window A (base 15.5 C)", "H3", "sum_hdd_A", "HDD");
    add("hdd_B", "Heating degree days in window B (base 15.5 C)", "H3", "sum_hdd_B", "HDD");
    add("beta", "Extra electricity per heating degree day (regression slope)", "H3", "beta", "kWh/HDD");
    add("beta_t", "t-statistic of that slope", "H3", "beta_t", "t");
    const vw = add("v_weather", "Weather part of the volume effect (cold weather)", "H3", "v_weather", "GBP");
    const dC = t.get("delta_bill")?.value;
    if (vw && typeof vw.value === "number" && typeof dC === "number") t.add("v_weather_share", "Weather part as a share of the bill change", pctOf(vw.value, dC), "%", vw.evidence, "H3");
  }
  if (has("H4")) {
    const dC = t.get("delta_bill")?.value, v = t.get("V")?.value;
    const vw = asNum(ref(i.evidence, "H4", "v_weather"));
    const vop = ref(i.evidence, "H4", "v_operational");
    if (vop && typeof v === "number" && vw !== null) { // V - V_weather, so that the two parts add up to V exactly as displayed
      const op = Math.round((v - vw) * 100) / 100;
      t.add("v_operational", "Operational part of the volume effect (not explained by weather)", op, "GBP", vop.evidence, "H4");
      if (typeof dC === "number") t.add("v_operational_share", "Operational part as a share of the bill change", pctOf(op, dC), "%", vop.evidence, "H4");
    }
    const events = ((has("H4")?.details?.events as EventTest[] | undefined) ?? []).filter((e) => i.scope.sites.includes(e.siteId));
    const opsEv = ref(i.evidence, "H4", "events_in_scope");
    events.forEach((e, n) => {
      const k = n + 1, where = `${e.siteId}${i.siteNames[e.siteId] ? ` (${i.siteNames[e.siteId]})` : ""}`;
      t.add(`event_${k}_site`, `Site of logged event ${k}`, where, "text", opsEv?.evidence, "H4");
      t.add(`event_${k}`, `Logged event ${k} at ${where}`, e.description, "text", opsEv?.evidence, "H4");
      t.add(`event_${k}_date`, `Date of logged event ${k} (${e.siteId})`, e.date, "date", opsEv?.evidence, "H4");
      const tRef = ref(i.evidence, "H4", `event_${e.eventId}_t_adjusted`);
      if (e.testable && tRef) {
        t.add(`event_${k}_step`, `Change in daily electricity after event ${k} (${e.siteId}), weather- and weekday-adjusted`, e.diffKwhPerDay, "kWh/day", tRef.evidence, "H4");
        t.add(`event_${k}_t`, `t-statistic of that step (event ${k}, ${e.siteId}); 2 or more counts as a real step`, e.tAdjusted, "t", tRef.evidence, "H4");
      }
    });
  }
}

function h5h6(t: FactTable, i: FactsInput, has: (id: HypothesisId) => HypothesisResult | undefined, add: Adder): void {
  const h5 = has("H5");
  if (h5) {
    add("peak_share_change_pp", "Change in the share of electricity used in the 16:00-19:00 peak band", "H5", "peak_share_change_pp", "pp");
    const shifts = (h5.details?.scheduleShifts as ScheduleShift[] | undefined) ?? [];
    const cands = (h5.details?.scheduleCandidates as ScheduleShift[] | undefined) ?? [];
    const top = shifts[0] ?? cands[0];
    const probe = ref(i.evidence, "H5", shifts[0] ? "schedule_shift_delta_pp" : "schedule_candidate_delta_pp");
    if (top && probe) {
      const kind = shifts[0] ? "Schedule shift" : "Largest daily-schedule move (below the 10 pp threshold)";
      t.add("schedule_site", `${kind}: site`, top.site, "text", probe.evidence, "H5");
      t.add("schedule_band", `${kind}: time band`, top.band, "text", probe.evidence, "H5");
      t.add("schedule_delta_pp", `${kind}: change in that band's share of the site's electricity`, top.deltaPp, "pp", probe.evidence, "H5");
      t.add("schedule_change_date", `${kind}: first day of the new pattern`, top.changePoint, "date", probe.evidence, "H5");
      t.add("schedule_event", `${kind}: nearest logged event`, top.nearestEvent?.description, "text", probe.evidence, "H5");
      t.add("schedule_event_date", `${kind}: date of that event`, top.nearestEvent?.date, "date", probe.evidence, "H5");
    }
  }
  const h6 = has("H6");
  if (h6) {
    const day = add("top_day", "Single day that contributed most to the bill change", "H6", "top_day", "date");
    add("top_day_share", "That day's share of the total bill change", "H6", "top_day_share", "%", 100);
    add("top_day_delta", "That day's change in cost (window B day minus the aligned window A day)", "H6", "top_day_delta", "GBP");
    const drv = h6.details?.topDriver as { label: string; z: number } | null | undefined;
    if (day && drv) {
      t.add("top_day_driver", "What stood out on that day pair", drv.label, "text", day.evidence, "H6");
      t.add("top_day_driver_z", "How far that was from its window mean, in standard deviations", drv.z, "sd", day.evidence, "H6");
    }
    add("opposite_day", "Day that worked most against the change", "H6", "opposite_day", "date");
    add("opposite_day_delta", "That day's change in cost", "H6", "opposite_day_delta", "GBP");
    add("anomaly_day", "Most unusual day for its weather and weekday", "H6", "anomalous_day", "date");
    add("anomaly_day_z", "How unusual that day was, in standard deviations", "H6", "anomalous_day_z", "sd");
    add("anomaly_day_excess_kwh", "Electricity above what weather and weekday predict on that day", "H6", "anomalous_day_excess_kwh", "kWh");
  }
}

function dataChecks(t: FactTable, i: FactsInput, has: (id: HypothesisId) => HypothesisResult | undefined, add: Adder): void {
  if (has("H7")) {
    const parts = ["zero_runs", "flatlines", "duplicate_timestamps", "days_not_48_slots"].map((n) => ref(i.evidence, "H7", n));
    if (parts.every((p) => p)) t.add("meter_faults", "Meter faults found (zero runs, flatlines, duplicate timestamps, days without 48 half-hours)", parts.reduce((s, p) => s + (asNum(p) ?? 0), 0), "count", parts[0]!.evidence, "H7");
    add("meter_sites_checked", "Sites whose meter readings were checked", "H7", "sites_checked", "count");
  }
  if (has("H8")) {
    add("standing_A", "Standing charge per day in window A", "H8", "standing_A", "p/day");
    add("standing_B", "Standing charge per day in window B", "H8", "standing_B", "p/day");
  }
  if (has("H9")) {
    add("data_gap_site_windows", "Site-windows with missing or extra half-hours", "H9", "site_windows_with_gap", "count");
    add("data_checked_site_windows", "Site-windows checked for completeness", "H9", "site_windows_checked", "count");
    add("data_expected_slots", "Half-hours expected per site and window", "H9", "expected_rows_per_window", "slots");
  }
}

function h10h11(t: FactTable, i: FactsInput, has: (id: HypothesisId) => HypothesisResult | undefined, add: Adder): void {
  if (has("H10")) {
    const dE = add("delta_emissions", "Change in emissions, window B minus window A (location-based, grid carbon intensity)", "H10", "delta_emissions", "kgCO2e");
    add("emissions_A", "Emissions in window A", "H10", "emissions_A", "kgCO2e");
    add("emissions_B", "Emissions in window B", "H10", "emissions_B", "kgCO2e");
    add("avg_intensity_A", "Average grid carbon intensity in window A", "H10", "avg_intensity_A", "gCO2/kWh");
    add("avg_intensity_B", "Average grid carbon intensity in window B", "H10", "avg_intensity_B", "gCO2/kWh");
    for (const [name, label, metric] of [["emissions_volume", "using more or less electricity", "volume_Vc"], ["emissions_intensity", "a dirtier or cleaner grid", "intensity_level_Lc"], ["emissions_timing", "usage moving to dirtier or cleaner times", "timing_Tc"]] as const) {
      const c = add(name, `Emissions change from ${label}`, "H10", metric, "kgCO2e");
      if (c && dE && typeof c.value === "number" && typeof dE.value === "number") t.add(`${name}_share`, `Emissions change from ${label}, as a share of the total emissions change`, pctOf(c.value, dE.value), "%", c.evidence, "H10");
    }
  }
  const h11 = has("H11");
  if (h11) {
    const flagged = ((h11.details?.flagged as DayAnomaly[] | undefined) ?? []).slice(0, 3);
    flagged.forEach((a, n) => {
      const k = n + 1, e = ref(i.evidence, "H11", `anomaly_${k}_z`)?.evidence;
      const name = i.siteNames[a.site] ? `${a.site} (${i.siteNames[a.site]})` : a.site;
      t.add(`spike_${k}_site`, `Unusual day ${k}: site`, name, "text", e, "H11");
      t.add(`spike_${k}_day`, `Unusual day ${k}: date (it falls in ${a.win === "A" ? "window A, the baseline, so it raised the baseline and did not add to the change" : "window B, the latest four weeks"})`, a.date, "date", e, "H11");
      t.add(`spike_${k}_window`, `Unusual day ${k}: which window it falls in`, a.win === "A" ? "window A (the baseline)" : "window B (the latest four weeks)", "text", e, "H11");
      t.add(`spike_${k}_kwh`, `Unusual day ${k}: electricity used`, a.kwh, "kWh", e, "H11");
      t.add(`spike_${k}_expected_kwh`, `Unusual day ${k}: electricity expected from weather and weekday`, a.expected, "kWh", e, "H11");
      t.add(`spike_${k}_z`, `Unusual day ${k}: distance from expected, in standard deviations (4 or more is flagged)`, a.z, "sd", e, "H11");
      t.add(`spike_${k}_event`, `Unusual day ${k}: logged event on that date`, a.event?.description, "text", e, "H11");
    });
    if (!flagged.length) add("max_abs_z", "Largest distance of any site-day from its expected electricity, in standard deviations (4 or more is flagged)", "H11", "max_abs_z", "sd");
  }
}

export function hypothesisFacts(t: FactTable, i: FactsInput): void {
  const has = (id: HypothesisId) => i.results.find((r) => r.id === id);
  const add: Adder = (key, label, hyp, metric, unit, scale = 1) => {
    const r = ref(i.evidence, hyp, metric);
    if (!r) return null;
    const value = typeof r.value === "number" ? r.value * scale : r.value;
    t.add(key, label, value, unit, r.evidence, hyp);
    return { value, evidence: r.evidence };
  };
  h1h2h3h4(t, i, has, add);
  h5h6(t, i, has, add);
  dataChecks(t, i, has, add);
  h10h11(t, i, has, add);
}
