// Scenario builder tests: truth labels are consistent with what is planted, the planted series are what the plants say, and everything is deterministic.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBaseline, N_SLOTS, SLOTS_A } from "./baseline.ts";
import { deriveLabels, deriveReal } from "./labels.ts";
import { checkQuality } from "./layer.ts";
import { truthOf } from "./oracle.ts";
import { applyPlants, dateOfSlot, slotOfDate } from "./plants.ts";
import { buildSnapshot, loadReal, parseSnapshot, serializeSnapshot, validateSnapshot, type RawRun } from "./real.ts";
import { SCENARIOS, SCORED } from "./scenarios.ts";

const real = loadReal();
const price = real.slots.map((s) => s.p);
const base = buildBaseline(real);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("real-data snapshot", () => {
  it("is complete: 2 x 28 days of priced slots with carbon and generation mix, hourly temperature, run ids, no meter data", () => {
    assert.deepEqual(validateSnapshot(real), []);
    assert.equal(real.slots.length, 2688);
    assert.equal(real.temps.length, 1344);
    assert.ok(real.queries.every((q) => /^[0-9a-f-]{36}$/.test(q.zetarisRunId) && q.sql.includes("kilowhy.")));
    assert.ok(!JSON.stringify(real.queries).includes("meter_hh"));
  });
  it("round-trips through the file format and builds from Zetaris-shaped responses", () => {
    assert.deepEqual(parseSnapshot(serializeSnapshot(real)), real);
    const run = (headers: string[], data: unknown[][]): RawRun => ({ sql: "SELECT 1 FROM kilowhy.x", runId: "11111111-2222-3333-4444-555555555555", ok: true, status: 200, body: { headers, data } });
    const slots = Array.from({ length: 2688 }, (_, i) => [new Date(Date.parse("2026-08-27T00:00:00Z") + i * 1800e3).toISOString().replace("T", " ").replace(".000Z", ".0"), "20.5", "100", "30", "10", "15"]);
    const temps = Array.from({ length: 1344 }, (_, i) => [new Date(Date.parse("2026-08-27T00:00:00Z") + i * 3600e3).toISOString().replace("T", " ").replace(".000Z", ".0"), "12.5"]);
    const snap = buildSnapshot({ slots: run(["ts", "p", "intensity", "wind_pct", "gas_pct", "imports_pct"], slots), temps: run(["ts", "temp_c"], temps), standing: run(["valid_from", "p_day_exc_vat", "p_day_inc_vat"], [["2024-09-30 00:00:00.0", "37.6525", "37.6525"]]) }, "2026-10-22T00:00:00.000Z");
    assert.deepEqual(validateSnapshot(snap), []);
    assert.equal(snap.slots[1].ts, "2026-08-27T00:30:00Z");
    assert.equal(snap.standing[0].validFrom, "2024-09-30");
    assert.throws(() => buildSnapshot({ slots: { ...run([], []), ok: false, status: 500 }, temps: run([], []), standing: run([], []) }, "x"), /query failed/);
  });
});

describe("clean baseline", () => {
  it("is the sample generator's S1 series without the dated events: 2688 non-negative slots, deterministic", () => {
    assert.equal(base.kwh.length, N_SLOTS);
    assert.ok(base.kwh.every((x) => x >= 0));
    assert.deepEqual(buildBaseline(real).kwh, base.kwh);
    assert.notDeepEqual(buildBaseline(real, 7).kwh, base.kwh);
  });
  it("has the modelled heating: zero where it is warm, positive and larger in the cold window B", () => {
    assert.ok(sum(base.heating.slice(SLOTS_A)) > 4 * sum(base.heating.slice(0, SLOTS_A)));
    assert.ok(base.heating.every((h) => h >= 0));
  });
  it("noise stream is the sample's: a nothing-planted run changes no reading", () => {
    assert.deepEqual(applyPlants(base, []).kwh, base.kwh);
  });
});

describe("plants do what they say", () => {
  it("heating factor raises only heating kWh, only from its date", () => {
    const p = applyPlants(base, [{ kind: "heating", from: "2026-10-03", factor: 2 }]);
    const i = slotOfDate("2026-10-03", 10), j = slotOfDate("2026-10-02", 10);
    assert.ok(Math.abs(p.kwh[i] - (base.kwh[i] + base.heating[i])) < 1.5e-3);
    assert.equal(p.kwh[j], base.kwh[j]);
    assert.ok(Math.abs(sum(p.parts[0].delta) - sum(base.heating.map((h, k) => (dateOfSlot(k) >= "2026-10-03" ? h : 0)))) < 1e-9);
    assert.equal(p.ops.length, 0);
  });
  it("a step adds exactly kwhPerDay on every day from its date, in its half-hours, and logs an event", () => {
    const p = applyPlants(base, [{ kind: "step", from: "2026-10-06", kwhPerDay: 12, slots: [10, 18], event: "Extra opening." }]);
    const day = (d: string) => sum(p.kwh.slice(slotOfDate(d), slotOfDate(d) + 48)) - sum(base.kwh.slice(slotOfDate(d), slotOfDate(d) + 48));
    assert.ok(Math.abs(day("2026-10-06") - 12) < 0.01 && Math.abs(day("2026-10-21") - 12) < 0.01);
    assert.equal(day("2026-10-05"), 0);
    assert.deepEqual(p.ops.map((o) => [o.eventId, o.siteId, o.eventDate]), [["E1", "S1", "2026-10-06"]]);
    assert.match(p.ops[0].description, /^SAMPLE: /);
  });
  it("an oven shift moves energy without changing it", () => {
    const p = applyPlants(base, [{ kind: "shift", from: "2026-10-01", hours: 10, event: "Oven moved." }]);
    for (const d of ["2026-10-01", "2026-10-11", "2026-10-20"]) {
      const s = slotOfDate(d);
      assert.ok(Math.abs(sum(p.kwh.slice(s, s + 48)) - sum(base.kwh.slice(s, s + 48))) < 0.05, d);
    }
    assert.equal(p.kwh[slotOfDate("2026-09-30", 8)], base.kwh[slotOfDate("2026-09-30", 8)]);
    assert.ok(p.kwh[slotOfDate("2026-10-06", 8)] < base.kwh[slotOfDate("2026-10-06", 8)] - 4);
    assert.ok(p.kwh[slotOfDate("2026-10-06", 32)] > base.kwh[slotOfDate("2026-10-06", 32)] + 4);
  });
  it("a fault day adds kWh to every half-hour of that day only", () => {
    const p = applyPlants(base, [{ kind: "fault_day", date: "2026-10-19", kwhPerSlot: 4.6, event: "Fault." }]);
    const s = slotOfDate("2026-10-19");
    assert.ok(Math.abs(sum(p.kwh.slice(s, s + 48)) - sum(base.kwh.slice(s, s + 48)) - 220.8) < 0.05);
    assert.equal(p.kwh[s + 48], base.kwh[s + 48]);
    assert.equal(p.kwh[s - 1], base.kwh[s - 1]);
  });
  it("zero run, flatline and gap are what the H7 / H9 rules look for", () => {
    const p = applyPlants(base, [{ kind: "zero_run", date: "2026-10-09", fromSlot: 8, slots: 8 }, { kind: "flatline", date: "2026-10-14", fromSlot: 36, slots: 16 }, { kind: "gap", date: "2026-10-02", fromSlot: 12, slots: 24 }]);
    const q = checkQuality(p.kwh, p.dropped);
    assert.deepEqual(q.map((x) => [x.check, x.n]), [["zero_run", 8], ["flatline", 17], ["slots_per_day", 24]]);
    assert.equal(p.dropped.filter(Boolean).length, 24);
    assert.deepEqual(checkQuality(base.kwh, new Array(N_SLOTS).fill(false)), []);
  });
  it("a standing plant changes only the contract", () => {
    const p = applyPlants(base, [{ kind: "standing", from: "2026-09-24", pencePerDay: 52 }]);
    assert.deepEqual(p.kwh, base.kwh);
    assert.equal(p.contract.filter((c) => c.src === "contract").length, 2);
    assert.deepEqual(p.standingPencePerDay, { A: 37.6525, B: 52 });
  });
  it("refuses an oven shift that would leave the day", () => {
    assert.throws(() => applyPlants(base, [{ kind: "shift", from: "2026-10-01", hours: 20, event: "x" }]), /leaves the day/);
  });
});

describe("12 scenarios", () => {
  it("are numbered 1..12 with unique ids and a plant list, and scenario 1 plants nothing", () => {
    assert.deepEqual(SCENARIOS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 12);
    assert.deepEqual(SCENARIOS[0].plants, []);
    assert.ok(SCENARIOS.slice(1).every((s) => s.plants.length > 0));
  });
  for (const s of SCENARIOS) {
    it(`#${s.n} ${s.id}: expected statuses equal the labels derived from the plants and the oracle`, () => {
      const t = truthOf(applyPlants(base, s.plants), price);
      const labels = deriveLabels(s.plants, t);
      for (const h of SCORED) assert.equal(s.expected[h], labels[h], `${h}: expected ${s.expected[h]}, oracle says ${labels[h]} (weather ${t.share.weather.toFixed(3)}, op ${t.share.operational.toFixed(3)}, timing ${t.share.timing.toFixed(3)}, top-day ${t.share.topDay.toFixed(3)})`);
      assert.deepEqual([...s.real].sort(), deriveReal(s.plants, t, labels).sort(), "real-data causes");
      for (const h of SCORED) assert.ok(s.expected[h] !== null || s.notScored?.[h], `${h} not scored without a reason`);
    });
    it(`#${s.n} ${s.id}: planted causes are present in the series and in the truth, absent causes are absent`, () => {
      const pl = applyPlants(base, s.plants), t = truthOf(pl, price);
      const kinds = new Set(s.plants.map((p) => p.kind));
      assert.equal(pl.ops.length, s.plants.filter((p) => p.kind === "step" || p.kind === "shift" || p.kind === "fault_day").length, "one ops_log event per logged plant");
      if (!kinds.has("step")) assert.equal(t.operationalEffect, 0);
      if (!kinds.has("fault_day") && !kinds.has("zero_run") && !kinds.has("flatline")) assert.equal(t.anomalousDays.length, 0);
      assert.equal(t.faultDays.length, s.plants.filter((p) => p.kind === "fault_day").length);
      assert.equal(pl.dropped.some(Boolean), kinds.has("gap"));
      assert.equal(pl.standingPencePerDay.B !== pl.standingPencePerDay.A, kinds.has("standing"));
      assert.equal(s.flexiblePeak, kinds.has("shift") || s.plants.some((p) => p.kind === "fault_day" && p.date >= "2026-09-24"));
      assert.deepEqual(applyPlants(base, s.plants).kwh, pl.kwh, "deterministic");
    });
  }
  it("the oracle's bill split is exact and independent: V+L+T+S = dC for every scenario", () => {
    for (const s of SCENARIOS) {
      const t = truthOf(applyPlants(base, s.plants), price);
      assert.ok(Math.abs(t.V + t.L + t.T + t.S - t.deltaC) < 1e-6, s.id);
    }
  });
  it("the real cold snap is the same in every scenario: weather carries more than a third of the baseline change", () => {
    const t = truthOf(applyPlants(base, []), price);
    assert.ok(t.share.weather > 0.3 && t.share.weather < 0.6);
  });
});
