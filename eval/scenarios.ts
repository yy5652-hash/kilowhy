// The 12 evaluation scenarios: a clean baseline bakery site (S1, SAMPLE kWh) on the REAL price / carbon / temperature windows, each with
// planted causes whose truth labels were written down from the plant definitions (and the oracle's arithmetic on the planted series)
// BEFORE the hypothesis layer was run on any scenario. Nothing below was changed after seeing a hypothesis result.
//
// How the expected status is derived (eval/oracle.ts computes the numbers from the planted series and real prices only):
//   H3 weather_volume      supported when the true weather-driven volume cost (pbarA x extra heating kWh) is >= 15% of the bill change (1.5 x the 10% rule); the
//                          real windows are 3.3 C colder in B, so weather is a real cause in every scenario ("real" below), with or without a plant.
//   H4 operational_change  supported when a sustained kWh step (logged in ops_log) is planted and its cost is >= 15% of the change; otherwise ruled_out.
//   H5 timing_shift        exact arithmetic on the series: supported when the true timing effect T is >= 11% of the change, ruled_out below 9%.
//   H6 one_off_day         exact arithmetic: supported when the largest day in the direction of the change is >= 27.5% of it, ruled_out below 12.5%; between
//                          the two the rule itself answers "inconclusive", so the scenario is not scored for H6 (null). The real windows contain one real
//                          one-off day (17 Oct, whose baseline partner 19 Sep was a very cheap windy day), so H6 is "real" wherever that day decides it.
//   H7 meter_fault         supported when a zero run (>= 4 slots), flatline (>= 12) or a day without 48 slots is planted.
//   H8 tariff_change       supported when the contract changes.
//   H9 data_gap            supported when meter rows are missing.
//   H11 usage_anomaly_day  supported when a planted fault, zero run or flatline moves a day's kWh by >= 8 kWh; otherwise ruled_out.
// H1 price_level, H2 price_driver_generation and H10 carbon depend on real data only (the 4-week prices, generation mix and carbon intensity are the
// same in every scenario), so their expected status is the status measured on scenario 1 (nothing planted); they are reported, not scored.
// The recommendation (load shift into the cheapest block) is expected to find flexible peak-band load only where an oven or fault load is planted into 16-19 local.
import type { Plant } from "./plants.ts";

export type Scored = "H3" | "H4" | "H5" | "H6" | "H7" | "H8" | "H9" | "H11";
export const SCORED: readonly Scored[] = ["H3", "H4", "H5", "H6", "H7", "H8", "H9", "H11"];
export const REFERENCE = ["H1", "H2", "H10"] as const;
export type Expect = "supported" | "ruled_out";

export interface Scenario {
  n: number; id: string; title: string;
  plants: Plant[];
  /** expected status per scored hypothesis; null = not scored in this scenario (reason in `notScored`) */
  expected: Record<Scored, Expect | null>;
  /** hypotheses whose "supported" comes from real data (cold snap, 17 Oct price day), not from a planted cause */
  real: Scored[];
  notScored?: Partial<Record<Scored, string>>;
  /** is flexible load planted into the 16-19 local peak band in window B (so the load-shift recommendation should find some)? */
  flexiblePeak: boolean;
  because: string;
}

const OVEN_FAULT = 4.6;     // kWh per half-hour: the site's own oven load (S1 ovenKwh) left on for all 48 half-hours of a day
const ALL_RULED_OUT: Record<Scored, Expect> = { H3: "ruled_out", H4: "ruled_out", H5: "ruled_out", H6: "ruled_out", H7: "ruled_out", H8: "ruled_out", H9: "ruled_out", H11: "ruled_out" };
const x = (over: Partial<Record<Scored, Expect | null>>): Record<Scored, Expect | null> => ({ ...ALL_RULED_OUT, ...over });

export const SCENARIOS: Scenario[] = [
  { n: 1, id: "baseline", title: "Nothing planted (real price and weather effects only)", plants: [],
    expected: x({ H3: "supported", H6: "supported" }), real: ["H3", "H6"], flexiblePeak: false,
    because: "No cause is planted. Real windows: B is colder (heating kWh 46 -> 251) so weather carries ~43% of the change; the 17 Oct vs 19 Sep day pair carries ~31%." },
  { n: 2, id: "heating_up", title: "Heating sensitivity doubles from 3 Oct", plants: [{ kind: "heating", from: "2026-10-03", factor: 2 }],
    expected: x({ H3: "supported", H6: null }), real: [], flexiblePeak: false,
    notScored: { H6: "exact largest-day share is ~25%, inside the rule's own inconclusive band" },
    because: "Extra heating makes weather-driven volume ~60% of the change. No operational step, timing change, fault day, meter, tariff or gap cause is planted." },
  { n: 3, id: "ops_step_up", title: "Operational step: +12 kWh/day from 6 Oct (extra opening), logged", plants: [{ kind: "step", from: "2026-10-06", kwhPerDay: 12, slots: [10, 18], event: "Extra opening hours from this date." }],
    expected: x({ H3: "supported", H4: "supported", H6: null }), real: ["H3"], flexiblePeak: false,
    notScored: { H6: "exact largest-day share is ~23%, inside the rule's own inconclusive band" },
    because: "A sustained +12 kWh/day in the 05:00-09:00 UTC half-hours is ~27% of the change (volume only; timing effect ~1.5%)." },
  { n: 4, id: "schedule_shift", title: "Oven schedule moves 10 h later (into the 16-19 local peak) from 1 Oct, logged", plants: [{ kind: "shift", from: "2026-10-01", hours: 10, event: "Oven schedule moved to the afternoon from this date." }],
    expected: x({ H3: "supported", H5: "supported", H6: null }), real: ["H3"], flexiblePeak: true,
    notScored: { H6: "exact largest-day share is ~20%, inside the rule's own inconclusive band" },
    because: "Energy-neutral move of the bake into dear half-hours; timing effect ~43% of the change; no volume change." },
  { n: 5, id: "fault_day_A", title: "One-off fault day in A (16 Sep, oven on all day), logged", plants: [{ kind: "fault_day", date: "2026-09-16", kwhPerSlot: OVEN_FAULT, event: "One-off oven thermostat fault; oven ran all day." }],
    expected: x({ H3: "supported", H6: "supported", H11: "supported" }), real: ["H3", "H6"], flexiblePeak: false,
    because: "The fault inflates window A, so it works AGAINST the bill increase: H6's day in the direction of the change is the real 17 Oct day, the fault is the opposite day; H11 should flag 16 Sep." },
  { n: 6, id: "fault_day_B", title: "One-off fault day in B (19 Oct, oven on all day), logged", plants: [{ kind: "fault_day", date: "2026-10-19", kwhPerSlot: OVEN_FAULT, event: "One-off oven thermostat fault; oven ran all day." }],
    expected: x({ H3: "supported", H6: "supported", H11: "supported" }), real: ["H3"], flexiblePeak: true,
    because: "The fault day alone is ~40% of the change and the largest day; the fault also puts 13.8 kWh into the peak band that day." },
  { n: 7, id: "meter_fault", title: "Meter fault in B: zero run (9 Oct) and flatline (14 Oct)", plants: [{ kind: "zero_run", date: "2026-10-09", fromSlot: 8, slots: 8 }, { kind: "flatline", date: "2026-10-14", fromSlot: 36, slots: 16 }],
    expected: x({ H3: "supported", H6: "supported", H7: "supported", H11: "supported" }), real: ["H3", "H6"], flexiblePeak: false,
    because: "8 zero half-hours and 16 repeated readings are planted; the zero run removes ~47 kWh from 9 Oct (an anomalous day), the flatline repeats a normal night reading." },
  { n: 8, id: "data_gap", title: "Data gap in B: 30 missing half-hours (2 and 12 Oct)", plants: [{ kind: "gap", date: "2026-10-02", fromSlot: 12, slots: 24 }, { kind: "gap", date: "2026-10-12", fromSlot: 30, slots: 6 }],
    expected: x({ H3: "supported", H6: null, H7: "supported", H9: "supported" }), real: ["H3"], flexiblePeak: false,
    notScored: { H6: "H6 abstains by design when day pairs are incomplete (inconclusive), so no label exists for the observable data" },
    because: "30 meter rows are missing: H9 (rows != 1344) and H7 (days without 48 slots) are both true by their definitions." },
  { n: 9, id: "tariff_change", title: "Standing charge 37.65 -> 52.00 p/day from the start of B", plants: [{ kind: "standing", from: "2026-09-24", pencePerDay: 52 }],
    expected: x({ H3: "supported", H6: "supported", H8: "supported" }), real: ["H3", "H6"], flexiblePeak: false,
    because: "The contract row changes between the windows (S = +£4.02)." },
  { n: 10, id: "ops_step_down", title: "Operational decrease: -10 kWh/day from 8 Oct (early shift dropped), logged", plants: [{ kind: "step", from: "2026-10-08", kwhPerDay: -10, slots: [10, 18], event: "Early shift dropped from this date." }],
    expected: x({ H3: "supported", H4: "supported", H6: "supported" }), real: ["H3", "H6"], flexiblePeak: false,
    because: "A sustained -10 kWh/day is ~54% of the (smaller) change; the real 17 Oct day is ~47% of it." },
  { n: 11, id: "shift_and_step", title: "Combination: oven shift to the peak (1 Oct) + operational step +12 kWh/day (8 Oct)", plants: [
      { kind: "shift", from: "2026-10-01", hours: 10, event: "Oven schedule moved to the afternoon from this date." },
      { kind: "step", from: "2026-10-08", kwhPerDay: 12, slots: [10, 18], event: "Extra opening hours from this date." }],
    expected: x({ H3: "supported", H4: "supported", H5: "supported", H6: null }), real: ["H3"], flexiblePeak: true,
    notScored: { H6: "exact largest-day share is ~17%, inside the rule's own inconclusive band" },
    because: "Both causes are planted at the sizes of scenarios 3 and 4; each stays above its threshold in the larger change." },
  { n: 12, id: "fault_and_heating", title: "Combination: one-off fault day in B (19 Oct) + heating sensitivity doubles from 3 Oct", plants: [
      { kind: "heating", from: "2026-10-03", factor: 2 },
      { kind: "fault_day", date: "2026-10-19", kwhPerSlot: OVEN_FAULT, event: "One-off oven thermostat fault; oven ran all day." }],
    expected: x({ H3: "supported", H6: "supported", H11: "supported" }), real: [], flexiblePeak: true,
    because: "Fault ~32% of the change (largest day), heating ~43%; the fault day puts 13.8 kWh into the peak band." },
];
