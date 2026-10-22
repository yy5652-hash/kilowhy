// Ground truth of a planted scenario, computed from the planted series and the real prices ONLY (nothing here calls the hypothesis library
// or server/src/decompose.ts: the bill split below is a separate implementation of the same textbook formulas).
// All quantities are for the true series (rows missing from the meter still count: the truth is what the site consumed).
import { WINDOW_A, WINDOW_B } from "../server/src/windows.ts";
import { SLOTS_A, N_SLOTS } from "./baseline.ts";
import { dateOfSlot, type Planted } from "./plants.ts";

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export interface Truth {
  deltaC: number;                         // pence, bill B minus bill A (energy + standing)
  pbarA: number;                          // pence/kWh
  V: number; L: number; T: number; S: number; // exact split, pence
  weatherEffect: number;                  // pence: pbarA x (heating kWh in B - heating kWh in A): the weather-driven volume cost
  operationalEffect: number;              // pence: pbarA x kWh change of the sustained operational plants (steps)
  topDay: { date: string; delta: number; share: number };   // largest single day in the direction of the change, exact arithmetic
  faultDays: { date: string; kwh: number; share: number }[]; // planted one-off days: their kWh and share of the change, signed (negative = against the change)
  anomalousDays: { date: string; kwh: number }[];            // days where one-off plants (fault, zero run, flatline) move the day's kWh by >= 8 kWh
  share: { weather: number; operational: number; timing: number; topDay: number };  // |effect| / |deltaC| (weather: in the direction of the change; topDay: in the direction)
}

export const ANOMALY_MIN_KWH = 8;

export function truthOf(pl: Planted, price: number[]): Truth {
  if (price.length !== N_SLOTS) throw new Error("price series has the wrong length");
  const q = pl.kwh;
  const win = (a: number[], lo: number, hi: number) => a.slice(lo, hi);
  const cost = (lo: number, hi: number) => sum(win(q, lo, hi).map((x, i) => x * price[lo + i]));
  const QA = sum(win(q, 0, SLOTS_A)), QB = sum(win(q, SLOTS_A, N_SLOTS));
  const CA = cost(0, SLOTS_A), CB = cost(SLOTS_A, N_SLOTS);
  const stdA = WINDOW_A.days * pl.standingPencePerDay.A, stdB = WINDOW_B.days * pl.standingPencePerDay.B;
  const deltaC = CB + stdB - (CA + stdA);
  const pbarA = CA / QA, pbarB = CB / QB;
  const pbarBStar = sum(win(price, SLOTS_A, N_SLOTS).map((p, i) => p * q[i])) / QA;   // B prices on the A usage shape
  const V = (QB - QA) * pbarA, L = QB * (pbarBStar - pbarA), T = QB * (pbarB - pbarBStar), S = stdB - stdA;

  const sign = deltaC < 0 ? -1 : 1;
  const heatB = sum(win(pl.heating, SLOTS_A, N_SLOTS)), heatA = sum(win(pl.heating, 0, SLOTS_A));
  const weatherEffect = pbarA * (heatB - heatA);
  const stepKwh = (lo: number, hi: number) => sum(pl.parts.filter((p) => p.cause === "step").map((p) => sum(win(p.delta, lo, hi))));
  const operationalEffect = pbarA * (stepKwh(SLOTS_A, N_SLOTS) - stepKwh(0, SLOTS_A));

  const dayDelta = Array.from({ length: WINDOW_B.days }, (_, d) => {
    const cb = sum(Array.from({ length: 48 }, (_, k) => q[SLOTS_A + d * 48 + k] * price[SLOTS_A + d * 48 + k]));
    const ca = sum(Array.from({ length: 48 }, (_, k) => q[d * 48 + k] * price[d * 48 + k]));
    return { date: dateOfSlot(SLOTS_A + d * 48), delta: cb - ca + (pl.standingPencePerDay.B - pl.standingPencePerDay.A) };
  });
  const top = dayDelta.reduce((b, x) => (x.delta * sign > b.delta * sign ? x : b), dayDelta[0]);

  const dayKwh = (cause: string, date: string) => sum(pl.parts.filter((p) => p.cause === cause).map((p) => sum(p.delta.filter((_, i) => dateOfSlot(i) === date))));
  const dayCost = (date: string) => sum(pl.parts.filter((p) => p.cause === "fault_day").map((p) => sum(p.delta.map((x, i) => (dateOfSlot(i) === date ? x * price[i] : 0)))));
  const faultDates = [...new Set(pl.parts.filter((p) => p.cause === "fault_day").flatMap((p) => p.delta.map((x, i) => (x !== 0 ? dateOfSlot(i) : "")).filter(Boolean)))];
  const faultDays = faultDates.map((date) => {
    const inB = date >= WINDOW_B.from, c = dayCost(date);
    return { date, kwh: dayKwh("fault_day", date), share: ((inB ? c : -c) * sign) / Math.abs(deltaC) };
  });
  const oneOffDates = [...new Set(pl.parts.filter((p) => p.cause === "fault_day" || p.cause === "zero_run" || p.cause === "flatline").flatMap((p) => p.delta.map((x, i) => (x !== 0 ? dateOfSlot(i) : "")).filter(Boolean)))];
  const anomalousDays = oneOffDates.map((date) => {
    const kwh = sum(["fault_day", "zero_run", "flatline"].map((c) => dayKwh(c, date)));
    return { date, kwh };
  }).filter((x) => Math.abs(x.kwh) >= ANOMALY_MIN_KWH);

  const ad = Math.abs(deltaC);
  return {
    deltaC, pbarA, V, L, T, S, weatherEffect, operationalEffect, topDay: { ...top, share: (top.delta * sign) / ad }, faultDays, anomalousDays,
    share: { weather: (weatherEffect * sign) / ad, operational: Math.abs(operationalEffect) / ad, timing: Math.abs(T) / ad, topDay: (top.delta * sign) / ad },
  };
}
