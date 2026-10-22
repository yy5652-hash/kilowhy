// Smoke test of the evaluation run on two scenarios (baseline and a fault day in B), plus the scoring arithmetic. No Zetaris.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THRESHOLDS } from "../server/src/hypotheses/thresholds.ts";
import { loadReal } from "./real.ts";
import { buildReport, renderMarkdown } from "./report.ts";
import { runScenarios } from "./run.ts";
import { SCENARIOS, REFERENCE } from "./scenarios.ts";
import { outcomeOf, statisticOf, tally, type Pair } from "./score.ts";

const real = loadReal();
const two = SCENARIOS.filter((s) => s.n === 1 || s.n === 6);

describe("outcomes and tallies", () => {
  it("classifies every expected/got combination", () => {
    assert.equal(outcomeOf("supported", "supported"), "tp");
    assert.equal(outcomeOf("supported", "ruled_out"), "fn_missed");
    assert.equal(outcomeOf("supported", "inconclusive"), "fn_hedged");
    assert.equal(outcomeOf("ruled_out", "supported"), "fp");
    assert.equal(outcomeOf("ruled_out", "ruled_out"), "tn");
    assert.equal(outcomeOf("ruled_out", "inconclusive"), "tn_hedged");
  });
  it("precision, recall and F1 follow from the counts; a hedge on a supported label is a false negative", () => {
    const mk = (outcome: Pair["outcome"]): Pair => ({ scenario: 1, id: "H3", expected: "supported", got: "supported", outcome, planted: true, stat: { name: "", text: "", value: 0, threshold: "" }, headline: "" });
    const t = tally([mk("tp"), mk("tp"), mk("tp"), mk("fn_hedged"), mk("fp"), mk("tn"), mk("tn_hedged")]);
    assert.deepEqual([t.tp, t.fp, t.fn, t.tn, t.hedged], [3, 1, 1, 1, 1]);
    assert.equal(t.precision, 0.75);
    assert.equal(t.recall, 0.75);
    assert.equal(t.f1, 0.75);
    assert.equal(tally([]).precision, null);
  });
});

describe("eval run, two scenarios", async () => {
  const runs = await runScenarios(real, two);
  it("decomposes exactly: the identity holds and the bill change equals the independent calculation", () => {
    assert.equal(runs.length, 2);
    for (const r of runs) {
      assert.ok(r.decomposition.ok && r.decomposition.identityOk, r.scenario.id);
      assert.ok(r.decomposition.compensatedErrorPence < 1e-6);
      assert.equal(r.decomposition.deltaGbp, r.decomposition.trueDeltaGbp);
      assert.equal(r.decomposition.slotsKept, r.decomposition.slotsExpected);
      assert.equal(r.results.length, 11, "all hypotheses ran");
      assert.ok(r.results.every((h) => h.summary.error === undefined));
    }
  });
  it("the fault day in B is found by H6 and H11 and named; the clean baseline has no fault, meter, tariff or gap finding", () => {
    const [base, fault] = runs;
    const st = (r: typeof base, id: string) => r.results.find((h) => h.id === id)!.status;
    assert.equal(st(fault, "H6"), "supported");
    assert.equal(fault.results.find((h) => h.id === "H6")!.summary.top_day, "2026-10-19");
    assert.equal(st(fault, "H11"), "supported");
    for (const id of ["H7", "H8", "H9", "H11"]) assert.equal(st(base, id), "ruled_out", id);
    assert.equal(st(base, "H5"), "ruled_out");
    assert.ok(fault.recommendation.found && fault.recommendation.match && !base.recommendation.found);
  });
  const rep = buildReport(real, runs);
  it("builds a deterministic report with the counts, the misses and the SAMPLE label", () => {
    assert.deepEqual(buildReport(real, runs), rep);
    assert.equal(rep.sample_meter_data, true);
    assert.equal(rep.summary.scenarios, 2);
    assert.equal(rep.summary.decomposition_identity.passed, 2);
    assert.equal(rep.scenarios.length, 2);
    assert.deepEqual(rep.scenarios[0].hypotheses.filter((h) => !h.scored).map((h) => h.id), [...REFERENCE]);
    assert.ok(rep.summary.supported_class.tp >= 3 && rep.summary.supported_class.fp === 0);
    for (const m of rep.misses) assert.ok(m.threshold.length > 0 && m.measured.length > 0);
    const md = renderMarkdown(rep);
    assert.match(md, /SAMPLE meter data/);
    assert.match(md, /## Misses/);
    assert.match(md, /fault_day_B/);
    assert.ok(!/NaN|undefined/.test(md), "no NaN or undefined in the markdown");
  });
  it("statistics carry the threshold constants, not copies", () => {
    const h6 = runs[1].results.find((h) => h.id === "H6")!;
    assert.match(statisticOf(h6).threshold, new RegExp(`${(THRESHOLDS.H6_SHARE * 100).toFixed(1)}%`));
  });
});

describe("committed report", () => {
  it("is what a fresh run of all 12 scenarios produces (summary and misses), so the README figures are current", async () => {
    const fresh = buildReport(real, await runScenarios(real, SCENARIOS));
    const committed = JSON.parse(readFileSync(new URL("./results/eval_report.json", import.meta.url), "utf8"));
    assert.deepEqual(JSON.parse(JSON.stringify(fresh.summary)), committed.summary, "run `node scripts/eval_run.ts` to refresh eval/results");
    assert.deepEqual(JSON.parse(JSON.stringify(fresh.misses)), committed.misses);
    assert.equal(committed.sample_meter_data, true);
  });
});
