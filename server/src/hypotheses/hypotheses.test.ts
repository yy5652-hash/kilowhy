// Decision-rule tests for H1..H10 on synthetic inputs (injected data layer, no Zetaris). Numbers are made up.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, HYPOTHESIS_IDS, runAll, runHypothesis } from "./index.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { gradeEffect } from "./util.ts";
import { decideH1 } from "./h1_price_level.ts";
import { decideH2 } from "./h2_price_driver.ts";
import { decideH3 } from "./h3_weather_volume.ts";
import { decideH4, testEvent } from "./h4_operational_change.ts";
import { decideH5 } from "./h5_timing_shift.ts";
import { decideH6, nameDriver, oppositeDay } from "./h6_one_off_day.ts";
import { decideH7 } from "./h7_meter_fault.ts";
import { decideH8 } from "./h8_tariff_change.ts";
import { decideH9, coverageGaps } from "./h9_data_gap.ts";
import { decideH10 } from "./h10_carbon.ts";
import { decideH11, scanAnomalies } from "./h11_usage_anomaly_day.ts";
import { synth, ctxFor, sameTemp, DEFAULT_CONTRACT } from "./testkit.ts";
import type { ContractRow, OpsEvent } from "../data.ts";
import type { HypCtx, HypothesisId, HypothesisResult } from "./types.ts";
import type { DayPoint } from "./weather.ts";
import { addDays } from "../bands.ts";

const R = (r: HypothesisResult[], id: HypothesisId): HypothesisResult => r.find((x) => x.id === id)!;
const ALL = async (ctx: HypCtx) => runAll(ctx);
const clean = (r: HypothesisResult) => assert.equal(r.summary.error, undefined, `${r.id} errored: ${r.summary.error}`);

describe("thresholds are the spec constants", () => {
  it("values", () => {
    assert.deepEqual([T.H1_SHARE, T.H2_GAS_PP, T.H2_WIND_PP, T.H2_CORR, T.H3_T, T.H3_SHARE, T.H4_SHARE, T.H4_T, T.H5_SHARE, T.H6_SHARE, T.H7_ZERO_RUN_SLOTS, T.H7_FLATLINE_SLOTS, T.SLOTS_PER_DAY, T.HDD_BASE_C],
      [0.20, 3, 3, -0.3, 2, 0.10, 0.10, 2, 0.10, 0.25, 4, 12, 48, 15.5]);
    assert.deepEqual([T.H11_Z, T.H5_SHIFT_PP, T.H5_EVENT_DAYS], [4, 10, 3]);
  });
});

describe("catalog and runner", () => {
  it("lists H1..H11 with id, name, title and a one-line description", () => {
    assert.deepEqual(CATALOG.map((c) => c.id), ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11"]);
    assert.deepEqual(HYPOTHESIS_IDS, CATALOG.map((c) => c.id));
    for (const c of CATALOG) { assert.ok(c.name && c.title && c.description.length > 20); assert.ok(!c.description.includes("\n")); }
    assert.deepEqual(CATALOG.map((c) => c.name), ["price_level", "price_driver_generation", "weather_volume", "operational_change", "timing_shift", "one_off_day", "meter_fault", "tariff_change", "data_gap", "carbon", "usage_anomaly_day"]);
  });
  it("runAll returns one result per hypothesis whose evidence ids exist, with sequential E# ids and 64-hex hashes", async () => {
    const ctx = await ctxFor(synth({ sites: ["S1", "S2"] }));
    const res = await ALL(ctx);
    assert.equal(res.length, 11);
    res.forEach(clean);
    const ids = ctx.evidence.list().map((e) => e.id);
    assert.deepEqual(ids, ids.map((_, i) => `E${i + 1}`));
    for (const r of res) { assert.ok(r.evidence.length > 0, r.id); for (const id of r.evidence) assert.ok(ctx.evidence.get(id), `${r.id} cites ${id}`); }
    for (const e of ctx.evidence.list()) { assert.match(e.resultSha256, /^[0-9a-f]{64}$/); assert.ok(e.sampleRows.length <= 10); assert.ok(e.sources.length > 0); }
  });
  it("a failing data fetch becomes an inconclusive result carrying the error", async () => {
    const s = synth({});
    const ctx = await ctxFor(s);
    const broken: HypCtx = { ...ctx, data: { ...ctx.data, quality: async () => { throw new Error("Zetaris down"); } } };
    const r = await runHypothesis("H7", broken);
    assert.equal(r.status, "inconclusive"); assert.match(String(r.summary.error), /Zetaris down/);
  });
  it("unknown id throws", async () => { await assert.rejects(runHypothesis("H99" as HypothesisId, await ctxFor(synth({})))); });
});

describe("gradeEffect / H1 decision", () => {
  it("supported at exactly 20% in the direction of the change; inconclusive between 10% and 20%; ruled out below 10% or against the change", () => {
    assert.equal(decideH1(20, 100).status, "supported");
    assert.equal(decideH1(19.9, 100).status, "inconclusive");
    assert.equal(decideH1(10, 100).status, "inconclusive");
    assert.equal(decideH1(9.9, 100).status, "ruled_out");
    assert.equal(decideH1(-60, 100).status, "ruled_out");
    assert.equal(decideH1(0, 100).status, "ruled_out");
  });
  it("is direction-aware for a cost fall and inconclusive when nothing changed", () => {
    assert.equal(decideH1(-60, -100).status, "supported");
    assert.equal(decideH1(60, -100).status, "ruled_out");
    assert.equal(decideH1(5, 0).status, "inconclusive");
    assert.equal(gradeEffect(50, 100, 0.2).share, 0.5);
  });
});

describe("H2 decision", () => {
  const base = { dGasPp: 0, dWindPp: 0, corr: -0.5, priceLevelRose: true };
  it("supported on gas +3 pp or wind -3 pp together with corr <= -0.3 and a price rise", () => {
    assert.equal(decideH2({ ...base, dGasPp: 3 }), "supported");
    assert.equal(decideH2({ ...base, dWindPp: -3 }), "supported");
    assert.equal(decideH2({ ...base, dGasPp: 3, corr: -0.3 }), "supported");
  });
  it("inconclusive when the mix moved but correlation is weaker than -0.3, missing, or the price did not rise", () => {
    assert.equal(decideH2({ ...base, dGasPp: 3, corr: -0.29 }), "inconclusive");
    assert.equal(decideH2({ ...base, dGasPp: 3, corr: null }), "inconclusive");
    assert.equal(decideH2({ ...base, dGasPp: 3, priceLevelRose: false }), "inconclusive");
  });
  it("ruled out when neither gas nor wind moved enough, whatever the correlation", () => {
    assert.equal(decideH2({ ...base, dGasPp: 2.9, dWindPp: -2.9 }), "ruled_out");
    assert.equal(decideH2({ ...base, dGasPp: -5, dWindPp: 4 }), "ruled_out");
  });
});

describe("H3 decision", () => {
  const ok = { beta: 4, t: 2, vWeatherPence: 10, deltaPence: 100 };
  it("supported only with beta > 0, t >= 2 and V_weather >= 10% of |dC|", () => {
    assert.equal(decideH3(ok).status, "supported");
    assert.equal(decideH3({ ...ok, t: 1.99 }).status, "inconclusive");
    assert.equal(decideH3({ ...ok, vWeatherPence: 9.9 }).status, "inconclusive");
    assert.equal(decideH3({ ...ok, vWeatherPence: 4.9 }).status, "ruled_out");
    assert.equal(decideH3({ ...ok, beta: -1 }).status, "ruled_out");
    assert.equal(decideH3({ ...ok, vWeatherPence: -30 }).status, "ruled_out");
    assert.equal(decideH3({ ...ok, deltaPence: 0 }).status, "inconclusive");
  });
});

describe("H4 decision and the event step test", () => {
  const ev = (t: number | null, testable = true) => ({ testable, tAdjusted: t });
  it("supported needs |V_op| >= 10% of |dC| AND an event with |t| >= 2", () => {
    assert.equal(decideH4({ vOperationalPence: 10, deltaPence: 100, events: [ev(2)] }).status, "supported");
    assert.equal(decideH4({ vOperationalPence: -10, deltaPence: 100, events: [ev(-2.5)] }).status, "supported");
    assert.equal(decideH4({ vOperationalPence: 10, deltaPence: 100, events: [ev(1.9)] }).status, "inconclusive");
    assert.equal(decideH4({ vOperationalPence: 10, deltaPence: 100, events: [] }).status, "inconclusive");
    assert.equal(decideH4({ vOperationalPence: 10, deltaPence: 100, events: [ev(9, false)] }).status, "inconclusive");
    assert.equal(decideH4({ vOperationalPence: 9, deltaPence: 100, events: [ev(5)] }).status, "inconclusive");
    assert.equal(decideH4({ vOperationalPence: 4.9, deltaPence: 100, events: [ev(5)] }).status, "ruled_out");
  });
  const days = (f: (i: number) => number, n = 40, from = "2026-09-01"): DayPoint[] =>
    Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), win: "A" as const, kwh: f(i), hdd: (i * 7) % 5 }));
  const event = (date: string): OpsEvent => ({ eventId: "E9", siteId: "S1", eventDate: date, description: "x" });
  it("finds a step after the event date (positive t) and reports the size in kWh/day", () => {
    const pts = days((i) => 100 + 4 * ((i * 7) % 5) + (i >= 20 ? 15 : 0) + ((i * 13) % 7) * 0.1);
    const t = testEvent(event(addDays("2026-09-01", 20)), pts);
    assert.equal(t.testable, true);
    assert.ok(t.tAdjusted! > 10, String(t.tAdjusted)); assert.ok(Math.abs(t.diffKwhPerDay! - 15) < 1);
    assert.equal(t.nBefore, 20); assert.equal(t.nAfter, 20);
  });
  it("a pure weather trend is NOT a step once HDD is adjusted for (raw t is large, adjusted t is small)", () => {
    // HDD rises steadily; kWh follows HDD exactly (4 kWh per HDD) plus tiny noise
    const pts: DayPoint[] = Array.from({ length: 40 }, (_, i) => ({ date: addDays("2026-09-01", i), win: i < 20 ? "A" : "B", hdd: i * 0.2, kwh: 100 + 4 * i * 0.2 + ((i * 13) % 7) * 0.05 }));
    const t = testEvent(event(addDays("2026-09-01", 20)), pts);
    assert.ok(t.tRaw! > 5, String(t.tRaw));
    assert.ok(Math.abs(t.tAdjusted!) < 2, String(t.tAdjusted));
  });
  it("an event with fewer than 5 days on one side is not testable", () => {
    const t = testEvent(event("2026-09-03"), days((i) => 100 + i));
    assert.equal(t.testable, false); assert.match(t.reason ?? "", /fewer than 5 days/);
    assert.equal(testEvent(event("2027-01-01"), days((i) => 100 + i)).testable, false);
  });
});

describe("H5 / H6 / H7 / H8 / H9 / H10 decisions", () => {
  it("H5: binary at 10% of |dC|", () => {
    assert.equal(decideH5(10, 100).status, "supported"); assert.equal(decideH5(-10, 100).status, "supported");
    assert.equal(decideH5(9.9, 100).status, "ruled_out"); assert.equal(decideH5(5, 0).status, "inconclusive");
  });
  it("H6: supported at 25%, inconclusive 12.5%..25%, ruled out below; flags are inconclusive", () => {
    assert.equal(decideH6(0.25), "supported"); assert.equal(decideH6(0.2), "inconclusive"); assert.equal(decideH6(0.125), "inconclusive");
    assert.equal(decideH6(0.12), "ruled_out"); assert.equal(decideH6(0, "zero_total"), "inconclusive");
  });
  it("H6 helpers: the largest day against the total, and the driver with the largest |z|", () => {
    const days = [{ date: "d1", deltaPence: 10 }, { date: "d2", deltaPence: -40 }, { date: "d3", deltaPence: 50 }];
    assert.deepEqual(oppositeDay(days), { date: "d2", deltaPence: -40, share: -40 / 20 });
    assert.equal(oppositeDay([{ date: "a", deltaPence: 1 }, { date: "b", deltaPence: 2 }]).date, null);
    assert.equal(nameDriver([{ kind: "a", label: "A", z: 1 }, { kind: "b", label: "B", z: -3 }, { kind: "c", label: "C", z: 2 }])!.kind, "b");
    assert.equal(nameDriver([]), null);
  });
  it("H7: any fault -> supported, none -> ruled out, a site without rows -> inconclusive", () => {
    const c = { zeroRuns: 0, flatlines: 0, duplicates: 0, shortDays: 0, sitesWithRows: 1, sitesExpected: 1 };
    assert.equal(decideH7(c), "ruled_out");
    for (const k of ["zeroRuns", "flatlines", "duplicates", "shortDays"] as const) assert.equal(decideH7({ ...c, [k]: 1 }), "supported");
    assert.equal(decideH7({ ...c, sitesWithRows: 0 }), "inconclusive");
  });
  it("H8: product, tariff, standing or a mid-window row -> supported; equal -> ruled out; missing row -> inconclusive", () => {
    const row = (o: Partial<ContractRow> = {}): ContractRow => ({ ...DEFAULT_CONTRACT[0], ...o });
    assert.equal(decideH8(row(), row(), 0).status, "ruled_out");
    assert.equal(decideH8(row(), row({ productCode: "X" }), 0).status, "supported");
    assert.equal(decideH8(row(), row({ tariffCode: "X" }), 0).status, "supported");
    assert.equal(decideH8(row(), row({ standingPencePerDay: 40 }), 0).status, "supported");
    assert.equal(decideH8(row(), row(), 1).status, "supported");
    assert.equal(decideH8(null, row(), 0).status, "inconclusive");
  });
  it("H9: expected rows per site-window (a missing site-window is a gap)", () => {
    const rows = [{ site: "S1", win: "A" as const, nMeter: 1344, nPriced: 1344, nCarbon: 1344 }, { site: "S1", win: "B" as const, nMeter: 1344, nPriced: 1343, nCarbon: 1300 }];
    const g = coverageGaps(rows, ["S1", "S2"], { A: 1344, B: 1344 });
    assert.equal(g.all.length, 4); assert.deepEqual(g.gaps.map((x) => `${x.site}${x.win}`), ["S1B", "S2A", "S2B"]); assert.equal(g.carbonGaps.length, 3);
    assert.equal(decideH9(0), "ruled_out"); assert.equal(decideH9(1), "supported");
  });
  it("H10: per-component grading, ruled out when emissions fell", () => {
    const up = decideH10(10, 70, -5, 75);
    assert.equal(up.status, "supported"); assert.equal(up.components.intensity_level.status, "supported"); assert.equal(up.components.timing.status, "ruled_out");
    assert.equal(decideH10(-10, -70, 5, -75).status, "ruled_out");
    assert.equal(decideH10(0, 0, 0, 0).status, "inconclusive");
    assert.equal(decideH10(50, 50, -30, 70).components.volume.status, "supported");
  });
});

// ------------------------------------------------------------------------------------------------ pipeline scenarios
const quiet = { noise: 0.0005 };

describe("scenario: price rise only (same usage, +10 p/kWh in every slot of window B)", () => {
  it("H1 supported, H5/H6/H3/H4 ruled out, H2 supported when wind fell and correlates with price, H7-H9 ruled out", async () => {
    const wind = (w: "A" | "B", _d: number, slot: number) => (w === "A" ? 38 : 30) - (slot >= 32 && slot < 38 ? 12 : 0) + (slot % 3);
    const ctx = await ctxFor(synth({ ...quiet, price: (w, d, slot) => (slot >= 32 && slot < 38 ? 35 : slot < 14 ? 12 : 22) + (d % 5) + (w === "B" ? 10 : 0), wind, gas: (w) => (w === "A" ? 8 : 13) }));
    const r = await ALL(ctx); r.forEach(clean);
    assert.equal(R(r, "H1").status, "supported"); assert.ok((R(r, "H1").summary.L_share_of_delta as number) > 0.95);
    assert.equal(R(r, "H2").status, "supported"); assert.ok((R(r, "H2").summary.corr_price_wind_B as number) <= -0.3);
    assert.equal(R(r, "H3").status, "ruled_out");
    assert.equal(R(r, "H4").status, "ruled_out");
    assert.equal(R(r, "H5").status, "ruled_out");
    assert.equal(R(r, "H6").status, "ruled_out");
    assert.equal(R(r, "H7").status, "ruled_out"); assert.equal(R(r, "H8").status, "ruled_out"); assert.equal(R(r, "H9").status, "ruled_out");
    assert.notEqual(R(r, "H10").status, "supported", "carbon intensity and usage unchanged: emissions did not rise");
    // the per-band evidence: peak band price in B is 10 p above A
    const e = ctx.evidence.get(R(r, "H1").evidence[1])!;
    assert.ok(Math.abs((e.metrics.price_peak_B.value as number) - (e.metrics.price_peak_A.value as number) - 10) < 1e-6);
  });
  it("a price FALL is not H1 'supported' for an increase question but is for a decrease (direction-aware)", async () => {
    const ctx = await ctxFor(synth({ ...quiet, price: (w, d, slot) => (slot >= 32 && slot < 38 ? 35 : 22) + (d % 5) - (w === "B" ? 8 : 0) }));
    const r = R(await ALL(ctx), "H1");
    assert.ok((r.summary.delta_total_gbp as number) < 0);
    assert.equal(r.status, "supported");
  });
});

describe("scenario: cold snap (window B colder, usage follows heating degree days, prices unchanged)", () => {
  it("H3 supported with beta close to the true 5 kWh/HDD; H4 and H1 ruled out", async () => {
    const hdd = (w: "A" | "B", day: number) => (w === "A" ? 0.3 + (day % 3) * 0.2 : 1 + (day % 7) * 0.9);
    const ctx = await ctxFor(synth({
      ...quiet, temp: (w, day) => 15.5 - hdd(w, day),
      kwh: (_s, w, day, slot, date) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (5 / 48) * hdd(w, day),
    }));
    const r = await ALL(ctx); r.forEach(clean);
    const h3 = R(r, "H3");
    assert.equal(h3.status, "supported");
    assert.ok(Math.abs((h3.summary.beta_kwh_per_hdd as number) - 5) < 0.1, String(h3.summary.beta_kwh_per_hdd));
    assert.ok((h3.summary.beta_t as number) >= 2); assert.ok((h3.summary.v_weather_share as number) > 0.9);
    assert.equal(R(r, "H4").status, "ruled_out");
    assert.equal(R(r, "H1").status, "ruled_out");
    assert.ok((R(r, "H3").summary.sum_hdd_B as number) > (R(r, "H3").summary.sum_hdd_A as number));
  });
});

describe("scenario: operational step (extra load from 2026-10-08, logged in ops_log)", () => {
  const stepKwh = (_s: string, w: "A" | "B", day: number, slot: number, date: string) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (w === "B" && day >= 14 ? 0.1 : 0);
  const ops: OpsEvent[] = [{ eventId: "E1", siteId: "S1", eventDate: "2026-10-08", description: "extra oven line" }];
  it("H4 supported: V_operational is most of the change and the logged event shows a daily-kWh step", async () => {
    const ctx = await ctxFor(synth({ ...quiet, kwh: stepKwh, ops }));
    const h4 = R(await ALL(ctx), "H4");
    clean(h4);
    assert.equal(h4.status, "supported");
    assert.ok((h4.summary.v_operational_share as number) > 0.8);
    assert.equal(h4.summary.steps, "E1");
    const ev = (h4.details!.events as any[])[0];
    assert.ok(Math.abs(ev.diffKwhPerDay - 4.8) < 0.3, String(ev.diffKwhPerDay)); assert.ok(ev.tAdjusted > 10);
    assert.equal(R(await ALL(ctx), "H3").status, "ruled_out");
  });
  it("the same change with NO ops_log event is inconclusive (an unexplained operational shift)", async () => {
    const h4 = R(await ALL(await ctxFor(synth({ ...quiet, kwh: stepKwh }))), "H4");
    assert.equal(h4.status, "inconclusive");
    assert.ok((h4.summary.v_operational_share as number) > 0.8);
  });
  it("flat usage (price +5 p so the change is material) with an event logged: V_operational ~ 0 -> ruled out, and the event is not a step", async () => {
    const h4 = R(await ALL(await ctxFor(synth({ ...quiet, ops, price: (w, d, slot) => (slot >= 32 && slot < 38 ? 35 : 22) + (d % 5) + (w === "B" ? 5 : 0) }))), "H4");
    assert.equal(h4.status, "ruled_out"); assert.equal(h4.summary.events_with_step, 0);
  });
  it("in a multi-site scope an event is tested on its own site's series", async () => {
    const s = synth({ ...quiet, sites: ["S1", "S2"], kwh: (site, w, day, slot, date) => stepKwh(site, w, day, slot, date) + (site === "S2" ? 0.5 : 0) - (site === "S2" && w === "B" && day >= 14 ? 0.1 : 0), ops: [{ ...ops[0], siteId: "S2" }] });
    const h4 = R(await ALL(await ctxFor(s)), "H4");
    const ev = (h4.details!.events as any[])[0];
    assert.equal(ev.siteId, "S2"); assert.ok(Math.abs(ev.tAdjusted) < 2, `S2 is flat, got t ${ev.tAdjusted}`);
  });
});

describe("scenario: timing shift (0.5 kWh moved from a cheap slot to a peak slot every day, same total)", () => {
  it("H5 supported (T is the whole change), H1 ruled out, peak-band share up", async () => {
    const ctx = await ctxFor(synth({ ...quiet, kwh: (_s, w, _d, slot, date) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (w === "B" ? (slot === 34 ? 0.5 : slot === 8 ? -0.5 : 0) : 0) }));
    const r = await ALL(ctx); r.forEach(clean);
    const h5 = R(r, "H5");
    assert.equal(h5.status, "supported"); assert.ok((h5.summary.T_gbp as number) > 0);
    assert.ok((h5.summary.T_share_of_delta as number) > 0.8);
    assert.ok((h5.summary.peak_share_change_pp as number) > 0);
    assert.equal(R(r, "H1").status, "ruled_out");
  });
});

describe("scenario: one-off day", () => {
  const day10 = (extra: number) => (_s: string, w: "A" | "B", d: number, slot: number, date: string) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (w === "B" && d === 10 ? extra : 0);
  it("a spike day in window B carries the change: supported, driver is usage on that day", async () => {
    const h6 = R(await ALL(await ctxFor(synth({ ...quiet, kwh: day10(0.8) }))), "H6");
    clean(h6);
    assert.equal(h6.status, "supported"); assert.equal(h6.summary.top_day, addDays("2026-09-24", 10)); assert.ok((h6.summary.top_day_share as number) > 0.9);
    assert.equal(h6.summary.driver, "usage_B");
    assert.equal(h6.summary.anomalous_day, addDays("2026-09-24", 10));
  });
  it("a spike day in the BASELINE window: the aligned B day is the top day (negative change) and the driver is baseline usage", async () => {
    const baseSpike = (_s: string, w: "A" | "B", d: number, slot: number, date: string) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (w === "A" && d === 5 ? 0.8 : 0);
    const h6 = R(await ALL(await ctxFor(synth({ ...quiet, kwh: baseSpike }))), "H6");
    assert.equal(h6.status, "supported"); assert.equal(h6.summary.top_day, addDays("2026-09-24", 5)); assert.equal(h6.summary.driver, "usage_A");
    assert.equal(h6.summary.anomalous_day, addDays("2026-08-27", 5));
  });
  it("evenly spread change: no single day matters", async () => {
    const h6 = R(await ALL(await ctxFor(synth({ ...quiet, kwh: (_s, w, _d, slot, date) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (w === "B" ? 0.1 : 0) }))), "H6");
    assert.equal(h6.status, "ruled_out"); assert.ok((h6.summary.top_day_share as number) < 0.125);
  });
  it("not testable when slots are missing (days cannot be paired)", async () => {
    const h6 = R(await ALL(await ctxFor(synth({ ...quiet, drop: (_s, w, d, slot) => w === "B" && d === 2 && slot === 4 }))), "H6");
    assert.equal(h6.status, "inconclusive"); assert.match(String(h6.summary.reason), /slots are missing/);
  });
});

describe("scenario: meter fault / tariff change / data gap", () => {
  it("H7 supported when the quality query finds a zero run; ruled out when it finds nothing", async () => {
    const issue = { check: "zero_run" as const, site: "S1", start: "2026-09-01 03:00:00", end: "2026-09-01 04:30:00", n: 4, value: 0 };
    assert.equal(R(await ALL(await ctxFor(synth({ qualityIssues: [issue] }))), "H7").status, "supported");
    const clean_ = R(await ALL(await ctxFor(synth({}))), "H7");
    assert.equal(clean_.status, "ruled_out"); assert.equal(clean_.summary.zero_runs, 0);
  });
  it("H8 supported with the standing-charge effect S when the contract changes between the windows", async () => {
    const contract: ContractRow[] = [{ ...DEFAULT_CONTRACT[0], validFrom: "2026-08-27" }, { ...DEFAULT_CONTRACT[0], standingPencePerDay: 50, validFrom: "2026-09-24" }];
    const r = await ALL(await ctxFor(synth({ contract })));
    assert.equal(R(r, "H8").status, "supported"); assert.ok(Math.abs((R(r, "H8").summary.standing_effect_gbp as number) - 28 * (50 - 37.65) / 100) < 0.01);
    assert.equal(R(await ALL(await ctxFor(synth({}))), "H8").status, "ruled_out");
  });
  it("H8 is inconclusive when no contract row is in force", async () => {
    assert.equal(R(await ALL(await ctxFor(synth({ contract: [] }))), "H8").status, "inconclusive");
  });
  it("H9 supported when joined rows are missing; the decomposition still runs on the common slots", async () => {
    const ctx = await ctxFor(synth({ drop: (_s, w, d, slot) => w === "B" && d === 4 && slot < 3 }));
    const h9 = R(await ALL(ctx), "H9");
    assert.equal(h9.status, "supported"); assert.equal(h9.summary.site_windows_with_gap, 1);
    assert.equal(ctx.decomposition.aligned.kept, 1344 - 3); assert.equal(ctx.decomposition.ok, true);
    assert.match(ctx.decomposition.warnings.join(" "), /1341 of 1344/);
    assert.equal(R(await ALL(await ctxFor(synth({}))), "H9").status, "ruled_out");
  });
});

describe("scenario: carbon", () => {
  it("H10 supported when intensity rose; components add up to the change; kg units", async () => {
    const ctx = await ctxFor(synth({ ...quiet, intensity: (w, _d, slot) => 100 + (slot % 4) * 10 + (w === "B" ? 30 : 0) }));
    const h10 = R(await ALL(ctx), "H10");
    clean(h10);
    assert.equal(h10.status, "supported"); assert.equal(h10.summary.intensity_level_status, "supported");
    const sum3 = (h10.summary.volume_kg as number) + (h10.summary.intensity_level_kg as number) + (h10.summary.timing_kg as number);
    assert.ok(Math.abs(sum3 - (h10.summary.delta_kg as number)) < 0.01);
    const kwhB = ctx.decomposition.result!.QB;
    assert.ok(Math.abs((h10.summary.emissions_B_kg as number) - kwhB * (100 + 15 + 30) / 1000) < 1, `kg ${h10.summary.emissions_B_kg}`);
  });
  it("lower intensity: ruled out; missing intensity: inconclusive with the reason", async () => {
    assert.equal(R(await ALL(await ctxFor(synth({ ...quiet, intensity: (w) => (w === "A" ? 120 : 90) }))), "H10").status, "ruled_out");
    const h10 = R(await ALL(await ctxFor(synth({ intensity: (w, d) => (w === "B" && d === 3 ? null : 100) }))), "H10");
    assert.equal(h10.status, "inconclusive"); assert.match(String(h10.summary.reason), /carbon intensity missing/);
  });
});

describe("scenario: decomposition unavailable", () => {
  it("hypotheses that need it say so instead of inventing numbers; the pure data checks still run", async () => {
    const ctx = await ctxFor(synth({ kwh: (_s, w) => (w === "A" ? 0 : 1), noise: 0 }));
    const r = await ALL(ctx);
    for (const id of ["H1", "H2", "H3", "H4", "H5", "H6", "H10"] as HypothesisId[]) { assert.equal(R(r, id).status, "inconclusive", id); assert.match(String(R(r, id).summary.reason), /no consumption/); }
    for (const id of ["H7", "H8", "H9"] as HypothesisId[]) assert.notEqual(R(r, id).summary.reason, "decomposition unavailable");
  });
});

describe("evidence content", () => {
  it("each hypothesis evidence carries its metrics and the sources include the SAMPLE label for meter data", async () => {
    const ctx = await ctxFor(synth({ ...quiet, sites: ["S1", "S2"] }));
    const r = await ALL(ctx);
    for (const x of r) for (const id of x.evidence) {
      const e = ctx.evidence.get(id)!;
      if (e.hypothesisId === x.id) assert.ok(Object.keys(e.metrics).length > 0, `${x.id}/${id} has metrics`);
    }
    const kinds = new Set(ctx.evidence.list().flatMap((e) => e.sources.map((s) => `${s.view}:${s.kind}`)));
    assert.ok(kinds.has("meter_hh:FILE: sample"));
    assert.ok(kinds.has("agile_rates:REST: Octopus") || kinds.has("agile_standing:REST: Octopus"));
    assert.equal(JSON.stringify(ctx.evidence).includes("NaN"), false);
  });
  it("sameTemp helper is the same in both windows (guards the scenario design)", () => assert.equal(sameTemp("A", 5), sameTemp("B", 5)));
});

describe("H11 usage_anomaly_day", () => {
  it("decision: any flagged site-day -> supported; none and all sites modelled -> ruled out; a site that could not be modelled -> inconclusive", () => {
    const d = (flagged: number, failedSites: string[], siteDays = 56) => decideH11({ flagged: Array(flagged).fill({}) as any, failedSites, siteDays });
    assert.equal(d(1, []), "supported"); assert.equal(d(1, ["S2"]), "supported");
    assert.equal(d(0, []), "ruled_out"); assert.equal(d(0, ["S2"]), "inconclusive"); assert.equal(d(0, [], 0), "inconclusive");
  });
  const mkPoints = (spike: Record<string, number> = {}): DayPoint[] =>
    Array.from({ length: 56 }, (_, i) => {
      const date = addDays("2026-08-27", i), hdd = (i * 7) % 5 + (i >= 28 ? 1 : 0);
      return { date, win: i < 28 ? "A" as const : "B" as const, hdd, kwh: 100 + 4 * hdd + ((i * 13) % 7) * 0.3 - ((i * 5) % 3) * 0.2 + (spike[date] ?? 0) };
    });
  it("scanAnomalies: flags a +30 kWh day (z well above 4), gives kWh vs expected, and cites the ops_log event of that site and date only", () => {
    const events: OpsEvent[] = [{ eventId: "E2", siteId: "S3", eventDate: "2026-09-20", description: "freezer fault" }, { eventId: "E9", siteId: "S3", eventDate: "2026-09-21", description: "other day" }, { eventId: "E8", siteId: "S1", eventDate: "2026-09-20", description: "other site" }];
    const scan = scanAnomalies([{ site: "S3", points: mkPoints({ "2026-09-20": 30 }) }], events);
    assert.equal(scan.flagged.length, 1);
    const a = scan.flagged[0];
    assert.equal(a.date, "2026-09-20"); assert.ok(a.z > 4 && a.z < 8, String(a.z));
    assert.ok(Math.abs(a.kwh - a.expected - 30) < 3, `kwh ${a.kwh} expected ${a.expected}`);
    assert.deepEqual(a.event, { eventId: "E2", description: "freezer fault" });
    assert.equal(scan.siteDays, 56); assert.equal(scan.maxAbsZ, Math.abs(a.z));
  });
  it("a negative spike (a day far BELOW expectation) is flagged too, and a higher z threshold flags nothing", () => {
    const scan = scanAnomalies([{ site: "S1", points: mkPoints({ "2026-10-01": -30 }) }], []);
    assert.equal(scan.flagged.length, 1); assert.ok(scan.flagged[0].z < -4); assert.equal(scan.flagged[0].event, null);
    assert.equal(scanAnomalies([{ site: "S1", points: mkPoints({ "2026-10-01": -30 }) }], [], 50).flagged.length, 0);
  });
  it("a series with no spike is not flagged; a site whose model cannot be fitted is listed, not guessed", () => {
    assert.equal(scanAnomalies([{ site: "S1", points: mkPoints() }], []).flagged.length, 0);
    const flat = mkPoints().map((p) => ({ ...p, hdd: 2 }));
    const scan = scanAnomalies([{ site: "S1", points: flat }, { site: "S2", points: mkPoints() }], []);
    assert.deepEqual(scan.failedSites, ["S1"]); assert.equal(scan.siteDays, 56);
  });
  const spikeKwh = (extra: number, site = "S1", day = 10) => (s: string, w: "A" | "B", d: number, slot: number, date: string) =>
    0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0) + (s === site && w === "B" && d === day ? extra : 0);
  it("pipeline: a spike day with an ops_log event is supported and the evidence cites the day, kWh vs expected, z and the event text", async () => {
    const date = addDays("2026-09-24", 10);
    const ops: OpsEvent[] = [{ eventId: "E5", siteId: "S1", eventDate: date, description: "SAMPLE: walk-in freezer fault" }];
    const ctx = await ctxFor(synth({ kwh: spikeKwh(0.8), ops }));
    const h11 = R(await ALL(ctx), "H11");
    clean(h11);
    assert.equal(h11.status, "supported");
    assert.equal(h11.summary.top_day, date); assert.equal(h11.summary.top_site, "S1");
    assert.ok((h11.summary.top_z as number) > 4); assert.ok(Math.abs((h11.summary.top_kwh as number) - (h11.summary.top_expected_kwh as number) - 38.4) < 3);
    assert.match(String(h11.summary.top_ops_event), /E5: SAMPLE: walk-in freezer fault/);
    const e = ctx.evidence.get(h11.evidence[0])!;
    assert.equal(e.metrics.anomaly_1_day.value, date); assert.match(String(e.metrics.anomaly_1_ops_event.value), /freezer/); assert.ok((e.metrics.anomaly_1_z.value as number) > 4);
    assert.ok(h11.notes.some((n) => n.includes("freezer fault") && n.includes("expected")));
  });
  it("pipeline: the same spike without a logged event says so; a flat series is ruled out", async () => {
    const h11 = R(await ALL(await ctxFor(synth({ kwh: spikeKwh(0.8) }))), "H11");
    assert.equal(h11.status, "supported"); assert.equal(h11.summary.top_ops_event, null); assert.ok(h11.notes.some((n) => n.includes("no ops_log event on that date")));
    assert.equal(R(await ALL(await ctxFor(synth({}))), "H11").status, "ruled_out");
  });
  it("pipeline: in a multi-site scope the spike is attributed to its own site", async () => {
    const h11 = R(await ALL(await ctxFor(synth({ sites: ["S1", "S2"], kwh: spikeKwh(0.8, "S2") }))), "H11");
    assert.equal(h11.status, "supported"); assert.equal(h11.summary.top_site, "S2"); assert.equal(h11.summary.site_days_tested, 112);
  });
});
