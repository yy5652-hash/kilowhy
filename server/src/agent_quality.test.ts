// D5b: the narrative meaning rules end to end, with a scripted fake LLM and the synthetic data layer (no network): option ranking in the recommendation,
// site questions answered with the site's own change, headline repair, one-clause ruled-out items, past one-off events.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { investigate } from "./agent.ts";
import { isClarification, type InvestigationResult } from "./agent_types.ts";
import { templateAnswer } from "./agent_template.ts";
import { qualityContext, makeChecks, HEADLINE_MAX_CHARS } from "./quality.ts";
import { rankOptions } from "./facts_options.ts";
import { tokenize, tokenMatchesFact, verifyAnswer } from "./verifier.ts";
import { scenario, fakeChat, goodNarrative, factLines, ph, INTENT_OK, PLAN_OK } from "./agent_testkit.ts";
import type { ChatRequest } from "./provider_shared.ts";

const Q = "Why did our electricity cost more in the last four weeks than the four weeks before?";
const QB = "Why did Brixton use more electricity?";
const ok = (o: Awaited<ReturnType<typeof investigate>>): InvestigationResult => { assert.ok(!isClarification(o), "expected an investigation"); return o as InvestigationResult; };
const ask = async (q: string, narrative: (string | ((r: ChatRequest) => string) | Error)[], over: Parameters<typeof scenario>[0] = {}, opts: Parameters<typeof investigate>[1] = {}, sites: string[] = []) => {
  const chat = fakeChat({ intent: [INTENT_OK({ sites })], plan: [PLAN_OK()], narrative });
  const o = ok(await investigate(q, { engine: "plain", data: scenario(over).data, chat, ...opts }));
  return { o, chat };
};
/** goodNarrative with a change applied to its parsed JSON. */
const edit = (f: (n: any, L: ReturnType<typeof factLines>) => void) => (req: ChatRequest): string => { const n = JSON.parse(goodNarrative(req)); f(n, factLines(req)); return JSON.stringify(n); };
const firstMoney = (text: string) => tokenize(text).find((t) => t.type === "money")!;

// A site had a one-off freezer fault on 2026-09-20, which is day 24 of window A (the baseline).
const freezerAt = (site: string) => ({
  ops: [
    { eventId: "E1", siteId: "S2", eventDate: "2026-10-07", description: "SAMPLE: Oven schedule moved 2h later from this date (new sourdough line)." },
    { eventId: "E2", siteId: site, eventDate: "2026-09-20", description: "SAMPLE: One-off freezer fault; extra kWh consumed all day." },
  ],
  kwh: (s: string, w: string, day: number, slot: number) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (w === "B" ? (0.15 * Math.max(0, 15.5 - (9 + 2 * Math.sin(day)))) / 6 : 0) + (s === site && w === "A" && day === 24 ? 1.5 : 0),
});
const FREEZER = freezerAt("S3"), FREEZER_S2 = freezerAt("S2");

describe("1. recommendation options ranked by £ effect", () => {
  it("the narrative prompt carries the options largest first, and the facts table says which fact is which option", async () => {
    const { o, chat } = await ask(Q, [goodNarrative]);
    const options = rankOptions(o.facts);
    assert.deepEqual(options.map((x) => x.key), ["tariff", "load_shift"]);
    const sys = String(chat.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.match(sys, new RegExp(`^1\\. staying on Agile saved \\{${options[0].factId}:abs\\} against a flat business tariff over the four weeks`, "m"));
    assert.match(sys, new RegExp(`^2\\. shifting flexible peak-band load saved \\{${options[1].factId}:abs\\} and \\{${options[1].extraFactIds[0]}\\}`, "m"));
    assert.match(sys, /Lead with option 1/); assert.match(sys, /never use one as an option, a saving or a "lever"/);
    assert.deepEqual(o.facts.filter((f) => f.rank).map((f) => [f.key, f.rank, f.option]), [["rec_saved", 2, "load_shift"], ["flat_minus_agile_B", 1, "tariff"]]);
  });
  it("a recommendation that leads with the small load shift is rejected and corrected; the final one leads with the largest option", async () => {
    const shiftFirst = edit((n, L) => { n.recommendation.text = `Shifting load would have saved ${ph(L, "Load shift: money saved")} and ${ph(L, "Load shift: carbon saved")}; staying on Agile saved ${ph(L, "Flat tariff minus Agile in window B", true)} against a flat business tariff, a historical counterfactual.`; });
    const { o } = await ask(Q, [shiftFirst, goodNarrative]);
    assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 2);
    assert.ok(o.verification.history[0].errors.some((e) => /the first £ figure must be the option with the largest effect/.test(e)), o.verification.history[0].errors.join("\n"));
    const top = o.facts.find((f) => f.rank === 1)!;
    assert.ok(tokenMatchesFact(firstMoney(o.answer.recommendation.text), top), o.answer.recommendation.text);
  });
  it("saying plainly that Agile was cheaper is required, and the text names the saving", async () => {
    const vague = edit((n, L) => { n.recommendation.text = `The tariff comparison gives ${ph(L, "Flat tariff minus Agile in window B", true)}, a historical counterfactual; shifting load would have saved only ${ph(L, "Load shift: money saved")} and ${ph(L, "Load shift: carbon saved")}.`; });
    const { o } = await ask(Q, [vague, goodNarrative]);
    assert.ok(o.verification.history[0].errors.some((e) => /say plainly that Agile was cheaper/.test(e)));
    assert.match(o.answer.recommendation.text, /^Staying on Agile saved £[\d,.]+ against a flat business tariff over the four weeks/);
  });
  it("when the flat tariff would have been cheaper, that is the lead and the text must say so", async () => {
    const cheapFlat = { flat: [{ from: "2026-05-31T23:00:00Z", to: null, excP: 8, standingExc: 20 }] };
    const wrongWay = (req: ChatRequest) => goodNarrative(req);   // says "Staying on Agile saved ..."
    const { o } = await ask(Q, [wrongWay, edit((n, L) => { n.recommendation.text = `A flat business tariff would have cost ${ph(L, "Flat tariff minus Agile in window B", true)} less than Agile over the four weeks, a historical counterfactual; shifting load would have saved only ${ph(L, "Load shift: money saved")} and ${ph(L, "Load shift: carbon saved")}.`; })], cheapFlat);
    const t = rankOptions(o.facts)[0];
    assert.equal(t.key, "tariff"); assert.equal(t.direction, "flat_cheaper");
    assert.ok(o.verification.history[0].errors.some((e) => /say plainly that the flat tariff would have been cheaper/.test(e)), o.verification.history[0].errors.join("\n"));
    assert.match(o.answer.recommendation.text, /^A flat business tariff would have cost £[\d,.]+ less than Agile/);
  });
  it("a recommendation that leaves out the load shift's carbon figure, or an option, is rejected", async () => {
    const noKg = edit((n, L) => { n.recommendation.text = `Staying on Agile saved ${ph(L, "Flat tariff minus Agile in window B", true)} against a flat business tariff, a historical counterfactual; shifting load would have saved only ${ph(L, "Load shift: money saved")}.`; });
    const { o } = await ask(Q, [noKg, goodNarrative]);
    assert.ok(o.verification.history[0].errors.some((e) => /present the load shift with its carbon figure too/.test(e)));
    const noShift = edit((n, L) => { n.recommendation.text = `Staying on Agile saved ${ph(L, "Flat tariff minus Agile in window B", true)} against a flat business tariff, a historical counterfactual.`; });
    const b = await ask(Q, [noShift, goodNarrative]);
    assert.ok(b.o.verification.history[0].errors.some((e) => /every option is presented with its own figure/.test(e)));
  });
  it("the freezer fault of window A is never a lever or a saving: not in the recommendation, not in a sentence", async () => {
    const asLever = edit((n, L) => { n.recommendation.text += ` Preventing another freezer fault such as ${ph(L, "Unusual day 1: date")} is the biggest lever.`; });
    const { o } = await ask(Q, [asLever, goodNarrative], FREEZER);
    assert.ok(o.facts.some((f) => f.key === "spike_1_window" && String(f.value).startsWith("window A")), "the spike falls in window A");
    const errs = o.verification.history[0].errors.join("\n");
    assert.match(errs, /do not call anything a lever/); assert.match(errs, /the recommendation may not use F\d+ = 2026-09-20: a past one-off event explains a change, it is not an option/);
    const asSaving = edit((n, L) => { n.sentences.push({ text: `Avoiding another freezer fault like the one on ${ph(L, "Unusual day 1: date")} in window A, the baseline, would be a saving.` }); });
    const b = await ask(Q, [asSaving, goodNarrative], FREEZER);
    assert.ok(b.o.verification.history[0].errors.some((e) => /a past one-off event \(an unusual day, a fault\) explains a change; it is not a lever or a saving/.test(e)), b.o.verification.history[0].errors.join("\n"));
  });
  it("an unusual day in window A is said to be in the baseline; the template says it", async () => {
    const unsaid = edit((n, L) => { n.sentences.push({ text: `An unusual usage day on ${ph(L, "Unusual day 1: date")} added ${ph(L, "Unusual day 1: electricity used")}.` }); });
    const { o } = await ask(Q, [unsaid, goodNarrative], FREEZER);
    assert.ok(o.verification.history[0].errors.some((e) => /this unusual day falls in window A, the baseline: say so/.test(e)), o.verification.history[0].errors.join("\n"));
    const t = ok(await investigate(Q, { engine: "plain", data: scenario(FREEZER).data, chat: fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("down")] }) }));
    const spike = t.answer.sentences.find((s) => /freezer|unusual|used .* kWh on 2026-09-20/.test(s.text));
    assert.ok(spike, t.answer.sentences.map((s) => s.text).join(" | "));
    assert.match(spike!.text, /that day falls in window A \(the baseline\), so it raised the baseline rather than the latest four weeks/);
    assert.equal(t.verification.passed, true);
  });
});

describe("2. a question about a site is answered with the site's own change", () => {
  it("the prompt tells the model so, and names the site's largest supported cause", async () => {
    const { o, chat } = await ask(QB, [goodNarrative], {}, {}, ["Brixton"]);
    const sys = String(chat.requests.find((r) => r.step === "narrative")!.req.messages[0].content);
    assert.match(sys, /The question is about Crumb & Co Brixton only, so the headline and the first sentence are about ITS OWN change/);
    assert.match(sys, /and name its largest supported cause \(H\d+ /);
    assert.equal(o.scope.label, "S2");
  });
  it("opening with a single-day statistic, or without the site's ΔC, is rejected; the corrected answer opens with ΔC and the largest cause", async () => {
    const dayFirst = edit((n, L) => { n.sentences[0].text = `The most unusual day, ${ph(L, "Unusual day 1: date")}, used ${ph(L, "Unusual day 1: electricity used")}.`; n.sentences.push({ text: `The bill rose by ${ph(L, "Change in the bill, window")}.` }); });
    const { o } = await ask(QB, [dayFirst, goodNarrative], FREEZER_S2, {}, ["Brixton"]);
    const errs = o.verification.history[0].errors.join("\n");
    assert.match(errs, /sentences\[0\]: the first sentence is about a single day/); assert.match(errs, /sentences\[0\]: the first sentence must give the size of the change: cite F\d+ = £[\d,.]+ \(this site's own change\)/);
    const q = qualityContext(o.facts, o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })), { type: "why_cost_change", siteScoped: true });
    const first = o.answer.sentences[0];
    assert.ok(first.facts.includes(q.billFact!), "the first sentence cites the site's ΔC");
    if (q.topCause) assert.ok(first.facts.some((id) => q.topCause!.factIds.includes(id)), "…and its largest supported cause");
    assert.ok(!first.facts.some((id) => q.dayStatFacts.includes(id)));
  });
  it("a headline that is not about the site's own bill change is replaced by the deterministic one (no correction round trip)", async () => {
    const wrong = edit((n, L) => { n.headline = `Electricity use rose on ${ph(L, "Unusual day 1: date")}`; });
    const { o } = await ask(QB, [wrong], FREEZER_S2, {}, ["Brixton"]);
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "llm");
    assert.match(o.answer.headline, /^Crumb & Co Brixton's electricity bill rose by £[\d,.]+ \(\d+\.\d%\)$/);
    assert.ok(o.verification.repairs.some((r) => /headline lacked the size of the change: the deterministic headline was used/.test(r)));
  });
  it("for the whole business the lead need not name a cause, but a single-day opening is still rejected", async () => {
    const dayFirst = edit((n, L) => { n.sentences[0].text = `The most unusual day, ${ph(L, "Unusual day 1: date")}, used ${ph(L, "Unusual day 1: electricity used")}; in window A, the baseline.`; n.sentences.push({ text: `The bill rose by ${ph(L, "Change in the bill, window")}.` }); });
    const { o } = await ask(Q, [dayFirst, goodNarrative], FREEZER);
    assert.ok(o.verification.history[0].errors.some((e) => /the first sentence is about a single day/.test(e)));
  });
  it("the template for a site question also opens with the site's change and its largest cause, and says what it compares in a second sentence", async () => {
    const t = ok(await investigate(QB, { engine: "plain", data: scenario().data, chat: fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], narrative: [new Error("down")] }) }));
    assert.equal(t.verification.mode, "template"); assert.equal(t.verification.passed, true, t.verification.errors.join("\n"));
    const a = t.answer;
    assert.match(a.sentences[0].text, /^Crumb & Co Brixton's electricity bill (rose|fell) by £[\d,.]+ \(\d+\.\d%\), from £[\d,.]+ to £[\d,.]+, mostly because /);
    assert.match(a.sentences[1].text, /^This compares window A \(2026-08-27 to 2026-09-23\) with window B/);
    assert.match(a.headline, /^Crumb & Co Brixton's electricity bill (rose|fell) by £[\d,.]+/);
  });
});

describe("3. headline: sentence case, at most 90 characters, with the size of the change", () => {
  it("capitals are set in sentence case in code, units and ids keep their spelling, and nothing is sent back to the model", async () => {
    const shout = edit((n, L) => { n.headline = `YOUR BILL ROSE BY ${ph(L, "Change in the bill, window")} (${ph(L, "Change in the bill as a share")}) AND S2 USED ${ph(L, "Electricity used in window B")} IN WINDOW B`; });
    const { o } = await ask(Q, [shout]);
    assert.equal(o.verification.attempts, 1);
    assert.match(o.answer.headline, /^Your bill rose by £[\d,.]+ \(\d+\.\d%\) and S2 used [\d,]+ kWh in window b$/);
    assert.ok(o.verification.repairs.includes("headline was in capitals: set in sentence case"));
  });
  it("a headline over 90 characters is cut at a clause boundary that keeps the size; the stored headline is within 90", async () => {
    const long = edit((n, L) => { n.headline = `Your electricity bill rose by ${ph(L, "Change in the bill, window")}, mainly because the weather turned colder and unit prices were higher across the whole four weeks`; });
    const { o } = await ask(Q, [long]);
    assert.ok(o.answer.headline.length <= HEADLINE_MAX_CHARS, o.answer.headline);
    assert.match(o.answer.headline, /^Your electricity bill rose by £[\d,.]+/);
    assert.ok(o.verification.repairs.some((r) => /^headline was \d+ characters: cut to \d+$/.test(r)));
  });
  it("every verified answer has a headline of at most 90 characters with a size, whatever the model wrote", async () => {
    for (const h of ["", "Prices", "A".repeat(200), "THE BILL IS UP", "Your bill rose"]) {
      const { o } = await ask(Q, [edit((n) => { n.headline = h; })]);
      assert.ok(o.answer.headline.length > 0 && o.answer.headline.length <= HEADLINE_MAX_CHARS, `${h}: ${o.answer.headline}`);
      assert.ok(tokenize(o.answer.headline).some((t) => ["delta_bill", "delta_bill_pct", "delta_kwh", "delta_kwh_pct"].some((k) => tokenMatchesFact(t, o.facts.find((f) => f.key === k)!))), o.answer.headline);
      assert.notEqual(o.answer.headline, o.answer.headline.toUpperCase());
    }
  });
  it("the template headline is sentence case within 90 characters for every question type and for a site with a long name", async () => {
    for (const type of ["why_cost_change", "why_spike_day", "why_emissions", "what_to_change"] as const) {
      const o = ok(await investigate("q", { engine: "plain", data: scenario({ siteNames: { S1: "Crumb & Co Shoreditch", S2: "Crumb & Co Brixton Hill Market Street", S3: "Crumb & Co Hampstead" } }).data, chat: fakeChat({ intent: [INTENT_OK({ type, sites: ["S2"] })], plan: [PLAN_OK()], narrative: [new Error("down")] }) }));
      assert.ok(o.answer.headline.length <= HEADLINE_MAX_CHARS && o.answer.headline.length > 10, `${type}: ${o.answer.headline}`);
      assert.match(o.answer.headline, /^[A-Z]/); assert.ok(o.verification.passed, o.verification.errors.join("\n"));
    }
  });
});

describe("inline evidence markers", () => {
  it("[E1, E5] written into the prose is removed (the answer shows its evidence itself) and noted", async () => {
    const marked = edit((n) => { n.sentences[1].text += " [E1, E5] [E3]"; n.ruledOut[0].text += " [E9]"; });
    const { o } = await ask(Q, [marked]);
    assert.equal(o.verification.attempts, 1);
    assert.ok(!/\[E\d/.test(o.answer.sentences[1].text) && !/\[E\d/.test(o.answer.ruledOut[0].text), o.answer.sentences[1].text);
    assert.ok(o.verification.repairs.some((r) => /^sentences\[1\]: inline evidence markers removed$/.test(r)));
  });
});

describe("the historical-counterfactual clause", () => {
  it("is appended in code when it is the only thing wrong, so no corrective round trip is spent on it", async () => {
    const bare = edit((n, L) => { n.recommendation.text = `Staying on Agile saved ${ph(L, "Flat tariff minus Agile in window B", true)} against a flat business tariff over the four weeks; shifting flexible load saved only ${ph(L, "Load shift: money saved")} and ${ph(L, "Load shift: carbon saved")}.`; });
    const { o, chat } = await ask(Q, [bare]);
    assert.equal(o.verification.attempts, 1); assert.equal(o.verification.mode, "llm");
    assert.equal(chat.requests.filter((r) => r.step === "narrative").length, 1);
    assert.match(o.answer.recommendation.text, /kgCO2e\. This is a historical counterfactual on the same kWh, not advice\.$/);
    assert.ok(o.verification.repairs.includes("recommendation: the historical-counterfactual clause was appended"));
  });
  it("is not appended when other things are wrong too (the model is asked to correct them)", async () => {
    const wrongOrder = edit((n, L) => { n.recommendation.text = `Shifting flexible load saved ${ph(L, "Load shift: money saved")} and ${ph(L, "Load shift: carbon saved")}; staying on Agile saved ${ph(L, "Flat tariff minus Agile in window B", true)} against a flat business tariff.`; });
    const { o } = await ask(Q, [wrongOrder, goodNarrative]);
    assert.equal(o.verification.attempts, 2);
    assert.ok(o.verification.history[0].errors.some((e) => /the first £ figure must be the option with the largest effect/.test(e)));
  });
});

describe("a sentence about prices", () => {
  it("that offers a usage figure as the price effect is sent back, and the corrected sentence passes", async () => {
    const bad = edit((n, L) => { n.sentences.push({ text: `Higher wholesale prices also lifted the bill (${ph(L, "Electricity used in window A")} from the price-level effect).` }); });
    const { o } = await ask(Q, [bad, goodNarrative]);
    assert.ok(o.verification.history[0].errors.some((e) => /a sentence about prices needs a price figure/.test(e)), o.verification.history[0].errors.join("\n"));
    assert.equal(o.verification.attempts, 2);
  });
});

describe("4. ruled-out items are one short clause", () => {
  it("a second sentence is cut off and the trimming is noted", async () => {
    const wordy = edit((n, L) => { n.ruledOut[0].text = `Timing is ruled out: it moved the bill by only ${ph(L, "Timing effect T:")}. Moving use between cheaper and dearer times made no real difference at all to what the owner pays.`; });
    const { o } = await ask(Q, [wordy]);
    assert.equal(o.verification.attempts, 1);
    assert.match(o.answer.ruledOut[0].text, /^Timing is ruled out: it moved the bill by only £[\d,.]+\.$/);
    assert.ok(o.verification.repairs.includes("ruledOut[0] trimmed to one short clause"));
  });
  it("a long clause is cut at a boundary, keeping the figure", async () => {
    const long = edit((n, L) => { n.ruledOut[0].text = `Timing is ruled out because moving usage between the cheaper and the dearer times of the day changed the bill by only ${ph(L, "Timing effect T:")}, and the peak share of use hardly moved either across the two windows that were compared`; });
    const { o } = await ask(Q, [long]);
    assert.ok(o.answer.ruledOut[0].text.split(/\s+/).length <= 22 && /£[\d,.]+/.test(o.answer.ruledOut[0].text), o.answer.ruledOut[0].text);
  });
  it("a figure written as digits in a ruled-out item is not accepted unless it spells a fact", async () => {
    const digits = edit((n, L) => { n.ruledOut[0].text = `Timing is ruled out: it moved the bill by only £9,999 (${ph(L, "Timing effect T as a share")}).`; });
    const { o } = await ask(Q, [digits, goodNarrative]);
    assert.ok(o.verification.history[0].errors.some((e) => /ruledOut\[0\]: digits written outside placeholders \("£9,999"\)/.test(e)));
  });
  it("the template's ruled-out items are single clauses of at most 30 words", async () => {
    const o = ok(await investigate(Q, { engine: "plain", data: scenario().data, chat: fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], narrative: [new Error("down")] }) }));
    assert.ok(o.answer.ruledOut.length >= 3);
    for (const r of o.answer.ruledOut) assert.ok(r.text.split(/\s+/).length <= 30 && !/[.!?]\s+[A-Z]/.test(r.text), r.text);
  });
});

describe("the template follows the same rules", () => {
  const run = async (q: string, intent: object, over: Parameters<typeof scenario>[0] = {}) => ok(await investigate(q, { engine: "plain", data: scenario(over).data, chat: fakeChat({ intent: [INTENT_OK(intent)], plan: [PLAN_OK()], narrative: [new Error("down")] }) }));
  it("its recommendation leads with the largest option: Agile cheaper, flat cheaper, and a load shift that is larger", async () => {
    const agile = await run(Q, {});
    assert.match(agile.answer.recommendation.text, /^Staying on Agile saved £[\d,.]+ against the flat Flexible Octopus Business \(August 2025\) tariff over the four weeks \(£[\d,.]+ against £[\d,.]+\); that is a historical counterfactual on the same electricity, not advice, and nothing to change\. Shifting [\d.]+ kWh of flexible load out of the 16:00-19:00 peak/);
    assert.match(agile.answer.recommendation.text, /would have saved only £[\d,.]+ and [\d.]+ kgCO2e on window B prices\.$/);
    const flat = await run(Q, {}, { flat: [{ from: "2026-05-31T23:00:00Z", to: null, excP: 8, standingExc: 20 }] });
    assert.match(flat.answer.recommendation.text, /^The flat Flexible Octopus Business \(August 2025\) tariff would have cost £[\d,.]+ less than Agile over the four weeks/);
    const near = await run(Q, {}, { flat: [{ from: "2026-05-31T23:00:00Z", to: null, excP: 21.7, standingExc: 36 }] });
    for (const o of [agile, flat, near]) {
      const q = qualityContext(o.facts, o.results.map((r) => ({ id: r.id, name: r.name, status: r.status })), { type: "why_cost_change", siteScoped: false });
      assert.deepEqual(makeChecks(q, o.facts)(o.answer), []);
      assert.ok(tokenMatchesFact(firstMoney(o.answer.recommendation.text), o.facts.find((f) => f.rank === 1)!), o.answer.recommendation.text);
    }
    assert.ok(near.verification.passed);
  });
  it("it passes the full verifier with the quality checks for every question type, whole business and one site", async () => {
    for (const intent of [{}, { type: "why_spike_day" }, { type: "why_emissions" }, { type: "what_to_change" }, { sites: ["Brixton"] }, { type: "what_to_change", sites: ["Hampstead"] }]) {
      const o = await run("Why?", intent, FREEZER);
      assert.equal(o.verification.mode, "template");
      assert.equal(o.verification.passed, true, JSON.stringify(intent) + o.verification.errors.join("\n"));
    }
  });
  it("templateAnswer on its own (no quality context) still gives a verifiable whole-business answer", async () => {
    const o = await run(Q, {});
    const hyps = o.results.map((r) => ({ id: r.id, name: r.name, status: r.status }));
    const a = templateAnswer(o.facts, hyps, "why_cost_change");
    assert.deepEqual(verifyAnswer(a, { facts: o.facts, evidenceIds: o.evidence.map((e) => e.id), hypotheses: hyps, requireRecommendation: true }).errors, []);
  });
});

describe("the markovian engine uses the same rules", () => {
  /** A narrative written from the facts the narrative chunk can see (interpret chunks hide the details of the tests they read). */
  const visible = (recFirst: "tariff" | "shift") => (req: ChatRequest): string => {
    const L = factLines(req), sys = String(req.messages[0].content);
    const f = (start: string, abs = false) => ph(L, start, abs);
    const top = L.find((l) => l.hyp === "H3") ?? L.find((l) => l.hyp !== "-" && l.hyp !== "REC" && new RegExp(`^${l.hyp} [^\\n]*: supported$`, "m").test(sys))!;
    const tariff = `staying on Agile saved ${f("Flat tariff minus Agile in window B", true)} against a flat business tariff, a historical counterfactual`;
    const shift = `shifting load would have saved only ${f("Load shift: money saved")} and ${f("Load shift: carbon saved")}`;
    return JSON.stringify({
      headline: `Your bill rose by ${f("Change in the bill, window")}`,
      sentences: [{ text: `Your bill rose by ${f("Change in the bill, window")} (${f("Change in the bill as a share")}), mostly because of {${top.id}}.` }, { text: `The bill was ${f("Electricity bill in window A")} before and ${f("Electricity bill in window B")} after.` }],
      ruledOut: [], recommendation: { text: recFirst === "tariff" ? `${tariff[0].toUpperCase()}${tariff.slice(1)}; ${shift}.` : `${shift[0].toUpperCase()}${shift.slice(1)}; ${tariff}.` },
    });
  };
  it("its narrative chunk carries the ranked options and a bad lead is corrected the same way", async () => {
    const { interpretOk } = await import("./agent_testkit.ts");
    const chat = fakeChat({ intent: [INTENT_OK()], plan: [PLAN_OK()], interpret: [interpretOk], narrative: [visible("shift"), visible("tariff")] });
    const o = ok(await investigate(Q, { data: scenario().data, chat }));
    const narr = chat.requests.filter((r) => r.step === "narrative");
    assert.match(String(narr[0].req.messages[0].content), /^1\. staying on Agile saved \{F\d+:abs\}/m);
    assert.equal(o.engine, "markovian"); assert.equal(o.verification.mode, "llm"); assert.equal(o.verification.attempts, 2);
    assert.ok(o.verification.history[0].errors.some((e) => /the first £ figure must be the option with the largest effect/.test(e)));
    assert.match(o.answer.recommendation.text, /^Staying on Agile saved/);
  });
});
