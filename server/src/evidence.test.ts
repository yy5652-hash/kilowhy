// Tests for Evidence records, canonical JSON hashing and the per-investigation store.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, hashRows, makeEvidence, EvidenceStore, metric, MAX_SAMPLE_ROWS, type EvidenceInput } from "./evidence.ts";

const input = (rows: Record<string, unknown>[], extra: Partial<EvidenceInput> = {}): EvidenceInput => ({
  hypothesisId: "H1", title: "t", sql: "SELECT 1", zetarisRunId: "run-1", rows, sources: [{ view: "meter_hh", kind: "FILE: sample" }], ...extra,
});

describe("canonicalJson / hashRows", () => {
  it("sorts object keys at every level, keeps array order, drops undefined, maps non-finite numbers to null", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(canonicalJson([NaN, Infinity, null, undefined, "x\"y", true]), '[null,null,null,null,"x\\"y",true]');
  });
  it("the hash does not depend on key order but does depend on row order and on every value", () => {
    const r1 = [{ a: "1", b: "2" }, { a: "3", b: "4" }];
    assert.equal(hashRows(r1), hashRows([{ b: "2", a: "1" }, { b: "4", a: "3" }]));
    assert.notEqual(hashRows(r1), hashRows([r1[1], r1[0]]));
    assert.notEqual(hashRows(r1), hashRows([r1[0], { a: "3", b: "5" }]));
  });
  it("equals sha256 of the sorted-key JSON text computed independently", () => {
    const rows = [{ site_id: "S1", kwh: "1.087" }, { site_id: "S2", kwh: "0.5" }];
    const expected = createHash("sha256").update('[{"kwh":"1.087","site_id":"S1"},{"kwh":"0.5","site_id":"S2"}]').digest("hex");
    assert.equal(hashRows(rows), expected);
  });
});

describe("makeEvidence / EvidenceStore", () => {
  it("assigns sequential ids per store (E1, E2, ...) and independent stores restart at E1", () => {
    const s1 = new EvidenceStore(), s2 = new EvidenceStore();
    assert.deepEqual([makeEvidence(s1, input([])).id, makeEvidence(s1, input([])).id, makeEvidence(s1, input([])).id], ["E1", "E2", "E3"]);
    assert.equal(makeEvidence(s2, input([])).id, "E1");
    assert.equal(s1.size, 3);
  });
  it("keeps the full row count and hash but at most 10 sample rows", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ i: String(i) }));
    const e = makeEvidence(new EvidenceStore(), input(rows));
    assert.equal(e.rowCount, 25);
    assert.equal(e.sampleRows.length, MAX_SAMPLE_ROWS);
    assert.deepEqual(e.sampleRows[9], { i: "9" });
    assert.equal(e.resultSha256, hashRows(rows));
    const changed = rows.map((r, i) => (i === 24 ? { i: "x" } : r));
    assert.notEqual(makeEvidence(new EvidenceStore(), input(changed)).resultSha256, e.resultSha256, "the hash must cover rows beyond the sample");
  });
  it("carries the spec fields: hypothesis, title, sql, run id, sources with kind labels, metrics with units", () => {
    const e = makeEvidence(new EvidenceStore(), input([{ a: 1 }], { metrics: { L: metric(12.5, "GBP"), bad: metric(NaN, "x") }, sources: [{ view: "meter_hh", kind: "FILE: sample" }, { view: "agile_rates", kind: "REST: Octopus" }] }));
    assert.deepEqual(Object.keys(e).sort(), ["hypothesisId", "id", "metrics", "resultSha256", "rowCount", "sampleRows", "sources", "sql", "title", "zetarisRunId"]);
    assert.equal(e.zetarisRunId, "run-1"); assert.equal(e.sql, "SELECT 1");
    assert.deepEqual(e.metrics.L, { value: 12.5, unit: "GBP" });
    assert.equal(e.metrics.bad.value, null, "NaN must not reach the JSON");
    assert.deepEqual(e.sources.map((s) => s.kind), ["FILE: sample", "REST: Octopus"]);
    assert.equal(JSON.parse(JSON.stringify(e)).metrics.bad.value, null);
  });
  it("get / list / toJSON / addMetrics", () => {
    const s = new EvidenceStore();
    const a = makeEvidence(s, input([])), b = makeEvidence(s, input([]));
    assert.equal(s.get("E2"), b); assert.equal(s.get("E9"), undefined);
    assert.deepEqual(s.list().map((e) => e.id), ["E1", "E2"]);
    s.addMetrics(a.id, { k: metric(1, "kWh") });
    s.addMetrics(a.id, { m: metric(2, "kWh") });
    assert.deepEqual(Object.keys(s.get("E1")!.metrics), ["k", "m"]);
    assert.equal(JSON.stringify(s), JSON.stringify([a, b]));
    assert.throws(() => s.addMetrics("E7", {}));
  });
  it("refuses a duplicate id", () => {
    const s = new EvidenceStore();
    const e = makeEvidence(s, input([]));
    assert.throws(() => s.add({ ...e }));
  });
  it("copies the sources it is given (later mutation of the input does not change the record)", () => {
    const src = [{ view: "sites", kind: "FILE: sample" as const }];
    const e = makeEvidence(new EvidenceStore(), input([], { sources: src }));
    src[0].view = "changed";
    assert.equal(e.sources[0].view, "sites");
  });
});
