// Tests for the counterfactual load shift (synthetic prices and loads; hand-computed expectations).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planShift, recommend, recommendTariff, TARIFF_NOT_ADVICE } from "./recommend.ts";
import type { SlotRow } from "./data.ts";
import { synth, ctxFor, DEFAULT_CONTRACT } from "./hypotheses/testkit.ts";

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

describe("recommendTariff: flat business tariff vs the actual Agile bill on the same kWh", () => {
  // 1 kWh in every half-hour (1344 kWh per window), Agile 20 p inc VAT, flat 30 p ex VAT + 50 p/day ex VAT, contract standing 37.65 p/day, VAT 5%
  const base = { noise: 0, kwh: () => 1, price: () => 20 };
  it("hand-computed totals for both windows: energy plus standing, VAT at the contract rate on the flat tariff", async () => {
    const ctx = await ctxFor(synth({ ...base }));
    const t = await recommendTariff(ctx);
    assert.equal(t.ok, true);
    for (const w of ["A", "B"] as const) {
      const x = t.windows![w];
      near(x.kwh, 1344); assert.equal(x.days, 28);
      near(x.agile.energyGbp, 1344 * 20 / 100);                // 268.80
      near(x.agile.standingGbp, 28 * 37.65 / 100, 0.006 / 10);   // 10.54 (rounded to pence)
      near(x.flat.energyGbp, 1344 * 30 * 1.05 / 100);          // 423.36
      near(x.flat.standingGbp, 28 * 50 * 1.05 / 100);          // 14.70
      near(x.flatMinusAgileGbp, x.flat.totalGbp - x.agile.totalGbp, 1e-9);
      assert.deepEqual(x.flatUnitRateRangeP, [30, 30]); assert.equal(x.coverageComplete, true);
    }
    near(t.windows!.B.flatMinusAgileGbp, 423.36 + 14.7 - 268.8 - 10.54, 1e-6);
    assert.equal(t.cheaperInWindowB, "agile");
    assert.equal(t.historicalCounterfactual, true); assert.equal(t.notAdvice, TARIFF_NOT_ADVICE); assert.match(t.notAdvice, /not advice/);
    assert.match(t.text, /Historical counterfactual, not advice/); assert.match(t.text, /£158\.72 more/); assert.match(t.text, /BUS-VAR-AUG25/);
    assert.equal(t.tariff.productCode, "BUS-VAR-AUG25"); assert.equal(t.tariff.vatRate, 0.05);
  });
  it("the Agile side equals the decomposition's energy cost (same kWh, same prices), so the two reports agree", async () => {
    const ctx = await ctxFor(synth({ sites: ["S1"], noise: 0.01, price: (w, d, slot) => 15 + (slot % 7) * 3 + (w === "B" ? 4 : 0) + (d % 3) }));
    const t = await recommendTariff(ctx), r = ctx.decomposition.result!;
    near(t.windows!.A.agile.energyGbp, Math.round(r.CA) / 100, 1e-9); near(t.windows!.B.agile.energyGbp, Math.round(r.CB) / 100, 1e-9);
    near(t.windows!.B.kwh, r.QB, 1e-9);
  });
  it("a flat-rate change inside window B is applied slot by slot (rate and standing charge from the period in force)", async () => {
    const flat = [{ from: "2026-05-31T23:00:00Z", to: "2026-09-30T23:00:00Z", excP: 30, standingExc: 50 }, { from: "2026-09-30T23:00:00Z", to: null, excP: 40, standingExc: 60 }];
    const t = await recommendTariff(await ctxFor(synth({ ...base, flat })));
    const before = 6 * 48 + 46; // 2026-09-24T00:00Z up to the change at 2026-09-30T23:00Z
    near(t.windows!.B.flat.energyGbp, (before * 30 + (1344 - before) * 40) * 1.05 / 100, 1e-3);
    near(t.windows!.B.flat.standingGbp, (before * 50 + (1344 - before) * 60) / 48 * 1.05 / 100, 1e-3);
    assert.deepEqual(t.windows!.B.flatUnitRateRangeP, [30, 40]); assert.deepEqual(t.windows!.A.flatUnitRateRangeP, [30, 30]);
  });
  it("a cheaper flat tariff is reported as such", async () => {
    const t = await recommendTariff(await ctxFor(synth({ ...base, flat: [{ from: "2026-05-31T23:00:00Z", to: null, excP: 10, standingExc: 20 }] })));
    assert.equal(t.cheaperInWindowB, "flat"); assert.ok(t.windows!.B.flatMinusAgileGbp < 0); assert.match(t.text, /less \(/);
  });
  it("sums sites for the scope and keeps the per-site breakdown", async () => {
    const t = await recommendTariff(await ctxFor(synth({ ...base, sites: ["S1", "S2"] })));
    assert.equal(t.sites.length, 2);
    near(t.windows!.B.flat.totalGbp, 2 * t.sites[0].B.flat.totalGbp, 1e-6);
    assert.equal(t.windows!.A.coverageComplete, true); assert.equal(t.windows!.B.coverageComplete, true); assert.ok(t.sites.every((x) => x.A.coverageComplete && x.B.coverageComplete)); near(t.windows!.B.agile.standingGbp, 2 * 10.54, 1e-3);
  });
  it("records an Evidence record with both totals, the difference for each window, the product code and flat_tariff as a REST source", async () => {
    const ctx = await ctxFor(synth({ ...base }));
    const t = await recommendTariff(ctx);
    const e = ctx.evidence.get(t.evidence[0])!;
    assert.equal(e.hypothesisId, "REC-TARIFF");
    near(e.metrics.flat_minus_agile_B.value as number, t.windows!.B.flatMinusAgileGbp, 1e-9); near(e.metrics.flat_minus_agile_A.value as number, t.windows!.A.flatMinusAgileGbp, 1e-9);
    assert.equal(e.metrics.product_code.value, "BUS-VAR-AUG25"); assert.equal(e.metrics.vat_rate.value, 0.05);
    assert.ok(e.sources.some((s) => s.view === "flat_tariff" && s.kind === "REST: Octopus")); assert.match(e.resultSha256, /^[0-9a-f]{64}$/);
  });
  it("no VAT rate in the contract: no comparison rather than a guess", async () => {
    const t = await recommendTariff(await ctxFor(synth({ ...base, contract: [{ ...DEFAULT_CONTRACT[0], vatRate: null }] })));
    assert.equal(t.ok, false); assert.match(t.reason ?? "", /VAT/);
  });
  it("flat rates that start part-way through window A leave those half-hours out of both sides and say so", async () => {
    const t = await recommendTariff(await ctxFor(synth({ ...base, flat: [{ from: "2026-09-01T00:00:00Z", to: null, excP: 30, standingExc: 50 }] })));
    assert.equal(t.ok, true); assert.equal(t.windows!.A.coverageComplete, false); assert.equal(t.windows!.B.coverageComplete, true);
    assert.equal(t.windows!.A.slots, 23 * 48); assert.match(t.text, /left out of both sides/);
  });
  it("flat rates that do not reach a window at all: no comparison", async () => {
    const t = await recommendTariff(await ctxFor(synth({ ...base, flat: [{ from: "2026-09-24T00:00:00Z", to: null, excP: 30, standingExc: 50 }] })));
    assert.equal(t.ok, false); assert.match(t.reason ?? "", /no half-hours/);
  });
});
