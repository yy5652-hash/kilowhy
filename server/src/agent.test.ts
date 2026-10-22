// Agent loop tests with a scripted fake LLM and the synthetic data layer: no network, no Zetaris, no Nightshift.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { investigate, normalizeAnswer, DEADLINES_MS, HEDGE_AFTER_MS } from "./agent.ts";
import { isClarification, type InvestigationResult } from "./agent_types.ts";
import { renderOutcome, routeLine, wrap } from "./agent_render.ts";
import { templateAnswer } from "./agent_template.ts";
import { verifyAnswer } from "./verifier.ts";
import { scenario, fakeChat, goodNarrative, badNarrative, factLines, ph, INTENT_OK, PLAN_OK, SITE_NAMES } from "./agent_testkit.ts";
import type { ProgressEvent } from "./agent_events.ts";
import type { ChatRequest } from "./provider_shared.ts";

const Q = "Why did our electricity cost more in the last four weeks than the four weeks before?";
const run = async (q: string, chat: ReturnType<typeof fakeChat>, extra: Parameters<typeof investigate>[1] = {}) => investigate(q, { engine: "plain", data: scenario().data, chat, ...extra });
const ok = (o: Awaited<ReturnType<typeof investigate>>): InvestigationResult => { assert.ok(!isClarification(o), "expected an investigation, got a clarification"); return o as InvestigationResult; };
const stepsOf = (o: InvestigationResult) => o.llmCalls.map((c) => c.step);
const sorted = (xs: string[]) => [...xs].sort();
const happy = () => fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] });

describe("investigate: a verified LLM answer", () => {
  it("returns a verified placeholder narrative on the first attempt", async () => {
    const o = ok(await run(Q, happy()));
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 1); assert.deepEqual(o.verification.errors, []); assert.deepEqual(o.verification.history, []);
    assert.deepEqual(sorted(stepsOf(o)), ["intent", "narrative", "plan"]);
    assert.equal(stepsOf(o).at(-1), "narrative");
    assert.equal(o.intent.type, "why_cost_change"); assert.equal(o.intent.source, "llm");
    assert.equal(o.scope.label, "ALL"); assert.deepEqual(o.scope.sites.map((s) => s.id), ["S1", "S2", "S3"]);
    assert.ok(o.answer.sentences.length >= 2 && o.answer.headline.startsWith("Your bill rose by £"));
    assert.equal(o.answer.ruledOut[0].hypothesis, "H5");
    assert.equal(o.sampleDataNote.includes("SAMPLE"), true);
  });
  it("the rendered text carries the fact displays, and the cited facts and evidence were derived from the placeholders", async () => {
    const o = ok(await run(Q, happy()));
    const s0 = o.answer.sentences[0];
    const get = (k: string) => o.facts.find((f) => f.key === k)!;
    assert.equal(s0.text, `Your bill rose by ${get("delta_bill").display} (${get("delta_bill_pct").display}), from ${get("bill_A").display} to ${get("bill_B").display}.`);
    assert.deepEqual(s0.facts, [get("delta_bill").id, get("delta_bill_pct").id, get("bill_A").id, get("bill_B").id].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    assert.deepEqual(s0.evidence, ["E1"]);
    for (const t of [o.answer.headline, ...o.answer.sentences.map((x) => x.text), ...o.answer.ruledOut.map((x) => x.text), o.answer.recommendation.text]) assert.ok(!/[{}]/.test(t), `no placeholder survives: ${t}`);
  });
  it("the result has every field of the spec", async () => {
    const o = ok(await run(Q, happy()));
    for (const k of ["question", "intent", "scope", "decomposition", "plan", "results", "evidence", "facts", "answer", "verification", "llmCalls", "timings"]) assert.ok(k in o, k);
    assert.ok(o.decomposition.ok && o.decomposition.result);
    assert.ok(!("windowA" in o.decomposition) && !("aligned" in o.decomposition), "per-slot arrays stay out of the result");
    assert.equal(o.decomposition.slotsAligned, 1344); assert.equal(o.decomposition.slotsExpected, 1344);
    assert.ok(o.evidence.length > 10 && o.evidence.every((e) => /^E\d+$/.test(e.id)));
    assert.ok(o.facts.length > 40);
    for (const k of ["sites", "intent", "plan", "data", "hypotheses", "recommend", "facts", "narrative", "total"]) assert.equal(typeof o.timings[k], "number", k);
    assert.ok(o.timings.total >= 0);
  });
  it("records the route and the wall time of every LLM call (routed model, label, latency, race width, receipt)", async () => {
    const o = ok(await run(Q, happy()));
    for (const c of o.llmCalls) {
      assert.ok(c.route, c.step); assert.equal(typeof c.wallMs, "number", c.step);
      assert.equal(c.route!.routedModel, "mock/model-x"); assert.equal(c.route!.label, "Mock model"); assert.equal(typeof c.route!.latencyMs, "number"); assert.equal(c.route!.raceWidth, 6); assert.equal(c.route!.receiptId, "rcpt_test");
    }
    const by = (step: string) => o.llmCalls.find((c) => c.step === step)!.route!.requestedModel;
    assert.equal(by("intent"), "meterless/auto"); assert.equal(by("plan"), "meterless/deep"); assert.equal(by("narrative"), "meterless/deep");
  });
  it("uses mode auto for the intent and deep for the plan and the narrative, with small token caps and per-call deadlines", async () => {
    const chat = happy();
    await run(Q, chat);
    const by = (step: string) => chat.requests.find((r) => r.step === step)!.req;
    assert.equal(by("intent").mode, "auto"); assert.equal(by("plan").mode, "deep"); assert.equal(by("narrative").mode, "deep");
    assert.deepEqual([by("intent").max_tokens, by("plan").max_tokens, by("narrative").max_tokens], [800, 1200, 2200]);
    assert.deepEqual([by("intent").deadlineMs, by("plan").deadlineMs, by("narrative").deadlineMs], [DEADLINES_MS.intent, DEADLINES_MS.plan, DEADLINES_MS.narrative]);
    assert.deepEqual([by("intent").hedgeAfterMs, by("plan").hedgeAfterMs, by("narrative").hedgeAfterMs], [HEDGE_AFTER_MS.intent, HEDGE_AFTER_MS.plan, HEDGE_AFTER_MS.narrative]);
  });
  it("the deadlines and hedges can be overridden", async () => {
    const chat = happy();
    await run(Q, chat, { deadlinesMs: { narrative: 12_000 }, hedgeAfterMs: { narrative: 5_000 } });
    assert.equal(chat.requests.find((r) => r.step === "narrative")!.req.deadlineMs, 12_000);
    assert.equal(chat.requests.find((r) => r.step === "narrative")!.req.hedgeAfterMs, 5_000);
    assert.equal(chat.requests.find((r) => r.step === "plan")!.req.deadlineMs, 30_000);
  });
  it("every sentence cites existing facts and evidence, and evidence includes the cited facts' own evidence", async () => {
    const o = ok(await run(Q, happy()));
    const byId = new Map(o.facts.map((f) => [f.id, f])), ev = new Set(o.evidence.map((e) => e.id));
    for (const s of [...o.answer.sentences, ...o.answer.ruledOut, o.answer.recommendation]) {
      assert.ok(s.facts.length >= 1 && s.evidence.length >= 1);
      for (const f of s.facts) { assert.ok(byId.has(f)); assert.ok(s.evidence.includes(byId.get(f)!.evidence)); }
      for (const e of s.evidence) assert.ok(ev.has(e));
    }
    assert.equal(verifyAnswer(o.answer, { facts: o.facts, evidenceIds: ev, hypotheses: o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })) }).passed, true);
  });
  it("what the model sees: the question, site names, statuses and a compact facts table; never SQL, tokens or secrets", async () => {
    const chat = happy();
    const o = ok(await run(Q, chat));
    const all = chat.requests.flatMap((r) => r.req.messages.map((m) => String(m.content))).join("\n");
    for (const e of o.evidence) assert.ok(!all.includes(e.sql), `evidence SQL of ${e.id} must not be sent`);
    for (const bad of ["Bearer", "proxy-token", "NVIDIA_API_KEY", "ZETARIS_API_KEY", "nvapi-", "sk-"]) assert.ok(!all.includes(bad), bad);
    const narrative = String(chat.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.match(narrative, /^H3 Weather-driven volume: supported$/m);
    assert.match(narrative, /^H5 Timing shift: ruled_out$/m);
    assert.doesNotMatch(narrative, /^H4 .*inconclusive/m, "inconclusive hypotheses are not listed");
    assert.match(narrative, /^F9 Change in the bill, window B minus window A = £[\d,.]+$/m);
    assert.match(narrative, /NEVER write a digit/);
    assert.match(String(chat.requests.find((r) => r.step === "narrative")!.req.messages[1].content), /Crumb & Co Brixton/);
    assert.match(String(chat.requests.find((r) => r.step === "intent")!.req.messages[0].content), /S2 = Crumb & Co Brixton/);
    assert.equal(String(chat.requests.find((r) => r.step === "plan")!.req.messages[1].content), `Order the tests for this question: ${Q}`, "the plan sees only the question");
    assert.equal(String(chat.requests.find((r) => r.step === "intent")!.req.messages[1].content), `Classify this question: ${Q}`);
  });
  it("the narrative prompt carries only the relevant facts (supported and ruled-out hypotheses, neutral and REC facts)", async () => {
    const chat = happy();
    const o = ok(await run(Q, chat));
    const lines = factLines(chat.requests.find((r) => r.step === "narrative")!.req);
    assert.ok(lines.length < o.facts.length, `${lines.length} of ${o.facts.length}`);
    const status = new Map(o.results.map((r) => [r.id, r.status]));
    for (const l of lines) if (l.hyp !== "-" && l.hyp !== "REC" && l.hyp !== "EXTRA") assert.notEqual(status.get(l.hyp), "inconclusive", `${l.id} ${l.label}`);
    assert.ok(lines.some((l) => l.hyp === "H3") && lines.some((l) => l.hyp === "REC") && lines.some((l) => l.hyp === "-"));
    const inconclusive = o.facts.filter((f) => f.hypothesis && status.get(f.hypothesis) === "inconclusive");
    assert.ok(inconclusive.length > 0 && inconclusive.every((f) => !lines.some((l) => l.id === f.id)));
  });
  it("each step's user message is unique to the step, and the narrative's depends on its facts (Nightshift caches by user message)", async () => {
    const a = happy(), b = happy();
    await run(Q, a);
    await investigate(Q, { engine: "plain", data: scenario({ price: (w, day, slot) => (slot >= 32 && slot < 38 ? (w === "B" ? 50 : 35) : 12) + (day % 5) }).data, chat: b });
    const user = (c: ReturnType<typeof happy>, step: string) => String(c.requests.find((r) => r.step === step)!.req.messages.at(-1)!.content);
    assert.equal(new Set(["intent", "plan", "narrative"].map((s) => user(a, s))).size, 3);
    assert.match(user(a, "narrative"), /Facts table [0-9a-f]{12}: write the answer from it\.$/);
    assert.notEqual(user(a, "narrative"), user(b, "narrative"), "different facts, different message");
    const a2 = happy();
    await run(Q, a2);
    assert.equal(user(a2, "narrative"), user(a, "narrative"), "same facts, same message (cache hits stay possible)");
  });
  it("an emissions question gets the emissions facts and no cost-hypothesis facts; a cost question gets no emissions facts", async () => {
    const e = happy(), c = happy();
    await run("Why were our emissions higher?", fakeChat({ intent: [INTENT_OK({ type: "why_emissions" })], plan: [PLAN_OK()], narrative: [new Error("x")] }));
    const chatE = fakeChat({ intent: [INTENT_OK({ type: "why_emissions" })], plan: [PLAN_OK()], narrative: [new Error("x")] });
    await run("Why were our emissions higher?", chatE);
    const tagsE = new Set(factLines(chatE.requests.find((r) => r.step === "narrative")!.req).map((l) => l.hyp));
    assert.ok(tagsE.has("H10") && !tagsE.has("H1") && !tagsE.has("H5") && !tagsE.has("H8"));
    await run(Q, c);
    const tagsC = new Set(factLines(c.requests.find((r) => r.step === "narrative")!.req).map((l) => l.hyp));
    assert.ok(!tagsC.has("H10") && tagsC.has("H3"));
    const sysC = String(c.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.doesNotMatch(sysC, /^H10 /m);
    void e;
  });
  it("the compact prompt is small", async () => {
    const chat = happy();
    await run(Q, chat);
    const prompt = String(chat.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.ok(prompt.length < 9000, `narrative system prompt is ${prompt.length} characters`);
  });
});

describe("investigate: reasoning control", () => {
  it("by default every call asks the model not to think (chat_template_kwargs.enable_thinking=false), with no extra system line", async () => {
    const chat = happy();
    await run(Q, chat);
    for (const { req } of chat.requests) { assert.deepEqual(req.extra, { chat_template_kwargs: { enable_thinking: false } }); assert.ok(!String(req.messages[0].content).includes("thinking off")); }
  });
  it("applies the extra system line and request fields to every call", async () => {
    const chat = happy();
    await run(Q, chat, { reasoning: { systemLine: "detailed thinking off", extra: { chat_template_kwargs: { enable_thinking: false } } } });
    assert.equal(chat.requests.length, 3);
    for (const { req } of chat.requests) {
      assert.ok(String(req.messages[0].content).endsWith("\ndetailed thinking off"));
      assert.deepEqual(req.extra, { chat_template_kwargs: { enable_thinking: false } });
    }
  });
});

describe("investigate: concurrency", () => {
  it("the plan call starts at once and overlaps the intent call and the data work; the narrative waits for all of them", async () => {
    const s = scenario();
    const stamps: { prefetchAt: number; prefetchSites: string[] }[] = [];
    const data = { ...s.data, prefetch: async (q: { sites: string[]; windows: any }) => { stamps.push({ prefetchAt: performance.now(), prefetchSites: q.sites }); await s.data.prefetch!(q); } };
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] }, { intent: 120, plan: 160, narrative: 50 });
    const t0 = performance.now();
    const o = ok(await investigate(Q, { engine: "plain", data, chat }));
    const at = (step: string) => chat.requests.find((r) => r.step === step)!;
    assert.ok(at("plan").startedAt < at("intent").endedAt, "plan started before the intent finished");
    assert.ok(at("intent").startedAt < at("plan").endedAt, "the two calls overlapped");
    assert.equal(stamps.length, 1); assert.deepEqual(stamps[0].prefetchSites, ["S1", "S2", "S3"]);
    assert.ok(stamps[0].prefetchAt < at("intent").endedAt, "data work started before the intent answered");
    assert.ok(at("narrative").startedAt >= at("plan").endedAt - 1 && at("narrative").startedAt >= at("intent").endedAt - 1);
    assert.ok(performance.now() - t0 < 120 + 160 + 50 + 400, "intent and plan did not run one after the other");
    assert.equal(o.verification.mode, "llm");
  });
  it("a plan that arrives long after the data and the intent is not waited for: default emphasis, a note, and the narrative starts without it", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK({ hypotheses: ["H9"] })], narrative: [goodNarrative] }, { plan: 900 });
    const t0 = performance.now();
    const o = ok(await investigate(Q, { engine: "plain", data: scenario().data, chat, planGraceMs: 80 }));
    const narrativeStart = chat.requests.find((r) => r.step === "narrative")!.startedAt;
    const planEnd = chat.requests.find((r) => r.step === "plan")!.endedAt;
    assert.ok(planEnd === 0 || narrativeStart < planEnd, "the narrative did not wait for the plan");
    assert.ok(performance.now() - t0 < 880);
    assert.equal(o.plan.source, "default"); assert.deepEqual(o.plan.hypotheses.slice(0, 2), ["H1", "H2"]); assert.deepEqual(o.plan.extraSql, []);
    assert.ok(o.notes.some((n) => /plan: not back within 0.08 s of the data being ready/.test(n)));
    assert.equal(o.verification.mode, "llm");
  });
  it("evidence ids do not depend on timing: the same question gives the same E# for the same hypothesis", async () => {
    const a = ok(await run(Q, happy())), b = ok(await investigate(Q, { engine: "plain", data: scenario().data, chat: fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] }, { intent: 40, plan: 90 }) }));
    assert.deepEqual(a.evidence.map((e) => [e.id, e.hypothesisId, e.title]), b.evidence.map((e) => [e.id, e.hypothesisId, e.title]));
  });
  it("a scope that differs from the text-based guess redoes the data work and says so", async () => {
    const s = scenario();
    const events: ProgressEvent[] = [];
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["everything"] })], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = ok(await investigate("Compare Brixton with everything else", { engine: "plain", data: s.data, chat, onEvent: (e) => events.push(e) }));
    assert.equal(o.scope.label, "ALL");
    assert.deepEqual(s.prefetchCalls, [["S2"], ["S1", "S2", "S3"]]);
    assert.ok(o.notes.some((n) => /scope changed from S2 to ALL/.test(n)));
    const reset = events.findIndex((e) => e.type === "reset");
    assert.ok(reset >= 0);
    assert.ok(events.slice(reset).some((e) => e.type === "evidence"), "evidence is announced again after the reset");
  });
});

describe("investigate: progress events", () => {
  it("announces steps, evidence, hypotheses, LLM routes and completion, in a sensible order", async () => {
    const events: ProgressEvent[] = [];
    const o = ok(await run(Q, happy(), { onEvent: (e) => events.push(e) }));
    const steps = events.filter((e) => e.type === "step") as Extract<ProgressEvent, { type: "step" }>[];
    for (const name of ["sites", "intent", "plan", "data", "hypotheses", "recommend", "extraSql", "facts", "narrative"]) {
      const started = steps.findIndex((e) => e.step === name && e.status === "started"), finished = steps.findIndex((e) => e.step === name && e.status === "finished");
      assert.ok(started >= 0 && finished > started, name);
      assert.equal(typeof steps[finished].ms, "number");
    }
    const ev = events.filter((e) => e.type === "evidence") as Extract<ProgressEvent, { type: "evidence" }>[];
    assert.deepEqual(ev.map((e) => e.evidence.id), o.evidence.map((e) => e.id));
    assert.ok(ev[0].evidence.rowCount > 0 && ev[0].evidence.sources.length > 0 && ev[0].evidence.title.length > 0);
    const hyp = events.filter((e) => e.type === "hypothesis") as Extract<ProgressEvent, { type: "hypothesis" }>[];
    assert.deepEqual(hyp.map((e) => e.id), o.results.map((r) => r.id)); assert.equal(hyp.length, 11);
    const llm = events.filter((e) => e.type === "llm") as Extract<ProgressEvent, { type: "llm" }>[];
    assert.deepEqual(sorted(llm.map((e) => e.call.step)), sorted(stepsOf(o)));
    assert.ok(llm.every((e) => e.call.route && e.call.route.routedModel === "mock/model-x"));
    assert.equal(events.at(-1)!.type, "done");
    assert.equal((events.at(-1) as { totalMs: number }).totalMs, o.timings.total);
    const narrativeStart = events.findIndex((e) => e.type === "step" && e.step === "narrative" && e.status === "started");
    assert.ok(events.findIndex((e) => e.type === "step" && e.step === "facts" && e.status === "finished") < narrativeStart);
    assert.ok(events.slice(narrativeStart).filter((e) => e.type === "llm").length >= 1);
  });
  it("a listener that throws does not break the investigation; onProgress receives the step names", async () => {
    const names: string[] = [];
    const o = ok(await run(Q, happy(), { onEvent: () => { throw new Error("ui crashed"); }, onProgress: (n) => names.push(n) }));
    assert.equal(o.verification.mode, "llm");
    assert.ok(names.includes("intent") && names.includes("narrative") && names.includes("hypotheses"));
  });
  it("a clarification emits its events too but no done event", async () => {
    const events: ProgressEvent[] = [];
    const o = await investigate("Why did Peckham use more electricity?", { engine: "plain", data: scenario().data, chat: fakeChat({ intent: [INTENT_OK({ sites: ["Peckham"] })], plan: [PLAN_OK()] }), onEvent: (e) => events.push(e) });
    assert.ok(isClarification(o));
    assert.ok(events.some((e) => e.type === "step" && e.step === "intent" && e.status === "finished"));
    assert.ok(!events.some((e) => e.type === "done"));
  });
});

describe("investigate: placeholder repairs and verification retries", () => {
  it("a figure written as digits that spells a fact's display is repaired into the placeholder", async () => {
    const withDigits = (req: ChatRequest): string => {
      const L = factLines(req);
      const n = JSON.parse(goodNarrative(req));
      const disp = (s: string) => L.find((l) => l.label.startsWith(s))!.display;
      n.sentences[1].text = `Colder weather added ${disp("Weather part of the volume effect")} (${ph(L, "Weather part as a share")} of the change).`;
      return JSON.stringify(n);
    };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [withDigits] })));
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 1);
    assert.equal(o.verification.repairs.length, 1); assert.match(o.verification.repairs[0], /^sentences\[1\]: "£[\d,.]+" -> \{F\d+\}$/);
    assert.match(o.answer.sentences[1].text, /^Colder weather added £[\d,.]+ \(\d+\.\d% of the change\)\.$/);
  });
  it("a sentence that cites a fact of a ruled-out hypothesis is dropped and noted; the rest verifies on the first attempt", async () => {
    const citing = (req: ChatRequest): string => {
      const L = factLines(req);
      const n = JSON.parse(goodNarrative(req));
      n.sentences.push({ text: `Timing shifts added ${ph(L, "Timing effect T:")} as well.` });
      return JSON.stringify(n);
    };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [citing] })));
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "llm");
    assert.equal(o.answer.sentences.length, 2);
    assert.ok(o.verification.repairs.some((r) => /sentences\[2\] dropped: it cites F\d+, a fact of H5, which is ruled_out/.test(r)));
  });
  it("a ruled-out item for a hypothesis that is not ruled out is dropped", async () => {
    const wrong = (req: ChatRequest): string => {
      const L = factLines(req);
      const n = JSON.parse(goodNarrative(req));
      n.ruledOut.push({ hypothesis: "H3", text: `Weather is ruled out at ${ph(L, "Weather part as a share")}.` });
      return JSON.stringify(n);
    };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [wrong] })));
    assert.deepEqual(o.answer.ruledOut.map((r) => r.hypothesis), ["H5"]);
    assert.ok(o.verification.repairs.some((r) => /ruledOut\[1\] dropped: H3 is supported, not ruled_out/.test(r)));
  });
  it("digits that match no fact are rejected with a message, then a corrected placeholder answer passes (attempts 2, mode llm)", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [badNarrative, goodNarrative] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 2);
    assert.deepEqual(stepsOf(o).filter((s) => s.startsWith("narrative")), ["narrative", "narrative (correction 1)"]);
    assert.equal(o.verification.history.length, 1); assert.equal(o.verification.history[0].attempt, 1);
    assert.match(o.verification.history[0].errors[0], /sentences\[1\]: digits written outside placeholders \("£999\.99"\)/);
    const narrativeCalls = chat.requests.filter((r) => r.step === "narrative");
    const corrective = narrativeCalls[1].req.messages;
    assert.match(String(corrective.at(-1)!.content), /Your answer was rejected for these reasons/);
    assert.match(String(corrective.at(-1)!.content), /£999\.99/);
    assert.match(String(corrective.at(-2)!.content), /£999\.99/);                  // the model sees its own previous answer
    assert.equal(corrective[0].role, "system");                                    // and the original instructions
    assert.ok(!o.answer.sentences[1].text.includes("999.99"));
  });
  it("two corrections are allowed; the third failure falls back to the template", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [badNarrative] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.attempts, 3);
    assert.deepEqual(stepsOf(o).filter((s) => s.startsWith("narrative")), ["narrative", "narrative (correction 1)", "narrative (correction 2)"]);
    assert.ok(o.verification.errors.some((e) => /£999\.99/.test(e)), "the model's last errors are kept");
    assert.deepEqual(o.verification.history.map((h) => h.attempt), [1, 2, 3]);
    assert.equal(o.verification.passed, true, "the template itself verifies");
    assert.ok(!o.answer.sentences.some((s) => s.text.includes("999.99")));
    assert.ok(o.answer.headline.length > 0 && o.answer.sentences.length >= 2);
  });
  it("maxCorrections limits the attempts", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [badNarrative] });
    const o = ok(await run(Q, chat, { maxCorrections: 0 }));
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "template");
    assert.equal(chat.requests.filter((r) => r.step === "narrative").length, 1);
  });
  it("unknown placeholders are rejected", async () => {
    const unknown = (req: ChatRequest): string => { const n = JSON.parse(goodNarrative(req)); n.sentences[1].text = "Colder weather added {F9999} of the change."; return JSON.stringify(n); };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [unknown, goodNarrative] })));
    assert.match(o.verification.history[0].errors[0], /placeholder \{F9999\} does not exist/);
    assert.equal(o.verification.attempts, 2);
  });
  it("a narrative that names a ruled-out cause in its words is rejected by the verifier, and the correction can fix it", async () => {
    const naming = (req: ChatRequest) => { const n = JSON.parse(goodNarrative(req)); n.sentences[1].text += " The bill also rose because of timing shifts."; return JSON.stringify(n); };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [naming, goodNarrative] })));
    assert.equal(o.verification.attempts, 2); assert.equal(o.verification.mode, "llm");
    assert.match(o.verification.history[0].errors[0], /presents H5 \(timing_shift\) as a cause/);
  });
  it("a sentence that names a non-supported cause is left out instead of costing a correction round trip", async () => {
    const naming = (req: ChatRequest) => { const n = JSON.parse(goodNarrative(req)); n.sentences.push({ text: `The bill also rose because of timing shifts, ${ph(factLines(req), "Change in the bill, window")}.` }); return JSON.stringify(n); };
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [naming] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "llm");
    assert.equal(chat.requests.filter((r) => r.step === "narrative").length, 1);
    assert.equal(o.answer.sentences.length, 2);
    assert.ok(o.verification.repairs.some((r) => /^sentences\[2\] dropped: presents H5 \(timing_shift\) as a cause/.test(r)));
  });
  it("a time range written in digits is kept and the fact that contains it is cited", async () => {
    const withTime = (req: ChatRequest) => {
      const L = factLines(req), block = L.find((l) => l.label.startsWith("Load shift: cheapest same-day block"))!.display;
      const n = JSON.parse(goodNarrative(req));
      n.recommendation.text = `Move load to ${block}; as a historical counterfactual, the flat tariff would have cost ${ph(L, "Flat tariff minus Agile in window B")} more.`;
      return JSON.stringify(n);
    };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [withTime] })));
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "llm");
    assert.match(o.answer.recommendation.text, /^Move load to \d\d:\d\d-\d\d:\d\d;/);
    assert.ok(o.answer.recommendation.facts.includes(o.facts.find((f) => f.key === "rec_blocks")!.id));
  });
  it("a quick rate-limit error on the narrative is retried once and the answer is still verified by the model", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("meterless HTTP 502: gone; the alongside NVIDIA call failed too: nvidia HTTP 429: Too Many Requests"), goodNarrative] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 1);
    assert.equal(chat.requests.filter((r) => r.step === "narrative").length, 2);
    assert.ok(o.llmCalls.some((c) => c.error && /429/.test(c.error)) && o.llmCalls.some((c) => /^narrative \(retry after/.test(c.step)));
  });
  it("when the narrative call fails outright (Meterless timed out and the alongside call was rate limited), one direct retry to the labelled route follows", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("meterless timeout after 25s; the alongside NVIDIA call failed too: nvidia HTTP 429: Too Many Requests"), goodNarrative] });
    const o = ok(await run(Q, chat));
    const calls = chat.requests.filter((r) => r.step === "narrative");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].req.direct, undefined); assert.equal(calls[1].req.direct, "the first narrative call failed: meterless timeout after 25s; the alongside NVIDIA call failed too: nvidia HTTP 429: Too Many Requests");
    assert.equal(calls[1].req.hedgeAfterMs, undefined);
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 1);
    assert.ok(o.llmCalls.some((c) => c.step === "narrative (direct retry)" && c.route));
  });
  it("the direct retry happens once: two failures end in the template", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("meterless timeout after 25s")] });
    const o = ok(await run(Q, chat));
    assert.equal(chat.requests.filter((r) => r.step === "narrative").length, 2);
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.passed, true);
  });
  it("an unparsable narrative gets one stricter retry inside the same attempt", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: ["Here is my answer: the bill rose.", goodNarrative] });
    const o = ok(await run(Q, chat));
    assert.deepEqual(stepsOf(o).filter((s) => s.startsWith("narrative")), ["narrative", "narrative (stricter retry)"]);
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "llm");
  });
  it("a narrative that is never parsable ends in the template", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: ["no json at all"] })));
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.passed, true);
    assert.ok(o.verification.errors[0].includes("narrative"));
  });
  it("the template narrative verifies and cites facts and evidence on every sentence", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [badNarrative] })));
    const ev = new Set(o.evidence.map((e) => e.id));
    const v = verifyAnswer(o.answer, { facts: o.facts, evidenceIds: ev, hypotheses: o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })), requireRecommendation: true });
    assert.deepEqual(v.errors, []);
    assert.match(o.answer.recommendation.text, /historical counterfactual/);
    assert.match(o.answer.sentences[0].text, /^Your electricity bill rose by £[\d,.]+ \(\d+\.\d%\)/);
  });
});

describe("investigate: every LLM step failing still gives an answer", () => {
  it("intent, plan and narrative all failing at the transport level: keyword intent, default order, template", async () => {
    const boom = new Error("meterless unavailable");
    const chat = fakeChat({ intent: [boom], plan: [boom], narrative: [boom] });
    const o = ok(await run(Q, chat));
    assert.equal(o.intent.source, "fallback"); assert.equal(o.intent.type, "why_cost_change");
    assert.equal(o.plan.source, "default");
    assert.equal(o.results.length, 11);
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 1);
    assert.deepEqual(sorted(o.llmCalls.map((c) => `${c.step}:${c.error}`)), ["intent:meterless unavailable", "narrative:meterless unavailable", "plan:meterless unavailable"]);
    assert.ok(o.notes.some((n) => /keyword rules used/.test(n)) && o.notes.some((n) => /default emphasis used/.test(n)));
    assert.equal(chat.requests.length, 3, "transport errors are not retried");
  });
  it("keyword intent routing for emissions and savings when the model is down", async () => {
    const boom = new Error("down");
    const e = ok(await run("Why were our emissions higher?", fakeChat({ intent: [boom], plan: [boom], narrative: [boom] })));
    assert.equal(e.intent.type, "why_emissions");
    assert.match(e.answer.sentences[0].text, /^Emissions rose by/);
    const w = ok(await run("What should we change to save money?", fakeChat({ intent: [boom], plan: [boom], narrative: [boom] })));
    assert.equal(w.intent.type, "what_to_change");
    assert.ok(w.answer.recommendation.text.length > 0 && w.answer.sentences.length <= 3);
  });
  it("an intent reply that is unusable twice falls back to keywords but the other steps still use the model", async () => {
    const o = ok(await run(Q, fakeChat({ intent: ["blah", "blah again"], plan: [PLAN_OK()], narrative: [goodNarrative] })));
    assert.equal(o.intent.source, "fallback"); assert.equal(o.plan.source, "llm"); assert.equal(o.verification.mode, "llm");
    assert.ok(stepsOf(o).includes("intent") && stepsOf(o).includes("intent (stricter retry)"));
  });
});

describe("investigate: entity resolution", () => {
  it("Brixton resolves to S2 and the scope, facts and prompt follow", async () => {
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], narrative: [badNarrative] });
    const o = ok(await run("Why did Brixton use more electricity?", chat, { maxCorrections: 0 }));
    assert.equal(o.scope.label, "S2"); assert.deepEqual(o.scope.sites, [{ id: "S2", name: SITE_NAMES.S2 }]);
    assert.equal(o.facts.find((f) => f.key === "sites")!.display, "S2 (Crumb & Co Brixton)");
    assert.ok(o.facts.some((f) => f.key === "event_1"), "the S2 oven event is in scope");
    assert.match(String(chat.requests.find((r) => r.step === "narrative")!.req.messages[1].content), /^Question: Why did Brixton use more electricity\?\nScope: S2 Crumb & Co Brixton/);
  });
  it("the question's own site mention counts when the model forgot it; 'site 3' works too; a site named in the question is not rerun after the intent", async () => {
    const s = scenario();
    const a = ok(await investigate("Why did Brixton use more electricity?", { engine: "plain", data: s.data, chat: fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("x")] }) }));
    assert.equal(a.scope.label, "S2");
    assert.deepEqual(s.prefetchCalls, [["S2"]], "the speculative scope was right, so the data work ran once");
    const b = ok(await run("Why did site 3 use more electricity?", fakeChat({ intent: [INTENT_OK({ sites: ["site 3"] })], plan: [PLAN_OK()], narrative: [new Error("x")] })));
    assert.equal(b.scope.label, "S3");
  });
  it("two sites give a combined scope", async () => {
    const o = ok(await run("Why did Brixton and Hampstead use more?", fakeChat({ intent: [INTENT_OK({ sites: ["Brixton", "Hampstead"] })], plan: [PLAN_OK()], narrative: [new Error("x")] })));
    assert.equal(o.scope.label, "S2+S3");
  });
  it("ALL and no site both mean every site", async () => {
    for (const sites of [["ALL"], ["all sites"], []]) assert.equal(ok(await run(Q, fakeChat({ intent: [INTENT_OK({ sites })], plan: [PLAN_OK()], narrative: [new Error("x")] }))).scope.label, "ALL");
  });
  it("an unknown site in the question gives a clarification and no narrative call", async () => {
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Peckham"] })], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = await run("Why did Peckham use more electricity?", chat);
    assert.ok(isClarification(o));
    if (isClarification(o)) {
      assert.match(o.clarification, /could not find a site called "Peckham"/);
      assert.match(o.clarification, /S1 \(Crumb & Co Shoreditch\), S2 \(Crumb & Co Brixton\), S3 \(Crumb & Co Hampstead\)/);
      assert.deepEqual(o.knownSites.map((s) => s.id), ["S1", "S2", "S3"]);
      assert.ok(o.llmCalls.some((c) => c.step === "intent"));
    }
    assert.ok(!chat.requests.some((r) => r.step === "narrative"));
  });
  it("'site 9' in the question is a clarification even when the model rewrites it as S9; it is never widened to all sites", async () => {
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["S9"] })], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = await run("Why did site 9 use more electricity?", chat);
    assert.ok(isClarification(o));
    if (isClarification(o)) assert.match(o.clarification, /could not find "site 9".*S1 \(Crumb & Co Shoreditch\)/);
    assert.ok(!chat.requests.some((r) => r.step === "narrative"));
  });
  it("a site the model invented (not in the question) is ignored, not turned into a clarification", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK({ sites: ["S9"] })], plan: [PLAN_OK()], narrative: [new Error("x")] })));
    assert.equal(o.scope.label, "ALL");
    assert.ok(o.notes.some((n) => /ignored site "S9"/.test(n)));
  });
  it("opts.site restricts the scope and overrides the question; an unknown opts.site is a clarification", async () => {
    const a = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("x")] }), { site: "S2" }));
    assert.equal(a.scope.label, "S2");
    const b = ok(await run("Why did Brixton use more?", fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], narrative: [new Error("x")] }), { site: "S3" }));
    assert.equal(b.scope.label, "S3");
    const c = await run(Q, fakeChat({ intent: [INTENT_OK()] }), { site: "S9" });
    assert.ok(isClarification(c));
  });
  it("a date outside the data range is a clarification; a date inside is passed to the narrative as the focus", async () => {
    const c = await run("Why did Brixton spike on 2026-12-25?", fakeChat({ intent: [INTENT_OK({ type: "why_spike_day", sites: ["Brixton"], dates: ["2026-12-25"] })] }));
    assert.ok(isClarification(c));
    if (isClarification(c)) assert.match(c.clarification, /only have meter data from 2026-08-27 to 2026-10-21/);
    const chat = fakeChat({ intent: [INTENT_OK({ type: "why_spike_day", sites: ["Brixton"], dates: ["2026-10-10"] })], plan: [PLAN_OK({ hypotheses: ["H3"] })], narrative: [new Error("x")] });
    const o = ok(await run("Why did Brixton spike on 2026-10-10?", chat));
    assert.equal(o.intent.type, "why_spike_day"); assert.deepEqual(o.intent.dates, ["2026-10-10"]);
    assert.match(String(chat.requests.find((r) => r.step === "narrative")!.req.messages[1].content), /The owner asked about: 2026-10-10\./);
    assert.ok(o.results.some((r) => r.id === "H6") && o.results.some((r) => r.id === "H11"), "spike questions are answered with the one-off and unusual-day tests, which always run");
  });
});

describe("investigate: the plan orders the tests", () => {
  it("every catalog hypothesis runs; the plan's ids come first in the model's order, unknown ids are dropped and logged", async () => {
    const plan = PLAN_OK({ hypotheses: ["H3", "h1", "H99", "H3", "H5", "weather"] });
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [plan], narrative: [new Error("x")] })));
    assert.deepEqual(o.plan.hypotheses.slice(0, 3), ["H3", "H1", "H5"]);
    assert.equal(o.plan.hypotheses.length, 11);
    assert.deepEqual(o.plan.added, ["H2", "H4", "H6", "H7", "H8", "H9", "H10", "H11"]);
    assert.deepEqual(o.plan.dropped, ["H99", "WEATHER"]);
    assert.ok(o.notes.some((n) => /dropped ids outside the catalog: H99, WEATHER/.test(n)));
    assert.deepEqual(sorted(o.results.map((r) => r.id)), sorted(["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11"]));
    assert.equal(o.plan.source, "llm");
  });
  it("evidence numbering follows the fixed catalog order, not the plan", async () => {
    const a = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK({ hypotheses: ["H9", "H1"] })], narrative: [new Error("x")] })));
    const b = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK({ hypotheses: ["H1", "H9"] })], narrative: [new Error("x")] })));
    assert.deepEqual(a.evidence.map((e) => e.hypothesisId), b.evidence.map((e) => e.hypothesisId));
  });
  it("facts exist for every hypothesis, including ones the plan did not mention", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK({ hypotheses: ["H1"] })], narrative: [new Error("x")] })));
    assert.ok(o.facts.some((f) => f.key === "price_peak_A")); assert.ok(o.facts.some((f) => f.key === "hdd_A")); assert.ok(o.facts.some((f) => f.key === "wind_A")); assert.ok(o.facts.some((f) => f.key === "emissions_A"));
  });
  it("extra SQL: at most one, through the guard; a good one becomes evidence and facts", async () => {
    const ran: string[] = [];
    const zsql = async (sql: string) => { ran.push(sql); return { ok: true, status: 200, runId: "run-extra-1", body: { headers: ["n_rows", "avg_kwh"], data: [[1344, 0.81]] } }; };
    const plan = PLAN_OK({ extraSql: [
      { purpose: "average load of S2", sql: "SELECT COUNT(*) AS n_rows, AVG(kwh) AS avg_kwh FROM kilowhy.meter_hh WHERE site_id = 'S2'" },
      { purpose: "second query is ignored", sql: "SELECT 1 FROM kilowhy.sites" },
    ] });
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [plan], narrative: [new Error("x")] }), { zsql }));
    assert.deepEqual(o.plan.extraSql.map((x) => x.status), ["ran"]);
    assert.equal(ran.length, 1); assert.match(ran[0], /LIMIT 5000$/);
    const ev = o.evidence.find((e) => e.id === o.plan.extraSql[0].evidence)!;
    assert.equal(ev.hypothesisId, "EXTRA"); assert.equal(ev.zetarisRunId, "run-extra-1"); assert.equal(ev.rowCount, 1); assert.deepEqual(ev.sources, [{ view: "meter_hh", kind: "FILE: sample" }]);
    assert.equal(ev.id, `E${o.evidence.length}`, "the extra query is numbered after the deterministic evidence");
    assert.ok(o.facts.some((f) => f.key === "extra_1_avg_kwh" && f.evidence === ev.id));
  });
  it("a query the guard rejects is logged, not run", async () => {
    const ran: string[] = [];
    const zsql = async (sql: string) => { ran.push(sql); return { ok: true, status: 200, runId: "r", body: { headers: [], data: [] } }; };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK({ extraSql: [{ purpose: "drop everything", sql: "DROP TABLE kilowhy.meter_hh" }] })], narrative: [new Error("x")] }), { zsql }));
    assert.equal(o.plan.extraSql[0].status, "rejected"); assert.match(o.plan.extraSql[0].reason!, /only SELECT or WITH|forbidden keyword/);
    assert.equal(ran.length, 0);
  });
  it("an extra query that fails in Zetaris is recorded and does not stop the investigation", async () => {
    const zsql = async () => ({ ok: false, status: 500, runId: "r", body: { message: "boom" } });
    const plan = PLAN_OK({ extraSql: [{ purpose: "p", sql: "SELECT 1 FROM kilowhy.sites" }] });
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [plan], narrative: [new Error("x")] }), { zsql }));
    assert.equal(o.plan.extraSql[0].status, "failed"); assert.match(o.plan.extraSql[0].reason!, /Zetaris HTTP 500/);
    assert.equal(o.verification.passed, true);
  });
  it("without a SQL runner, extra SQL is recorded as failed", async () => {
    const plan = PLAN_OK({ extraSql: [{ purpose: "p", sql: "SELECT 1 FROM kilowhy.sites" }] });
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [plan], narrative: [new Error("x")] })));
    assert.equal(o.plan.extraSql[0].status, "failed"); assert.match(o.plan.extraSql[0].reason!, /no SQL runner/);
  });
});

describe("template narrative", () => {
  const prepare = async (type: Parameters<typeof templateAnswer>[2], over: Parameters<typeof scenario>[0] = {}) => {
    const o = ok(await investigate("q", { engine: "plain", data: scenario(over).data, chat: fakeChat({ intent: [INTENT_OK({ type })], plan: [PLAN_OK()], narrative: [new Error("x")] }) }));
    const hyps = o.results.map((r) => ({ id: r.id, name: r.name, status: r.status }));
    const check = (a: ReturnType<typeof templateAnswer>) => verifyAnswer(a, { facts: o.facts, evidenceIds: o.evidence.map((e) => e.id), hypotheses: hyps, requireRecommendation: true }).errors;
    return { o, hyps, check };
  };
  it("verifies for every question type", async () => {
    for (const type of ["why_cost_change", "why_spike_day", "why_emissions", "what_to_change"] as const) {
      const { o, hyps, check } = await prepare(type);
      assert.deepEqual(check(templateAnswer(o.facts, hyps, type)), [], type);
    }
  });
  it("a bill that fell is described as falling, with magnitudes of the negative numbers", async () => {
    const { o, hyps, check } = await prepare("why_cost_change", { price: (w, day, slot) => (slot >= 32 && slot < 38 ? (w === "B" ? 25 : 35) : slot < 14 ? 12 : 22) + (day % 5), temp: () => 11, kwh: () => 1 });
    const a = templateAnswer(o.facts, hyps, "why_cost_change");
    assert.match(a.sentences[0].text, /^Your electricity bill fell by £[\d,.]+ \(\d+\.\d%\)/);
    assert.match(a.headline, /^Your electricity bill fell by £/);
    assert.deepEqual(check(a), []);
  });
  it("when no cause is supported it says so and still verifies", async () => {
    const { o, hyps, check } = await prepare("why_cost_change", { price: () => 20, temp: () => 11, kwh: (_s, w) => (w === "B" ? 1.002 : 1) });
    const a = templateAnswer(o.facts, hyps, "why_cost_change");
    assert.ok(a.sentences.length >= 1);
    assert.deepEqual(check(a), []);
  });
  it("a ruled-out timing shift still mentions a daily-pattern move that matches a logged event", async () => {
    // S2 moves its evening load later from the day of the logged oven event, but prices are flat, so the cost effect T is nil
    const { o, hyps, check } = await prepare("why_cost_change", { price: () => 20, temp: () => 11, kwh: (s, w, day, slot) => (s === "S2" && w === "B" && day >= 13 ? (slot >= 20 && slot < 34 ? 2.4 : 0.6) : slot >= 12 && slot < 26 ? 1.2 : 0.6) });
    const a = templateAnswer(o.facts, hyps, "why_cost_change");
    const h5 = a.ruledOut.find((r) => r.hypothesis === "H5");
    assert.ok(h5, "H5 is ruled out");
    assert.match(h5!.text, /The daily pattern at S2 did move: its \w+ share changed by [\d.]+ pp from 2026-10-07\./);
    assert.match(h5!.text, /matches a logged event: SAMPLE: Oven schedule moved/);
    assert.match(h5!.text, /did not change the bill materially\.$/);
    assert.deepEqual(check(a), []);
  });
  it("an emissions answer leads with emissions and keeps cost effects out", async () => {
    const { o, hyps } = await prepare("why_emissions");
    const a = templateAnswer(o.facts, hyps, "why_emissions");
    assert.match(a.sentences[0].text, /^Emissions rose by .* kgCO2e/);
    assert.ok(!a.sentences.some((s) => /£/.test(s.text)));
    assert.ok(a.ruledOut.every((r) => ["H10", "H7", "H9"].includes(r.hypothesis)));
  });
  it("the logged event appears next to the operational cause when its step is significant", async () => {
    const { o, hyps } = await prepare("why_cost_change", { kwh: (s, w, day, slot) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (s === "S2" && w === "B" && day >= 11 ? 2.5 : 0) });
    const a = templateAnswer(o.facts, hyps, "why_cost_change");
    const op = a.sentences.find((s) => /A logged event at S2/.test(s.text));
    assert.ok(op, a.sentences.map((s) => s.text).join(" | "));
    assert.match(op!.text, /Oven schedule moved 2h later/);
  });
});

describe("normalizeAnswer", () => {
  it("sorts and dedupes ids, drops unknown facts, adds the evidence of the cited facts, canonicalises the ruled-out hypothesis id", () => {
    const facts = [{ id: "F2", key: "a", label: "a", value: 1, unit: "count", display: "1", evidence: "E4" }, { id: "F10", key: "b", label: "b", value: 2, unit: "count", display: "2", evidence: "E2" }];
    const a = normalizeAnswer({
      headline: "  The   bill ", sentences: [{ text: " x\n y ", facts: ["F10", "F2", "F2", "F77"], evidence: ["E9", "E9"] }],
      ruledOut: [{ hypothesis: "timing shift", text: "t", facts: ["F2"], evidence: [] }], recommendation: { text: "", facts: [], evidence: [] },
    }, facts, [{ id: "H5", name: "timing_shift", status: "ruled_out" }]);
    assert.equal(a.headline, "The bill");
    assert.deepEqual(a.sentences[0], { text: "x y", facts: ["F2", "F10"], evidence: ["E2", "E4", "E9"] });
    assert.equal(a.ruledOut[0].hypothesis, "H5"); assert.deepEqual(a.ruledOut[0].evidence, ["E4"]);
  });
});

describe("rendering", () => {
  it("prints the answer with [E#] markers, the ruled-out list, the recommendation, verification and the routes", async () => {
    const o = await run(Q, happy());
    const text = renderOutcome(o);
    assert.match(text, /SAMPLE data/);
    assert.match(text, /^1\. Your bill rose by £[\d,.]+ .* \[E1\]/m);
    assert.match(text, /Ruled out:\n {2}- H5: Timing is ruled out/);
    assert.match(text, /Recommendation:\n/);
    assert.match(text, /Verification: PASSED, mode llm, 1 narrative attempt\(s\)/);
    assert.match(text, /intent: mock\/model-x \(Mock model\) via meterless, 0\.0 s, race of 6/);
    assert.match(text, /Timings \(ms\): total \d+/);
  });
  it("a clarification renders as a question; a template run says so", async () => {
    const c = await run("Why did Peckham use more?", fakeChat({ intent: [INTENT_OK({ sites: ["Peckham"] })] }));
    assert.match(renderOutcome(c), /I need one more detail: I could not find a site called "Peckham"/);
    const t = await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("rate limited")] }));
    assert.match(renderOutcome(t), /Verification: PASSED, mode template.*model attempts failed with: narrative: rate limited/);
    assert.match(renderOutcome(t), /narrative: FAILED rate limited/);
  });
  it("routeLine shows a fallback and the wall time of the call; wrap indents continuation lines", () => {
    const route = { provider: "nvidia-direct" as const, requestedModel: "m", routedModel: "nvidia/x", label: "NVIDIA direct", kind: "cloud", tier: null, latencyMs: 56700, receiptId: null, raceWidth: 1, usage: { inputTokens: null, outputTokens: null, totalTokens: null, outputTps: null, routerLatencyMs: null }, fallbackReason: "meterless timeout after 45s" };
    assert.match(routeLine({ step: "narrative", route }), /^narrative: nvidia\/x \(NVIDIA direct\) via nvidia-direct, 56\.7 s, race of 1 \[fallback: meterless timeout after 45s\]$/);
    assert.match(routeLine({ step: "narrative", route, wallMs: 101_300 }), /via nvidia-direct, 56\.7 s \(101\.3 s wall\), race of 1/);
    assert.equal(wrap("aaa bbb ccc", 7, "  "), "aaa bbb\n  ccc");
  });
});

describe("factLines helper", () => {
  it("parses the facts table out of the narrative prompt", async () => {
    const chat = happy();
    const o = ok(await run(Q, chat));
    const lines = factLines(chat.requests.find((r) => r.step === "narrative")!.req);
    assert.ok(lines.length > 20 && lines.length < o.facts.length);
    const byId = new Map(o.facts.map((f) => [f.id, f]));
    for (const l of lines) { assert.equal(byId.get(l.id)!.display, l.display); assert.equal(byId.get(l.id)!.label, l.label); }
  });
});
