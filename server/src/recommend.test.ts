// Tests for the counterfactual load shift (synthetic prices and loads; hand-computed expectations).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planShift, recommend } from "./recommend.ts";
import type { SlotRow } from "./data.ts";
import { synth, ctxFor } from "./hypotheses/testkit.ts";

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

/** One complete local day (BST, UTC+1): slot k starts at k/2 hours local. */
function localDay(date: string, f: (k: number) => { kwh: number; p: number; ci?: number | null }, site = "S1", slots = 48): SlotRow[] {
  const start = Date.parse(date + "T00:00:00Z") - 3600e3; // local midnight = 23:00 UTC the day before
  return Array.from({ length: slots }, (_, k) => {
    const v = f(k);
    return { site, ts: new Date(start + k * 1800e3).toISOString().replace(".000Z", "Z"), win: "B" as const, kwh: v.kwh, p: v.p, intensity: v.ci === undefined ? 100 : v.ci, windPct: null, gasPct: null, importsPct: null };
  });
}
const PEAK = (k: number) => k >= 32 && k < 38;                  // 16:00-19:00 local
const CHEAP = (k: number) => k >= 4 && k < 10;                  // 02:00-05:00 local
const days3 = (f: (k: number) => { kwh: number; p: number; ci?: number | null }) => ["2026-10-01", "2026-10-02", "2026-10-03"].flatMap((d) => localDay(d, f));
const base = (peakKwh: number) => (k: number) => ({ kwh: PEAK(k) ? peakKwh : 1, p: PEAK(k) ? 40 : CHEAP(k) ? 5 : 20, ci: PEAK(k) ? 200 : CHEAP(k) ? 50 : 100 });

describe("planShift: hand-computed counterfactual", () => {
  it("moves the peak load above the night baseline (capped at 10 kWh/day) into the cheapest block and re-prices it", () => {
    const r = planShift(days3(base(3)));
    assert.equal(r.baselineKwhPerSlot, 1);
    assert.equal(r.daysUsed, 3); assert.equal(r.daysShifted, 3);
    near(r.shiftedKwh, 30);                       // flexible = 6 slots x (3 - 1) = 12 kWh, capped at 10 per day
    near(r.savedPence, 3 * (10 * 40 - (10 / 6) * 6 * 5)); // 3 x 350 p
    near(r.savedKgCo2e!, 3 * (10 * 200 - 10 * 50) / 1000); // 3 x 1.5 kg
    assert.equal(r.targetBlock, "02:00-05:00");
    near(r.costBeforePence - r.costAfterPence, r.savedPence);
  });
  it("cost before is the real cost of the days used", () => {
    const r = planShift(days3(base(3)));
    const expectedDay = [...Array(48).keys()].reduce((s, k) => s + base(3)(k).kwh * base(3)(k).p, 0);
    near(r.costBeforePence, 3 * expectedDay);
  });
  it("a lower cap moves less; a small flexible load below the cap moves exactly that load", () => {
    near(planShift(days3(base(3)), { maxKwhPerDay: 4 }).savedPence, 3 * (4 * 40 - (4 / 6) * 30));
    near(planShift(days3(base(1.5))).shiftedKwh, 3 * 3); // 6 x 0.5 = 3 kWh/day
    near(planShift(days3(base(1.5))).savedPence, 3 * (3 * 40 - (3 / 6) * 30));
  });
  it("nothing above the night baseline: nothing to shift", () => {
    const r = planShift(days3(base(1)));
    assert.equal(r.shiftedKwh, 0); assert.equal(r.savedPence, 0); assert.equal(r.daysShifted, 0); assert.equal(r.targetBlock, null);
  });
  it("no saving when no block is cheaper than the peak slots (flat prices, or peak cheapest)", () => {
    const flat = planShift(days3((k) => ({ kwh: PEAK(k) ? 3 : 1, p: 20 })));
    assert.equal(flat.daysShifted, 0); assert.equal(flat.savedPence, 0);
    const peakCheap = planShift(days3((k) => ({ kwh: PEAK(k) ? 3 : 1, p: PEAK(k) ? 5 : 20 })));
    assert.equal(peakCheap.daysShifted, 0); assert.equal(peakCheap.savedPence, 0);
  });
  it("the target block never overlaps the peak band, even if the peak is the cheapest place", () => {
    const r = planShift(days3((k) => ({ kwh: PEAK(k) ? 3 : 1, p: k >= 30 && k < 40 ? 1 : 20 }))); // cheap slots surround and include the peak
    assert.equal(r.daysShifted, 0, "moving within a cheap region that includes the peak saves nothing");
  });
  it("negative prices are used (paid to consume)", () => {
    const r = planShift(days3((k) => ({ kwh: PEAK(k) ? 3 : 1, p: PEAK(k) ? 30 : CHEAP(k) ? -5 : 20 })));
    near(r.savedPence, 3 * (10 * 30 - (10 / 6) * 6 * -5));
  });
  it("incomplete local days are skipped", () => {
    const r = planShift([...localDay("2026-10-01", base(3)), ...localDay("2026-10-02", base(3), "S1", 47), ...localDay("2026-10-03", base(3)).slice(0, 10)]);
    assert.equal(r.daysUsed, 1);
  });
  it("the night baseline is a median, so a few oven slots at night do not raise it", () => {
    const f = (k: number) => ({ kwh: k >= 8 && k < 14 ? 5 : PEAK(k) ? 3 : 1, p: PEAK(k) ? 40 : CHEAP(k) ? 5 : 20 }); // 6 of 14 night slots are oven
    assert.equal(planShift(days3(f)).baselineKwhPerSlot, 1);
  });
  it("a missing carbon intensity keeps the money result and drops the carbon number", () => {
    const r = planShift(days3((k) => ({ ...base(3)(k), ci: k === 33 ? null : 100 })));
    assert.equal(r.savedKgCo2e, null); assert.ok(r.savedPence > 0);
  });
  it("empty input is harmless", () => {
    const r = planShift([]);
    assert.equal(r.daysUsed, 0); assert.equal(r.savedPence, 0); assert.equal(r.baselineKwhPerSlot, null);
  });
});

describe("recommend over the investigation context", () => {
  const peak = (slot: number) => slot >= 30 && slot < 36;      // 15:00-18:00 UTC = 16:00-19:00 BST
  const cheap = (slot: number) => slot >= 2 && slot < 8;       // 01:00-04:00 UTC = 02:00-05:00 BST
  const mk = (sites: string[]) => synth({
    sites, noise: 0, kwh: (_s, _w, _d, slot) => (peak(slot) ? 3 : 1),
    price: (w, _d, slot) => (w === "B" ? (peak(slot) ? 40 : cheap(slot) ? 5 : 20) : 999), // window A prices are absurd on purpose: only window B may be used
    intensity: (w, _d, slot) => (w === "B" ? (peak(slot) ? 200 : cheap(slot) ? 50 : 100) : 9999),
  });
  it("re-prices on window-B prices and carbon only: GBP and kgCO2e saved over the 27 complete local days, with evidence", async () => {
    const ctx = await ctxFor(mk(["S1"]));
    const rec = await recommend(ctx);
    assert.equal(rec.ok, true);
    assert.equal(rec.total.daysUsed, 27);
    near(rec.total.shiftedKwh, 27 * 10);
    near(rec.total.savedGbp, 27 * 350 / 100);
    near(rec.total.savedKgCo2e!, 27 * 1.5);
    near(rec.total.costBeforeGbp - rec.total.costAfterGbp, rec.total.savedGbp, 1e-6);
    assert.match(rec.text, /saves £94\.50 and 40\.50 kgCO2e/); assert.match(rec.text, /SAMPLE/);
    const e = ctx.evidence.get(rec.evidence[0])!;
    assert.equal(e.hypothesisId, "REC");
    near(e.metrics.saved.value as number, 94.5); near(e.metrics.saved_kgco2e.value as number, 40.5);
    assert.match(e.resultSha256, /^[0-9a-f]{64}$/);
  });
  it("sums over the sites of the scope", async () => {
    const rec = await recommend(await ctxFor(mk(["S1", "S2"])));
    assert.equal(rec.sites.length, 2);
    near(rec.total.savedGbp, 2 * 27 * 350 / 100);
    near(rec.total.shiftedKwh, 2 * 27 * 10);
  });
  it("a site with no flexible load saves nothing and says so", async () => {
    const rec = await recommend(await ctxFor(synth({ sites: ["S1"], noise: 0, kwh: () => 1 })));
    assert.equal(rec.ok, true); assert.equal(rec.total.savedGbp, 0); assert.match(rec.text, /No flexible peak-band load/);
  });
  it("max kWh per day is an option", async () => {
    const rec = await recommend(await ctxFor(mk(["S1"])), { maxKwhPerDay: 2 });
    near(rec.total.savedGbp, 27 * (2 * 40 - (2 / 6) * 30) / 100);
  });
});
