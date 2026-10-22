// Injectable data layer for one scenario: the same DataLayer interface the Zetaris layer implements (server/src/data.ts), filled from the planted series
// and the REAL prices / carbon / temperatures of the snapshot. Built on the test kit's synthetic layer (server/src/hypotheses/testkit.ts) with noise 0 and
// real series plugged into its hooks. H7 reads quality issues that Zetaris finds with one SQL query (window functions over meter_hh); here the same four
// checks are computed from the planted rows by checkQuality() below (equivalent rules, so H7 is judged on its decision, not on the SQL).
import type { QualityRow } from "../server/src/data.ts";
import { synth, type Synth } from "../server/src/hypotheses/testkit.ts";
import { THRESHOLDS as T } from "../server/src/hypotheses/thresholds.ts";
import { EVAL_SITE_ID, N_SLOTS, SLOTS_A } from "./baseline.ts";
import type { Planted } from "./plants.ts";
import { dateOfSlot } from "./plants.ts";
import type { RealWindows } from "./real.ts";

const isoSlot = (i: number): string => new Date(Date.parse("2026-08-27T00:00:00Z") + i * 1800e3).toISOString().replace(".000Z", "Z");

/** zero runs >= 4, non-zero flatlines >= 12 (consecutive identical readings over the rows that exist), days without 48 rows. */
export function checkQuality(kwh: number[], dropped: boolean[], site: string = EVAL_SITE_ID): QualityRow[] {
  const idx = kwh.map((_, i) => i).filter((i) => !dropped[i]);
  const out: QualityRow[] = [];
  for (let a = 0; a < idx.length;) {
    let b = a;
    while (b + 1 < idx.length && kwh[idx[b + 1]] === kwh[idx[a]]) b++;
    const n = b - a + 1, v = kwh[idx[a]];
    if ((v === 0 && n >= T.H7_ZERO_RUN_SLOTS) || (v !== 0 && n >= T.H7_FLATLINE_SLOTS)) out.push({ check: v === 0 ? "zero_run" : "flatline", site, start: isoSlot(idx[a]), end: isoSlot(idx[b]), n, value: v });
    a = b + 1;
  }
  const perDay = new Map<string, number>();
  for (const i of idx) perDay.set(dateOfSlot(i), (perDay.get(dateOfSlot(i)) ?? 0) + 1);
  for (const [d, n] of perDay) if (n !== T.SLOTS_PER_DAY) out.push({ check: "slots_per_day", site, start: d, end: d, n, value: null });
  return out;
}

/** UTC-day mean of the real hourly temperature, 56 days from the start of window A. */
export const dailyMeanTemps = (real: RealWindows): number[] =>
  Array.from({ length: N_SLOTS / 48 }, (_, d) => real.temps.slice(d * 24, d * 24 + 24).reduce((s, t) => s + t.tempC, 0) / 24);

export function scenarioLayer(real: RealWindows, pl: Planted): Synth {
  const at = (win: "A" | "B", day: number, slot: number): number => (win === "A" ? 0 : SLOTS_A) + day * 48 + slot;
  const temps = dailyMeanTemps(real);
  return synth({
    sites: [EVAL_SITE_ID], noise: 0,
    kwh: (_s, win, day, slot) => pl.kwh[at(win, day, slot)],
    price: (win, day, slot) => real.slots[at(win, day, slot)].p,
    intensity: (win, day, slot) => real.slots[at(win, day, slot)].intensity,
    wind: (win, day, slot) => real.slots[at(win, day, slot)].windPct,
    gas: (win, day, slot) => real.slots[at(win, day, slot)].gasPct,
    imports: (win, day, slot) => real.slots[at(win, day, slot)].importsPct,
    temp: (win, day) => temps[(win === "A" ? 0 : 28) + day],
    ops: pl.ops, contract: pl.contract,
    drop: (_s, win, day, slot) => pl.dropped[at(win, day, slot)],
    qualityIssues: checkQuality(pl.kwh, pl.dropped),
  });
}
