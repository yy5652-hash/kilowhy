import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { memoryFacts, memorySnippets } from "./memory_facts.ts";
import type { Recall, RecalledMemory } from "./memory.ts";

const m = (id: string, o: Partial<RecalledMemory>): RecalledMemory => ({ id, text: `text of ${id}`, relevance: 0.5, origin: "user", site: "S2", learnedAt: "2026-10-22T10:00:00.000Z", confidence: 0.9, layer: "long_term", provenance: { origin: "user_correction", learnedAt: 0, label: "x" }, ...o });
const recall = (memories: RecalledMemory[]): Recall => ({ query: "q", memories, context: "", trace: { retrievalReason: "r", strategy: "minimal", scores: {} }, embed: { route: "fake", ms: 1 } });

describe("memoryFacts", () => {
  it("M1.. in recall order, display = text + who + date, no evidence, provenance on the fact", () => {
    const f = memoryFacts(recall([m("mem-3", { validFrom: "2026-10-07" }), m("mem-1", { origin: "agent", site: undefined })]), ["S2"]);
    assert.deepEqual(f.map((x) => [x.id, x.key, x.evidence, x.unit]), [["M1", "memory_1", "", "text"], ["M2", "memory_2", "", "text"]]);
    assert.equal(f[0].display, '"text of mem-3" (your note, 2026-10-22)');
    assert.equal(f[1].display, '"text of mem-1" (earlier investigation, 2026-10-22)');
    assert.match(f[0].label, /note from the owner about S2, applies from 2026-10-07 \(H-MEM mem-3\)/);
    assert.deepEqual(f[0].memory, { id: "mem-3", origin: "user", site: "S2", learnedAt: "2026-10-22T10:00:00.000Z", validFrom: "2026-10-07", confidence: 0.9, relevance: 0.5 });
  });
  it("only memories of the scope's sites or of no site; duplicates once; no recall means no facts", () => {
    const f = memoryFacts(recall([m("mem-1", { site: "S3" }), m("mem-2", { site: undefined }), m("mem-2", { site: undefined }), m("mem-4", { site: "S2" })]), ["S2"]);
    assert.deepEqual(f.map((x) => x.memory!.id), ["mem-2", "mem-4"]); assert.deepEqual(f.map((x) => x.id), ["M1", "M2"]);
    assert.deepEqual(memoryFacts(null, ["S2"]), []);
  });
  it("snippets for the plan prompt", () => {
    const f = memoryFacts(recall([m("mem-3", {}), m("mem-1", { origin: "agent", site: undefined })]), ["S2"]);
    assert.equal(memorySnippets(f), "- M1 (owner's note, 2026-10-22, S2): text of mem-3\n- M2 (earlier finding, 2026-10-22): text of mem-1");
    assert.equal(memorySnippets([]), "");
  });
});

describe("the template mentions a remembered note next to the schedule change it explains", () => {
  const f = (id: string, key: string, value: string | number, unit: string, display: string, hypothesis?: string) => ({ id, key, label: key, value, unit, display, evidence: "E1", ...(hypothesis ? { hypothesis } : {}) });
  const base = [
    f("F1", "T", 1.03, "GBP", "£1.03", "H5"), f("F2", "T_share", 1, "%", "1.0%", "H5"),
    f("F3", "schedule_site", "S2", "text", "S2", "H5"), f("F4", "schedule_band", "night", "text", "night", "H5"), f("F5", "schedule_delta_pp", -8.3, "pp", "−8.3 pp", "H5"), f("F6", "schedule_change_date", "2026-10-07", "date", "2026-10-07", "H5"),
    f("F7", "schedule_event", "SAMPLE: Oven schedule moved 2h later", "text", "SAMPLE: Oven schedule moved 2h later", "H5"),
  ];
  const note = (site?: string) => ({ id: "M1", key: "memory_1", label: "note", value: "Oven moved later", unit: "text", display: '"Oven moved later" (your note, 2026-10-22)', evidence: "",
    memory: { id: "mem-1", origin: "user" as const, site, learnedAt: "2026-10-22T10:00:00.000Z", confidence: 0.9, relevance: 0.4 } });
  it("a note for the site, or for no site, is cited in the ruled-out timing item and the answer verifies", async () => {
    const { templateAnswer } = await import("./agent_template.ts");
    const { verifyAnswer } = await import("./verifier.ts");
    for (const site of ["S2", undefined]) {
      const facts = [...base, note(site)], hyps = [{ id: "H5", name: "timing_shift", status: "ruled_out" as const }];
      const a = templateAnswer(facts, hyps, "why_cost_change");
      const item = a.ruledOut.find((r) => r.hypothesis === "H5")!;
      assert.ok(item.facts.includes("M1"), `site ${site}`); assert.ok(item.text.includes('Your note on file says "Oven moved later" (your note, 2026-10-22)'));
      assert.ok(item.evidence.length > 0 && item.evidence.every(Boolean), "evidence comes from the data facts only");
      assert.equal(verifyAnswer({ ...a, headline: a.headline, sentences: [{ text: "Timing: £1.03.", facts: ["F1"], evidence: ["E1"] }] }, { facts, evidenceIds: ["E1"], hypotheses: hyps }).errors.filter((e) => e.part === "ruledOut").length, 0);
    }
  });
  it("a note about another site is not mentioned", async () => {
    const { templateAnswer } = await import("./agent_template.ts");
    const a = templateAnswer([...base, note("S3")], [{ id: "H5", name: "timing_shift", status: "ruled_out" as const }], "why_cost_change");
    assert.ok(!a.ruledOut.some((r) => r.facts.includes("M1")));
  });
});
