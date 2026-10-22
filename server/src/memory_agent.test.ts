// H-MEM in the agent loop: recall at the start (M# facts, plan prompt), the narrative cites {M#}, the verifier accepts it, confirmed causes are written back.
// Scripted LLM, synthetic data, fake embedder: no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { investigate } from "./agent.ts";
import { isClarification, type InvestigationResult } from "./agent_types.ts";
import { scenario, fakeChat, INTENT_OK, PLAN_OK, goodNarrative, factLines, ph } from "./agent_testkit.ts";
import { KilowhyMemory } from "./memory.ts";
import { fakeEmbedder, NOTE } from "./memory_testkit.ts";
import type { ChatRequest } from "./provider_shared.ts";
import type { ProgressEvent } from "./agent_events.ts";
import { verifyAnswer } from "./verifier.ts";
import { renderPlaceholders } from "./placeholders.ts";

const Q = "Why did Brixton use more electricity?";
const ok = (o: Awaited<ReturnType<typeof investigate>>): InvestigationResult => { assert.ok(!isClarification(o), "expected an investigation"); return o as InvestigationResult; };
const memory = () => KilowhyMemory.create({ embed: fakeEmbedder(), clock: () => Date.UTC(2026, 10, 1, 9, 0, 0), recall: { threshold: 0.2 } });

/** The good narrative, plus {M1} in the ruled-out timing item (the note explains why the day pattern moved). */
function narrativeWithNote(req: ChatRequest): string {
  const n = JSON.parse(goodNarrative(req));
  n.ruledOut[0].text = `${n.ruledOut[0].text} It fits {M1}.`;
  return JSON.stringify(n);
}
type Narrative = (req: ChatRequest) => string;
const ask = async (m: KilowhyMemory, narrative: Narrative | Error = narrativeWithNote, extra: Parameters<typeof investigate>[1] = {}) => {
  const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], narrative: [narrative] });
  const o = ok(await investigate(Q, { data: scenario().data, chat, memory: m, ...extra }));
  return { o, chat };
};

describe("a question with no memory yet", () => {
  it("recalls nothing, writes the supported causes with their provenance, and a second identical question writes nothing new", async () => {
    const m = memory();
    const events: ProgressEvent[] = [];
    const { o, chat } = await ask(m, goodNarrative, { onEvent: (e) => events.push(e) });
    assert.equal(o.memory!.recalled.length, 0); assert.equal(o.facts.filter((f) => f.id.startsWith("M")).length, 0);
    assert.ok(!/Notes remembered/.test(String(chat.requests.find((r) => r.step === "plan")!.req.messages[1].content)));
    const supported = o.results.filter((r) => r.status === "supported" && !["H7", "H9"].includes(r.id)).map((r) => r.id);
    assert.deepEqual(o.memory!.written.map((w) => w.hypothesis), supported); assert.ok(supported.length >= 2);
    assert.ok(o.memory!.written.every((w) => !w.skipped && /^mem-\d+$/.test(w.id)));
    const rec = m.get(o.memory!.written[0].id)!;
    assert.equal(rec.source, "agent:kilowhy-investigation"); assert.equal(rec.chatId, "S2");
    const refs = rec.provenance.refs!;
    assert.ok(refs.some((r) => /^evidence:E\d+$/.test(r)) && refs.includes("zetaris-run:fake-run") && refs.includes("nightshift-receipt:rcpt_test"), refs.join(","));
    assert.ok(!/£|%|\d+\.\d/.test(rec.content), "no figures in a memory: they live in the evidence");
    const w = events.find((e) => e.type === "memory" && e.action === "write") as Extract<ProgressEvent, { type: "memory"; action: "write" }>;
    assert.equal(w.written.length, supported.length);
    const again = (await ask(m, goodNarrative)).o;
    assert.ok(again.memory!.written.every((x) => x.skipped), "the same causes for the same windows are not written twice");
    assert.equal(m.list().length, supported.length);
  });
  it("no memory option: no memory fields, no events, nothing written", async () => {
    const events: ProgressEvent[] = [];
    const o = ok(await investigate(Q, { data: scenario().data, chat: fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] }), onEvent: (e) => events.push(e) }));
    assert.equal(o.memory, undefined); assert.ok(!events.some((e) => e.type === "memory"));
  });
});

describe("after a note", () => {
  const withNote = async () => { const m = memory(); await m.remember(NOTE, { source: "user", site: "S2", validFrom: "2026-10-07" }); return m; };
  it("the note is recalled at the start and becomes an M# fact with its text, date and source; the plan prompt and the narrative prompt show it", async () => {
    const m = await withNote();
    const events: ProgressEvent[] = [];
    const { o, chat } = await ask(m, narrativeWithNote, { onEvent: (e) => events.push(e) });
    const f = o.facts.find((x) => x.id === "M1")!;
    assert.ok(f, "M1 exists");
    assert.equal(f.value, NOTE); assert.equal(f.evidence, ""); assert.equal(f.memory!.origin, "user"); assert.equal(f.memory!.site, "S2");
    assert.equal(f.display, `"${NOTE}" (your note, 2026-11-01)`);
    assert.match(f.label, /Remembered note from the owner about S2, applies from 2026-10-07 \(H-MEM mem-1\)/);
    const plan = String(chat.requests.find((r) => r.step === "plan")!.req.messages[1].content);
    assert.match(plan, /Notes remembered from earlier \(H-MEM\)[^\n]*\n- M1 \(owner's note, 2026-11-01, S2\): Brixton moved its oven schedule/);
    const sys = String(chat.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.match(sys, /^M1 Remembered note from the owner about S2.* = "Brixton moved/m); assert.match(sys, /7\. Facts whose id starts with M are notes remembered/);
    assert.ok(factLines(chat.requests.find((r) => r.step === "narrative")!.req).length > 20, "the F# lines are still there");
    const r = events.find((e) => e.type === "memory" && e.action === "recall") as Extract<ProgressEvent, { type: "memory"; action: "recall" }>;
    assert.ok(r.ids.includes("mem-1") && r.route.startsWith("fake:"));
    assert.equal(o.memory!.recalled[0].id, "mem-1"); assert.equal(o.memory!.recalled[0].factId, "M1");
  });
  it("the narrative may cite {M1} next to a data fact: the verifier accepts it and the report counts the citation", async () => {
    const m = await withNote();
    const { o } = await ask(m);
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 1);
    const item = o.answer.ruledOut[0];
    assert.ok(item.text.includes(`"${NOTE}" (your note, 2026-11-01)`), item.text);
    assert.ok(item.facts.includes("M1") && item.evidence.length > 0 && item.evidence.every((e) => /^E\d+$/.test(e)));
    assert.ok(item.facts.some((x) => x.startsWith("F")), "the note sits next to data facts");
    assert.equal(o.memory!.recalled[0].citedIn, 1);
  });
  it("a note cannot stand alone: a sentence citing only {M1} has no evidence and is rejected, and the correction can fix it", async () => {
    const m = await withNote();
    let n = 0;
    const lone: Narrative = (req) => { n++; if (n > 1) return goodNarrative(req); const j = JSON.parse(goodNarrative(req)); j.sentences.push({ text: "The oven schedule moved. {M1}" }); return JSON.stringify(j); };
    const { o } = await ask(m, lone);
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 2);
    assert.ok(o.verification.history[0].errors.some((e) => /sentences\[\d+\]: cites no evidence/.test(e)), o.verification.history[0].errors.join(" | "));
  });
  it("the template fallback still verifies when the note was recalled", async () => {
    const m = await withNote();
    const { o } = await ask(m, new Error("down"), { maxCorrections: 0 });
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.passed, true);
    assert.equal(o.memory!.recalled.length, 1);
  });
  it("a note about another site is not recalled for this site", async () => {
    const m = memory();
    await m.remember(NOTE, { source: "user", site: "S3" });
    const { o } = await ask(m);
    assert.equal(o.memory!.recalled.length, 0); assert.equal(o.facts.filter((f) => f.id === "M1").length, 0);
  });
});

describe("M# in the verifier and the placeholders", () => {
  const facts = [
    { id: "F1", key: "a", label: "bill change", value: 12.34, unit: "GBP", display: "£12.34", evidence: "E1" },
    { id: "M1", key: "memory_1", label: "note", value: "Oven moved 2 hours later from 7 Oct", unit: "text", display: '"Oven moved 2 hours later from 7 Oct" (your note, 2026-10-22)', evidence: "" },
  ];
  it("renders {M1} and {F1} in one sentence and cites both; an M# that does not exist is an error", () => {
    const byId = new Map(facts.map((f) => [f.id, f]));
    const r = renderPlaceholders("The bill moved by {F1}, as in {M1}.", byId, "s");
    assert.deepEqual(r.errors, []); assert.deepEqual(r.facts, ["F1", "M1"]); assert.match(r.text, /^The bill moved by £12\.34, as in "Oven moved 2 hours later from 7 Oct" \(your note, 2026-10-22\)\.$/);
    assert.match(renderPlaceholders("See {M7}.", byId, "s").errors[0], /placeholder \{M7\} does not exist/);
  });
  it("the digits inside a remembered note match its own fact; a date only the note has is rejected unless the note is cited", () => {
    const ctx = { facts, evidenceIds: ["E1"], hypotheses: [], requireRecommendation: false };
    const empty = { text: "", facts: [], evidence: [] };
    const good = verifyAnswer({ headline: "£12.34", sentences: [{ text: 'Up £12.34; note: "Oven moved 2 hours later from 7 Oct" (your note, 2026-10-22).', facts: ["F1", "M1"], evidence: ["E1"] }], ruledOut: [], recommendation: empty }, ctx);
    assert.equal(good.passed, true, JSON.stringify(good.errors));
    const bad = verifyAnswer({ headline: "£12.34", sentences: [{ text: "Up £12.34 on 7 Oct.", facts: ["F1"], evidence: ["E1"] }], ruledOut: [], recommendation: empty }, ctx);
    assert.equal(bad.passed, false);
  });
});
