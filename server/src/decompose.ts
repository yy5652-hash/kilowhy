// Exact bill-change decomposition for Kilowhy (pure functions, no I/O).
//
// Two aligned windows A (baseline) and B (current), slot i of A aligned with slot i of B.
// Per window: Q = sum q (kWh), C = sum p*q (pence), Pbar = C/Q.
//   Volume  V = (Q_B - Q_A) * Pbar_A                      more/less energy at the old average price
//   Price   L = Q_B * (Pbar_B* - Pbar_A)                  new prices on the old usage shape
//   Timing  T = Q_B * (Pbar_B - Pbar_B*)                  usage moved between cheap/dear slots
//   Standing S = days_B*sc_B - days_A*sc_A
// with Pbar_B* = sum(p_B_i * w_A_i), w_A_i = q_A_i / Q_A.
// V + L + T + S = (C_B + standing_B) - (C_A + standing_A) exactly (up to floating point).
// Meter kWh in this project are SAMPLE data; the maths here is data-agnostic.

export interface Slot { ts: string; kwh: number; p: number } // p = pence/kWh (may be negative)
export interface Window { slots: Slot[]; days: number; standingPencePerDay: number }

export interface DecomposeOk {
  ok: true;
  QA: number; QB: number;                  // kWh
  CA: number; CB: number;                  // energy cost, pence
  pbarA: number; pbarB: number; pbarBStar: number; // pence/kWh
  standingA: number; standingB: number;    // pence
  totalA: number; totalB: number;          // energy + standing, pence
  deltaEnergy: number; deltaTotal: number; // pence
  volume: number; price: number; timing: number; standing: number; // V, L, T, S in pence
  identityError: number;                   // |V+L+T+S - deltaTotal| in pence
}
export type DecomposeErrorCode = "length_mismatch" | "empty_window" | "non_finite_input" | "invalid_days" | "zero_usage_A" | "zero_usage_B";
export interface DecomposeErr { ok: false; error: DecomposeErrorCode; message: string }
export type DecomposeResult = DecomposeOk | DecomposeErr;

const fail = (error: DecomposeErrorCode, message: string): DecomposeErr => ({ ok: false, error, message });

/** Neumaier compensated sum: keeps the identity error far below 1e-6 pence even for long windows. */
export function sum(xs: Iterable<number>): number {
  let s = 0, c = 0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return s + c;
}

function validate(a: Window, b: Window): DecomposeErr | null {
  if (a.slots.length === 0 || b.slots.length === 0) return fail("empty_window", "a window has no slots");
  if (a.slots.length !== b.slots.length) return fail("length_mismatch", `window A has ${a.slots.length} slots, window B has ${b.slots.length}`);
  for (const w of [a, b]) {
    if (!(w.days > 0) || !Number.isFinite(w.days)) return fail("invalid_days", "days must be a positive finite number");
    if (!Number.isFinite(w.standingPencePerDay)) return fail("non_finite_input", "standing charge is not finite");
    for (const s of w.slots) if (!Number.isFinite(s.kwh) || !Number.isFinite(s.p)) return fail("non_finite_input", `non-finite kwh/p at ${s.ts}`);
  }
  return null;
}

export function decompose(a: Window, b: Window): DecomposeResult {
  const bad = validate(a, b);
  if (bad) return bad;
  const QA = sum(a.slots.map((s) => s.kwh));
  const QB = sum(b.slots.map((s) => s.kwh));
  if (!(QA > 0)) return fail("zero_usage_A", "window A has no consumption, the baseline average price is undefined");
  if (!(QB > 0)) return fail("zero_usage_B", "window B has no consumption, the current average price is undefined");
  const CA = sum(a.slots.map((s) => s.p * s.kwh));
  const CB = sum(b.slots.map((s) => s.p * s.kwh));
  const pbarA = CA / QA;
  const pbarB = CB / QB;
  // Pbar_B* = sum(p_B_i * w_A_i) with w_A_i = q_A_i / Q_A; dividing once at the end keeps it bit-identical to Pbar_B when q is unchanged.
  const pbarBStar = sum(b.slots.map((s, i) => s.p * a.slots[i].kwh)) / QA;
  const standingA = a.days * a.standingPencePerDay;
  const standingB = b.days * b.standingPencePerDay;
  const volume = (QB - QA) * pbarA;
  const price = QB * (pbarBStar - pbarA);
  const timing = QB * (pbarB - pbarBStar);
  const standing = standingB - standingA;
  const totalA = CA + standingA, totalB = CB + standingB;
  const deltaTotal = totalB - totalA;
  const identityError = Math.abs(sum([volume, price, timing, standing]) - deltaTotal);
  return { ok: true, QA, QB, CA, CB, pbarA, pbarB, pbarBStar, standingA, standingB, totalA, totalB, deltaEnergy: CB - CA, deltaTotal, volume, price, timing, standing, identityError };
}

// ---------------------------------------------------------------- weather split of the volume effect

export interface DailyPoint { date: string; kwh: number; hdd: number } // hdd = max(0, 15.5 - daily mean temp), computed by the caller
export type WeatherFlag = "hdd_variance_zero" | "too_few_points";
/** Non-fatal quality warnings: beta is still returned but should not be trusted blindly. */
export type WeatherWarning = "low_r2" | "few_heating_days";
export interface WeatherSplit {
  ok: true;
  beta: number;   // kWh per heating degree day
  alpha: number;  // kWh/day at zero HDD
  r2: number;     // 0 when total variance of kwh is 0 (never NaN)
  n: number;
  sumHddA: number; sumHddB: number;
  deltaQWeather: number;     // beta * (sumHddB - sumHddA), kWh
  volume: number;            // (sum kwh B - sum kwh A) * pbarA, pence (same V as decompose)
  vWeather: number;          // pence
  vOperational: number;      // pence = volume - vWeather
  flag?: WeatherFlag;        // set when beta was forced to 0
  warnings: WeatherWarning[]; // low_r2: r2 < 0.3; few_heating_days: fewer than 5 fitted days with hdd > 0 (slope hangs on a handful of days)
}
export interface WeatherErr { ok: false; error: "empty_window" | "non_finite_input"; message: string }

/**
 * OLS kwh = alpha + beta*hdd on window A (or on `fitOn`, e.g. A+B pooled, as a diagnostic);
 * applies beta to the change in total HDD between the windows.
 */
export function weatherSplit(dailyA: DailyPoint[], dailyB: DailyPoint[], pbarA: number, fitOn: DailyPoint[] = dailyA): WeatherSplit | WeatherErr {
  if (dailyA.length === 0 || dailyB.length === 0 || fitOn.length === 0) return { ok: false, error: "empty_window", message: "a daily series is empty" };
  if (!Number.isFinite(pbarA) || [...dailyA, ...dailyB, ...fitOn].some((d) => !Number.isFinite(d.kwh) || !Number.isFinite(d.hdd))) {
    return { ok: false, error: "non_finite_input", message: "non-finite kwh/hdd/price input" };
  }
  const n = fitOn.length;
  const mx = sum(fitOn.map((d) => d.hdd)) / n;
  const my = sum(fitOn.map((d) => d.kwh)) / n;
  const sxx = sum(fitOn.map((d) => (d.hdd - mx) ** 2));
  const syy = sum(fitOn.map((d) => (d.kwh - my) ** 2));
  const sxy = sum(fitOn.map((d) => (d.hdd - mx) * (d.kwh - my)));
  let flag: WeatherFlag | undefined;
  if (n < 2) flag = "too_few_points";
  else if (!(sxx > 1e-9)) flag = "hdd_variance_zero";
  const beta = flag ? 0 : sxy / sxx;
  const alpha = my - beta * mx;
  const sse = sum(fitOn.map((d) => (d.kwh - alpha - beta * d.hdd) ** 2));
  const r2 = syy > 0 && !flag ? 1 - sse / syy : 0;
  const warnings: WeatherWarning[] = [];
  if (!flag && r2 < 0.3) warnings.push("low_r2");
  if (!flag && fitOn.filter((d) => d.hdd > 0).length < 5) warnings.push("few_heating_days");
  const sumHddA = sum(dailyA.map((d) => d.hdd));
  const sumHddB = sum(dailyB.map((d) => d.hdd));
  const deltaQWeather = beta * (sumHddB - sumHddA);
  const volume = (sum(dailyB.map((d) => d.kwh)) - sum(dailyA.map((d) => d.kwh))) * pbarA;
  const vWeather = deltaQWeather * pbarA;
  return { ok: true, beta, alpha, r2, n, sumHddA, sumHddB, deltaQWeather, volume, vWeather, vOperational: volume - vWeather, warnings, ...(flag ? { flag } : {}) };
}

// ---------------------------------------------------------------- one-off spike hypothesis

export interface DayDelta { date: string; deltaPence: number }
export interface TopDay {
  share: number;        // topDelta / total; can exceed 1 when other days offset it; 0 with a flag when undefined
  date: string | null;  // day with the largest contribution in the direction of the total change
  deltaPence: number;   // that day's contribution
  totalPence: number;   // total change over all days
  flag?: "empty" | "zero_total";
}

/** Share of the total cost change contributed by the single largest day (largest in the direction of the total). */
export function topDayShare(days: DayDelta[]): TopDay {
  if (days.length === 0) return { share: 0, date: null, deltaPence: 0, totalPence: 0, flag: "empty" };
  const totalPence = sum(days.map((d) => d.deltaPence));
  const dir = totalPence < 0 ? -1 : 1;
  let top = days[0];
  for (const d of days) if (d.deltaPence * dir > top.deltaPence * dir) top = d;
  if (totalPence === 0) return { share: 0, date: top.date, deltaPence: top.deltaPence, totalPence, flag: "zero_total" };
  return { share: top.deltaPence / totalPence, date: top.date, deltaPence: top.deltaPence, totalPence };
}

/** Per-day change in (energy + standing) cost, day i of B minus day i of A; slots are consecutive, `slotsPerDay` per day. */
export function dailyDeltaCost(a: Window, b: Window, slotsPerDay = 48): DayDelta[] {
  const out: DayDelta[] = [];
  const dayCost = (w: Window, i: number) => sum(w.slots.slice(i * slotsPerDay, (i + 1) * slotsPerDay).map((s) => s.p * s.kwh)) + w.standingPencePerDay;
  const nDays = Math.floor(Math.min(a.slots.length, b.slots.length) / slotsPerDay);
  for (let i = 0; i < nDays; i++) out.push({ date: b.slots[i * slotsPerDay].ts.slice(0, 10), deltaPence: dayCost(b, i) - dayCost(a, i) });
  return out;
}

// ---------------------------------------------------------------- display rounding

/** Rounds `parts` (pence) to whole pence so that they add up to round(sum of parts) (largest-remainder method). */
export function allocateRounded(parts: number[]): number[] {
  const target = Math.round(sum(parts));
  const floors = parts.map(Math.floor);
  let rest = target - sum(floors);
  const order = parts.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((u, v) => v.frac - u.frac || u.i - v.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1; rest -= 1;
  }
  return floors;
}
