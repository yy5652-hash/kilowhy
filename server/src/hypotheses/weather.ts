// Daily series per scope and the pooled weather model of H3: daily kWh ~ intercept + beta*HDD + gamma*[B] + weekday dummies.
// HDD = max(0, 15.5 - daily mean temperature) (UTC day, Open-Meteo hourly temperature via Zetaris).
import type { DailyRow } from "../data.ts";
import { weekdayUtc } from "../bands.ts";
import { ols, type OlsFit } from "../ols.ts";
import { sum } from "../decompose.ts";
import type { DateWindow } from "../windows.ts";
import { windowOf, SLOTS_PER_DAY } from "../windows.ts";
import { THRESHOLDS } from "./thresholds.ts";

export interface DayPoint { date: string; win: "A" | "B"; kwh: number; hdd: number }
export const hddOf = (tMean: number): number => Math.max(0, THRESHOLDS.HDD_BASE_C - tMean);

/** Sums daily kWh over `sites`; a day is kept only if every site has 48 slots and a temperature exists. `dropped` counts the others. */
export function dailyPoints(rows: DailyRow[], sites: string[], a: DateWindow, b: DateWindow): { points: DayPoint[]; dropped: number } {
  const byDate = new Map<string, DailyRow[]>();
  for (const r of rows) if (sites.includes(r.site)) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r);
  const points: DayPoint[] = [];
  let dropped = 0;
  for (const [date, rs] of [...byDate].sort((x, y) => x[0].localeCompare(y[0]))) {
    const win = windowOf(date, a, b);
    if (!win) continue;
    const complete = rs.length === sites.length && rs.every((r) => r.nSlots === SLOTS_PER_DAY) && rs[0].tMean !== null;
    if (!complete) { dropped++; continue; }
    points.push({ date, win, kwh: sum(rs.map((r) => r.kwh)), hdd: hddOf(rs[0].tMean as number) });
  }
  return { points, dropped };
}

export const WD_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DUMMIES = [2, 3, 4, 5, 6, 0]; // Tue..Sat, Sun (Monday is the reference)

export interface WeatherModel {
  fit: OlsFit;
  beta: number; se: number; t: number; r2: number; n: number;
  gamma: number;                    // window-B shift in kWh/day after weather and weekday
  sigma: number;                    // residual standard deviation, kWh/day
  residualByDate: Map<string, number>;
  sumHddA: number; sumHddB: number;
  /** daily kWh with the weather and weekday terms removed (the window shift is left in) */
  adjust(p: { date: string; kwh: number; hdd: number }): number;
}
export type WeatherFit = { ok: true; model: WeatherModel } | { ok: false; error: string };

export function fitWeather(points: DayPoint[]): WeatherFit {
  // columns without any variation (a window that is absent, a weekday that never occurs) are left out; HDD itself must vary
  const cols: { name: string; f: (p: DayPoint) => number; wd?: number }[] = [
    { name: "hdd", f: (p) => p.hdd }, { name: "win_B", f: (p) => (p.win === "B" ? 1 : 0) },
    ...DUMMIES.map((d) => ({ name: `wd_${WD_NAMES[d]}`, f: (p: DayPoint) => (weekdayUtc(p.date) === d ? 1 : 0), wd: d })),
  ];
  const used = cols.filter((c, i) => { const v = points.map(c.f); return i === 0 || v.some((x) => x !== v[0]); });
  const f = ols(points.map((p) => p.kwh), points.map((p) => used.map((c) => c.f(p))), used.map((c) => c.name));
  if (!f.ok) return { ok: false, error: `${f.error}: ${f.message}` };
  const hdd = f.get("hdd");
  const has = (name: string) => used.some((c) => c.name === name);
  const wdEffect = (date: string): number => { const nm = `wd_${WD_NAMES[weekdayUtc(date)]}`; return has(nm) ? f.get(nm).beta : 0; };
  return {
    ok: true,
    model: {
      fit: f, beta: hdd.beta, se: hdd.se, t: hdd.t, r2: f.r2, n: f.n, gamma: has("win_B") ? f.get("win_B").beta : 0, sigma: Math.sqrt(f.sigma2),
      residualByDate: new Map(points.map((p, i) => [p.date, f.residuals[i]])),
      sumHddA: sum(points.filter((p) => p.win === "A").map((p) => p.hdd)), sumHddB: sum(points.filter((p) => p.win === "B").map((p) => p.hdd)),
      adjust: (p) => p.kwh - hdd.beta * p.hdd - wdEffect(p.date),
    },
  };
}
