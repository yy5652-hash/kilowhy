/**
 * Tests for SAMPLE meter data generator (synthetic Crumb & Co series).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SLOTS_PER_SITE,
  SITES,
  generateMeterRows,
  loadTemperatures,
  slotLoads,
  mulberry32,
  type MeterRow,
} from "./generate_sample.ts";

describe("generate_sample (SAMPLE synthetic meter data)", () => {
  it("produces 3 × 2688 rows with no negative kWh", async () => {
    const temps = await loadTemperatures();
    const rows = generateMeterRows(temps);
    assert.equal(SLOTS_PER_SITE, 2688);
    assert.equal(rows.length, 3 * 2688);
    for (const site of SITES) {
      const n = rows.filter((r) => r.site_id === site.site_id).length;
      assert.equal(n, 2688, `${site.site_id} row count`);
    }
    for (const r of rows) {
      assert.ok(r.kwh >= 0, `negative kWh at ${r.site_id} ${r.ts}: ${r.kwh}`);
      assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it("is deterministic for the same seed and temperature cache", async () => {
    const temps = await loadTemperatures();
    const a = generateMeterRows(temps, 0xc0ffee);
    const b = generateMeterRows(temps, 0xc0ffee);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.deepEqual(a[i], b[i], `mismatch at index ${i}`);
    }
  });

  it("seeded PRNG is stable", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    assert.deepEqual(seq1, seq2);
  });

  it("different seeds diverge", async () => {
    const temps = await loadTemperatures();
    const a = generateMeterRows(temps, 1);
    const b = generateMeterRows(temps, 2);
    const same = a.every((row: MeterRow, i: number) => row.kwh === b[i].kwh);
    assert.equal(same, false);
  });
});

describe("generate_sample clean baseline option (used by eval/)", () => {
  // constant 12 C everywhere, so no network or cache is needed
  const temps = new Map<string, number>();
  for (let ms = Date.parse("2026-08-27T00:00:00Z"); ms <= Date.parse("2026-10-21T23:00:00Z"); ms += 3600e3) temps.set(new Date(ms).toISOString().slice(0, 13), 12);

  it("plantedEvents: false drops the dated sample events and nothing else; the default keeps them", () => {
    const withEvents = generateMeterRows(temps, 0xc0ffee);
    const clean = generateMeterRows(temps, 0xc0ffee, { plantedEvents: false });
    assert.equal(clean.length, withEvents.length);
    const differing = clean.map((r, i) => (r.kwh !== withEvents[i].kwh ? `${r.site_id} ${r.ts.slice(0, 10)}` : null)).filter(Boolean) as string[];
    assert.ok(differing.length > 0);
    const dates = new Set(differing.map((d) => d.slice(3)));
    assert.ok([...dates].every((d) => d >= "2026-09-20"), "only dates of the sample events differ");
    assert.ok(differing.some((d) => d.startsWith("S3 2026-09-20")) && differing.some((d) => d.startsWith("S2 2026-10-")) && differing.some((d) => d.startsWith("S1 2026-10-")));
    assert.deepEqual(clean.filter((r) => r.site_id === "S1" && r.ts < "2026-10-03"), withEvents.filter((r) => r.site_id === "S1" && r.ts < "2026-10-03"));
  });

  it("slotLoads gives the modelled components of a slot", () => {
    const s1 = SITES[0];
    const ms = Date.parse("2026-09-10T04:00:00Z");   // weekday, inside the oven window
    const l = slotLoads(s1, ms, temps, false);
    assert.equal(l.base, s1.baseKwh);
    assert.equal(l.oven, s1.ovenKwh);
    assert.ok(Math.abs(l.heating - s1.heatingCoeff * 3.5) < 1e-12);
    assert.equal(l.events, 0);
    assert.equal(slotLoads(s1, Date.parse("2026-09-10T12:00:00Z"), temps, false).oven, 0);
  });
});
