// Placeholder rendering and narration assembly (pure; no LLM).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderPlaceholders, strayDigits, tidy } from "./placeholders.ts";
import { answerFromReply } from "./narration.ts";
import { displayFor } from "./facts_format.ts";
import type { Fact } from "./facts.ts";
import type { HypInfo } from "./verifier.ts";

let n = 0;
const mk = (key: string, value: Fact["value"], unit: string, hypothesis?: string, evidence = "E1"): Fact => { n++; return { id: `F${n}`, key, label: key, value, unit, display: displayFor(value, unit), evidence, ...(hypothesis ? { hypothesis } : {}) }; };
const facts = [
  mk("blocks", "10:00-13:00, 04:00-07:00, 21:00-24:00", "text", "REC", "E19"), mk("delta", 339.91, "GBP"), mk("neg", -12.34, "GBP", "H6", "E11"), mk("share", 54.91, "%", "H1", "E3"), mk("kwh", 8312.122, "kWh"), mk("day", "2026-10-17", "date", "H6", "E11"),
  mk("T", 0.86, "GBP", "H5", "E9"), mk("weather", 127.67, "GBP", "H3", "E5"), mk("billA", 2002.05, "GBP"), mk("aglA", 2002.05, "GBP", "REC", "E20"), mk("days", 28, "days"),
];
const byId = new Map(facts.map((f) => [f.id, f]));
const id = (k: string) => facts.find((f) => f.key === k)!.id;
const disp = (k: string) => facts.find((f) => f.key === k)!.display;

describe("renderPlaceholders", () => {
  it("replaces {F#} with the display and records the cited facts once, in order of first use", () => {
    const r = renderPlaceholders(`Up {${id("delta")}} ({${id("share")}}), and again {${id("delta")}}.`, byId, "s[0]");
    assert.equal(r.text, `Up £339.91 (54.9%), and again £339.91.`);
    assert.deepEqual(r.facts, [id("delta"), id("share")]);
    assert.deepEqual(r.errors, []); assert.deepEqual(r.repairs, []);
  });
  it("accepts several bracket styles and a bare id", () => {
    const f = id("delta");
    for (const raw of [`{${f}}`, `[${f}]`, `<${f}>`, `{{${f}}}`, `{ ${f} }`, f, `{${f.toLowerCase()}}`]) assert.equal(renderPlaceholders(`Up ${raw}.`, byId, "s").text, "Up £339.91.", raw);
  });
  it(":abs gives the magnitude of a negative figure", () => {
    assert.equal(renderPlaceholders(`It fell by {${id("neg")}:abs}.`, byId, "s").text, "It fell by £12.34.");
    assert.equal(renderPlaceholders(`It was {${id("neg")}}.`, byId, "s").text, `It was ${disp("neg")}.`);
    assert.equal(renderPlaceholders(`Share {${id("share")}:abs}`, byId, "s").text, "Share 54.9%");
    assert.equal(renderPlaceholders(`Day {${id("day")}:abs}`, byId, "s").text, "Day 2026-10-17");
  });
  it("an unknown id is an error", () => {
    const r = renderPlaceholders("Up {F999}.", byId, "sentences[3]");
    assert.deepEqual(r.errors, ["sentences[3]: placeholder {F999} does not exist in the facts table"]);
  });
  it("a text without any placeholder is an error", () => { assert.match(renderPlaceholders("The bill went up.", byId, "sentences[0]").errors[0], /no placeholder/); });
  it("digits outside placeholders are an error, including small counts", () => {
    const r = renderPlaceholders(`Up £999.99 over 3 sites {${id("delta")}}.`, byId, "sentences[1]");
    assert.match(r.errors[0], /^sentences\[1\]: digits written outside placeholders \("£999\.99", "3"\)/);
    assert.match(r.errors[0], /spell out small counts in words/);
  });
  it("digits that spell exactly one fact's display are repaired into its placeholder", () => {
    const r = renderPlaceholders("Up £339.91 (54.9%) on 2026-10-17 after 8,312 kWh.", byId, "sentences[0]");
    assert.deepEqual(r.errors, []);
    assert.equal(r.text, "Up £339.91 (54.9%) on 2026-10-17 after 8,312 kWh.");
    assert.deepEqual(r.facts, [id("delta"), id("share"), id("day"), id("kwh")]);
    assert.equal(r.repairs.length, 4);
    assert.equal(r.repairs[0], `sentences[0]: "£339.91" -> {${id("delta")}}`);
  });
  it("a display shared by a neutral fact and a tagged fact is repaired to the neutral one", () => {
    const r = renderPlaceholders("From £2,002.05 it rose.", byId, "s");
    assert.deepEqual(r.facts, [id("billA")]);
  });
  it("a rounded or invented figure is not guessed at", () => {
    assert.match(renderPlaceholders("Up £340 {" + id("delta") + "}.", byId, "s").errors[0], /"£340"/);
    assert.match(renderPlaceholders("Up £339.92 {" + id("delta") + "}.", byId, "s").errors[0], /"£339\.92"/);
  });
  it("ids of hypotheses and sites may stay as written; E# markers are tolerated", () => {
    const r = renderPlaceholders(`H5 and S2 and [E3] at {${id("delta")}}.`, byId, "s");
    assert.deepEqual(r.errors, []);
    assert.deepEqual(strayDigits("H10 S12 E3 {F1} F22 [F3]"), []);
  });
  it("unit names that contain a digit (kgCO2e, CO2) are not stray digits", () => {
    assert.deepEqual(strayDigits("Emissions rose in kgCO2e; CO2 and gCO2 and CO\u2082e too"), []);
    assert.deepEqual(strayDigits("about 3 kgCO2e"), ["3"]);
  });
  it("strayDigits lists the offending words without punctuation", () => { assert.deepEqual(strayDigits("It cost (£12.50), then 3, then 17 Oct."), ["£12.50", "3", "17"]); });
  it("whitespace is normalised and surrounding text is untouched", () => { assert.equal(renderPlaceholders(`  Up   {${id("delta")}}  \n today `, byId, "s").text, "Up £339.91 today"); });
});

describe("times and dates written in digits", () => {
  it("a time range that sits inside exactly one fact's display is kept and that fact is cited", () => {
    const r = renderPlaceholders("Run the oven between 04:00-07:00 to save.", byId, "recommendation");
    assert.deepEqual(r.errors, []);
    assert.equal(r.text, "Run the oven between 04:00-07:00 to save.");
    assert.deepEqual(r.facts, [id("blocks")]);
    assert.deepEqual(r.repairs, [`recommendation: "04:00" kept, ${id("blocks")} cited`, `recommendation: "07:00" kept, ${id("blocks")} cited`]);
  });
  it("several times, mixed with placeholders and with figures that are still errors", () => {
    const ok = renderPlaceholders(`Move load to 10:00-13:00 or 21:00-24:00, saving {${id("delta")}}.`, byId, "s");
    assert.deepEqual(ok.errors, []); assert.equal(ok.text, "Move load to 10:00-13:00 or 21:00-24:00, saving £339.91."); assert.deepEqual(ok.facts, [id("delta"), id("blocks")]);
    const bad = renderPlaceholders("Move load to 10:00-13:00, saving £999.", byId, "s");
    assert.match(bad.errors[0], /digits written outside placeholders \("£999"\)/);
  });
  it("a time that no fact contains is still an error", () => {
    assert.match(renderPlaceholders("At 14:00 ok {" + id("delta") + "}.", byId, "s").errors[0], /"14:00"/);
  });
});

describe("tidy", () => {
  it("removes a unit written twice, a repeated percent word, doubled full stops and stray spaces before punctuation", () => {
    assert.equal(tidy("used 124 kWh kWh against 59.7 kWh kWh expected"), "used 124 kWh against 59.7 kWh expected");
    assert.equal(tidy("up 3.1 pp pp and 4.2 pp percentage points"), "up 3.1 pp and 4.2 pp");
    assert.equal(tidy("up 4.2 percentage points"), "up 4.2 percentage points");
    assert.equal(tidy("about 3.28 kWh/HDD kWh per heating degree day and 2.6 sd standard deviations over 45.0 HDD heating degree days"), "about 3.28 kWh/HDD and 2.6 sd over 45.0 HDD");
    assert.equal(tidy("share 54.9% percent, then 12.0% %"), "share 54.9%, then 12.0%");
    assert.equal(tidy("a freezer fault.. Next ."), "a freezer fault. Next.");
    assert.equal(tidy("wait... what"), "wait... what");
  });
  it("leaves ordinary text alone", () => { assert.equal(tidy("Saved £5.23 by moving 17.4 kWh of load to 10:00-13:00."), "Saved £5.23 by moving 17.4 kWh of load to 10:00-13:00."); });
  it("is applied when rendering", () => {
    const r = renderPlaceholders(`It used {${id("kwh")}} kWh and fell by {${id("neg")}:abs}..`, byId, "s");
    assert.equal(r.text, "It used 8,312 kWh and fell by £12.34.");
  });
});

describe("answerFromReply", () => {
  const hyps: HypInfo[] = [
    { id: "H1", name: "price_level", status: "supported" }, { id: "H3", name: "weather_volume", status: "supported" }, { id: "H5", name: "timing_shift", status: "ruled_out" },
    { id: "H6", name: "one_off_day", status: "inconclusive" },
  ];
  const evidence = new Set(["E1", "E3", "E5", "E9", "E11", "E20"]);
  const P = (k: string, abs = false) => `{${id(k)}${abs ? ":abs" : ""}}`;
  const run = (reply: object) => answerFromReply(reply, facts, hyps, evidence);

  it("builds the answer: rendered text, cited facts and their evidence", () => {
    const r = run({
      headline: `Up ${P("delta")}`,
      sentences: [{ text: `Up ${P("delta")}, mostly prices (${P("share")}).` }, { text: `Weather added ${P("weather")}.` }],
      ruledOut: [{ hypothesis: "H5", text: `Timing moved ${P("T")}.` }],
      recommendation: { text: `Shift load, a counterfactual ${P("aglA")}.` },
    });
    assert.deepEqual(r.errors, []); assert.deepEqual(r.repairs, []);
    assert.equal(r.answer.headline, "Up £339.91");
    assert.deepEqual(r.answer.sentences[0], { text: "Up £339.91, mostly prices (54.9%).", facts: [id("delta"), id("share")], evidence: ["E1", "E3"] });
    assert.deepEqual(r.answer.sentences[1].evidence, ["E5"]);
    assert.deepEqual(r.answer.ruledOut, [{ hypothesis: "H5", text: "Timing moved £0.86.", facts: [id("T")], evidence: ["E9"] }]);
    assert.equal(r.answer.recommendation.evidence[0], "E20");
  });
  it("uses the model's evidence ids only when they exist, in addition to the facts' own", () => {
    const r = run({ sentences: [{ text: `Up ${P("delta")}.`, evidence: ["E3", "E99", "[E5]"] }] });
    assert.deepEqual(r.answer.sentences[0].evidence, ["E1", "E3", "E5"]);
  });
  it("drops a sentence that cites a fact of a hypothesis that is not supported (ruled out or inconclusive) and says so", () => {
    const r = run({ sentences: [{ text: `Up ${P("delta")}.` }, { text: `Timing ${P("T")}.` }, { text: `A day ${P("day")}.` }, { text: `Weather ${P("weather")}.` }] });
    assert.equal(r.answer.sentences.length, 2);
    assert.deepEqual(r.errors, []);
    assert.equal(r.repairs.length, 2);
    assert.match(r.repairs[0], /^sentences\[1\] dropped: it cites F\d+, a fact of H5, which is ruled_out/);
    assert.match(r.repairs[1], /^sentences\[2\] dropped: it cites F\d+, a fact of H6, which is inconclusive/);
  });
  it("drops ruled-out items whose hypothesis is not ruled out, unknown, or whose facts belong to a supported hypothesis", () => {
    const r = run({ sentences: [{ text: `Up ${P("delta")}.` }], ruledOut: [
      { hypothesis: "H3", text: `Weather ${P("weather")}.` }, { hypothesis: "H77", text: `X ${P("T")}.` }, { hypothesis: "timing_shift", text: `Timing ${P("T")}.` }, { hypothesis: "H5", text: `Timing ${P("T")} and prices ${P("share")}.` },
    ] });
    assert.deepEqual(r.answer.ruledOut.map((x) => x.hypothesis), ["H5"]);
    assert.equal(r.repairs.length, 3);
    assert.match(r.repairs[1], /not a tested hypothesis/);
  });
  it("a sentence or ruled-out item without any placeholder is dropped (nothing in it can be checked); the recommendation is an error", () => {
    const r = run({ sentences: [{ text: "No placeholder here." }, { text: `Up ${P("delta")}.` }], ruledOut: [{ hypothesis: "H5", text: "Timing was small." }], recommendation: { text: "Just do better." } });
    assert.equal(r.answer.sentences.length, 1); assert.equal(r.answer.ruledOut.length, 0);
    assert.equal(r.repairs.length, 2); assert.match(r.repairs[0], /^sentences\[0\] dropped: it has no \{F#\} placeholder/);
    assert.equal(r.errors.length, 1); assert.match(r.errors[0], /^recommendation: no placeholder/);
  });
  it("collects placeholder errors from every part", () => {
    const r = run({ headline: "Up 17%", sentences: [{ text: "No placeholder here." }, { text: `Up ${P("delta")}.` }], ruledOut: [{ hypothesis: "H5", text: "Timing {F404}." }], recommendation: { text: "Save £5.23 now." } });
    assert.equal(r.errors.length, 3);
    assert.ok(r.errors.some((e) => e.startsWith("headline: digits")));
    assert.ok(r.errors.some((e) => e.startsWith("ruledOut[0]: placeholder {F404}")));
    assert.ok(r.errors.some((e) => e.startsWith("recommendation: digits")));
  });
  it("a headline without a placeholder is fine; an empty recommendation stays empty", () => {
    const r = run({ headline: "Your bill went up", sentences: [{ text: `Up ${P("delta")}.` }] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.answer.headline, "Your bill went up");
    assert.deepEqual(r.answer.recommendation, { text: "", facts: [], evidence: [] });
  });
  it("when every sentence is dropped it asks for a rewrite", () => {
    const r = run({ sentences: [{ text: `Timing ${P("T")}.` }] });
    assert.equal(r.answer.sentences.length, 0);
    assert.match(r.errors[0], /no usable sentence left/);
  });
  it("tolerates a malformed reply shape without throwing", () => {
    const r = run({ sentences: "nope", ruledOut: 5, recommendation: [] });
    assert.ok(r.errors.length >= 1);
  });
});
