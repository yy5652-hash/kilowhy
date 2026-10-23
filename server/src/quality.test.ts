// Meaning checks (quality.ts): option ranking, recommendation order, site questions, headline repair, one-clause ruled-out items, past one-off events. Pure.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qualityContext, makeChecks, tidyHeadline, sentenceCase, oneClause, fallbackHeadline, HEADLINE_MAX_CHARS, type QualityCtx } from "./quality.ts";
import { rankOptions, annotateOptions, optionsBlock } from "./facts_options.ts";
import { displayFor } from "./facts_format.ts";
import type { Fact } from "./facts.ts";
import { errorLine, type Answer, type AnswerItem, type HypInfo } from "./verifier.ts";

let n = 0;
const mk = (list: Fact[]) => (key: string, value: Fact["value"], unit: string, hypothesis?: string): Fact => { const f: Fact = { id: `F${++n}`, key, label: key, value, unit, display: displayFor(value, unit), evidence: "E1", ...(hypothesis ? { hypothesis } : {}) }; list.push(f); return f; };

/** Facts of a question about Brixton: price level and weather are supported, there is a freezer-type spike in window A, and the tariff counterfactual beats the load shift. */
function world(over: { flat?: number; saved?: number } = {}) {
  n = 0;
  const facts: Fact[] = [], add = mk(facts);
  const f = {
    sites: add("sites", "S2 (Crumb & Co Brixton)", "text"), bill: add("delta_bill", 104.67, "GBP"), pct: add("delta_bill_pct", 15.5, "%"), billA: add("bill_A", 675.1, "GBP"), billB: add("bill_B", 779.77, "GBP"),
    kwh: add("delta_kwh", 179, "kWh"), kwhPct: add("delta_kwh_pct", 6.9, "%"),
    L: add("L", 57.84, "GBP", "H1"), Lshare: add("L_share", 55.3, "%", "H1"), W: add("v_weather", 37.31, "GBP", "H3"), Wshare: add("v_weather_share", 35.6, "%", "H3"),
    T: add("T", 1.03, "GBP", "H5"), Tshare: add("T_share", 1, "%", "H5"),
    day: add("top_day", "2026-10-17", "date", "H6"), dayShare: add("top_day_share", 31, "%", "H6"),
    spikeDay: add("spike_1_day", "2026-09-20", "date", "H11"), spikeWin: add("spike_1_window", "window A (the baseline)", "text", "H11"), spikeKwh: add("spike_1_kwh", 124, "kWh", "H11"),
    event: add("event_1", "SAMPLE: One-off freezer fault; extra kWh consumed all day.", "text", "H4"),
    flat: add("flat_minus_agile_B", over.flat ?? 170.08, "GBP", "REC"), saved: add("rec_saved", over.saved ?? 0.1, "GBP", "REC"), kg: add("rec_saved_kg", 0.4, "kgCO2e", "REC"),
    name: add("tariff_name", "Flexible Octopus Business", "text", "REC"), flatB: add("flat_total_B", 949.42, "GBP", "REC"), agileB: add("agile_total_B", 779.34, "GBP", "REC"),
  };
  const hyps: HypInfo[] = [{ id: "H1", name: "price_level", status: "supported" }, { id: "H3", name: "weather_volume", status: "supported" }, { id: "H4", name: "operational_change", status: "inconclusive" }, { id: "H5", name: "timing_shift", status: "ruled_out" }, { id: "H6", name: "one_off_day", status: "supported" }, { id: "H11", name: "usage_anomaly_day", status: "supported" }];
  return { facts, f, hyps };
}
const item = (text: string, ids: string[]): AnswerItem => ({ text, facts: ids, evidence: ["E1"] });
const answer = (w: ReturnType<typeof world>, over: Partial<Answer> = {}): Answer => ({
  headline: "Crumb & Co Brixton's electricity bill rose by £104.67",
  sentences: [
    item("Crumb & Co Brixton's bill rose by £104.67 (15.5%), mostly because unit prices were higher (£57.84).", [w.f.bill.id, w.f.pct.id, w.f.L.id]),
    item("Colder weather added £37.31 (35.6% of the change).", [w.f.W.id, w.f.Wshare.id]),
    item("An unusual day, 2026-09-20, falls in window A (the baseline), so it raised the baseline.", [w.f.spikeDay.id, w.f.spikeWin.id]),
  ],
  ruledOut: [{ hypothesis: "H5", ...item("Timing is ruled out: only £1.03 (1.0%).", [w.f.T.id, w.f.Tshare.id]) }],
  recommendation: item("Staying on Agile saved £170.08 against a flat business tariff over the four weeks, a historical counterfactual; shifting load would have saved only £0.10 and 0.4 kgCO2e.", [w.f.flat.id, w.f.saved.id, w.f.kg.id]),
  ...over,
});
const ctx = (w: ReturnType<typeof world>, o: Partial<{ type: QualityCtx["type"]; siteScoped: boolean }> = {}) => qualityContext(w.facts, w.hyps, { type: o.type ?? "why_cost_change", siteScoped: o.siteScoped ?? true });
const run = (w: ReturnType<typeof world>, a: Answer, o: Parameters<typeof ctx>[1] = {}) => makeChecks(ctx(w, o), w.facts)(a).map(errorLine);
const withRec = (w: ReturnType<typeof world>, text: string, ids: string[]) => answer(w, { recommendation: item(text, ids) });

describe("rankOptions: the recommendation options by computed £ effect", () => {
  it("the tariff finding (Agile cheaper) outranks a small load shift; the facts carry the rank", () => {
    const w = world();
    const o = rankOptions(w.facts);
    assert.deepEqual(o.map((x) => [x.key, x.rank, x.factId, x.direction, x.gbp]), [["tariff", 1, w.f.flat.id, "agile_cheaper", 170.08], ["load_shift", 2, w.f.saved.id, "saving", 0.1]]);
    assert.deepEqual(o[1].extraFactIds, [w.f.kg.id]);
    annotateOptions(w.facts);
    assert.equal(w.f.flat.rank, 1); assert.equal(w.f.flat.option, "tariff"); assert.equal(w.f.saved.rank, 2); assert.equal(w.f.T.rank, undefined);
  });
  it("a flat tariff that would have been cheaper counts by its magnitude", () => {
    const w = world({ flat: -45.5 });
    const [t] = rankOptions(w.facts);
    assert.equal(t.direction, "flat_cheaper"); assert.equal(t.gbp, 45.5); assert.equal(t.rank, 1);
  });
  it("a load shift larger than the tariff difference leads", () => {
    const w = world({ flat: 2.5, saved: 40 });
    assert.deepEqual(rankOptions(w.facts).map((x) => x.key), ["load_shift", "tariff"]);
  });
  it("ties go to the tariff finding; no tariff difference and no load shift leave nothing to rank", () => {
    assert.deepEqual(rankOptions(world({ flat: 5, saved: 5 }).facts).map((x) => x.key), ["tariff", "load_shift"]);
    assert.deepEqual(rankOptions(world({ flat: 0 }).facts).map((x) => x.key), ["load_shift"]);
    assert.deepEqual(rankOptions(world().facts.filter((f) => f.hypothesis !== "REC")), []);
  });
  it("optionsBlock lists the options largest first with placeholders for the figures", () => {
    const w = world();
    const b = optionsBlock(rankOptions(w.facts)).split("\n");
    assert.match(b[0], new RegExp(`^1\\. staying on Agile saved \\{${w.f.flat.id}:abs\\} against a flat business tariff over the four weeks \\(a historical counterfactual`));
    assert.match(b[1], new RegExp(`^2\\. shifting flexible peak-band load saved \\{${w.f.saved.id}:abs\\} and \\{${w.f.kg.id}\\} on window B prices`));
    assert.match(optionsBlock(rankOptions(world({ flat: -45.5 }).facts)), /^1\. a flat business tariff would have cost \{F\d+:abs\} less than Agile/);
    assert.equal(optionsBlock([]), "");
  });
});

describe("recommendation checks", () => {
  it("a recommendation that leads with the largest option, cites every option and says plainly that Agile was cheaper passes", () => {
    const w = world();
    assert.deepEqual(run(w, answer(w)), []);
  });
  it("leading with the small load shift is rejected, with the largest option named", () => {
    const w = world();
    const e = run(w, withRec(w, "Shifting load would have saved £0.10 and 0.4 kgCO2e; staying on Agile saved £170.08 against a flat tariff, a historical counterfactual.", [w.f.saved.id, w.f.kg.id, w.f.flat.id]));
    assert.ok(e.some((x) => /the first £ figure must be the option with the largest effect \(F\d+ = £170\.08\), not £0\.10/.test(x)), e.join("\n"));
    assert.ok(e.some((x) => /present the options from the largest £ effect to the smallest/.test(x)));
  });
  it("an option left out is rejected: every option is cited with its own figure", () => {
    const w = world();
    const e = run(w, withRec(w, "Staying on Agile saved £170.08 against a flat business tariff, a historical counterfactual.", [w.f.flat.id]));
    assert.ok(e.some((x) => new RegExp(`cite ${w.f.saved.id} = £0\\.10`).test(x)));
  });
  it("the load shift is presented with its carbon figure too", () => {
    const w = world();
    const e = run(w, withRec(w, "Staying on Agile saved £170.08 against a flat business tariff, a historical counterfactual; shifting load would have saved only £0.10.", [w.f.flat.id, w.f.saved.id]));
    assert.ok(e.some((x) => new RegExp(`present the load shift with its carbon figure too: cite ${w.f.kg.id}`).test(x)), e.join("\n"));
  });
  it("when Agile was cheaper the text must say so plainly; when the flat tariff was cheaper it must say that", () => {
    const w = world();
    const vague = run(w, withRec(w, "The tariff comparison gives £170.08, a historical counterfactual; shifting load would have saved only £0.10 and 0.4 kgCO2e.", [w.f.flat.id, w.f.saved.id, w.f.kg.id]));
    assert.ok(vague.some((x) => /say plainly that Agile was cheaper/.test(x)));
    const w2 = world({ flat: -45.5 });
    const okFlat = run(w2, withRec(w2, "A flat business tariff would have cost £45.50 less than Agile over the four weeks, a historical counterfactual; shifting load would have saved only £0.10 and 0.4 kgCO2e.", [w2.f.flat.id, w2.f.saved.id, w2.f.kg.id]));
    assert.deepEqual(okFlat, []);
    const wrongWay = run(w2, withRec(w2, "Staying on Agile saved £45.50, a historical counterfactual; shifting load would have saved only £0.10 and 0.4 kgCO2e.", [w2.f.flat.id, w2.f.saved.id, w2.f.kg.id]));
    assert.ok(wrongWay.some((x) => /say plainly that the flat tariff would have been cheaper/.test(x)));
  });
  it("a past one-off event is never an option: citing it, or calling anything a lever, is rejected", () => {
    const w = world();
    const cites = run(w, withRec(w, "Staying on Agile saved £170.08 against a flat business tariff, a historical counterfactual; shifting load would have saved only £0.10 and 0.4 kgCO2e; avoiding the freezer fault (2026-09-20) is the next step.", [w.f.flat.id, w.f.saved.id, w.f.kg.id, w.f.spikeDay.id]));
    assert.ok(cites.some((x) => /may not use F\d+ = 2026-09-20: a past one-off event explains a change, it is not an option/.test(x)), cites.join("\n"));
    const lever = run(w, withRec(w, "Staying on Agile saved £170.08 against a flat business tariff, a historical counterfactual; the biggest lever is load shifting: £0.10 and 0.4 kgCO2e.", [w.f.flat.id, w.f.saved.id, w.f.kg.id]));
    assert.ok(lever.some((x) => /do not call anything a lever/.test(x)));
  });
  it("an empty recommendation or a scope without options raises nothing", () => {
    const w = world();
    assert.deepEqual(run(w, answer(w, { recommendation: item("", []) })), []);
    const none = world(); none.facts.splice(0, none.facts.length, ...none.facts.filter((f) => f.hypothesis !== "REC"));
    assert.deepEqual(makeChecks(qualityContext(none.facts, none.hyps, { type: "why_cost_change", siteScoped: true }), none.facts)(answer(none)), []);
  });
});

describe("a question about a site", () => {
  it("passes when the headline and the first sentence carry the site's own change and its largest supported cause", () => {
    const w = world();
    const q = ctx(w);
    assert.equal(q.siteName, "Crumb & Co Brixton"); assert.equal(q.topCause?.hyp, "H1");
    assert.deepEqual(run(w, answer(w)), []);
  });
  it("the largest supported cause is the one with the largest share of the change", () => {
    const w = world();
    w.hyps.find((h) => h.id === "H1")!.status = "inconclusive";
    assert.equal(ctx(w).topCause?.hyp, "H3");
    w.hyps.find((h) => h.id === "H3")!.status = "inconclusive";
    assert.equal(ctx(w).topCause, null);
  });
  it("opening with a single-day statistic is rejected", () => {
    const w = world();
    const e = run(w, answer(w, { sentences: [item("One day, 2026-10-17, accounts for 31.0% of the change.", [w.f.day.id, w.f.dayShare.id, w.f.bill.id, w.f.L.id]), ...answer(w).sentences.slice(1)] }));
    assert.ok(e.some((x) => /^sentences\[0\]: the first sentence is about a single day/.test(x)), e.join("\n"));
  });
  it("a first sentence without the site's ΔC, or without its largest cause, is rejected", () => {
    const w = world();
    const noBill = run(w, answer(w, { sentences: [item("Prices rose (£57.84).", [w.f.L.id]), ...answer(w).sentences.slice(1)] }));
    assert.ok(noBill.some((x) => /^sentences\[0\]: the first sentence must give the size of the change: cite F\d+ = £104\.67 \(this site's own change\)/.test(x)), noBill.join("\n"));
    const noCause = run(w, answer(w, { sentences: [item("Crumb & Co Brixton's bill rose by £104.67 (15.5%).", [w.f.bill.id, w.f.pct.id]), ...answer(w).sentences.slice(1)] }));
    assert.ok(noCause.some((x) => /^sentences\[0\]: the first sentence must also name this site's largest supported cause \(H1 price_level\)/.test(x)), noCause.join("\n"));
  });
  it("a headline without the site's own change is rejected; the cross-site day statistic is no substitute", () => {
    const w = world();
    const e = run(w, answer(w, { headline: "Electricity use rose 6.9% on 2026-10-17" }));
    assert.ok(e.some((x) => /^headline: the headline must contain the size of the change \(F\d+ = £104\.67 or F\d+ = 15\.5%\)/.test(x)), e.join("\n"));
  });
  it("for the whole business the usage change also counts as the size of the change, and the cause need not be in the first sentence", () => {
    const w = world();
    const a = answer(w, { headline: "Electricity use rose 6.9%", sentences: [item("Your bill rose by £104.67 (15.5%).", [w.f.bill.id, w.f.pct.id]), ...answer(w).sentences.slice(1)] });
    assert.deepEqual(run(w, a, { siteScoped: false }), []);
    assert.ok(run(w, a, { siteScoped: true }).length > 0);
  });
  it("other question types are not held to the lead rules", () => {
    const w = world();
    assert.deepEqual(run(w, answer(w, { sentences: [item("One day, 2026-10-17, is 31.0% of the change.", [w.f.day.id, w.f.dayShare.id]), ...answer(w).sentences.slice(1)] }), { type: "why_spike_day" }), []);
  });
});

describe("past one-off events and unusual days in the baseline", () => {
  it("a sentence that presents an unusual day or a logged event as a saving or a lever is rejected", () => {
    const w = world();
    const a = answer(w, { sentences: [...answer(w).sentences.slice(0, 2), item("Avoiding another freezer fault like the one on 2026-09-20 in window A (the baseline) is a saving.", [w.f.spikeDay.id, w.f.spikeWin.id])] });
    assert.ok(run(w, a).some((x) => /^sentences\[2\]: a past one-off event \(an unusual day, a fault\) explains a change; it is not a lever or a saving/.test(x)));
  });
  it("an unusual day in window A must be said to be in the baseline", () => {
    const w = world();
    const a = answer(w, { sentences: [...answer(w).sentences.slice(0, 2), item("An unusual usage day on 2026-09-20 added 124 kWh.", [w.f.spikeDay.id, w.f.spikeKwh.id])] });
    assert.ok(run(w, a).some((x) => /^sentences\[2\]: this unusual day falls in window A, the baseline: say so/.test(x)));
    assert.ok(!run(w, answer(w)).some((x) => /unusual day falls in window A/.test(x)));
  });
});

describe("remembered notes and words of past events", () => {
  const note = (w: ReturnType<typeof world>, bearsOn: string[]): Fact => ({ id: "M1", key: "memory_1", label: "Remembered note", value: "Brixton moved its oven schedule later", unit: "text", display: "Brixton moved its oven schedule later", evidence: "",
    memory: { id: "mem-1", origin: "user", site: "S2", learnedAt: "2026-10-22T10:00:00.000Z", confidence: 0.9, relevance: 0.4, bearsOn } });
  it("a note may be used next to the logged event it explains (or another fact of the same test), not next to unrelated facts", () => {
    const w = world(), m = note(w, [w.f.event.id]);
    const facts = [...w.facts, m];
    const q = qualityContext(facts, w.hyps, { type: "why_cost_change", siteScoped: true });
    assert.deepEqual(q.noteAllowed, { M1: [w.f.event.id] });
    const check = makeChecks(q, facts);
    const withNote = (ids: string[], text = "The oven schedule moved, Brixton moved its oven schedule later.") => check(answer(w, { sentences: [...answer(w).sentences.slice(0, 2), item(text, ids)] })).filter((e) => /note M1/.test(e.reason));
    assert.deepEqual(withNote([w.f.event.id, "M1"]), []);
    const bad = withNote([w.f.spikeDay.id, w.f.spikeWin.id, "M1"], "An unusual day in window A, the baseline, with Brixton moved its oven schedule later.");
    assert.equal(bad.length, 1); assert.match(bad[0].reason, /^the note M1 explains /); assert.equal(bad[0].part, "sentences");
    const inRuled = check(answer(w, { ruledOut: [{ hypothesis: "H5", ...item("Timing is ruled out: only £1.03, Brixton moved its oven schedule later.", [w.f.T.id, "M1"]) }] })).filter((e) => /note M1/.test(e.reason));
    assert.equal(inRuled.length, 1); assert.equal(inRuled[0].part, "ruledOut");
  });
  it("a note that bears on nothing is not policed here (the prompt says a note is never a source of figures)", () => {
    const w = world(), m = note(w, []);
    assert.deepEqual(qualityContext([...w.facts, m], w.hyps, { type: "why_cost_change", siteScoped: true }).noteAllowed, {});
  });
  it("a recommendation that builds advice on the words of a past one-off event is rejected", () => {
    const w = world();
    const spikeEvent: Fact = { id: "F99", key: "spike_1_event", label: "Unusual day 1: logged event", value: "SAMPLE: One-off freezer fault; extra kWh consumed all day.", unit: "text", display: "SAMPLE: One-off freezer fault; extra kWh consumed all day.", evidence: "E1", hypothesis: "H11" };
    const facts = [...w.facts, spikeEvent];
    const q = qualityContext(facts, w.hyps, { type: "why_cost_change", siteScoped: true });
    assert.deepEqual(q.oneOffWords.sort(), ["fault", "freezer"]);
    const rec = (t: string) => makeChecks(q, facts)(answer(w, { recommendation: item(t, [w.f.flat.id, w.f.saved.id, w.f.kg.id]) })).map(errorLine).filter((e) => /past one-off event; an event explains/.test(e));
    assert.equal(rec("Staying on Agile saved £170.08 against a flat business tariff, a historical counterfactual; shifting freezer defrost cycles would have saved only £0.10 and 0.4 kgCO2e.").length, 1);
    assert.deepEqual(rec("Staying on Agile saved £170.08 against a flat business tariff, a historical counterfactual; shifting baking would have saved only £0.10 and 0.4 kgCO2e."), []);
  });
});

describe("a sentence about prices shows a price figure", () => {
  it("a bare usage figure, offered as the size of the price effect, is rejected; £, %, p/kWh and pp are fine", () => {
    const w = world();
    const bad = answer(w, { sentences: [...answer(w).sentences.slice(0, 2), item("Higher wholesale prices also lifted the bill (179 kWh from the price-level effect).", [w.f.kwh.id])] });
    assert.ok(run(w, bad).some((x) => /^sentences\[2\]: a sentence about prices needs a price figure \(£, %, p\/kWh or pp\); this one shows only 179 kWh/.test(x)), run(w, bad).join("\n"));
    for (const t of ["Prices rose, adding £57.84.", "Prices rose, a 55.3% share of the change.", "Average prices went up 3.1 pp."]) {
      assert.deepEqual(run(w, answer(w, { sentences: [...answer(w).sentences.slice(0, 2), item(t, [w.f.L.id])] })).filter((x) => /about prices/.test(x)), [], t);
    }
  });
});

describe("ruled-out items are one short clause", () => {
  it("a second sentence or more than thirty words is rejected; a quoted logged event counts as one word", () => {
    const w = world();
    const two = answer(w, { ruledOut: [{ hypothesis: "H5", ...item("Timing is ruled out. It moved the bill by only £1.03.", [w.f.T.id]) }] });
    assert.ok(run(w, two).some((x) => /^ruledOut\[0\]: a ruled-out item is one short clause/.test(x)));
    const long = answer(w, { ruledOut: [{ hypothesis: "H5", ...item(`Timing is ruled out because ${"very ".repeat(30)}little of the bill, only £1.03.`, [w.f.T.id]) }] });
    assert.ok(run(w, long).some((x) => /one short clause/.test(x)));
    const quoted = answer(w, { ruledOut: [{ hypothesis: "H5", ...item("Timing is ruled out: only £1.03, though a logged event says SAMPLE: One-off freezer fault; extra kWh consumed all day.", [w.f.T.id, w.f.event.id]) }] });
    assert.deepEqual(run(w, quoted).filter((x) => /one short clause/.test(x)), []);
  });
  it("a second sentence that carries a remembered note may follow the clause", () => {
    const w = world();
    const note = { id: "M1", key: "memory_1", label: "note", value: "Brixton moved its oven schedule later from 7 Oct for the sourdough line", unit: "text", display: "Brixton moved its oven schedule later from 7 Oct for the sourdough line", evidence: "", memory: { id: "mem-1", origin: "user" as const, site: "S2", learnedAt: "2026-10-22T10:00:00.000Z", confidence: 0.9, relevance: 0.4 } };
    const facts = [...w.facts, note];
    const a = answer(w, { ruledOut: [{ hypothesis: "H5", ...item(`Timing is ruled out: only £1.03. It fits ${note.display}.`, [w.f.T.id, "M1"]) }] });
    assert.deepEqual(makeChecks(qualityContext(facts, w.hyps, { type: "why_cost_change", siteScoped: true }), facts)(a).filter((e) => e.part === "ruledOut"), []);
  });
});

describe("tidyHeadline", () => {
  const w = world();
  const q = ctx(w);
  it("capitals become sentence case; units, ids and the site name keep their spelling", () => {
    const r = tidyHeadline("CRUMB & CO BRIXTON'S BILL ROSE BY £104.67 (15.5%) AND S2 USED 179 KWH MORE, MAINLY ON H3", q, w.facts);
    assert.equal(r.text, "Crumb & Co Brixton's bill rose by £104.67 (15.5%) and S2 used 179 kWh more, mainly on H3");
    assert.deepEqual(r.notes, ["headline was in capitals: set in sentence case"]);
  });
  it("sentenceCase on its own: kgCO2e, HDD, p/kWh, Agile", () => {
    assert.equal(sentenceCase("EMISSIONS ROSE BY 64.3 KGCO2E AS HDD AND P/KWH MOVED UNDER AGILE", w.facts), "Emissions rose by 64.3 kgCO2e as HDD and p/kWh moved under Agile");
  });
  it("a normal headline is left alone; a leading lower-case letter is raised; a trailing full stop and quotes go", () => {
    assert.deepEqual(tidyHeadline("Your bill rose by £104.67", q, w.facts), { text: "Your bill rose by £104.67", notes: [] });
    assert.equal(tidyHeadline('"the bill rose by £104.67."', q, w.facts).text, "The bill rose by £104.67");
  });
  it("a headline over 90 characters is cut at a clause boundary and keeps the size of the change", () => {
    const long = "Crumb & Co Brixton's electricity bill rose by £104.67 (15.5%), mainly because unit prices were higher and the weather turned much colder across the whole period";
    assert.ok(long.length > HEADLINE_MAX_CHARS);
    const r = tidyHeadline(long, q, w.facts);
    assert.ok(r.text.length <= HEADLINE_MAX_CHARS && r.text.includes("£104.67"), r.text);
    assert.match(r.notes[0], /^headline was \d+ characters: cut to \d+$/);
  });
  it("a cut never leaves a dangling connective such as 'driven' or 'mainly by'", () => {
    const long = "Your electricity bill rose by £104.67 over the four weeks, driven mainly by higher wholesale prices and colder weather";
    assert.ok(long.length > HEADLINE_MAX_CHARS);
    assert.equal(tidyHeadline(long, q, w.facts).text, "Your electricity bill rose by £104.67 over the four weeks");
  });
  it("a headline that cannot be cut keeps no size, or lacks it: the deterministic headline replaces it", () => {
    assert.equal(q.fallbackHeadline, "Crumb & Co Brixton's electricity bill rose by £104.67 (15.5%)");
    const noSize = tidyHeadline("Prices and weather both pushed the bill up", q, w.facts);
    assert.equal(noSize.text, q.fallbackHeadline); assert.match(noSize.notes[0], /lacked the size of the change/);
    const noCut = tidyHeadline(`${"Verylongwordwithoutanybreakshere ".repeat(4)}£104.67`, q, w.facts);
    assert.equal(noCut.text, q.fallbackHeadline);
    assert.equal(tidyHeadline("", q, w.facts).text, q.fallbackHeadline);
  });
  it("a headline written with the usage change counts as the size for the whole business", () => {
    const all = qualityContext(w.facts, w.hyps, { type: "why_cost_change", siteScoped: false });
    assert.equal(tidyHeadline("Electricity use rose 6.9% to 179 kWh more", all, w.facts).text, "Electricity use rose 6.9% to 179 kWh more");
  });
  it("without a quality context it only tidies", () => { assert.equal(tidyHeadline("THE BILL ROSE BY £104.67.", undefined, w.facts).text, "The bill rose by £104.67"); });
  it("fallbackHeadline: whole business, falling bill, emissions", () => {
    const f = world();
    assert.equal(fallbackHeadline(f.facts, "why_cost_change", false, null), "Your electricity bill rose by £104.67 (15.5%)");
    f.f.bill.value = -12.34; f.f.bill.display = displayFor(-12.34, "GBP"); f.f.pct.value = -1.5; f.f.pct.display = displayFor(-1.5, "%");
    assert.equal(fallbackHeadline(f.facts, "why_cost_change", false, null), "Your electricity bill fell by £12.34 (1.5%)");
    assert.equal(fallbackHeadline(f.facts, "why_cost_change", true, null), "The electricity bill of these sites fell by £12.34 (1.5%)");
    assert.equal(fallbackHeadline(f.facts, "why_emissions", false, null), null);
  });
  it("the headline check rejects capitals, length and a missing size when nothing repaired them", () => {
    const e = run(w, answer(w, { headline: "THE BILL ROSE AND ROSE AND ROSE, DRIVEN BY PRICES, WEATHER AND AN UNUSUAL DAY IN THE BASELINE PERIOD" }));
    assert.ok(e.some((x) => /headline: the headline is written in capitals/.test(x)));
    assert.ok(e.some((x) => /headline: the headline is \d+ characters; keep it to 90 or fewer/.test(x)));
    assert.ok(e.some((x) => /headline: the headline must contain the size of the change/.test(x)));
  });
});

describe("oneClause", () => {
  it("keeps the first sentence of a ruled-out item", () => {
    const r = oneClause("Timing is ruled out: it moved the bill by only {F4}. It also had no effect elsewhere.");
    assert.equal(r.text, "Timing is ruled out: it moved the bill by only {F4}."); assert.equal(r.trimmed, true);
  });
  it("cuts a long clause at a boundary, keeping a placeholder", () => {
    const raw = "Timing shifts are ruled out because moving usage between cheaper and dearer times of the day changed the bill by only {F4} in total, with the peak band share barely moving at all across both windows {F9}";
    const r = oneClause(raw);
    assert.ok(r.text.split(/\s+/).length <= 22 && /\{F4\}/.test(r.text), r.text);
    assert.equal(r.trimmed, true);
    assert.match(r.text, /\.$/);
  });
  it("leaves a short clause alone (and adds the full stop)", () => {
    assert.deepEqual(oneClause("Weather is ruled out: its part was {F3}"), { text: "Weather is ruled out: its part was {F3}.", trimmed: false });
  });
  it("keeps a sentence that carries a remembered note", () => {
    const r = oneClause("Timing is ruled out: only {F4}. Another sentence. It fits {M1}.");
    assert.equal(r.text, "Timing is ruled out: only {F4}. It fits {M1}.");
  });
  it("without a placeholder inside the first words it does not cut", () => {
    const raw = `${"word ".repeat(30)}{F4}`;
    assert.equal(oneClause(raw).text, `${raw}.`);
  });
});
