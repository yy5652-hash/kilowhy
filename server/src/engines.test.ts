// The vendored engines load from plain node (no flag) and do their basic job. No network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hmemLib, worldLib, markovianLib } from "./engines.ts";

describe("vendored Meterless engines load through the vendor hook", () => {
  it("H-MEM: add and query", () => {
    const h = new hmemLib.HMEM({ clock: () => 1_750_000_000_000 });
    const rec = h.add({ content: "Brixton moved its oven schedule later", source: "test", confidence: 0.9 });
    assert.equal(rec.id, "mem-1");
    assert.equal(h.query("Brixton oven schedule", { threshold: 0.1 }).memories[0]?.memory.id, "mem-1");
    assert.equal(h.retrieval.constructor.name, "MemoryRetrievalService");
  });
  it("World Model: a provenance-stamped entity", async () => {
    const w = new worldLib.WorldModel({ namespace: "t", storage: "memory" });
    const e = await w.upsertEntity({ type: "site", externalKey: { system: "z", id: "S1" }, name: "Shoreditch", source: { kind: "api", at: "2026-08-27T00:00:00.000Z" } });
    assert.equal(e.id, "site:z:S1");
    await assert.rejects(() => w.upsertEntity({ type: "site", name: "x", source: { kind: "api" } as never }), /provenance/);
  });
  it("Markovian: a two-step chain with a stepFn", async () => {
    const m = new markovianLib.Markovian({ chunkConfig: { chunkSize: 4000, carryoverTokens: 640 } });
    const run = await m.run({ goal: "g", reflect: false, stepFn: ({ step }) => ({ content: step === 0 ? "one\n[STATE_CHECKPOINT]\nCOMPLETED: one\nREMAINING: two\nDECISIONS: none\nCONTEXT: test" : "two\n[TASK_COMPLETE]" }) });
    assert.equal(run.status, "completed"); assert.equal(run.chunks.length, 2);
    assert.match(run.chunks[1].carryover, /REMAINING: two/);
  });
});
