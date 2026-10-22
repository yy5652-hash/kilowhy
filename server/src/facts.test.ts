// Facts table tests: display formatting, and the table built from a synthetic investigation (no network, no LLM).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { fmtGbp, fmtPct, fmtKwh, fmtPkwh, fmtKg, fmtPp, displayFor, signedNumber, MINUS } from "./facts_format.ts";
import { buildFacts, FactTable, type Fact } from "./facts.ts";
import { buildContext, runAll, runHypothesis } from "./hypotheses/index.ts";
import { recommend, recommendTariff } from "./recommend.ts";
import { WINDOW_A, WINDOW_B } from "./windows.ts";
import { EvidenceStore } from "./evidence.ts";
import { tokenize } from "./verifier.ts";
import { scenario, SITE_NAMES } from "./agent_testkit.ts";
import { singleRowNumbers } from "./agent_extra.ts";
import type { HypothesisResult } from "./hypotheses/types.ts";

describe("display formatting", () => {
  it("currency: thousands separators, two decimals, negative with U+2212", () => {
    assert.equal(fmtGbp(1234.56), "£1,234.56");
    assert.equal(fmtGbp(0), "£0.00");
    assert.equal(fmtGbp(-12.34), `${MINUS}£12.34`);
    assert.equal(fmtGbp(-1234567.891), `${MINUS}£1,234,567.89`);
    assert.equal(fmtGbp(339.905), "£339.91");
  });
  it("a negative value that rounds to zero shows no minus sign", () => { assert.equal(fmtGbp(-0.004), "£0.00"); assert.equal(fmtPct(-0.02), "0.0%"); assert.equal(signedNumber(-0.0001, 2), "0.00"); });
  it("percent has one decimal", () => { assert.equal(fmtPct(12.34), "12.3%"); assert.equal(fmtPct(-3.1), `${MINUS}3.1%`); assert.equal(fmtPct(100), "100.0%"); });
  it("kWh is whole above 100, one decimal below", () => { assert.equal(fmtKwh(4567.2), "4,567 kWh"); assert.equal(fmtKwh(62.68), "62.7 kWh"); assert.equal(fmtKwh(-597.1), `${MINUS}597 kWh`); });
  it("p/kWh, kgCO2e and pp have one decimal", () => { assert.equal(fmtPkwh(21.44), "21.4 p/kWh"); assert.equal(fmtKg(103), "103.0 kgCO2e"); assert.equal(fmtPp(-3.14), `${MINUS}3.1 pp`); });
  it("units without a special format fall back sensibly; text and dates pass through", () => {
    assert.equal(displayFor(2026, "count"), "2,026");
    assert.equal(displayFor(1344, "slots"), "1,344 slots");
    assert.equal(displayFor(28, "days"), "28 days");
    assert.equal(displayFor(11.2648, "kWh/HDD"), "11.26 kWh/HDD");
    assert.equal(displayFor(-0.337, "r"), `${MINUS}0.34`);
    assert.equal(displayFor(37.6525, "p/day"), "37.65 p/day");
    assert.equal(displayFor("2026-10-17", "date"), "2026-10-17");
    assert.equal(displayFor("10:00-13:00", "text"), "10:00-13:00");
    assert.equal(displayFor(null, "GBP"), "n/a");
    assert.equal(displayFor(1.5, "widgets"), "1.50 widgets");
  });
  it("every numeric display parses back to its own value under the verifier's tokenizer", () => {
    for (const [v, u] of [[1234.56, "GBP"], [-12.34, "GBP"], [54.91, "%"], [4567, "kWh"], [21.4, "p/kWh"], [103, "kgCO2e"], [-3.1, "pp"], [2.6, "sd"], [44.99, "HDD"]] as const) {
      const toks = tokenize(displayFor(v, u));
      assert.equal(toks.length, 1, `${v} ${u}`);
      assert.ok(Math.abs(toks[0].value - Math.abs(Math.round(v * 10 ** toks[0].decimals) / 10 ** toks[0].decimals)) < 1e-9, `${v} ${u} -> ${toks[0].raw}`);
    }
  });
});

describe("FactTable", () => {
  it("assigns sequential ids and skips missing values", () => {
    const t = new FactTable();
    t.add("a", "A", 1.23456789, "GBP", "E1");
    t.add("b", "B", null, "GBP", "E1");
    t.add("c", "C", NaN, "GBP", "E1");
    t.add("d", "D", 5, "GBP", null);
    t.add("e", "E", "text", "text", "E2", "H3");
    assert.deepEqual(t.facts.map((f) => f.id), ["F1", "F2"]);
    assert.equal(t.facts[0].value, 1.2346);
    assert.equal(t.facts[0].display, "£1.23");
    assert.equal(t.facts[1].hypothesis, "H3");
    assert.equal(t.get("e")?.id, "F2");
  });
});

describe("buildFacts on a synthetic investigation", () => {
  let facts: Fact[], results: HypothesisResult[], evidence: EvidenceStore, dC: number;
  const get = (k: string) => facts.find((f) => f.key === k);
  const val = (k: string) => get(k)!.value as number;
  before(async () => {
    const s = scenario();
    const ctx = await buildContext({ data: s.data, scope: { label: "ALL", sites: s.sites }, windowA: WINDOW_A, windowB: WINDOW_B });
    results = await runAll(ctx);
    const rec = await recommend(ctx), tariff = await recommendTariff(ctx);
    evidence = ctx.evidence;
    facts = buildFacts({ scope: ctx.scope, siteNames: SITE_NAMES, windowA: WINDOW_A, windowB: WINDOW_B, decomposition: ctx.decomposition, results, evidence, rec, tariff });
    dC = ctx.decomposition.result!.deltaTotal / 100;
  });

  it("ids are F1.. in order and keys are unique", () => {
    facts.forEach((f, i) => assert.equal(f.id, `F${i + 1}`));
    assert.equal(new Set(facts.map((f) => f.key)).size, facts.length);
  });
  it("every fact cites an existing evidence record and has a display string", () => {
    for (const f of facts) { assert.ok(evidence.get(f.evidence), `${f.key} -> ${f.evidence}`); assert.ok(f.display.length > 0 && f.display !== "n/a", f.key); assert.ok(f.label.length > 10, f.key); }
  });
  it("covers the decomposition: bills, change, V L T S, shares, kWh, average prices", () => {
    for (const k of ["bill_A", "bill_B", "delta_bill", "delta_bill_pct", "V", "L", "T", "S", "V_share", "L_share", "T_share", "kwh_A", "kwh_B", "delta_kwh", "avg_price_A", "avg_price_B", "avg_price_B_on_A_shape", "window_days", "window_A_start", "window_B_end", "sites"]) assert.ok(get(k), k);
    assert.ok(Math.abs(val("delta_bill") - Math.round(dC * 100) / 100) < 0.011);
  });
  it("V + L + T + S equals the displayed change to the penny; shares are of the change", () => {
    assert.ok(Math.abs(val("V") + val("L") + val("T") + val("S") - val("delta_bill")) < 1e-9);
    assert.ok(Math.abs(val("L_share") - (val("L") / val("delta_bill")) * 100) < 1e-3);
    assert.ok(Math.abs(val("bill_B") - val("bill_A") - val("delta_bill")) <= 0.011);
  });
  it("windows: 28 days, A before B, ends are the day before the exclusive end", () => {
    assert.equal(get("window_A_start")!.display, "2026-08-27"); assert.equal(get("window_A_end")!.display, "2026-09-23");
    assert.equal(get("window_B_start")!.display, "2026-09-24"); assert.equal(get("window_B_end")!.display, "2026-10-21");
    assert.equal(get("window_days")!.display, "28 days");
  });
  it("hypothesis facts carry their hypothesis tag; neutral facts carry none", () => {
    assert.equal(get("L")!.hypothesis, "H1"); assert.equal(get("T")!.hypothesis, "H5"); assert.equal(get("v_weather")!.hypothesis, "H3"); assert.equal(get("rec_saved")!.hypothesis, "REC");
    assert.equal(get("delta_bill")!.hypothesis, undefined); assert.equal(get("V")!.hypothesis, undefined);
  });
  it("includes generation mix, HDD, regression, anomaly, data-check and carbon facts when those hypotheses ran", () => {
    for (const k of ["wind_A", "wind_B", "gas_A", "gas_B", "delta_wind_pp", "delta_gas_pp", "corr_price_wind_B", "hdd_A", "hdd_B", "beta", "beta_t", "v_weather", "v_weather_share", "v_operational", "v_operational_share",
      "top_day", "top_day_share", "top_day_delta", "anomaly_day", "anomaly_day_z", "meter_faults", "standing_A", "standing_B", "data_gap_site_windows", "data_expected_slots", "delta_emissions", "emissions_A", "emissions_B", "emissions_volume", "emissions_intensity", "emissions_timing", "max_abs_z"]) assert.ok(get(k), k);
  });
  it("weather: HDD increased and the weather part is positive", () => { assert.ok(val("hdd_B") > val("hdd_A")); assert.ok(val("v_weather") > 0); assert.ok(val("beta") > 0); });
  it("displays have the specified formats", () => {
    assert.match(get("delta_bill")!.display, /^£[\d,]+\.\d{2}$/);
    assert.match(get("L_share")!.display, /^[−]?\d+\.\d%$/);
    assert.match(get("kwh_B")!.display, /^[\d,]+ kWh$/);
    assert.match(get("avg_price_A")!.display, /^\d+\.\d p\/kWh$/);
    assert.match(get("emissions_B")!.display, /^[\d,]+\.\d kgCO2e$/);
    assert.match(get("top_day")!.display, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(get("delta_wind_pp")!.display, /^[−]?\d+\.\d pp$/);
  });
  it("planted-event facts: the logged event with its site, date, step and t", () => {
    assert.equal(get("event_1_site")!.display, "S2 (Crumb & Co Brixton)");
    assert.match(get("event_1")!.display, /Oven schedule moved/);
    assert.equal(get("event_1_date")!.display, "2026-10-07");
    assert.ok(get("event_1_step")); assert.ok(get("event_1_t"));
    assert.equal(get("event_1")!.hypothesis, "H4");
  });
  it("no fact exposes an ops_log event id (E1 would be read as evidence E1)", () => { for (const f of facts) assert.ok(!/\bE\d+\b/.test(f.display), `${f.key}: ${f.display}`); });
  it("recommendation facts: load shift £ and kg, blocks and the tariff counterfactual for A and B", () => {
    for (const k of ["rec_saved", "rec_saved_kg", "rec_shifted_kwh", "rec_blocks", "peak_band", "tariff_name", "flat_total_A", "flat_total_B", "agile_total_A", "agile_total_B", "flat_minus_agile_A", "flat_minus_agile_B", "tariff_cheaper_B"]) assert.ok(get(k), k);
    assert.equal(get("peak_band")!.display, "16:00-19:00");
    assert.ok(Math.abs(val("flat_minus_agile_B") - (val("flat_total_B") - val("agile_total_B"))) < 0.011);
  });
  it("is deterministic: the same inputs give the same table", async () => {
    const s = scenario();
    const ctx = await buildContext({ data: s.data, scope: { label: "ALL", sites: s.sites }, windowA: WINDOW_A, windowB: WINDOW_B });
    const res = await runAll(ctx);
    const again = buildFacts({ scope: ctx.scope, siteNames: SITE_NAMES, windowA: WINDOW_A, windowB: WINDOW_B, decomposition: ctx.decomposition, results: res, evidence: ctx.evidence, rec: await recommend(ctx), tariff: await recommendTariff(ctx) });
    assert.deepEqual(again.map((f) => [f.key, f.display]), facts.map((f) => [f.key, f.display]));
  });
});

describe("buildFacts: only what ran", () => {
  it("a hypothesis that was not run contributes no facts, and without recommendations there are no REC facts", async () => {
    const s = scenario({ sites: ["S1"] });
    const ctx = await buildContext({ data: s.data, scope: { label: "S1", sites: ["S1"] }, windowA: WINDOW_A, windowB: WINDOW_B });
    const results = [await runHypothesis("H1", ctx), await runHypothesis("H7", ctx)];
    const facts = buildFacts({ scope: ctx.scope, siteNames: SITE_NAMES, windowA: WINDOW_A, windowB: WINDOW_B, decomposition: ctx.decomposition, results, evidence: ctx.evidence, rec: null, tariff: null });
    const keys = new Set(facts.map((f) => f.key));
    assert.ok(keys.has("price_peak_A") && keys.has("meter_faults") && keys.has("L"));
    for (const k of ["hdd_A", "wind_A", "top_day", "emissions_A", "rec_saved", "flat_total_B", "standing_A", "event_1"]) assert.ok(!keys.has(k), k);
    assert.ok(!facts.some((f) => f.hypothesis === "REC" || f.hypothesis === "H3"));
  });
  it("a failed decomposition yields an empty table", () => {
    const facts = buildFacts({ scope: { label: "S1", sites: ["S1"] }, siteNames: {}, windowA: WINDOW_A, windowB: WINDOW_B, decomposition: { ok: false, error: "x", result: null, windowA: null, windowB: null, aligned: { A: [], B: [], expected: 0, kept: 0 }, standing: { A: 0, B: 0 }, vatRate: null, evidenceId: "E1", contractEvidenceId: "E2", warnings: [] }, results: [], evidence: new EvidenceStore(), rec: null, tariff: null });
    assert.equal(facts.length, 0);
  });
  it("extra single-row query results become numeric facts; multi-row results only a row count", async () => {
    const s = scenario({ sites: ["S1"] });
    const ctx = await buildContext({ data: s.data, scope: { label: "S1", sites: ["S1"] }, windowA: WINDOW_A, windowB: WINDOW_B });
    const one = ctx.evidence.add({ id: ctx.evidence.nextId(), hypothesisId: "EXTRA", title: "t", sql: "SELECT 1", zetarisRunId: "r", rowCount: 1, resultSha256: "0".repeat(64), sampleRows: [{ n: 48, avg_kwh: "0.8", label: "x" }], metrics: {}, sources: [] });
    assert.deepEqual(singleRowNumbers(ctx.evidence, one.id), [["n", 48], ["avg_kwh", 0.8]]);
    const many = ctx.evidence.add({ id: ctx.evidence.nextId(), hypothesisId: "EXTRA", title: "t", sql: "SELECT 2", zetarisRunId: "r", rowCount: 5, resultSha256: "0".repeat(64), sampleRows: [{ n: 1 }], metrics: {}, sources: [] });
    assert.deepEqual(singleRowNumbers(ctx.evidence, many.id), []);
    const facts = buildFacts({ scope: ctx.scope, siteNames: SITE_NAMES, windowA: WINDOW_A, windowB: WINDOW_B, decomposition: ctx.decomposition, results: [], evidence: ctx.evidence, rec: null, tariff: null,
      extras: [{ purpose: "avg load", evidence: one.id, rows: 1 }, { purpose: "daily list", evidence: many.id, rows: 5 }] });
    const keys = facts.map((f) => f.key);
    assert.ok(keys.includes("extra_1_n") && keys.includes("extra_1_avg_kwh") && keys.includes("extra_1_rows") && keys.includes("extra_2_rows") && !keys.includes("extra_2_n"));
    assert.equal(facts.find((f) => f.key === "extra_1_n")!.hypothesis, "EXTRA");
  });
});
