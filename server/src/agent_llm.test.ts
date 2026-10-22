// askJson: JSON extraction from noisy replies, one stricter retry, call recording, transport errors (fake chat, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askJson, correctiveMessage, type Checked } from "./agent_llm.ts";
import { fakeChat, INTENT_OK } from "./agent_testkit.ts";
import { checkIntent, checkPlan, checkNarrative } from "./agent_prompts.ts";
import type { LlmCall } from "./agent_types.ts";

const msgs = [{ role: "system" as const, content: "You classify x" }, { role: "user" as const, content: "q" }];
const intentStep = (chat: ReturnType<typeof fakeChat>, calls: LlmCall[]) => askJson({ chat, calls }, "intent", "auto", msgs, checkIntent);

describe("askJson", () => {
  it("parses a clean reply and records the route", async () => {
    const calls: LlmCall[] = [];
    const r = await intentStep(fakeChat({ intent: [INTENT_OK()] }), calls);
    assert.equal(r.value?.type, "why_cost_change");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].step, "intent");
    assert.equal(calls[0].route?.routedModel, "mock/model-x");
    assert.equal(calls[0].route?.raceWidth, 6);
    assert.equal(calls[0].route?.receiptId, "rcpt_test");
  });
  it("extracts the last JSON object from reasoning text and code fences", async () => {
    const calls: LlmCall[] = [];
    const noisy = 'The user wants me to classify. Maybe {"type": "x"}.\n```json\n{"type": "why_emissions", "sites": ["Brixton"], "dates": []}\n```';
    const r = await intentStep(fakeChat({ intent: [noisy] }), calls);
    assert.equal(r.value?.type, "why_emissions");
    assert.deepEqual(r.value?.requestedSites, ["Brixton"]);
    assert.equal(calls.length, 1);
  });
  it("retries once with a stricter instruction when the reply has no JSON", async () => {
    const calls: LlmCall[] = [];
    const chat = fakeChat({ intent: ["I think it is about cost.", INTENT_OK({ type: "what_to_change" })] });
    const r = await intentStep(chat, calls);
    assert.equal(r.value?.type, "what_to_change");
    assert.deepEqual(calls.map((c) => c.step), ["intent", "intent (stricter retry)"]);
    const second = chat.requests[1].req.messages;
    assert.equal(second[second.length - 1].role, "user");
    assert.match(String(second[second.length - 1].content), /could not be used: it contained no JSON object/);
    assert.match(String(second[second.length - 1].content), /ONE valid JSON object/);
    assert.equal(second[second.length - 2].content, "I think it is about cost.");
  });
  it("retries once when the JSON has the wrong shape, and names the problem", async () => {
    const calls: LlmCall[] = [];
    const chat = fakeChat({ intent: [JSON.stringify({ type: "poetry" }), INTENT_OK()] });
    const r = await intentStep(chat, calls);
    assert.equal(r.value?.type, "why_cost_change");
    assert.match(String(chat.requests[1].req.messages.at(-1)?.content), /"type" must be one of/);
  });
  it("gives up after the single retry and says why", async () => {
    const calls: LlmCall[] = [];
    const r = await intentStep(fakeChat({ intent: ["no json", "still none"] }), calls);
    assert.equal(r.value, null);
    assert.match(r.error!, /intent: it contained no JSON object/);
    assert.equal(r.rawText, "still none");
    assert.equal(calls.length, 2);
  });
  it("a transport error is recorded, not thrown, and is not retried", async () => {
    const calls: LlmCall[] = [];
    const chat = fakeChat({ intent: [new Error("meterless HTTP 502")] });
    const r = await intentStep(chat, calls);
    assert.equal(r.value, null);
    assert.equal(r.rawText, undefined);
    assert.deepEqual(calls, [{ step: "intent", error: "meterless HTTP 502" }]);
    assert.equal(chat.requests.length, 1);
  });
  it("the original messages are never mutated", async () => {
    const before = JSON.stringify(msgs);
    await intentStep(fakeChat({ intent: ["nope", INTENT_OK()] }), []);
    assert.equal(JSON.stringify(msgs), before);
  });
});

describe("reply checkers", () => {
  it("checkIntent: type is case-insensitive; dates must be ISO; sites may be a string", () => {
    const c = checkIntent({ type: "WHY_COST_CHANGE", sites: "Brixton, Hampstead", dates: ["2026-10-17", "17 Oct", "tomorrow"] }) as Extract<Checked<any>, { ok: true }>;
    assert.equal(c.ok, true);
    assert.deepEqual(c.value, { type: "why_cost_change", requestedSites: ["Brixton", "Hampstead"], dates: ["2026-10-17"] });
    assert.equal(checkIntent({ sites: [] }).ok, false);
    assert.equal(checkIntent(null).ok, false);
  });
  it("checkPlan: normalises ids, keeps only well-formed extra SQL, needs a hypotheses key", () => {
    const c = checkPlan({ hypotheses: ["h1", "H03", "H99", "H1"], extraSql: [{ purpose: "p", sql: "SELECT 1" }, { purpose: "no sql" }, "junk", { sql: "SELECT 2" }], rationale: "r" }) as Extract<Checked<any>, { ok: true }>;
    assert.equal(c.ok, true);
    assert.deepEqual(c.value.hypotheses, ["H1", "H3", "H99", "H1"]);
    assert.deepEqual(c.value.extraSql, [{ purpose: "p", sql: "SELECT 1" }, { purpose: "extra query", sql: "SELECT 2" }]);
    assert.equal(checkPlan({ rationale: "x" }).ok, false);
  });
  it("checkNarrative: coerces ids (12, '[F12]', 'f12'), defaults missing sections, rejects missing sentences", () => {
    const c = checkNarrative({ headline: " h ", sentences: [{ text: "A.", facts: [12, "[F13]", "f14"], evidence: "E1, e2" }] }) as Extract<Checked<any>, { ok: true }>;
    assert.equal(c.ok, true);
    assert.deepEqual(c.value.sentences[0].facts, ["F12", "F13", "F14"]);
    assert.deepEqual(c.value.sentences[0].evidence, ["E1", "E2"]);
    assert.deepEqual(c.value.ruledOut, []);
    assert.deepEqual(c.value.recommendation, { text: "", facts: [], evidence: [] });
    assert.equal(c.value.headline, "h");
    assert.equal(checkNarrative({ headline: "x" }).ok, false);
    assert.equal(checkNarrative({ sentences: [{ facts: [] }] }).ok, false);
    assert.equal(checkNarrative({ sentences: [], ruledOut: [{ text: 1 }] }).ok, false);
  });
  it("correctiveMessage lists every error", () => { const m = correctiveMessage(["a", "b"]); assert.match(m, /- a\n- b/); assert.match(m, /verifier rejected/); });
});
