// The Markovian chain in the agent: chunks run by the vendored engine, bounded carryover, corrections as chunks, token accounting, and the same structured results as the plain loop.
// Scripted LLM, synthetic data: no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { investigate } from "./agent.ts";
import { isClarification, type InvestigationResult } from "./agent_types.ts";
import { scenario, fakeChat, factLines, route, INTENT_OK, PLAN_OK, goodNarrative, interpretOk } from "./agent_testkit.ts";
import { interpretTargets, CHAIN_CONFIG, BATCH_SIZE, INTERPRET_DEADLINE_MS, INTERPRET_HEDGE_MS } from "./investigate_markovian.ts";
import { checkReadings, chunkFacts } from "./markovian_prompts.ts";
import { parseState } from "./markovian_state.ts";
import { totalsOf, withNaive } from "./markovian_log.ts";
import { KEEP_RUNS } from "./markovian_file.ts";
import { KilowhyMemory } from "./memory.ts";
import { renderAnswer } from "./agent_render.ts";
import { fakeEmbedder, NOTE } from "./memory_testkit.ts";
import type { ChatRequest, ChatResult } from "./provider_shared.ts";
import type { ProgressEvent } from "./agent_events.ts";

const Q = "Why did our electricity cost more in the last four weeks than the four weeks before?";
const ok = (o: Awaited<ReturnType<typeof investigate>>): InvestigationResult => { assert.ok(!isClarification(o), "expected an investigation"); return o as InvestigationResult; };

/** A narrative written from the facts the narrative chunk can see (it sees fewer than the plain loop does). */
function visibleNarrative(req: ChatRequest): string {
  const L = factLines(req), sys = String(req.messages[0].content);
  const f = (start: string) => { const x = L.find((l) => l.label.startsWith(start)); if (!x) throw new Error(`no visible fact "${start}"`); return `{${x.id}}`; };
  const status = (h: string) => sys.match(new RegExp(`^${h} [^\\n]*: (supported|ruled_out)$`, "m"))?.[1];
  const supported = L.find((l) => l.hyp !== "-" && l.hyp !== "REC" && status(l.hyp) === "supported");
  const ruled = L.find((l) => l.hyp === "H5" && status("H5") === "ruled_out");
  const top = L.find((l) => l.hyp === "H3") ?? supported;                       // a question about a site opens with its largest supported cause
  return JSON.stringify({
    headline: `Your bill rose by ${f("Change in the bill, window")}`,
    sentences: [
      { text: `Your bill rose by ${f("Change in the bill, window")} (${f("Change in the bill as a share")}), from ${f("Electricity bill in window A")} to ${f("Electricity bill in window B")}${top ? `, mostly because of {${top.id}}` : ""}.` },
      ...(supported ? [{ text: `One supported test adds {${supported.id}}.` }] : []),
    ],
    ruledOut: ruled ? [{ hypothesis: "H5", text: `Timing is ruled out: {${ruled.id}}.` }] : [],
    recommendation: { text: `Staying on Agile saved {${L.find((l) => l.label.startsWith("Flat tariff minus Agile in window B"))!.id}:abs} against a flat business tariff over the four weeks, a historical counterfactual, not advice; shifting flexible load would have saved only ${f("Load shift: money saved")} and ${f("Load shift: carbon saved")}.` },
  });
}
const badVisible = (req: ChatRequest): string => { const n = JSON.parse(visibleNarrative(req)); n.sentences[0].text = "Your bill rose by £999.99."; return JSON.stringify(n); };
const mk = (script: Parameters<typeof fakeChat>[0] = {}, extra: Parameters<typeof investigate>[1] = {}) => {
  const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], interpret: [interpretOk], narrative: [visibleNarrative], ...script });
  return investigate(Q, { data: scenario().data, chat, ...extra }).then((o) => ({ o: ok(o), chat }));
};
const kinds = (o: InvestigationResult) => o.markovian!.chunks.map((c) => c.kind);

describe("the chain", () => {
  it("is the default engine: plan, interpret batches, narrative, verify, all run by the vendored orchestrator", async () => {
    const { o } = await mk();
    assert.equal(o.engine, "markovian");
    const targets = interpretTargets(o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })), o.plan.hypotheses, o.intent.type);
    assert.ok(targets.length >= 4);
    assert.deepEqual(kinds(o), ["plan", ...Array(Math.ceil(targets.length / BATCH_SIZE)).fill("interpret"), "narrative", "verify"]);
    assert.equal(o.markovian!.status, "completed"); assert.equal(o.markovian!.reference, "vendor/meterless/markovian (Apache-2.0)");
    assert.deepEqual(o.markovian!.config, { chunkSize: CHAIN_CONFIG.chunkSize, maxChunks: 16, carryoverTokens: 800, batchSize: BATCH_SIZE });
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 1);
    assert.equal(o.llmCalls.map((c) => c.step).filter((s) => s.startsWith("interpret")).length, Math.ceil(targets.length / BATCH_SIZE));
    assert.equal(BATCH_SIZE, 5);
    assert.match(o.markovian!.chunks.at(-1)!.label, /verify \(passed\)/);
  });
  it("interpret chunks give Nightshift a real head start: the labelled NVIDIA call joins after 30 s, the chunk gives up after 50 s", async () => {
    const { chat } = await mk();
    const interpret = chat.requests.filter((r) => r.step === "interpret");
    assert.ok(interpret.length >= 1);
    assert.equal(INTERPRET_HEDGE_MS, 30_000); assert.equal(INTERPRET_DEADLINE_MS, 50_000);
    for (const r of interpret) { assert.equal(r.req.hedgeAfterMs, INTERPRET_HEDGE_MS); assert.equal(r.req.deadlineMs, INTERPRET_DEADLINE_MS); assert.ok(r.req.hedgeAfterMs! < r.req.deadlineMs!); }
  });
  it("engine plain is the single plan + narrative loop with no chain", async () => {
    const { o } = await mk({}, { engine: "plain" });
    assert.equal(o.engine, "plain"); assert.equal(o.markovian, undefined);
    assert.ok(!o.llmCalls.some((c) => c.step.startsWith("interpret")));
  });
  it("the batch size is an option: the spec's 3, one chunk for everything, or a chunk per test", async () => {
    const t3 = (await mk({}, { markovian: { batchSize: 3 } })).o;
    assert.equal(t3.markovian!.config.batchSize, 3); assert.equal(kinds(t3).filter((k) => k === "interpret").length, Math.ceil(interpretTargets(t3.results.map((r) => ({ id: r.id, name: r.name, status: r.status })), t3.plan.hypotheses, t3.intent.type).length / 3));
    assert.deepEqual(kinds((await mk({}, { markovian: { batchSize: 100 } })).o).filter((k) => k === "interpret").length, 1);
    const targets = interpretTargets((await mk()).o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })), PLAN_OK() as unknown as string[], "why_cost_change").length;
    assert.equal(kinds((await mk({}, { markovian: { batchSize: 1 } })).o).filter((k) => k === "interpret").length, targets);
  });
  it("interprets supported and ruled-out tests that matter; not inconclusive ones, the data checks, or emissions in a cost question", () => {
    const h = (id: string, status: "supported" | "ruled_out" | "inconclusive") => ({ id, name: id, status });
    const hyps = [h("H1", "supported"), h("H2", "inconclusive"), h("H3", "supported"), h("H7", "ruled_out"), h("H9", "ruled_out"), h("H10", "supported"), h("H5", "ruled_out")];
    assert.deepEqual(interpretTargets(hyps, ["H5", "H1", "H3"], "why_cost_change"), ["H5", "H1", "H3"]);
    assert.deepEqual(interpretTargets(hyps, [], "why_emissions"), ["H3", "H10"], "an emissions question skips the cost tests H1, H2, H5, H8");
  });
});

describe("same structured results as the plain loop", () => {
  it("results, evidence, facts, plan, scope, decomposition and recommendation are identical; both answers verify", async () => {
    const a = (await mk({}, { engine: "plain" })).o;
    const b = (await mk()).o;
    const plain = (x: InvestigationResult) => JSON.parse(JSON.stringify({ intent: x.intent, scope: x.scope, decomposition: x.decomposition, plan: x.plan, results: x.results, evidence: x.evidence, facts: x.facts, recommendation: x.recommendation }));
    assert.deepEqual(plain(b), plain(a));
    assert.equal(a.verification.passed && b.verification.passed, true);
    assert.equal(b.engine, "markovian");
  });
});

describe("the carryover", () => {
  it("every checkpoint is a bounded JSON state, and the next chunk reads exactly the state the engine handed on", async () => {
    const { o, chat } = await mk();
    const reqs = chat.requests;
    const interpret = reqs.filter((r) => r.step === "interpret"), narrative = reqs.find((r) => r.step === "narrative")!;
    const stateIn = (r: { req: ChatRequest }) => String(r.req.messages[0].content).split("(JSON carryover): ").pop()!.split("\n")[0];
    const first = parseState(stateIn(interpret[0]))!;
    assert.deepEqual(first.done, ["plan"]); assert.equal(first.next, "interpret 1"); assert.equal(first.scope, "ALL"); assert.deepEqual(Object.keys(first.read), []);
    const second = parseState(stateIn(interpret[1]))!;
    assert.deepEqual(second.done, ["plan", `interpret 1/${interpret.length}`]); assert.ok(Object.keys(second.read).length >= 1, "the first chunk's readings travelled in the carryover");
    const nstate = parseState(String(narrative.req.messages[0].content).split("\n").at(-1)!)!;
    assert.equal(nstate.next, "narrative"); assert.deepEqual(nstate.hyp, Object.fromEntries(o.results.map((r) => [r.id, { supported: "s", ruled_out: "r", inconclusive: "i" }[r.status]])));
    assert.deepEqual(nstate.plan, o.plan.hypotheses); assert.ok(nstate.ev.H3.length > 0 && nstate.ev.H3.every((e) => /^E\d+$/.test(e)));
    for (const c of o.markovian!.chunks) assert.ok(c.carryoverOut <= CHAIN_CONFIG.carryoverTokens && c.carryoverIn <= CHAIN_CONFIG.carryoverTokens, `${c.label}: ${c.carryoverIn} -> ${c.carryoverOut}`);
    assert.ok(o.markovian!.finalState!.read && o.markovian!.carryoverShrunk.length === 0);
  });
  it("huge readings are shrunk to the budget instead of breaking the chain", async () => {
    const long = (req: ChatRequest) => JSON.stringify({ readings: JSON.parse(interpretOk(req)).readings.map((r: { id: string; reading: string }) => ({ ...r, reading: `${r.reading} ${"and so on ".repeat(120)}` })) });
    const { o } = await mk({ interpret: [long] });
    assert.ok(o.markovian!.carryoverShrunk.length > 0, "the state had to be shrunk");
    assert.ok(o.markovian!.carryoverShrunk[0].includes("readings to 140 characters"));
    for (const c of o.markovian!.chunks) assert.ok(c.carryoverOut <= 800);
    assert.equal(o.verification.mode, "llm");
  });
  it("the narrative chunk is shown a subset of the facts the plain loop shows, never more", async () => {
    const plain = await mk({}, { engine: "plain" });
    const chain = await mk();
    const ids = (c: Awaited<ReturnType<typeof mk>>) => factLines(c.chat.requests.find((r) => r.step === "narrative")!.req).map((l) => l.id);
    const p = new Set(ids(plain)), m = ids(chain);
    assert.ok(m.length < p.size, `${m.length} < ${p.size}`); assert.ok(m.every((id) => p.has(id)));
  });
  it("tests without a reading, or with a reading that cites no fact, keep all their facts (a test is never starved of the figures it needs)", () => {
    const f = (id: string, hyp?: string) => ({ id, key: id, label: id, value: 1, unit: "count", display: "1", evidence: "E1", ...(hyp ? { hypothesis: hyp } : {}) });
    const facts = [f("F1"), f("F2", "H3"), f("F3", "H3"), f("F4", "H5"), f("F5", "H5"), f("F6", "REC")];
    const hyps = [{ id: "H3", name: "w", status: "supported" as const }, { id: "H5", name: "t", status: "supported" as const }];
    const state = parseState('{"v":1,"q":"","type":"why_cost_change","scope":"ALL","win":"","plan":[],"mem":[],"hyp":{"H3":"s","H5":"s"},"ev":{},"read":{"H3":"see {F3}","H5":"a reading with no placeholder"},"done":[],"next":"narrative","open":[],"att":0,"err":[]}')!;
    assert.deepEqual(chunkFacts(facts, hyps, [], "why_cost_change", state).map((x) => x.id), ["F1", "F3", "F4", "F5", "F6"]);
  });
});

describe("corrections are chunks", () => {
  it("a rejected draft is followed by a correction chunk whose carryover holds the errors; earlier chunks' prompts are not re-sent", async () => {
    const { o, chat } = await mk({ narrative: [badVisible, visibleNarrative] });
    assert.deepEqual(o.markovian!.chunks.map((c) => c.label).filter((l) => /narrative|verify/.test(l)), ["narrative", "verify (rejected 1)", "narrative (correction 1)", "verify (passed)"]);
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 2); assert.ok(o.verification.history[0].errors.length > 0);
    const narr = chat.requests.filter((r) => r.step === "narrative");
    assert.equal(narr.length, 2);
    const sys = String(narr[1].req.messages[0].content);
    const state = parseState(sys.split("\n").at(-1)!)!;
    assert.equal(state.att, 1); assert.ok(state.err.length >= 1 && state.err.every((e) => e.length <= 160));
    const turns = narr[1].req.messages.map((m) => m.role);
    assert.deepEqual(turns, ["system", "user", "assistant", "user"], "the base prompt, the rejected draft, and the corrections: no interpret prompts and no plan");
    assert.match(String(narr[1].req.messages[3].content), /Your answer was rejected for these reasons/);
  });
  it("when every draft is rejected the chain ends after maxCorrections and the template answers (mode template, verify failed)", async () => {
    const { o } = await mk({ narrative: [badVisible] });
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.passed, true); assert.equal(o.verification.attempts, 3);
    assert.equal(o.markovian!.status, "completed"); assert.match(o.markovian!.chunks.at(-1)!.label, /verify \(failed\)/);
    assert.equal(o.markovian!.chunks.filter((c) => c.kind === "narrative").length, 3);
  });
  it("maxCorrections 0 means one draft", async () => {
    const { o } = await mk({ narrative: [badVisible] }, { maxCorrections: 0 });
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "template");
  });
  it("a provider that returns nothing for the narrative is not asked again (as in the plain loop); the template answers", async () => {
    const { o, chat } = await mk({ narrative: [new Error("HTTP 500")] });
    assert.equal(o.verification.mode, "template"); assert.equal(o.verification.attempts, 1);
    const plain = await mk({ narrative: [new Error("HTTP 500")] }, { engine: "plain" });
    assert.equal(chat.requests.filter((r) => r.step === "narrative").length, plain.chat.requests.filter((r) => r.step === "narrative").length, "the same transient retry and one direct retry as the plain loop, no more");
    assert.match(o.markovian!.chunks.at(-1)!.label, /verify \(failed\)/);
  });
});

describe("interpret chunks are optional", () => {
  it("a failing interpret call is noted and the chain goes on with the facts of the unread tests", async () => {
    const { o } = await mk({ interpret: [new Error("HTTP 500")] });
    assert.equal(o.verification.mode, "llm");
    assert.ok(o.markovian!.notes.some((n) => /^interpret 1\/\d.*no readings/.test(n)), o.markovian!.notes.join(" | "));
    assert.deepEqual(o.markovian!.finalState!.read, {});
  });
  it("a reading with a digit outside a placeholder is dropped, readings with placeholders are kept", () => {
    const r = checkReadings(["H3", "H5"])({ readings: [{ id: "H3", reading: "Colder, adding {F9}" }, { id: "H5", reading: "Moved by 12 percent" }, { id: "H9", reading: "not in the batch" }] });
    assert.ok(r.ok); if (r.ok) { assert.deepEqual(r.value.readings, [{ id: "H3", reading: "Colder, adding {F9}" }]); assert.deepEqual(r.value.dropped, ["H5: digits outside placeholders (12)"]); }
    assert.ok(checkReadings(["H3"])({ H3: "x" } as unknown).ok === false, "a bare map is not the schema, an array is");
    const asMap = checkReadings(["H3"])({ readings: { H3: "a {F1}" } });
    assert.ok(asMap.ok && asMap.value.readings[0].id === "H3");
  });
});

describe("token accounting", () => {
  it("every chunk has estimated input and output tokens, the first chunk has no history, later chunks cost less than their naive full-history version", async () => {
    const { o } = await mk();
    const [plan, ...rest] = o.markovian!.chunks;
    assert.equal(plan.naiveInputTokens, plan.inputTokens.estimated); assert.equal(plan.carryoverIn, 0);
    const llm = rest.filter((c) => c.llmCalls > 0);
    assert.ok(llm.length >= 3 && llm.every((c) => c.inputTokens.estimated > 0 && c.outputTokens.estimated > 0 && c.carryoverIn > 0));
    assert.ok(llm.at(-1)!.naiveInputTokens > llm.at(-1)!.inputTokens.estimated, "the narrative chunk would have carried the whole history");
    const t = o.markovian!.totals;
    assert.equal(t.markovianInputEstimated, o.markovian!.chunks.reduce((s, c) => s + c.inputTokens.estimated, 0));
    assert.equal(t.savedEstimated, t.naiveInputEstimated - t.markovianInputEstimated); assert.ok(t.savedPercentEstimated > 0);
    assert.match(t.label, /estimated = ceil\(chars \/ 4\)/); assert.equal(t.markovianInputMeasured, null, "the scripted provider reports no usage");
    assert.ok(t.plainLoopInputEstimated > 0);
    assert.equal(o.markovian!.chunks.find((c) => c.kind === "verify")!.llmCalls, 0);
  });
  it("provider-reported usage is summed as 'measured' next to the estimate", async () => {
    const base = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], interpret: [interpretOk], narrative: [visibleNarrative] });
    const withUsage = Object.assign(async (req: ChatRequest): Promise<ChatResult> => { const r = await base(req); return { ...r, route: { ...route(), usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, outputTps: null, routerLatencyMs: null }, receiptId: `rcpt_${base.requests.length}` } }; }, { requests: base.requests });
    const o = ok(await investigate(Q, { data: scenario().data, chat: withUsage }));
    const llm = o.markovian!.chunks.filter((c) => c.llmCalls > 0);
    assert.ok(llm.every((c) => c.inputTokens.measured === 1000 * c.llmCalls && c.outputTokens.measured === 100 * c.llmCalls && c.receiptIds.length >= 1));
    assert.equal(o.markovian!.totals.markovianInputMeasured, 1000 * llm.reduce((s, c) => s + c.llmCalls, 0));
  });
  it("naive baseline: a chunk re-sends every earlier prompt and output (reference formula on a worked example)", () => {
    const c = (id: number, task: number, out: number) => ({ id, kind: "interpret" as const, label: `c${id}`, ms: 1, llmCalls: 1, inputTokens: { estimated: task + 100, measured: null }, outputTokens: { estimated: out, measured: null }, carryoverIn: 100, carryoverOut: 100, taskTokens: task, route: null, receiptIds: [] });
    const chunks = withNaive([c(1, 500, 50), c(2, 400, 60), c(3, 300, 70)]);
    assert.deepEqual(chunks.map((x) => x.naiveInputTokens), [500, 400 + 550, 300 + 550 + 460]);
    const t = totalsOf(chunks, 1000, null);
    assert.deepEqual([t.markovianInputEstimated, t.naiveInputEstimated, t.savedEstimated], [1200 + 300, 500 + 950 + 1310, 2760 - 1500]);
  });
  it("progress events announce every chunk with its tokens", async () => {
    const events: ProgressEvent[] = [];
    const { o } = await mk({}, { onEvent: (e) => events.push(e) });
    const ev = events.filter((e) => e.type === "chunk") as Extract<ProgressEvent, { type: "chunk" }>[];
    assert.deepEqual(ev.map((e) => e.kind), kinds(o)); assert.deepEqual(ev.map((e) => e.inputTokens), o.markovian!.chunks.map((c) => c.inputTokens.estimated));
  });
  it("the per-chunk log is appended to the log file with its labels and capped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilowhy-mk-"));
    const file = join(dir, "markovian_tokens.json");
    try {
      for (let i = 0; i < KEEP_RUNS + 2; i++) await mk({}, { markovian: { logPath: file } });
      const j = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(j.schema, 1); assert.match(j.note, /estimated/); assert.match(j.note, /SAMPLE/); assert.equal(j.runs.length, KEEP_RUNS);
      const r = j.runs.at(-1);
      assert.equal(r.question, Q); assert.equal(r.verificationMode, "llm"); assert.ok(r.report.chunks.length >= 5); assert.ok(r.report.totals.label.includes("estimated"));
      assert.ok(r.report.chunks[1].inputTokens.estimated > 0 && "measured" in r.report.chunks[1].inputTokens);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the CLI rendering", () => {
  it("prints the chain with seconds, estimated input tokens, the naive estimate and the carryover, and the H-MEM section", async () => {
    const m = KilowhyMemory.create({ embed: fakeEmbedder(), recall: { threshold: 0.2 } });
    await m.remember(NOTE, { source: "user", site: "S2" });
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], interpret: [interpretOk], narrative: [visibleNarrative] });
    const text = renderAnswer(ok(await investigate("Why did Brixton use more electricity?", { data: scenario().data, chat, memory: m })));
    assert.match(text, /Markovian chain \(\d+ chunks, status completed; carryover bound 800 tokens; tokens estimated = chars\/4 unless marked measured\)/);
    assert.match(text, /\n\s+1 plan\s+[\d.]+ s\s+in\s+\d+\s+naive\s+\d+\s+carryover 0->\d+/);
    assert.match(text, /interpret 1\/\d \(H\d+/); assert.match(text, /verify \(passed\)/);
    assert.match(text, /total input: chain \d+ vs naive full history \d+ \([\d.]+% less, estimated\)/);
    assert.match(text, /H-MEM: 1 recalled for .*embeddings via fake: fake\/embed-48/); assert.match(text, /M1 = mem-1 \[user, S2\] score 0\.\d{3}, cited in 0 answer item\(s\): Brixton moved its oven schedule/);
    assert.match(text, /wrote mem-\d+ \(H\d+\)/);
  });
});

describe("with memory", () => {
  it("a recalled note is an M# fact in the narrative chunk and is listed in the carryover", async () => {
    const m = KilowhyMemory.create({ embed: fakeEmbedder(), recall: { threshold: 0.2 } });
    await m.remember(NOTE, { source: "user", site: "S2" });
    const chat = fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], interpret: [interpretOk], narrative: [visibleNarrative] });
    const o = ok(await investigate("Why did Brixton use more electricity?", { data: scenario().data, chat, memory: m }));
    const sys = String(chat.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.match(sys, /^M1 Remembered note from the owner about S2/m);
    assert.deepEqual(o.markovian!.finalState!.mem, ["M1"]);
    assert.match(String(chat.requests.find((r) => r.step === "plan")!.req.messages[1].content), /M1 \(owner's note/);
    assert.equal(o.verification.mode, "llm");
  });
});
