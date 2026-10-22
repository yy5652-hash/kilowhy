// Tests for the bill-change decomposition. Synthetic numbers only (these are maths tests, not meter data).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decompose, weatherSplit, topDayShare, dailyDeltaCost, allocateRounded, sum,
  type Slot, type Window, type DecomposeOk, type DailyPoint, type WeatherSplit,
} from "./decompose.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mkSlots = (q: number[], p: number[], day0 = 0): Slot[] =>
  q.map((kwh, i) => ({ ts: new Date(Date.UTC(2026, 7, 27 + day0) + i * 1800e3).toISOString(), kwh, p: p[i] }));
const win = (q: number[], p: number[], days = 28, sc = 37.6525, day0 = 0): Window => ({ slots: mkSlots(q, p, day0), days, standingPencePerDay: sc });
const ok = (r: ReturnType<typeof decompose>): DecomposeOk => { assert.equal(r.ok, true, JSON.stringify(r)); return r as DecomposeOk; };
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe("decompose: identity", () => {
  it("V+L+T+S equals the total bill change for 200 random window pairs (negative prices, zero kWh slots)", () => {
    const rnd = mulberry32(2026);
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 400);
      const gen = (scale: number) => Array.from({ length: n }, () => (rnd() < 0.1 ? 0 : rnd() * scale));
      const prices = () => Array.from({ length: n }, () => -15 + rnd() * 90); // pence/kWh, Agile can go negative
      const qa = gen(3), qb = gen(4);
      qa[0] += 0.5; qb[0] += 0.5; // guarantee non-zero totals
      const a = win(qa, prices(), 28, 30 + rnd() * 20);
      const b = win(qb, prices(), 28 + Math.floor(rnd() * 3), 30 + rnd() * 20);
      const r = ok(decompose(a, b));
      assert.ok(r.identityError < 1e-6, `pair ${k}: identityError ${r.identityError}`);
      near(r.volume + r.price + r.timing + r.standing, r.deltaTotal, 1e-6);
      near(r.CA, sum(a.slots.map((s) => s.p * s.kwh)), 1e-9);
      near(r.standing, b.days * b.standingPencePerDay - a.days * a.standingPencePerDay, 1e-9);
    }
  });

  it("returns the intermediate values defined in the spec", () => {
    const a = win([1, 2, 3, 2], [10, 20, 30, 40]);
    const b = win([2, 2, 2, 4], [12, 18, 30, 50]);
    const r = ok(decompose(a, b));
    assert.equal(r.QA, 8); assert.equal(r.QB, 10);
    assert.equal(r.CA, 10 + 40 + 90 + 80); assert.equal(r.CB, 24 + 36 + 60 + 200);
    near(r.pbarA, 220 / 8); near(r.pbarB, 320 / 10);
    near(r.pbarBStar, (12 * 1 + 18 * 2 + 30 * 3 + 50 * 2) / 8);
    near(r.volume, 2 * (220 / 8)); near(r.price, 10 * (238 / 8 - 220 / 8)); near(r.timing, 10 * (32 - 238 / 8));
  });
});

describe("decompose: single-cause scenarios", () => {
  const rnd = mulberry32(7);
  const n = 96;
  const q = Array.from({ length: n }, () => 0.2 + rnd() * 2);
  const p = Array.from({ length: n }, () => -5 + rnd() * 60);

  it("no change gives all effects exactly 0", () => {
    const r = ok(decompose(win(q, p), win(q, p)));
    for (const v of [r.volume, r.price, r.timing, r.standing, r.deltaTotal, r.deltaEnergy, r.identityError]) assert.equal(v, 0);
  });

  it("price-only change (same q): V = 0 and T = 0 exactly, L = energy cost change", () => {
    const pB = p.map((x, i) => x + 3 + (i % 5));
    const r = ok(decompose(win(q, p), win(q, pB)));
    assert.equal(r.volume, 0);
    assert.equal(r.timing, 0);
    near(r.price, r.deltaEnergy, 1e-9);
    assert.ok(r.price > 0);
  });

  it("uniform volume scaling with the same prices: L = 0 and T = 0, V = whole change", () => {
    const k = 1.37;
    const r = ok(decompose(win(q, p), win(q.map((x) => x * k), p)));
    near(r.price, 0, 1e-9);
    near(r.timing, 0, 1e-9);
    near(r.volume, r.deltaEnergy, 1e-9);
    assert.ok(r.volume > 0);
  });

  it("shape-only change (same Q, same prices, load moved between slots): V = 0, L = 0, T = delta cost", () => {
    const qB = q.slice();
    // move 0.1 kWh from the dearest slot to the cheapest slot
    const hi = p.indexOf(Math.max(...p)), lo = p.indexOf(Math.min(...p));
    qB[hi] = q[hi] - 0.1; qB[lo] = q[lo] + 0.1;
    const r = ok(decompose(win(q, p), win(qB, p)));
    near(r.QA, r.QB, 1e-12);
    near(r.volume, 0, 1e-9);
    near(r.price, 0, 1e-9);
    near(r.timing, r.deltaEnergy, 1e-9);
    assert.ok(r.timing < 0, "moving load to the cheap slot should cut the bill");
  });

  it("standing-charge-only change is attributed entirely to S", () => {
    const r = ok(decompose(win(q, p, 28, 37.6525), win(q, p, 28, 40)));
    near(r.standing, 28 * (40 - 37.6525), 1e-9);
    near(r.deltaTotal, r.standing, 1e-9);
    assert.equal(r.volume, 0);
  });
});

describe("decompose: degenerate input", () => {
  const good = win([1, 1], [10, 10]);
  const finite = (o: unknown): boolean => JSON.stringify(o, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? "NaN!" : v)).indexOf("NaN!") < 0;

  it("Q_A = 0 and Q_B = 0 give an explicit error, never NaN", () => {
    const zero = win([0, 0], [10, 10]);
    const ea = decompose(zero, good), eb = decompose(good, zero);
    assert.deepEqual([ea.ok, eb.ok], [false, false]);
    assert.equal(!ea.ok && ea.error, "zero_usage_A");
    assert.equal(!eb.ok && eb.error, "zero_usage_B");
    assert.ok(finite(ea) && finite(eb));
  });

  it("empty, mismatched, non-finite and invalid-days inputs are rejected", () => {
    assert.equal((decompose(win([], []), good) as { error: string }).error, "empty_window");
    assert.equal((decompose(win([1], [1]), good) as { error: string }).error, "length_mismatch");
    assert.equal((decompose(win([1, NaN], [1, 1]), good) as { error: string }).error, "non_finite_input");
    assert.equal((decompose(good, win([1, 1], [Infinity, 1])) as { error: string }).error, "non_finite_input");
    assert.equal((decompose(win([1, 1], [1, 1], 0), good) as { error: string }).error, "invalid_days");
  });
});

describe("weatherSplit", () => {
  const days = (n: number, f: (i: number) => { kwh: number; hdd: number }): DailyPoint[] =>
    Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, ...f(i) }));

  it("recovers beta and alpha exactly on synthetic linear data", () => {
    const A = days(28, (i) => { const hdd = (i * 7) % 11; return { hdd, kwh: 40 + 3.5 * hdd }; });
    const B = days(28, (i) => { const hdd = 2 + ((i * 5) % 9); return { hdd, kwh: 40 + 3.5 * hdd + 2 }; }); // +2 kWh/day operational
    const pbarA = 25;
    const w = weatherSplit(A, B, pbarA);
    assert.ok(w.ok);
    if (!w.ok) return;
    near(w.beta, 3.5, 1e-9); near(w.alpha, 40, 1e-9); near(w.r2, 1, 1e-12);
    near(w.deltaQWeather, 3.5 * (w.sumHddB - w.sumHddA), 1e-9);
    near(w.vWeather, w.deltaQWeather * pbarA, 1e-9);
    near(w.vOperational, 2 * 28 * pbarA, 1e-6); // the extra 2 kWh/day is operational
    near(w.vWeather + w.vOperational, w.volume, 1e-9);
    assert.equal(w.flag, undefined);
  });

  it("noisy data: r2 below 1, beta close, split still adds up to V", () => {
    const rnd = mulberry32(99);
    const A = days(28, () => { const hdd = rnd() * 8; return { hdd, kwh: 50 + 4 * hdd + (rnd() - 0.5) * 6 }; });
    const B = days(28, () => { const hdd = rnd() * 8; return { hdd, kwh: 50 + 4 * hdd + (rnd() - 0.5) * 6 }; });
    const w = weatherSplit(A, B, 30);
    assert.ok(w.ok);
    if (!w.ok) return;
    assert.ok(w.r2 > 0.8 && w.r2 < 1, `r2 ${w.r2}`);
    assert.ok(Math.abs(w.beta - 4) < 0.5, `beta ${w.beta}`);
    near(w.vWeather + w.vOperational, w.volume, 1e-9);
  });

  it("flags degenerate input: zero HDD variance, one point, empty or non-finite series", () => {
    const flat = days(28, (i) => ({ hdd: 3, kwh: 50 + i }));
    const w = weatherSplit(flat, days(28, () => ({ hdd: 9, kwh: 70 })), 20);
    assert.ok(w.ok && w.flag === "hdd_variance_zero");
    if (w.ok) {
      assert.equal(w.beta, 0); assert.equal(w.r2, 0); assert.equal(w.vWeather, 0);
      near(w.vOperational, w.volume, 1e-12);
      assert.ok(Number.isFinite(w.alpha));
    }
    const one = weatherSplit(days(1, () => ({ hdd: 2, kwh: 10 })), days(1, () => ({ hdd: 5, kwh: 14 })), 10);
    assert.ok(one.ok && one.flag === "too_few_points" && one.beta === 0);
    assert.equal(weatherSplit([], flat, 10).ok, false);
    assert.equal(weatherSplit(flat, flat, NaN).ok, false);
  });

  it("warns when the fit window has almost no heating days or a poor r2, and fitOn re-fits on a wider series", () => {
    // window A: only 2 days with hdd > 0 and a weekly dip that hdd cannot explain (mimics a mild late summer)
    const A = days(28, (i) => ({ hdd: i === 12 ? 0.1 : i === 13 ? 0.5 : 0, kwh: (i % 7 === 3 ? 92 : 110) + (i === 13 ? 6 : 0) }));
    const B = days(28, (i) => ({ hdd: 1 + (i % 4), kwh: 112 + 4.3 * (1 + (i % 4)) }));
    const w = weatherSplit(A, B, 25);
    assert.ok(w.ok);
    if (!w.ok) return;
    assert.ok(w.warnings.includes("few_heating_days") && w.warnings.includes("low_r2"), w.warnings.join());
    const pooled = weatherSplit(A, B, 25, [...A, ...B]);
    assert.ok(pooled.ok);
    if (!pooled.ok) return;
    assert.equal(pooled.n, 56);
    near(pooled.volume, w.volume, 1e-9); // the total volume effect does not depend on the fit
    near(pooled.vWeather + pooled.vOperational, pooled.volume, 1e-9);
    assert.ok(Math.abs(pooled.beta - 4.3) < Math.abs(w.beta - 4.3), `pooled beta ${pooled.beta} should be closer to 4.3 than ${w.beta}`);
    const good = weatherSplit(days(28, (i) => ({ hdd: i % 9, kwh: 40 + 3 * (i % 9) })), B, 25);
    assert.ok(good.ok && good.warnings.length === 0);
  });

  it("zero kwh variance with varying HDD gives beta 0 and r2 0 (never NaN)", () => {
    const A = days(10, (i) => ({ hdd: i, kwh: 30 }));
    const w = weatherSplit(A, A, 20);
    assert.ok(w.ok);
    if (w.ok) { assert.equal(w.beta, 0); assert.equal(w.r2, 0); assert.ok(Number.isFinite(w.alpha)); }
  });
});

describe("topDayShare", () => {
  it("one dominant day", () => {
    const r = topDayShare([{ date: "d1", deltaPence: 10 }, { date: "d2", deltaPence: 70 }, { date: "d3", deltaPence: 20 }]);
    assert.equal(r.date, "d2"); near(r.share, 0.7, 1e-12); assert.equal(r.totalPence, 100);
  });
  it("evenly spread days give a small share", () => {
    const r = topDayShare(Array.from({ length: 28 }, (_, i) => ({ date: `d${i}`, deltaPence: 5 })));
    near(r.share, 1 / 28, 1e-12);
  });
  it("negative total: the largest day in the direction of the total", () => {
    const r = topDayShare([{ date: "a", deltaPence: -30 }, { date: "b", deltaPence: 10 }, { date: "c", deltaPence: -5 }]);
    assert.equal(r.date, "a"); near(r.share, 30 / 25, 1e-12); // offsetting days push the share above 1
  });
  it("empty or zero total is flagged with share 0", () => {
    assert.equal(topDayShare([]).flag, "empty");
    const z = topDayShare([{ date: "a", deltaPence: 5 }, { date: "b", deltaPence: -5 }]);
    assert.equal(z.flag, "zero_total"); assert.equal(z.share, 0);
  });
  it("dailyDeltaCost sums to the total bill change and feeds topDayShare", () => {
    const rnd = mulberry32(5);
    const n = 48 * 7;
    const q = Array.from({ length: n }, () => rnd() * 2), p = Array.from({ length: n }, () => rnd() * 40);
    const qB = q.map((x, i) => (i >= 48 * 3 && i < 48 * 4 ? x * 3 : x));
    const a = win(q, p, 7), b = win(qB, p, 7, 37.6525, 7);
    const d = dailyDeltaCost(a, b);
    assert.equal(d.length, 7);
    near(sum(d.map((x) => x.deltaPence)), ok(decompose(a, b)).deltaTotal, 1e-9);
    const top = topDayShare(d);
    assert.equal(top.date, d[3].date); assert.ok(top.share > 0.9);
  });
});

describe("allocateRounded", () => {
  it("rounded parts add up to the rounded sum", () => {
    const rnd = mulberry32(11);
    for (let k = 0; k < 200; k++) {
      const parts = Array.from({ length: 5 }, () => (rnd() - 0.4) * 5000);
      const r = allocateRounded(parts);
      assert.equal(sum(r), Math.round(sum(parts)));
      r.forEach((x, i) => assert.ok(Math.abs(x - parts[i]) <= 1, `part ${i}`));
    }
  });
});
