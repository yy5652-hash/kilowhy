// H-MEM: remember (mining), recall (provider vectors, trace, site scoping), audit (trust ledger), feedback, persistence. Fake embedder: no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KilowhyMemory, USER_CONFIDENCE } from "./memory.ts";
import { fakeEmbedder, NOTE } from "./memory_testkit.ts";
import { renderAudit, renderRecall } from "./memory_render.ts";

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const mem = (o: Parameters<typeof KilowhyMemory.create>[0] = {}) => KilowhyMemory.create({ clock: () => T0, ...o });
const Q = "Crumb & Co Brixton: Why did Brixton use more electricity?";

describe("remember", () => {
  it("a user note goes through the engine's mining service and is filed as a high-confidence fact about its site", async () => {
    const m = mem({ embed: fakeEmbedder() });
    const r = await m.remember(NOTE, { source: "user", site: "S2", validFrom: "2026-10-07" });
    assert.equal(r.id, "mem-1"); assert.equal(r.content, NOTE);
    assert.equal(r.source, "user:note"); assert.equal(r.type, "factual"); assert.equal(r.layer, "long_term"); assert.equal(r.confidence, USER_CONFIDENCE); assert.equal(r.chatId, "S2");
    assert.ok(r.tags.includes("site:S2") && r.tags.includes("valid_from:2026-10-07") && r.tags.includes("event:user_correction"));
    assert.equal(r.provenance.origin, "user_correction"); assert.equal(r.provenance.learnedAt, T0);
    assert.equal(r.domain, "general", "not the 'personal' domain the miner gives a preference");
  });
  it("a note without a signal word is kept (the engine's model-free miner would have dropped it)", async () => {
    const m = mem();
    assert.equal(m.mining.mineModelFree(NOTE).length, 0);
    await m.remember(NOTE, { source: "user" });
    assert.equal(m.list().length, 1);
  });
  it("an agent memory carries its provenance refs; empty or tiny text is refused", async () => {
    const m = mem();
    const r = await m.remember("Weather-driven volume (H3) was a supported cause at Brixton.", { source: "agent", site: "S2", key: "cause:S2:H3", evidence: ["E3", "E4"], zetarisRunIds: ["run-1"], receiptIds: ["rcpt_9"] });
    assert.equal(r.source, "agent:kilowhy-investigation"); assert.equal(r.layer, "working"); assert.equal(r.confidence, 0.7);
    assert.deepEqual(r.provenance.refs, ["evidence:E3", "evidence:E4", "zetaris-run:run-1", "nightshift-receipt:rcpt_9"]);
    assert.equal(m.findByKey("cause:S2:H3")?.id, r.id);
    await assert.rejects(() => m.remember("  ", { source: "user" }), /needs some text/);
  });
});

describe("recall", () => {
  it("returns the note for the question about its site, with score, trace and the embedding route; unrelated questions get nothing", async () => {
    const emb = fakeEmbedder();
    const m = mem({ embed: emb });
    await m.remember(NOTE, { source: "user", site: "S2" });
    const hit = await m.recall(Q, { site: "S2" });
    assert.deepEqual(hit.memories.map((x) => x.id), ["mem-1"]);
    assert.ok(hit.memories[0].relevance >= 0.28 && hit.memories[0].relevance <= 1);
    assert.equal(hit.memories[0].origin, "user"); assert.equal(hit.memories[0].text, NOTE);
    assert.match(hit.trace.retrievalReason, /hybrid ranking/); assert.deepEqual(Object.keys(hit.trace.scores), ["mem-1"]);
    assert.match(hit.embed.route, /fake: fake\/embed-48/);
    assert.match(hit.context, /\[MEMORY CONTEXT\][\s\S]*mem-1/);
    const none = await m.recall("tariff comparison, standing charge", { site: "S2" });
    assert.deepEqual(none.memories, []);
  });
  it("embeds the note as a passage and the question as a query, once each (the vector is kept)", async () => {
    const emb = fakeEmbedder();
    const m = mem({ embed: emb });
    await m.remember(NOTE, { source: "user", site: "S2" });
    await m.recall(Q, { site: "S2" }); await m.recall(Q, { site: "S2" });
    assert.deepEqual(emb.calls.map((c) => c.inputType), ["passage", "query", "query"]);
  });
  it("a note about another site is not recalled for this site; a note without a site is recalled for every site", async () => {
    const m = mem({ embed: fakeEmbedder() });
    await m.remember(NOTE, { source: "user", site: "S2" });
    await m.remember("Every bakery switched its ovens to the new sourdough line schedule", { source: "user" });
    const s1 = await m.recall("Crumb & Co Shoreditch: why did Shoreditch use more electricity sourdough ovens schedule", { site: "S1", threshold: 0.05 });
    assert.deepEqual(s1.memories.map((x) => x.id), ["mem-2"]);
    const s2 = await m.recall(Q, { site: "S2", threshold: 0.05 });
    assert.deepEqual(new Set(s2.memories.map((x) => x.id)), new Set(["mem-1", "mem-2"]));
  });
  it("the semantic term comes from the provider's vectors, not from the engine's hash embedder", async () => {
    // Same words in both notes, so the hash embedder cannot tell them apart; the provider's vectors can.
    const vec: Record<string, number[]> = { "oven alpha": [1, 0, 0], "oven beta": [0, 1, 0], "oven gamma": [0.6, 0.8, 0] };
    const m = mem({ embed: async (texts) => ({ vectors: texts.map((t) => vec[t.toLowerCase().replace(/^.*: /, "")] ?? [1, 0, 0]), route: { provider: "fake", requestedModel: "m", routedModel: "m", latencyMs: 1 } }) });
    await m.remember("oven alpha", { source: "user", site: "S2" });
    await m.remember("oven beta", { source: "user", site: "S2" });
    const r = await m.recall("S2: oven alpha", { site: "S2", threshold: 0 });
    assert.deepEqual(r.memories.map((x) => x.id), ["mem-1", "mem-2"]);
    assert.ok(r.memories[0].relevance - r.memories[1].relevance > 0.2, `${r.memories[0].relevance} vs ${r.memories[1].relevance}`);
    const hash = await mem().recall("oven alpha", { threshold: 0 });
    assert.equal(hash.memories.length, 0, "no notes in a fresh store");
  });
  it("a provider embedding failure falls back to the engine's own embedder and says so; nothing throws", async () => {
    let down = false;
    const emb = fakeEmbedder({ fail: () => down });
    const m = mem({ embed: emb });
    await m.remember(NOTE, { source: "user", site: "S2" });
    down = true;
    const r = await m.recall(Q, { site: "S2", threshold: 0.1 });
    assert.match(r.embed.route, /hash \(provider.embed unavailable\)/); assert.match(r.embed.fallback ?? "", /embedding service down/);
    assert.equal(r.memories[0]?.id, "mem-1");
  });
  it("without an embedder the engine's hash embedder is used", async () => {
    const m = mem();
    await m.remember(NOTE, { source: "user", site: "S2" });
    const r = await m.recall("Why did Brixton change its oven schedule for the sourdough line", { site: "S2", threshold: 0.1 });
    assert.equal(r.embed.route, "hash (no embedder configured)"); assert.equal(r.memories[0]?.id, "mem-1");
  });
  it("a model change re-embeds the memories (vectors of another model are never compared)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilowhy-hmem-"));
    try {
      const a = fakeEmbedder({ model: "model-a" });
      await mem({ dir, embed: a }).remember(NOTE, { source: "user", site: "S2" });
      const b = fakeEmbedder({ model: "model-b" });
      await mem({ dir, embed: b }).recall(Q, { site: "S2" });
      assert.deepEqual(b.calls.map((c) => c.inputType), ["query", "passage"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("audit and feedback (the trust ledger)", () => {
  it("records creation, enrichment, every recall and feedback, each with its actor", async () => {
    const m = mem({ embed: fakeEmbedder() });
    const r = await m.remember(NOTE, { source: "user", site: "S2" });
    await m.recall(Q, { site: "S2" });
    m.feedback(r.id, "helpful");
    m.feedback(r.id, "wrong");
    const h = m.audit(r.id);
    assert.deepEqual(h.map((e) => `${e.action}:${e.actor}`), ["create:user", "update:user", "read:kilowhy-agent", "feedback:user", "feedback:user"]);
    assert.equal(h[2].details?.query, Q);
    assert.deepEqual([h[3].details?.kind, h[3].details?.delta, h[4].details?.kind, h[4].details?.delta], ["helpful", 0.05, "wrong", -0.2]);
    assert.ok(Math.abs(m.get(r.id)!.confidence - (0.9 + 0.05 - 0.2)) < 1e-9); assert.ok(m.get(r.id)!.tags.includes("review"));
    const text = renderAudit(r.id, h);
    assert.match(text, /create\s+by user/); assert.match(text, /read\s+by kilowhy-agent\s+recalled for the query/); assert.match(text, /feedback\s+by user\s+wrong \(-0.2\), confidence 0.95 -> 0.75/);
  });
  it("a wrong memory ranks lower afterwards", async () => {
    const m = mem({ embed: fakeEmbedder() });
    const r = await m.remember(NOTE, { source: "user", site: "S2" });
    const before = (await m.recall(Q, { site: "S2" })).memories[0].relevance;
    m.feedback(r.id, "wrong");
    assert.ok((await m.recall(Q, { site: "S2", threshold: 0 })).memories[0].relevance < before);
  });
  it("unknown ids are an error, an empty history renders a message", () => {
    const m = mem();
    assert.throws(() => m.feedback("mem-99", "helpful"), /unknown memory id/);
    assert.match(renderAudit("mem-99", m.audit("mem-99")), /No ledger entries/);
  });
});

describe("persistence", () => {
  it("memories, ledger and vectors survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilowhy-hmem-"));
    try {
      const a = mem({ dir, embed: fakeEmbedder() });
      const r = await a.remember(NOTE, { source: "user", site: "S2" });
      await a.recall(Q, { site: "S2" });
      const emb = fakeEmbedder();
      const b = mem({ dir, embed: emb });
      assert.equal(b.list().length, 1); assert.equal(b.get(r.id)?.content, NOTE);
      assert.deepEqual(b.audit(r.id).map((e) => e.action), ["create", "update", "read"]);
      const hit = await b.recall(Q, { site: "S2" });
      assert.equal(hit.memories[0].id, r.id);
      assert.deepEqual(emb.calls.map((c) => c.inputType), ["query"], "the stored vector is reused");
      assert.equal((await b.remember("Another note about the freezer", { source: "user" })).id, "mem-2", "ids continue");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("rendering", () => {
  it("a recall renders with its scores and route", async () => {
    const m = mem({ embed: fakeEmbedder() });
    await m.remember(NOTE, { source: "user", site: "S2" });
    const text = renderRecall(await m.recall(Q, { site: "S2" }));
    assert.match(text, /1 memory; embeddings via fake: fake\/embed-48/); assert.match(text, /score 0\.\d{3}\s+mem-1 \[user, S2\] long_term, confidence 0\.9/);
  });
});
