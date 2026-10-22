// askJson: JSON extraction from noisy replies, one stricter retry, call recording, transport errors (fake chat, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askJson, correctiveMessage, type Checked } from "./agent_llm.ts";
import { fakeChat, INTENT_OK } from "./agent_testkit.ts";
import { checkIntent, checkPlan, checkNarrativeShape } from "./agent_prompts.ts";
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
  it("records why a rejected reply was unusable, with the start and end of its text and its token count", async () => {
    const calls: LlmCall[] = [];
    await intentStep(fakeChat({ intent: ["The user wants me to classify the question. " + "x".repeat(300) + " then I will answer", INTENT_OK()] }), calls);
    assert.equal(calls.length, 2);
    assert.match(calls[0].rejected!, /^it contained no JSON object; \? output tokens; starts "The user wants me to classify/);
    assert.match(calls[0].rejected!, /ends "x*  ?then I will answer"$|then I will answer"$/);
    assert.equal(calls[1].rejected, undefined);
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
    assert.equal(calls.length, 1); assert.equal(calls[0].step, "intent"); assert.equal(calls[0].error, "meterless HTTP 502"); assert.equal(typeof calls[0].wallMs, "number");
    assert.equal(chat.requests.length, 1);
  });
  it("passes the token cap, the deadline and the reasoning control to the model call and reports each call", async () => {
    const calls: LlmCall[] = [], seen: LlmCall[] = [];
    const chat = fakeChat({ intent: [INTENT_OK()] });
    await askJson({ chat, calls, onCall: (c) => seen.push(c), reasoning: { systemLine: "/no_think", extra: { chat_template_kwargs: { enable_thinking: false } } } }, "intent", "auto", msgs, checkIntent, { maxTokens: 120, deadlineMs: 20_000 });
    const req = chat.requests[0].req;
    assert.equal(req.max_tokens, 120); assert.equal(req.deadlineMs, 20_000); assert.deepEqual(req.extra, { chat_template_kwargs: { enable_thinking: false } });
    assert.equal(req.messages[0].content, "You classify x\n/no_think");
    assert.equal(seen.length, 1); assert.equal(seen[0].step, "intent");
  });
  it("without options nothing extra is sent", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()] });
    await intentStep(chat, []);
    const req = chat.requests[0].req;
    assert.equal("max_tokens" in req, false); assert.equal("deadlineMs" in req, false); assert.equal("extra" in req, false);
    assert.equal(req.messages[0].content, "You classify x");
  });
  it("retryTransient: one more try after a quick 429, none after a timeout or when not asked", async () => {
    const calls: LlmCall[] = [];
    const chat = fakeChat({ intent: [new Error("nvidia HTTP 429: Too Many Requests"), INTENT_OK()] });
    const r = await askJson({ chat, calls }, "intent", "auto", msgs, checkIntent, { retryTransient: true });
    assert.equal(r.value?.type, "why_cost_change");
    assert.equal(calls.length, 2); assert.equal(calls[0].error, "nvidia HTTP 429: Too Many Requests"); assert.match(calls[1].step, /^intent \(retry after/);
    const timeout = fakeChat({ intent: [new Error("meterless timeout after 30s"), INTENT_OK()] });
    assert.equal((await askJson({ chat: timeout, calls: [] }, "intent", "auto", msgs, checkIntent, { retryTransient: true })).value, null);
    assert.equal(timeout.requests.length, 1);
    const notAsked = fakeChat({ intent: [new Error("nvidia HTTP 429"), INTENT_OK()] });
    assert.equal((await askJson({ chat: notAsked, calls: [] }, "intent", "auto", msgs, checkIntent)).value, null);
    const twice = fakeChat({ intent: [new Error("nvidia HTTP 503"), new Error("nvidia HTTP 503")] });
    assert.equal((await askJson({ chat: twice, calls: [] }, "intent", "auto", msgs, checkIntent, { retryTransient: true })).value, null);
    assert.equal(twice.requests.length, 2);
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
  it("checkNarrativeShape: needs a sentences array of {text}; the other sections are left to narration.ts", () => {
    const c = checkNarrativeShape({ headline: "h", sentences: [{ text: "A {F1}." }], ruledOut: [{ hypothesis: "H5", text: "x {F2}" }], recommendation: { text: "r {F3}" } }) as Extract<Checked<any>, { ok: true }>;
    assert.equal(c.ok, true);
    assert.equal(c.value.sentences.length, 1);
    const loose = checkNarrativeShape({ sentences: ["A {F1}.", { text: "B {F2}." }], ruledOut: ["C {F3}"], recommendation: "D {F4}" }) as Extract<Checked<any>, { ok: true }>;
    assert.equal(loose.ok, true);
    assert.deepEqual(loose.value.sentences, [{ text: "A {F1}." }, { text: "B {F2}." }]); assert.deepEqual(loose.value.ruledOut, [{ text: "C {F3}" }]); assert.deepEqual(loose.value.recommendation, { text: "D {F4}" });
    assert.equal(checkNarrativeShape({ headline: "x" }).ok, false);
    assert.equal(checkNarrativeShape({ sentences: [{ facts: [] }] }).ok, false);
    assert.equal(checkNarrativeShape(null).ok, false);
    assert.equal(checkNarrativeShape({ sentences: [] }).ok, true, "an empty list is a content problem, reported by narration.ts");
  });
  it("correctiveMessage lists every error", () => { const m = correctiveMessage(["a", "b"]); assert.match(m, /- a\n- b/); assert.match(m, /rejected for these reasons/); assert.match(m, /Never write digits/); });
});
