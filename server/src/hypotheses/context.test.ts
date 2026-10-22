// Tests for slot alignment, contract lookup, daily series, the pooled weather model and the context build (synthetic data).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alignSlots, contractFor, buildContext } from "./context.ts";
import { dailyPoints, fitWeather, hddOf, type DayPoint } from "./weather.ts";
import { synth, ctxFor, mulberry32, DEFAULT_CONTRACT } from "./testkit.ts";
import { WINDOW_A, WINDOW_B } from "../windows.ts";
import type { ContractRow, DailyRow } from "../data.ts";
import { addDays } from "../bands.ts";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

describe("alignSlots", () => {
  it("aligns slot i of A with slot i of B (28 days apart) and sums kWh over the scope's sites", () => {
    const s = synth({ sites: ["S1", "S2"], kwh: (site) => (site === "S1" ? 1 : 2), noise: 0 });
    const al = alignSlots(s.rows, ["S1", "S2"], WINDOW_A, WINDOW_B);
    assert.equal(al.kept, 1344); assert.equal(al.expected, 1344);
    assert.equal(al.A[0].kwh, 3); assert.equal(al.B[1343].kwh, 3);
    al.A.forEach((a, i) => assert.equal(Date.parse(al.B[i].ts) - Date.parse(a.ts), 28 * 864e5));
  });
  it("drops a slot that is missing for one site or in one window, keeping the rest aligned", () => {
    const s = synth({ sites: ["S1", "S2"], noise: 0, drop: (site, win, day, slot) => (site === "S2" && win === "B" && day === 3 && slot === 10) || (site === "S1" && win === "A" && day === 0 && slot === 0) });
    const al = alignSlots(s.rows, ["S1", "S2"], WINDOW_A, WINDOW_B);
    assert.equal(al.kept, 1342);
    assert.equal(al.A.length, al.B.length);
    al.A.forEach((a, i) => assert.equal(Date.parse(al.B[i].ts) - Date.parse(a.ts), 28 * 864e5));
  });
  it("one site of a multi-site table only counts for its own scope", () => {
    const s = synth({ sites: ["S1", "S2"], noise: 0, kwh: (site) => (site === "S1" ? 1 : 5) });
    assert.equal(alignSlots(s.rows, ["S1"], WINDOW_A, WINDOW_B).A[0].kwh, 1);
  });
});

describe("contractFor", () => {
  const c = (validFrom: string, product = "P", standing = 37.65): ContractRow => ({ src: "contract", productCode: product, tariffCode: "T", standingPencePerDay: standing, vatRate: 0.05, validFrom });
  it("picks the row in force at the start of the window", () => {
    assert.equal(contractFor([c("2026-08-27")], WINDOW_A).row?.validFrom, "2026-08-27");
    assert.equal(contractFor([c("2026-01-01", "OLD"), c("2026-09-01", "NEW")], WINDOW_B).row?.productCode, "NEW");
    assert.equal(contractFor([c("2026-01-01", "OLD"), c("2026-09-01", "NEW")], WINDOW_A).row?.productCode, "OLD");
  });
  it("reports a row that starts inside the window as a mid-window change; ignores the published-standing rows", () => {
    const r = contractFor([c("2026-08-27"), c("2026-09-10", "NEW")], WINDOW_A);
    assert.equal(r.row?.productCode, "P"); assert.equal(r.midWindowChanges.length, 1);
    assert.equal(contractFor(DEFAULT_CONTRACT, WINDOW_A).midWindowChanges.length, 0);
  });
  it("a contract that starts after the window ends is not in force", () => {
    assert.equal(contractFor([c("2026-12-01")], WINDOW_A).row, null);
  });
});

describe("dailyPoints", () => {
  const row = (site: string, date: string, kwh: number, n = 48, t: number | null = 10): DailyRow => ({ site, date, kwh, nSlots: n, tMean: t, nHours: 24 });
  it("sums sites, converts temperature to HDD (base 15.5) and assigns windows", () => {
    const { points, dropped } = dailyPoints([row("S1", "2026-08-27", 100, 48, 10), row("S2", "2026-08-27", 50, 48, 10), row("S1", "2026-09-24", 90, 48, 20)], ["S1", "S2"], WINDOW_A, WINDOW_B);
    // 2026-09-24 only has S1 -> dropped from a two-site scope
    assert.deepEqual(points, [{ date: "2026-08-27", win: "A", kwh: 150, hdd: 5.5 }]);
    assert.equal(dropped, 1);
    assert.equal(hddOf(20), 0);
  });
  it("drops days with a missing temperature or fewer than 48 slots", () => {
    const { points, dropped } = dailyPoints([row("S1", "2026-08-27", 1, 47), row("S1", "2026-08-28", 1, 48, null), row("S1", "2026-08-29", 1)], ["S1"], WINDOW_A, WINDOW_B);
    assert.equal(points.length, 1); assert.equal(dropped, 2);
  });
});

describe("fitWeather (pooled OLS with window dummy and weekday dummies)", () => {
  const build = (beta: number, shiftB: number) => {
    const rnd = mulberry32(3);
    const pts: DayPoint[] = [];
    for (const [w, win] of [[WINDOW_A, "A"], [WINDOW_B, "B"]] as const) for (let d = 0; d < 28; d++) {
      const date = addDays(w.from, d), hdd = win === "A" ? rnd() * 0.5 : d * 0.25 + rnd();
      pts.push({ date, win, hdd, kwh: 100 + beta * hdd + (win === "B" ? shiftB : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -8 : 0) + (rnd() - 0.5) * 0.6 });
    }
    return pts;
  };
  it("recovers beta and the window shift; the adjusted series removes weather and weekday", () => {
    const m = fitWeather(build(4, 12));
    assert.ok(m.ok);
    if (!m.ok) return;
    assert.ok(Math.abs(m.model.beta - 4) < 0.1, String(m.model.beta));
    assert.ok(Math.abs(m.model.gamma - 12) < 1, String(m.model.gamma));
    assert.ok(m.model.t > 20 && m.model.r2 > 0.99);
    const pts = build(4, 12);
    const adj = pts.map((p) => m.model.adjust(p));
    const spread = Math.max(...adj.filter((_, i) => pts[i].win === "A")) - Math.min(...adj.filter((_, i) => pts[i].win === "A"));
    assert.ok(spread < 3, `adjusted window-A values should be nearly flat, spread ${spread}`);
  });
  it("reports a clear error when HDD never varies", () => {
    const pts = build(0, 0).map((p) => ({ ...p, hdd: 2 }));
    const m = fitWeather(pts);
    assert.equal(m.ok, false);
  });
});

describe("buildContext", () => {
  it("decomposes, records the DECOMP evidence with metrics, and standing charge per site", async () => {
    const s = synth({ sites: ["S1", "S2"], price: (w) => (w === "A" ? 20 : 25), kwh: () => 1, noise: 0 });
    const ctx = await ctxFor(s, "ALL");
    const d = ctx.decomposition;
    assert.equal(d.ok, true);
    const r = d.result!;
    near(r.QA, 2 * 1344); near(r.price, 2 * 1344 * 5);
    near(r.deltaTotal, r.volume + r.price + r.timing + r.standing, 1e-6);
    assert.equal(d.evidenceId, "E1"); assert.equal(d.contractEvidenceId, "E2");
    const e = ctx.evidence.get("E1")!;
    assert.equal(e.hypothesisId, "DECOMP");
    assert.ok(e.metrics.price_L && e.metrics.delta_total && e.metrics.kwh_A);
    near(e.metrics.price_L.value as number, 2 * 1344 * 5 / 100, 1e-6);
    assert.equal(d.standing.A, 37.65);
  });
  it("a tariff standing-charge change shows up as S in the decomposition", async () => {
    const contract: ContractRow[] = [
      { src: "contract", productCode: "P", tariffCode: "T", standingPencePerDay: 40, vatRate: 0.05, validFrom: "2026-08-27" },
      { src: "contract", productCode: "P", tariffCode: "T", standingPencePerDay: 50, vatRate: 0.05, validFrom: "2026-09-24" },
    ];
    const ctx = await ctxFor(synth({ sites: ["S1"], contract }));
    near(ctx.decomposition.result!.standing, 28 * 10);
  });
  it("reports the decomposition error instead of throwing when a window has no usage", async () => {
    const ctx = await ctxFor(synth({ kwh: (_s, w) => (w === "A" ? 0 : 1), noise: 0 }));
    assert.equal(ctx.decomposition.ok, false);
    assert.match(ctx.decomposition.error ?? "", /no consumption/);
  });
});
