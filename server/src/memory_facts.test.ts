import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkNotes, memoryFacts, memorySnippets } from "./memory_facts.ts";
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
  it("an agent finding for exactly the windows under investigation is left out; for other windows it stays", () => {
    const r = recall([m("mem-1", { origin: "agent", key: "cause:S2:H3:2026-08-27:2026-09-24" }), m("mem-2", { origin: "agent", key: "cause:S2:H3:2026-07-30:2026-08-27" }), m("mem-3", {})]);
    assert.deepEqual(memoryFacts(r, ["S2"], { a: "2026-08-27", b: "2026-09-24" }).map((f) => f.memory!.id), ["mem-2", "mem-3"]);
    assert.deepEqual(memoryFacts(r, ["S2"]).map((f) => f.memory!.id), ["mem-1", "mem-2", "mem-3"], "without windows nothing is left out");
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

describe("linkNotes", () => {
  const ev = (id: string, key: string, hyp: string, value: string) => ({ id, key, label: key, value, unit: "text", display: value, evidence: "E1", hypothesis: hyp });
  const note = { id: "M1", key: "memory_1", label: "Remembered note", value: "Brixton moved its oven schedule 2 hours later from 7 Oct for the new sourdough line", unit: "text", display: "x", evidence: "",
    memory: { id: "mem-6", origin: "user" as const, site: "S2", learnedAt: "2026-10-22T10:00:00.000Z", confidence: 0.9, relevance: 0.3 } };
  const facts = [ev("F44", "event_1", "H4", "SAMPLE: Oven schedule moved 2h later from this date (new sourdough line)."), ev("F53", "schedule_event", "H5", "SAMPLE: Oven schedule moved 2h later from this date (new sourdough line)."), ev("F60", "event_2", "H6", "SAMPLE: One-off freezer fault; extra kWh consumed all day.")];
  it("ties the note to logged-event facts that share two or more content words, but only those of tests that reach the narrative", () => {
    const [m] = linkNotes([note], facts, [{ id: "H4", status: "inconclusive" }, { id: "H5", status: "ruled_out" }, { id: "H6", status: "ruled_out" }]);
    assert.deepEqual(m.memory!.bearsOn, ["F53"]); assert.match(m.label, /Remembered note; bears on F53 \(same subject\)$/);
    const [all] = linkNotes([note], facts, [{ id: "H4", status: "supported" }, { id: "H5", status: "ruled_out" }]);
    assert.deepEqual(all.memory!.bearsOn, ["F44", "F53"]);
  });
  it("a note about something else, or sharing one word, is left alone", () => {
    const other = { ...note, value: "The freezer at Hampstead is being replaced" };
    assert.equal(linkNotes([other], facts, [{ id: "H6", status: "ruled_out" }])[0], other);
    assert.equal(linkNotes([{ ...note, value: "Brixton schedule" }], facts, [{ id: "H5", status: "ruled_out" }])[0].memory!.bearsOn, undefined);
  });
});
