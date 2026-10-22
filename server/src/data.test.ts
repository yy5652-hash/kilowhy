// Tests for the data layer with an injected fake zsql (no Zetaris needed): SQL shape, typed parsing, evidence, caching, error handling.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createZetarisData, slotsSql, dailySql, opsLogSql, contractSql, qualitySql, coverageSql, sitesSql, tariffSql, type ZSql } from "./data.ts";
import { EvidenceStore, hashRows } from "./evidence.ts";
import { guardSql } from "./sqlguard.ts";
import { WINDOW_A, WINDOW_B } from "./windows.ts";

const W = { A: WINDOW_A, B: WINDOW_B };
const meta = (store = new EvidenceStore()) => ({ store, hypothesisId: "H1", title: "test" });

function fakeZsql(handler: (sql: string) => { headers: string[]; data: unknown[][] } | { fail: number; body: unknown }) {
  const calls: string[] = [];
  const zsql: ZSql = async (sql) => {
    calls.push(sql);
    const r = handler(sql);
    if ("fail" in r) return { ok: false, status: r.fail, body: r.body, runId: `run-${calls.length}` };
    return { ok: true, status: 200, body: { ...r, total: r.data.length }, runId: `run-${calls.length}` };
  };
  return { zsql, calls };
}

describe("SQL templates", () => {
  const sql = {
    sites: sitesSql(), slots: slotsSql(["S1", "S2"], W), daily: dailySql(["S1"], W), ops: opsLogSql(["S1", "S3"]),
    contract: contractSql(), quality: qualitySql(["S1", "S2", "S3"], W), coverage: coverageSql(["S1"], W), tariff: tariffSql(["S1", "S2"], W),
  };
  it("every template passes the same read-only guard that LLM SQL has to pass", () => {
    for (const [name, s] of Object.entries(sql)) {
      const g = guardSql(s);
      assert.equal(g.ok, true, `${name}: ${JSON.stringify(g)}`);
    }
  });
  it("slots: one join across meter, price and carbon over both windows, filtered by site", () => {
    assert.match(sql.slots, /JOIN kilowhy\.agile_rates/);
    assert.match(sql.slots, /LEFT JOIN kilowhy\.ci_london/);
    assert.match(sql.slots, /m\.site_id IN \('S1', 'S2'\)/);
    assert.match(sql.slots, /timestamp '2026-08-27 00:00:00'/);
    assert.match(sql.slots, /timestamp '2026-10-22 00:00:00'/);
    assert.match(sql.slots, /AS win/);
  });
  it("tariff: one join of meter, Agile rates and the flat tariff valid at each slot, ex-VAT flat rate, per site and window", () => {
    assert.match(sql.tariff, /JOIN kilowhy\.flat_tariff f ON m\.ts >= f\.valid_from AND \(f\.valid_to IS NULL OR m\.ts < f\.valid_to\)/);
    assert.match(sql.tariff, /SUM\(m\.kwh \* r\.p_kwh_inc_vat\) AS agile_inc_pence/);
    assert.match(sql.tariff, /SUM\(m\.kwh \* f\.p_kwh_exc_vat\) AS flat_exc_pence/);
    assert.match(sql.tariff, /m\.site_id IN \('S1', 'S2'\)/);
  });
  it("quality: thresholds 4 (zero run), 12 (flatline), 48 slots per day", () => {
    assert.match(sql.quality, /kwh = 0 AND n >= 4/);
    assert.match(sql.quality, /kwh <> 0 AND n >= 12/);
    assert.match(sql.quality, /COUNT\(\*\) <> 48/);
  });
  it("rejects site ids and dates that could carry SQL", () => {
    assert.throws(() => slotsSql(["S1'; DROP TABLE x; --"], W));
    assert.throws(() => slotsSql([], W));
    assert.throws(() => slotsSql(["S1"], { A: { ...WINDOW_A, from: "2026-08-27' OR '1'='1" }, B: WINDOW_B }));
  });
  it("non-contiguous windows get two ranges", () => {
    const s = slotsSql(["S1"], { A: WINDOW_A, B: { ...WINDOW_B, from: "2026-10-01", toExclusive: "2026-10-29" } });
    assert.match(s, /\) OR \(/);
  });
});

describe("createZetarisData", () => {
  const slotHeaders = ["site_id", "ts", "win", "kwh", "p", "intensity", "wind_pct", "gas_pct", "imports_pct"];
  it("parses slots into typed rows and returns an evidence record with run id, hash and sources", async () => {
    const data = [["S1", "2026-08-27 00:00:00.0", "A", "1.087", "22.764", "106", "38.3", "9.4", "26.1"], ["S1", "2026-08-27 00:30:00.0", "A", "1.172", "22.764", null, null, null, null]];
    const { zsql, calls } = fakeZsql(() => ({ headers: slotHeaders, data }));
    const store = new EvidenceStore();
    const f = await createZetarisData(zsql).slots({ sites: ["S1"], windows: W }, meta(store));
    assert.deepEqual(f.rows[0], { site: "S1", ts: "2026-08-27T00:00:00Z", win: "A", kwh: 1.087, p: 22.764, intensity: 106, windPct: 38.3, gasPct: 9.4, importsPct: 26.1 });
    assert.equal(f.rows[1].intensity, null);
    assert.equal(f.evidence.id, "E1");
    assert.equal(f.evidence.rowCount, 2);
    assert.equal(f.evidence.zetarisRunId, "run-1");
    assert.equal(f.evidence.sql, calls[0]);
    assert.equal(f.evidence.resultSha256, hashRows(data.map((d) => Object.fromEntries(slotHeaders.map((h, i) => [h, d[i]])))));
    assert.deepEqual(f.evidence.sources.map((s) => `${s.view}:${s.kind}`), ["meter_hh:FILE: sample", "agile_rates:REST: Octopus", "ci_london:REST: NESO"]);
    assert.equal(store.get("E1"), f.evidence);
  });
  it("runs identical SQL once per layer, but each fetch still gets its own evidence id", async () => {
    const { zsql, calls } = fakeZsql(() => ({ headers: slotHeaders, data: [] }));
    const layer = createZetarisData(zsql);
    const store = new EvidenceStore();
    const a = await layer.slots({ sites: ["S1"], windows: W }, meta(store));
    const b = await layer.slots({ sites: ["S1"], windows: W }, { ...meta(store), hypothesisId: "H5" });
    assert.equal(calls.length, 1);
    assert.deepEqual([a.evidence.id, b.evidence.id], ["E1", "E2"]);
    assert.equal(b.evidence.hypothesisId, "H5");
    assert.equal(a.evidence.zetarisRunId, b.evidence.zetarisRunId);
    await layer.slots({ sites: ["S2"], windows: W }, meta(store));
    assert.equal(calls.length, 2);
  });
  it("parses daily, ops_log, contract, quality and coverage rows", async () => {
    const answers: Record<string, { headers: string[]; data: unknown[][] }> = {
      "WITH k AS": { headers: ["site_id", "d", "kwh", "n_slots", "t_mean", "n_hours"], data: [["S1", "2026-08-27", "109.92", "48", "19.9375", "24"], ["S1", "2026-08-28", "100", "48", null, null]] },
      "FROM kilowhy.ops_log": { headers: ["event_id", "site_id", "event_date", "description"], data: [["E3", "S1", "2026-10-03", "SAMPLE: x"]] },
      "'contract' AS src": { headers: ["src", "product_code", "tariff_code", "standing_p_per_day", "vat_rate", "valid_from"], data: [["agile_standing", null, null, "37.6525", null, "2024-09-30"], ["contract", "AGILE-24-10-01", "E-1R", "37.6525", "0.05", "2026-08-27"]] },
      "WITH base AS": { headers: ["check_name", "site_id", "start_ts", "end_ts", "n", "value"], data: [["zero_run", "S2", "2026-09-01 03:00:00.0", "2026-09-01 04:30:00.0", "4", "0"], ["rows", "S2", "2026-08-27 00:00:00", "2026-10-21 23:30:00", "2688", "5366.6"]] },
      "COUNT(r.slot_start)": { headers: ["site_id", "win", "n_meter", "n_priced", "n_carbon"], data: [["S1", "A", "1344", "1344", "1340"]] },
    };
    const { zsql } = fakeZsql((sql) => { const k = Object.keys(answers).find((p) => sql.includes(p)); assert.ok(k, sql); return answers[k!]; });
    const layer = createZetarisData(zsql);
    const m = meta();
    assert.deepEqual((await layer.daily({ sites: ["S1"], windows: W }, m)).rows, [{ site: "S1", date: "2026-08-27", kwh: 109.92, nSlots: 48, tMean: 19.9375, nHours: 24 }, { site: "S1", date: "2026-08-28", kwh: 100, nSlots: 48, tMean: null, nHours: 0 }]);
    assert.deepEqual((await layer.opsLog({ sites: ["S1"] }, m)).rows, [{ eventId: "E3", siteId: "S1", eventDate: "2026-10-03", description: "SAMPLE: x" }]);
    const c = (await layer.contract(m)).rows;
    assert.deepEqual(c[1], { src: "contract", productCode: "AGILE-24-10-01", tariffCode: "E-1R", standingPencePerDay: 37.6525, vatRate: 0.05, validFrom: "2026-08-27" });
    assert.equal(c[0].productCode, null);
    const q = (await layer.quality({ sites: ["S2"], windows: W }, m)).rows;
    assert.deepEqual(q[0], { check: "zero_run", site: "S2", start: "2026-09-01 03:00:00.0", end: "2026-09-01 04:30:00.0", n: 4, value: 0 });
    assert.deepEqual((await layer.coverage({ sites: ["S1"], windows: W }, m)).rows, [{ site: "S1", win: "A", nMeter: 1344, nPriced: 1344, nCarbon: 1340 }]);
  });
  it("parses tariff rows", async () => {
    const headers = ["site_id", "win", "n_slots", "kwh", "agile_inc_pence", "flat_exc_pence", "flat_standing_exc_pence", "flat_rate_min_exc", "flat_rate_max_exc"];
    const { zsql } = fakeZsql(() => ({ headers, data: [["S1", "B", "1344", "3312.9", "92047.5", "106327.3", "1439.8", "30.4635", "32.5891"]] }));
    const f = await createZetarisData(zsql).tariff({ sites: ["S1"], windows: W }, meta());
    assert.deepEqual(f.rows[0], { site: "S1", win: "B", nSlots: 1344, kwh: 3312.9, agileIncPence: 92047.5, flatExcPence: 106327.3, flatStandingExcPence: 1439.8, flatRateMinExc: 30.4635, flatRateMaxExc: 32.5891 });
    assert.deepEqual(f.evidence.sources.map((s) => `${s.view}:${s.kind}`), ["meter_hh:FILE: sample", "agile_rates:REST: Octopus", "flat_tariff:REST: Octopus"]);
  });
  it("lists site ids without creating evidence", async () => {
    const { zsql } = fakeZsql(() => ({ headers: ["site_id"], data: [["S1"], ["S2"]] }));
    assert.deepEqual(await createZetarisData(zsql).siteIds(), ["S1", "S2"]);
  });
  it("a failed query throws a short message (no body dump), and is not cached", async () => {
    let fail = true;
    const { zsql, calls } = fakeZsql(() => (fail ? { fail: 500, body: { message: "boom ".repeat(200) } } : { headers: ["site_id"], data: [["S1"]] }));
    const layer = createZetarisData(zsql);
    await assert.rejects(layer.opsLog({ sites: ["S1"] }, meta()), (e: Error) => /Zetaris query failed \(HTTP 500\)/.test(e.message) && e.message.length < 400);
    fail = false;
    const r = await layer.siteIds();
    assert.deepEqual(r, ["S1"]);
    assert.equal(calls.length, 2);
  });
  it("a numeric column that is not a number is an error, not NaN", async () => {
    const { zsql } = fakeZsql(() => ({ headers: slotHeaders, data: [["S1", "2026-08-27 00:00:00.0", "A", "oops", "22", null, null, null, null]] }));
    await assert.rejects(createZetarisData(zsql).slots({ sites: ["S1"], windows: W }, meta()), /expected a number/);
  });
});
