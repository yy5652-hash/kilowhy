// Small statistics helpers (pure functions): mean, sample variance, Pearson correlation, Welch's t-test.
import { sum } from "./decompose.ts";

export const mean = (xs: number[]): number => (xs.length ? sum(xs) / xs.length : NaN);

/** Sample variance (n-1 denominator); NaN for fewer than 2 values. */
export function variance(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

/** Pearson correlation; null when either series is constant or the series are shorter than 3 / of unequal length. */
export function pearson(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const mx = mean(x), my = mean(y);
  const sxx = sum(x.map((v) => (v - mx) ** 2));
  const syy = sum(y.map((v) => (v - my) ** 2));
  if (!(sxx > 1e-12) || !(syy > 1e-12)) return null;
  return sum(x.map((v, i) => (v - mx) * (y[i] - my))) / Math.sqrt(sxx * syy);
}

export interface Welch { ok: true; t: number; df: number; meanBefore: number; meanAfter: number; diff: number; nBefore: number; nAfter: number; se: number }
export interface WelchErr { ok: false; error: "too_few_points" | "zero_variance"; message: string }

/** Welch's t for (after - before); needs at least 2 points on each side. t is signed (positive = after is higher). */
export function welch(before: number[], after: number[]): Welch | WelchErr {
  if (before.length < 2 || after.length < 2) return { ok: false, error: "too_few_points", message: `need >= 2 points per side, got ${before.length} and ${after.length}` };
  const v1 = variance(before), v2 = variance(after);
  const a = v1 / before.length, b = v2 / after.length;
  const se = Math.sqrt(a + b);
  if (!(se > 0)) return { ok: false, error: "zero_variance", message: "both sides have zero variance" };
  const diff = mean(after) - mean(before);
  const df = (a + b) ** 2 / ((a * a) / (before.length - 1) + (b * b) / (after.length - 1));
  return { ok: true, t: diff / se, df, meanBefore: mean(before), meanAfter: mean(after), diff, nBefore: before.length, nAfter: after.length, se };
}
