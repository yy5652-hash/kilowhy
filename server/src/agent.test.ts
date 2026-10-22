// Agent loop tests with a scripted fake LLM and the synthetic data layer: no network, no Zetaris, no Nightshift.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { investigate, normalizeAnswer } from "./agent.ts";
import { isClarification, type InvestigationResult } from "./agent_types.ts";
import { renderOutcome, routeLine, wrap } from "./agent_render.ts";
import { templateAnswer } from "./agent_template.ts";
import { verifyAnswer } from "./verifier.ts";
import { scenario, fakeChat, goodNarrative, factLines, INTENT_OK, PLAN_OK, SITE_NAMES } from "./agent_testkit.ts";
import type { ChatRequest } from "./provider_shared.ts";

const Q = "Why did our electricity cost more in the last four weeks than the four weeks before?";
const run = async (q: string, chat: ReturnType<typeof fakeChat>, extra: Parameters<typeof investigate>[1] = {}) => investigate(q, { data: scenario().data, chat, ...extra });
const ok = (o: Awaited<ReturnType<typeof investigate>>): InvestigationResult => { assert.ok(!isClarification(o), "expected an investigation, got a clarification"); return o as InvestigationResult; };

const badNarrative = (req: ChatRequest): string => {
  const n = JSON.parse(goodNarrative(req));
  n.sentences[1].text = "Colder weather added £999.99 (65.4% of the change).";
  return JSON.stringify(n);
};
const stepsOf = (o: InvestigationResult) => o.llmCalls.map((c) => c.step);

describe("investigate: a verified LLM answer", () => {
  it("runs the steps in order and returns a verified narrative on the first attempt", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 1); assert.deepEqual(o.verification.errors, []);
    assert.deepEqual(stepsOf(o), ["intent", "plan", "narrative"]);
    assert.equal(o.intent.type, "why_cost_change"); assert.equal(o.intent.source, "llm");
    assert.equal(o.scope.label, "ALL"); assert.deepEqual(o.scope.sites.map((s) => s.id), ["S1", "S2", "S3"]);
    assert.ok(o.answer.sentences.length >= 2 && o.answer.headline.startsWith("Your bill rose by"));
    assert.equal(o.answer.ruledOut[0].hypothesis, "H5");
    assert.equal(o.sampleDataNote.includes("SAMPLE"), true);
  });
  it("the result has every field of the spec", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] })));
    for (const k of ["question", "intent", "scope", "decomposition", "plan", "results", "evidence", "facts", "answer", "verification", "llmCalls", "timings"]) assert.ok(k in o, k);
    assert.ok(o.decomposition.ok && o.decomposition.result);
    assert.ok(!("windowA" in o.decomposition) && !("aligned" in o.decomposition), "per-slot arrays stay out of the result");
    assert.equal(o.decomposition.slotsAligned, 1344); assert.equal(o.decomposition.slotsExpected, 1344);
    assert.ok(o.evidence.length > 10 && o.evidence.every((e) => /^E\d+$/.test(e.id)));
    assert.ok(o.facts.length > 40);
    for (const k of ["intent", "decomposition", "plan", "hypotheses", "recommend", "facts", "narrative", "total"]) assert.equal(typeof o.timings[k], "number", k);
    assert.ok(o.timings.total >= 0);
  });
  it("records the route of every LLM call (routed model, label, latency, race width, receipt)", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] })));
    for (const c of o.llmCalls) {
      assert.ok(c.route, c.step);
      assert.equal(c.route!.routedModel, "mock/model-x"); assert.equal(c.route!.label, "Mock model"); assert.equal(typeof c.route!.latencyMs, "number"); assert.equal(c.route!.raceWidth, 6); assert.equal(c.route!.receiptId, "rcpt_test");
    }
    assert.equal(o.llmCalls[0].route!.requestedModel, "meterless/auto");   // intent
    assert.equal(o.llmCalls[1].route!.requestedModel, "meterless/deep");   // plan
    assert.equal(o.llmCalls[2].route!.requestedModel, "meterless/deep");   // narrative
  });
  it("uses mode auto for the intent and deep for the plan and the narrative", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] });
    await run(Q, chat);
    assert.deepEqual(chat.requests.map((r) => [r.step, r.req.mode]), [["intent", "auto"], ["plan", "deep"], ["narrative", "deep"]]);
  });
  it("every sentence cites existing facts and evidence, and evidence includes the cited facts' own evidence", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] })));
    const byId = new Map(o.facts.map((f) => [f.id, f])), ev = new Set(o.evidence.map((e) => e.id));
    for (const s of [...o.answer.sentences, ...o.answer.ruledOut, o.answer.recommendation]) {
      assert.ok(s.facts.length >= 1 && s.evidence.length >= 1);
      for (const f of s.facts) { assert.ok(byId.has(f)); assert.ok(s.evidence.includes(byId.get(f)!.evidence)); }
      for (const e of s.evidence) assert.ok(ev.has(e));
    }
    assert.equal(verifyAnswer(o.answer, { facts: o.facts, evidenceIds: ev, hypotheses: o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })) }).passed, true);
  });
  it("what the model sees: the question, site names, statuses and the facts table; never SQL, tokens or secrets", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = ok(await run(Q, chat));
    const all = chat.requests.flatMap((r) => r.req.messages.map((m) => String(m.content))).join("\n");
    for (const e of o.evidence) assert.ok(!all.includes(e.sql), `evidence SQL of ${e.id} must not be sent`);
    for (const bad of ["Bearer", "proxy-token", "NVIDIA_API_KEY", "ZETARIS_API_KEY", "nvapi-", "sk-"]) assert.ok(!all.includes(bad), bad);
    const narrative = String(chat.requests[2].req.messages[0].content);
    assert.match(narrative, /H3 weather_volume \(Weather-driven volume\): supported/);
    assert.match(narrative, /H5 timing_shift .*: ruled_out/);
    assert.match(narrative, /^F9 \| - \| Change in the bill, window B minus window A \| £[\d,.]+ \| E1$/m);
    assert.match(String(chat.requests[2].req.messages[1].content), /Crumb & Co Brixton/);
    assert.match(String(chat.requests[0].req.messages[0].content), /S2 = Crumb & Co Brixton/);
  });
});

describe("investigate: verification retries and the template", () => {
  it("a bad narrative is rejected with its error list, then a corrected one passes (attempts 2, mode llm)", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [badNarrative, goodNarrative] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 2);
    assert.deepEqual(stepsOf(o), ["intent", "plan", "narrative", "narrative (correction 1)"]);
    assert.equal(o.verification.history.length, 1); assert.equal(o.verification.history[0].attempt, 1); assert.match(o.verification.history[0].errors[0], /£999\.99/);
    const corrective = chat.requests[3].req.messages;
    const last = String(corrective.at(-1)!.content);
    assert.match(last, /verifier rejected/);
    assert.match(last, /sentences\[1\]: the number "£999\.99" matches none of the cited facts/);
    assert.match(String(corrective.at(-2)!.content), /£999\.99/);                  // the model sees its own previous answer
    assert.equal(corrective[0].role, "system");                                    // and the original instructions
    assert.ok(o.answer.sentences[1].text.includes("£")); assert.ok(!o.answer.sentences[1].text.includes("999.99"));
  });
  it("two corrections are allowed; the third failure falls back to the template", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [badNarrative] });
    const o = ok(await run(Q, chat));
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.attempts, 3);
    assert.deepEqual(stepsOf(o), ["intent", "plan", "narrative", "narrative (correction 1)", "narrative (correction 2)"]);
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
  it("a narrative that names a ruled-out cause is rejected, and the correction can fix it", async () => {
    const naming = (req: ChatRequest) => { const n = JSON.parse(goodNarrative(req)); n.sentences[1].text += " The bill also rose because of timing shifts."; return JSON.stringify(n); };
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [naming, goodNarrative] })));
    assert.equal(o.verification.attempts, 2); assert.equal(o.verification.mode, "llm");
  });
  it("an unparsable narrative gets one stricter retry inside the same attempt", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: ["Here is my answer: the bill rose.", goodNarrative] });
    const o = ok(await run(Q, chat));
    assert.deepEqual(stepsOf(o), ["intent", "plan", "narrative", "narrative (stricter retry)"]);
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
  it("intent, plan and narrative all failing at the transport level: keyword intent, default plan, template", async () => {
    const boom = new Error("meterless unavailable");
    const chat = fakeChat({ intent: [boom], plan: [boom], narrative: [boom] });
    const o = ok(await run(Q, chat));
    assert.equal(o.intent.source, "fallback"); assert.equal(o.intent.type, "why_cost_change");
    assert.equal(o.plan.source, "default");
    assert.ok(o.plan.hypotheses.includes("H1") && o.plan.hypotheses.includes("H7"));
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 1);
    assert.deepEqual(o.llmCalls.map((c) => [c.step, c.error]), [["intent", "meterless unavailable"], ["plan", "meterless unavailable"], ["narrative", "meterless unavailable"]]);
    assert.ok(o.notes.some((n) => /keyword rules used/.test(n)) && o.notes.some((n) => /default plan used/.test(n)));
    assert.equal(chat.requests.length, 3, "transport errors are not retried");
  });
  it("keyword intent routing for emissions and savings when the model is down", async () => {
    const boom = new Error("down");
    const e = ok(await run("Why were our emissions higher?", fakeChat({ intent: [boom], plan: [boom], narrative: [boom] })));
    assert.equal(e.intent.type, "why_emissions"); assert.ok(e.plan.hypotheses.includes("H10"));
    assert.match(e.answer.sentences[0].text, /^Emissions rose by/);
    const w = ok(await run("What should we change to save money?", fakeChat({ intent: [boom], plan: [boom], narrative: [boom] })));
    assert.equal(w.intent.type, "what_to_change");
    assert.ok(w.answer.recommendation.text.length > 0 && w.answer.sentences.length <= 3);
  });
  it("an intent reply that is unusable twice falls back to keywords but the other steps still use the model", async () => {
    const o = ok(await run(Q, fakeChat({ intent: ["blah", "blah again"], plan: [PLAN_OK()], narrative: [goodNarrative] })));
    assert.equal(o.intent.source, "fallback"); assert.equal(o.plan.source, "llm"); assert.equal(o.verification.mode, "llm");
    assert.deepEqual(stepsOf(o).slice(0, 3), ["intent", "intent (stricter retry)", "plan"]);
  });
});

describe("investigate: entity resolution", () => {
  it("Brixton resolves to S2 and the scope, facts and prompt follow", async () => {
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], narrative: [badNarrative] });
    const o = ok(await run("Why did Brixton use more electricity?", chat, { maxCorrections: 0 }));
    assert.equal(o.scope.label, "S2"); assert.deepEqual(o.scope.sites, [{ id: "S2", name: SITE_NAMES.S2 }]);
    assert.equal(o.facts.find((f) => f.key === "sites")!.display, "S2 (Crumb & Co Brixton)");
    assert.ok(o.facts.some((f) => f.key === "event_1"), "the S2 oven event is in scope");
    assert.match(String(chat.requests[2].req.messages[1].content), /^Question: Why did Brixton use more electricity\?\nScope: S2 Crumb & Co Brixton/);
  });
  it("the question's own site mention counts when the model forgot it; 'site 3' works too", async () => {
    const a = ok(await run("Why did Brixton use more electricity?", fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("x")] })));
    assert.equal(a.scope.label, "S2");
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
  it("an unknown site in the question gives a clarification and stops before the plan", async () => {
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Peckham"] })], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = await run("Why did Peckham use more electricity?", chat);
    assert.ok(isClarification(o));
    if (isClarification(o)) {
      assert.match(o.clarification, /could not find a site called "Peckham"/);
      assert.match(o.clarification, /S1 \(Crumb & Co Shoreditch\), S2 \(Crumb & Co Brixton\), S3 \(Crumb & Co Hampstead\)/);
      assert.deepEqual(o.knownSites.map((s) => s.id), ["S1", "S2", "S3"]);
      assert.equal(o.llmCalls.length, 1);
    }
    assert.deepEqual(chat.requests.map((r) => r.step), ["intent"]);
  });
  it("'site 9' in the question is a clarification even when the model rewrites it as S9; it is never widened to all sites", async () => {
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["S9"] })], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = await run("Why did site 9 use more electricity?", chat);
    assert.ok(isClarification(o));
    if (isClarification(o)) assert.match(o.clarification, /could not find "site 9".*S1 \(Crumb & Co Shoreditch\)/);
    assert.deepEqual(chat.requests.map((r) => r.step), ["intent"]);
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
    assert.match(String(chat.requests[2].req.messages[1].content), /The owner asked about: 2026-10-10\./);
    assert.ok(o.plan.hypotheses.includes("H6") && o.plan.hypotheses.includes("H11"), "spike questions always test the one-off and unusual-day hypotheses");
  });
});

describe("investigate: the plan", () => {
  it("keeps catalog ids in the model's order, drops unknown ones, adds H7-H9, and logs what happened", async () => {
    const plan = PLAN_OK({ hypotheses: ["H3", "h1", "H99", "H3", "H5", "weather"] });
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [plan], narrative: [new Error("x")] })));
    assert.deepEqual(o.plan.hypotheses, ["H3", "H1", "H5", "H7", "H8", "H9"]);
    assert.deepEqual(o.plan.added, ["H7", "H8", "H9"]); assert.deepEqual(o.plan.dropped, ["H99", "WEATHER"]);
    assert.ok(o.notes.some((n) => /dropped ids outside the catalog: H99, WEATHER/.test(n)));
    assert.deepEqual(o.results.map((r) => r.id), ["H3", "H1", "H5", "H7", "H8", "H9"]);
    assert.equal(o.plan.source, "llm"); assert.match(o.plan.rationale, /usual suspects/);
  });
  it("an emissions question always tests H10; hypotheses the model listed are not duplicated", async () => {
    const o = ok(await run("Why were our emissions higher?", fakeChat({ intent: [INTENT_OK({ type: "why_emissions" })], plan: [PLAN_OK({ hypotheses: ["H1", "H7"] })], narrative: [new Error("x")] })));
    assert.deepEqual(o.plan.hypotheses, ["H1", "H7", "H10", "H8", "H9"]); assert.deepEqual(o.plan.added, ["H10", "H8", "H9"]);
    assert.ok(o.facts.some((f) => f.key === "emissions_A"));
  });
  it("only the planned hypotheses produce facts", async () => {
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK({ hypotheses: ["H1"] })], narrative: [new Error("x")] })));
    assert.ok(o.facts.some((f) => f.key === "price_peak_A")); assert.ok(!o.facts.some((f) => f.key === "hdd_A")); assert.ok(!o.facts.some((f) => f.key === "wind_A"));
  });
  it("extra SQL: at most 2, each through the guard; a rejected one is logged, a good one becomes evidence and facts", async () => {
    const ran: string[] = [];
    const zsql = async (sql: string) => { ran.push(sql); return { ok: true, status: 200, runId: "run-extra-1", body: { headers: ["n_rows", "avg_kwh"], data: [[1344, 0.81]] } }; };
    const plan = PLAN_OK({ extraSql: [
      { purpose: "drop everything", sql: "DROP TABLE kilowhy.meter_hh" },
      { purpose: "average load of S2", sql: "SELECT COUNT(*) AS n_rows, AVG(kwh) AS avg_kwh FROM kilowhy.meter_hh WHERE site_id = 'S2'" },
      { purpose: "third query is ignored", sql: "SELECT 1 FROM kilowhy.sites" },
    ] });
    const o = ok(await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [plan], narrative: [new Error("x")] }), { zsql }));
    assert.deepEqual(o.plan.extraSql.map((x) => x.status), ["rejected", "ran"]);
    assert.match(o.plan.extraSql[0].reason!, /only SELECT or WITH|forbidden keyword/);
    assert.equal(ran.length, 1); assert.match(ran[0], /LIMIT 5000$/);
    const ev = o.evidence.find((e) => e.id === o.plan.extraSql[1].evidence)!;
    assert.equal(ev.hypothesisId, "EXTRA"); assert.equal(ev.zetarisRunId, "run-extra-1"); assert.equal(ev.rowCount, 1); assert.deepEqual(ev.sources, [{ view: "meter_hh", kind: "FILE: sample" }]);
    assert.ok(o.facts.some((f) => f.key === "extra_1_avg_kwh" && f.evidence === ev.id));
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
    const o = ok(await investigate("q", { data: scenario(over).data, chat: fakeChat({ intent: [INTENT_OK({ type })], plan: [PLAN_OK({ hypotheses: ["H1", "H2", "H3", "H4", "H5", "H6", "H10", "H11"] })], narrative: [new Error("x")] }) }));
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
    const o = await run(Q, fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] }));
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
  it("routeLine shows a fallback and wrap indents continuation lines", () => {
    const line = routeLine({ step: "narrative", route: { provider: "nvidia-direct", requestedModel: "m", routedModel: "nvidia/x", label: "NVIDIA direct", kind: "cloud", tier: null, latencyMs: 56700, receiptId: null, raceWidth: 1, usage: { inputTokens: null, outputTokens: null, totalTokens: null, outputTps: null, routerLatencyMs: null }, fallbackReason: "meterless HTTP 502" } });
    assert.match(line, /^narrative: nvidia\/x \(NVIDIA direct\) via nvidia-direct, 56\.7 s, race of 1 \[fallback: meterless HTTP 502\]$/);
    assert.equal(wrap("aaa bbb ccc", 7, "  "), "aaa bbb\n  ccc");
  });
});

describe("factLines helper", () => {
  it("parses the facts table out of the narrative prompt", async () => {
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [goodNarrative] });
    const o = ok(await run(Q, chat));
    const lines = factLines(chat.requests[2].req);
    assert.equal(lines.length, o.facts.length);
    assert.deepEqual(lines.map((l) => l.display), o.facts.map((f) => f.display));
  });
});
