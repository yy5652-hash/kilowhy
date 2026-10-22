// Ordinary least squares via the normal equations (no dependencies).
// y = intercept + X b. Columns are centred and scaled before the solve (Gauss-Jordan with partial pivoting),
// which keeps the normal equations well conditioned; a constant or collinear column is reported as "singular".
import { sum } from "./decompose.ts";

export interface OlsCoef { name: string; beta: number; se: number; t: number }
export interface OlsFit {
  ok: true;
  n: number; k: number; df: number;      // k = number of coefficients including the intercept
  coef: OlsCoef[];                       // coef[0] is the intercept
  r2: number;                            // 0 when y is constant
  rss: number; sigma2: number;           // residual sum of squares and RSS / df
  residuals: number[];
  leverage: number[];                    // hat-matrix diagonal h_ii (sums to k)
  get(name: string): OlsCoef;
}
export interface OlsErr { ok: false; error: "shape_mismatch" | "non_finite_input" | "too_few_observations" | "singular"; message: string }

/** Solves [M | I] -> [I | M^-1] in place; returns null when M is singular (pivot below `tol`). */
function invert(m: number[][], tol: number): number[][] | null {
  const p = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    if (!(Math.abs(a[piv][c]) > tol)) return null;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * p; j++) a[c][j] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * p; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(p));
}

/**
 * @param y     observations (n)
 * @param X     predictors, n rows x p columns, WITHOUT an intercept column (it is added)
 * @param names p predictor names
 */
export function ols(y: number[], X: number[][], names: string[]): OlsFit | OlsErr {
  const n = y.length, p = names.length;
  if (X.length !== n || X.some((r) => r.length !== p)) return { ok: false, error: "shape_mismatch", message: "X must be n x p with p = names.length" };
  if (y.some((v) => !Number.isFinite(v)) || X.some((r) => r.some((v) => !Number.isFinite(v)))) return { ok: false, error: "non_finite_input", message: "non-finite value in y or X" };
  const k = p + 1;
  if (n <= k) return { ok: false, error: "too_few_observations", message: `${n} observations for ${k} coefficients` };
  const my = sum(y) / n;
  const mx = Array.from({ length: p }, (_, j) => sum(X.map((r) => r[j])) / n);
  const Xc = X.map((r) => r.map((v, j) => v - mx[j]));
  const yc = y.map((v) => v - my);
  // scale each centred column to unit length so the pivot tolerance means the same thing for every column
  const scale = Array.from({ length: p }, (_, j) => Math.sqrt(sum(Xc.map((r) => r[j] * r[j]))));
  const flat = scale.findIndex((s) => !(s > 1e-9));
  if (flat >= 0) return { ok: false, error: "singular", message: `column "${names[flat]}" is constant` };
  const Z = Xc.map((r) => r.map((v, j) => v / scale[j]));
  const G = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, b) => sum(Z.map((r) => r[a] * r[b]))));
  const Ginv = invert(G, 1e-10);
  if (!Ginv) return { ok: false, error: "singular", message: "predictors are collinear" };
  const Zy = Array.from({ length: p }, (_, a) => sum(Z.map((r, i) => r[a] * yc[i])));
  const bz = Ginv.map((row) => sum(row.map((v, j) => v * Zy[j])));
  const b = bz.map((v, j) => v / scale[j]);
  const intercept = my - sum(b.map((v, j) => v * mx[j]));
  const residuals = y.map((v, i) => v - intercept - sum(b.map((bj, j) => bj * X[i][j])));
  const leverage = Z.map((r) => 1 / n + sum(r.map((za, a) => za * sum(r.map((zb, b) => Ginv[a][b] * zb)))));
  const rss = sum(residuals.map((e) => e * e));
  const tss = sum(yc.map((e) => e * e));
  const df = n - k;
  const sigma2 = rss / df;
  // Var(b) = sigma2 * D^-1 Ginv D^-1 ; Var(intercept) = sigma2 * (1/n + m' Var0 m) with Var0 the slope covariance / sigma2
  const V = Ginv.map((row, a) => row.map((v, c) => v / (scale[a] * scale[c])));
  const quad = sum(mx.map((ma, a) => sum(mx.map((mc, c) => ma * V[a][c] * mc))));
  const seOf = (variance: number) => Math.sqrt(Math.max(0, variance));
  const mk = (name: string, beta: number, se: number): OlsCoef => ({ name, beta, se, t: se > 0 ? beta / se : beta === 0 ? 0 : beta > 0 ? Infinity : -Infinity });
  const coef = [mk("intercept", intercept, seOf(sigma2 * (1 / n + quad))), ...names.map((nm, j) => mk(nm, b[j], seOf(sigma2 * V[j][j])))];
  return {
    ok: true, n, k, df, coef, r2: tss > 0 ? 1 - rss / tss : 0, rss, sigma2, residuals, leverage,
    get(name: string) { const c = coef.find((x) => x.name === name); if (!c) throw new Error(`no coefficient "${name}"`); return c; },
  };
}
