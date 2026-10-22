// Slot-level aggregation helpers: per-band means and kWh shares, per-day statistics.
import { BAND_NAMES, bandOf, type Band } from "../bands.ts";
import { sum } from "../decompose.ts";
import { mean, variance } from "../stats.ts";
import type { SlotAgg } from "./types.ts";

export type BandMap = Record<Band, number | null>;
const emptyBands = (): BandMap => ({ night: null, morning: null, afternoon: null, peak: null, evening: null });

/** Mean of `pick` per local band (nulls skipped); null when a band has no value. */
export function bandMeans(slots: SlotAgg[], pick: (s: SlotAgg) => number | null): BandMap {
  const acc: Record<Band, number[]> = { night: [], morning: [], afternoon: [], peak: [], evening: [] };
  for (const s of slots) { const v = pick(s); if (v !== null && Number.isFinite(v)) acc[bandOf(s.ts)].push(v); }
  const out = emptyBands();
  for (const b of BAND_NAMES) out[b] = acc[b].length ? mean(acc[b]) : null;
  return out;
}

/** Share of total kWh falling in each local band. */
export function bandShares(slots: SlotAgg[]): Record<Band, number> {
  const tot = sum(slots.map((s) => s.kwh));
  const acc: Record<Band, number> = { night: 0, morning: 0, afternoon: 0, peak: 0, evening: 0 };
  for (const s of slots) acc[bandOf(s.ts)] += s.kwh;
  for (const b of BAND_NAMES) acc[b] = tot > 0 ? acc[b] / tot : 0;
  return acc;
}

export const meanOf = (slots: SlotAgg[], pick: (s: SlotAgg) => number | null): number | null => {
  const v = slots.map(pick).filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? mean(v) : null;
};

export interface DayStat { date: string; kwh: number; meanP: number; n: number }
/** Groups aligned slots by UTC date: daily kWh and the mean slot price. */
export function dayStats(slots: SlotAgg[]): DayStat[] {
  const m = new Map<string, SlotAgg[]>();
  for (const s of slots) { const d = s.ts.slice(0, 10); (m.get(d) ?? m.set(d, []).get(d)!).push(s); }
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([date, ss]) => ({ date, kwh: sum(ss.map((x) => x.kwh)), meanP: mean(ss.map((x) => x.p)), n: ss.length }));
}

/** z-score of `x` against `xs` (sample sd); null if sd is 0 or undefined. */
export function zScore(x: number, xs: number[]): number | null {
  const sd = Math.sqrt(variance(xs));
  return sd > 1e-9 ? (x - mean(xs)) / sd : null;
}
