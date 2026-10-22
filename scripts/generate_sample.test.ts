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
