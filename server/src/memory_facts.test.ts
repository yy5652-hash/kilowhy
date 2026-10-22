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
