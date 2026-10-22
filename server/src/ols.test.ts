// Tests for the OLS solver and the small statistics helpers. Synthetic numbers only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ols, type OlsFit } from "./ols.ts";
import { welch, pearson, mean, variance } from "./stats.ts";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const fit = (r: ReturnType<typeof ols>): OlsFit => { assert.equal(r.ok, true, JSON.stringify(r)); return r as OlsFit; };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("ols: simple regression against hand-computed values", () => {
  // x = 1..5, y = [1,3,2,5,4]: slope 0.8, intercept 0.6, RSS 3.6 (df 3), r2 0.64
  const f = fit(ols([1, 3, 2, 5, 4], [[1], [2], [3], [4], [5]], ["x"]));
  it("coefficients", () => { near(f.get("x").beta, 0.8); near(f.get("intercept").beta, 0.6); });
  it("standard errors and t", () => {
    near(f.get("x").se, Math.sqrt(1.2 / 10)); near(f.get("x").t, 0.8 / Math.sqrt(0.12));
    near(f.get("intercept").se, Math.sqrt(1.2 * (1 / 5 + 9 / 10)));
  });
  it("leverage h_i = 1/n + (x_i - mean)^2 / Sxx, and the leverages sum to the number of coefficients", () => {
    f.leverage.forEach((h, i) => near(h, 1 / 5 + ((i + 1 - 3) ** 2) / 10));
    near(f.leverage.reduce((s, h) => s + h, 0), 2);
  });
  it("r2, rss, df, sigma2, residuals", () => {
    near(f.r2, 0.64); near(f.rss, 3.6); assert.equal(f.df, 3); assert.equal(f.n, 5); assert.equal(f.k, 2); near(f.sigma2, 1.2);
    f.residuals.forEach((e, i) => near(e, [-0.4, 0.8, -1.0, 1.2, -0.6][i]));
  });
});

describe("ols: multiple regression", () => {
  const rnd = mulberry32(11);
  const n = 40;
  const x1 = Array.from({ length: n }, () => rnd() * 10);
  const x2 = Array.from({ length: n }, (_, i) => (i % 2) + rnd() * 0.3);
  const y = x1.map((v, i) => 5 + 2 * v - 3 * x2[i] + (rnd() - 0.5) * 2);
  const f = fit(ols(y, x1.map((v, i) => [v, x2[i]]), ["x1", "x2"]));

  it("matches an independent 3x3 Cramer's-rule solution of the normal equations", () => {
    const rows = x1.map((v, i) => [1, v, x2[i]]);
    const A = [0, 1, 2].map((a) => [0, 1, 2].map((b) => rows.reduce((s, r) => s + r[a] * r[b], 0)));
    const rhs = [0, 1, 2].map((a) => rows.reduce((s, r, i) => s + r[a] * y[i], 0));
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(A);
    const sol = [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, k) => (k === c ? rhs[r] : v)))) / d);
    near(f.get("intercept").beta, sol[0], 1e-8); near(f.get("x1").beta, sol[1], 1e-8); near(f.get("x2").beta, sol[2], 1e-8);
    // standard errors from the adjugate: var(b_j) = sigma2 * cofactor_jj / det
    const cof = (r: number, c: number) => { const m = [0, 1, 2].filter((i) => i !== r).map((i) => [0, 1, 2].filter((j) => j !== c).map((j) => A[i][j])); return m[0][0] * m[1][1] - m[0][1] * m[1][0]; };
    [["intercept", 0], ["x1", 1], ["x2", 2]].forEach(([name, j]) => near(f.get(name as string).se, Math.sqrt(f.sigma2 * cof(j as number, j as number) / d), 1e-8));
  });
  it("leverages sum to k (3) and lie in (0, 1)", () => {
    near(f.leverage.reduce((s, h) => s + h, 0), 3, 1e-9);
    assert.ok(f.leverage.every((h) => h > 0 && h < 1));
  });
  it("residuals are orthogonal to every predictor and sum to zero", () => {
    near(f.residuals.reduce((s, e) => s + e, 0), 0, 1e-9);
    near(f.residuals.reduce((s, e, i) => s + e * x1[i], 0), 0, 1e-8);
    near(f.residuals.reduce((s, e, i) => s + e * x2[i], 0), 0, 1e-8);
  });
  it("recovers the generating coefficients within a few standard errors and has a high r2", () => {
    assert.ok(Math.abs(f.get("x1").beta - 2) < 4 * f.get("x1").se);
    assert.ok(Math.abs(f.get("x2").beta + 3) < 4 * f.get("x2").se);
    assert.ok(f.r2 > 0.98 && f.r2 < 1);
  });
  it("is invariant to the order of columns and rescales correctly with units", () => {
    const g = fit(ols(y, x1.map((v, i) => [x2[i], v * 1000]), ["x2", "x1k"]));
    near(g.get("x1k").beta * 1000, f.get("x1").beta, 1e-8); near(g.get("x1k").t, f.get("x1").t, 1e-8); near(g.r2, f.r2, 1e-12);
  });
});

describe("ols: the H3 design (HDD + window dummy + weekday dummies)", () => {
  it("recovers beta (kWh per HDD) and the window shift from noiseless-plus-small-noise daily data", () => {
    const rnd = mulberry32(5);
    const rows: number[][] = [], y: number[] = [];
    for (let d = 0; d < 56; d++) {
      const hdd = d < 28 ? rnd() * 0.5 : 1 + rnd() * 5, win = d < 28 ? 0 : 1, wd = d % 7;
      rows.push([hdd, win, ...Array.from({ length: 6 }, (_, k) => (wd === k + 1 ? 1 : 0))]);
      y.push(100 + 4.2 * hdd + 12 * win + (wd === 0 ? -9 : 0) + (rnd() - 0.5));
    }
    const f = fit(ols(y, rows, ["hdd", "win", "wd1", "wd2", "wd3", "wd4", "wd5", "wd6"]));
    assert.ok(Math.abs(f.get("hdd").beta - 4.2) < 0.3, String(f.get("hdd").beta));
    assert.ok(Math.abs(f.get("win").beta - 12) < 1.5);
    assert.ok(f.get("hdd").t > 10);
    assert.ok(f.r2 > 0.98);
  });
});

describe("ols: degenerate input is reported, never NaN", () => {
  it("constant column, duplicate column and exact collinearity are 'singular'", () => {
    const y = [1, 2, 3, 4, 5, 6];
    const e1 = ols(y, y.map(() => [1]), ["c"]);
    assert.deepEqual([e1.ok, !e1.ok && e1.error], [false, "singular"]);
    const x = [3, 1, 4, 1, 5, 9];
    const e2 = ols(y, x.map((v) => [v, v]), ["a", "b"]);
    assert.deepEqual([e2.ok, !e2.ok && e2.error], [false, "singular"]);
    const x2 = [2, 7, 1, 8, 2, 8];
    const e3 = ols(y, x.map((v, i) => [v, x2[i], v + x2[i]]), ["a", "b", "c"]);
    assert.deepEqual([e3.ok, !e3.ok && e3.error], [false, "singular"]);
  });
  it("too few observations, shape mismatch and non-finite values", () => {
    const e1 = ols([1, 2], [[1], [2]], ["x"]);
    assert.equal(!e1.ok && e1.error, "too_few_observations");
    const e2 = ols([1, 2, 3, 4], [[1], [2], [3]], ["x"]);
    assert.equal(!e2.ok && e2.error, "shape_mismatch");
    const e3 = ols([1, 2, 3, NaN], [[1], [2], [3], [4]], ["x"]);
    assert.equal(!e3.ok && e3.error, "non_finite_input");
  });
  it("constant y gives r2 = 0 and beta 0", () => {
    const f = fit(ols([5, 5, 5, 5, 5], [[1], [2], [3], [5], [4]], ["x"]));
    assert.equal(f.r2, 0); near(f.get("x").beta, 0); near(f.get("intercept").beta, 5);
  });
  it("get() of an unknown coefficient throws", () => {
    const f = fit(ols([1, 3, 2, 5, 4], [[1], [2], [3], [4], [5]], ["x"]));
    assert.throws(() => f.get("nope"));
  });
});

describe("stats: welch, pearson, mean, variance", () => {
  it("Welch t matches hand-computed values (and has the sign of after - before)", () => {
    const w = welch([1, 2, 3, 4, 5], [4, 5, 6, 7, 8, 9]);
    assert.equal(w.ok, true);
    if (!w.ok) return;
    near(w.diff, 3.5); near(w.se, Math.sqrt(2.5 / 5 + 3.5 / 6)); near(w.t, 3.5 / Math.sqrt(2.5 / 5 + 3.5 / 6));
    near(w.df, ((2.5 / 5 + 3.5 / 6) ** 2) / ((2.5 / 5) ** 2 / 4 + (3.5 / 6) ** 2 / 5));
    const rev = welch([4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 5]);
    assert.ok(rev.ok && rev.t < 0);
  });
  it("Welch rejects tiny or zero-variance samples explicitly", () => {
    const a = welch([1], [1, 2]); assert.equal(!a.ok && a.error, "too_few_points");
    const b = welch([2, 2, 2], [3, 3, 3]); assert.equal(!b.ok && b.error, "zero_variance");
  });
  it("Pearson: perfect, inverse, constant and short series", () => {
    near(pearson([1, 2, 3, 4], [2, 4, 6, 8])!, 1); near(pearson([1, 2, 3, 4], [8, 6, 4, 2])!, -1);
    assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
    assert.equal(pearson([1, 2], [1, 2]), null);
    near(pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])!, 0.8);
  });
  it("mean and sample variance", () => {
    near(mean([1, 2, 3, 4]), 2.5); near(variance([1, 2, 3, 4]), 5 / 3);
    assert.ok(Number.isNaN(variance([1])) && Number.isNaN(mean([])));
  });
});
