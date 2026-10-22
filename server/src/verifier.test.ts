// Verifier tests: token parsing, matching within rounding, citations, hypothesis status rules. Pure, no I/O.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize, tokenMatchesFact, verifyAnswer, resolveHypothesis, errorLine, type Answer, type HypInfo, type VerifyCtx } from "./verifier.ts";
import type { Fact } from "./facts.ts";
import { displayFor } from "./facts_format.ts";

let n = 0;
function fact(key: string, value: Fact["value"], unit: string, hypothesis?: string, evidence = "E1"): Fact {
  n++;
  return { id: `F${n}`, key, label: key, value, unit, display: displayFor(value, unit), evidence, ...(hypothesis ? { hypothesis } : {}) };
}
const facts: Fact[] = [];
const add = (key: string, value: Fact["value"], unit: string, hypothesis?: string, evidence = "E1") => { const f = fact(key, value, unit, hypothesis, evidence); facts.push(f); return f.id; };
const dC = add("delta_bill", 339.91, "GBP");
const billA = add("bill_A", 2002.05, "GBP");
const billB = add("bill_B", 2341.97, "GBP");
const L = add("L", 186.66, "GBP", "H1", "E3");
const Lshare = add("L_share", 54.91, "%", "H1", "E3");
const vW = add("v_weather", 127.67, "GBP", "H3", "E5");
const hddB = add("hdd_B", 44.9916, "HDD", "H3", "E5");
const T = add("T", 0.86, "GBP", "H5", "E9");
const Tshare = add("T_share", 0.25, "%", "H5", "E9");
const price = add("avg_price_A", 25.5388, "p/kWh");
const kwhB = add("kwh_B", 8312.122, "kWh");
const emis = add("emissions", 250.072, "kgCO2e", "H10", "E16");
const topDay = add("top_day", "2026-10-17", "date", "H6", "E11");
const days = add("window_days", 28, "days");
const corr = add("corr", -0.337, "r", "H2", "E4");
const negGbp = add("opposite_day_delta", -12.34, "GBP", "H6", "E11");
const wind = add("delta_wind_pp", -3.1, "pp", "H2", "E4");
const blocks = add("rec_blocks", "10:00-13:00, 04:00-07:00", "text", "REC", "E19");
const flat = add("flat_minus_agile_B", 504.69, "GBP", "REC", "E20");
const standing = add("standing_B", 37.6525, "p/day", "H8", "E14");
const recSaved = add("rec_saved", 5.23, "GBP", "REC", "E19");
const beta = add("beta", 11.2648, "kWh/HDD", "H3", "E5");
const windowStart = add("window_B_start", "2026-09-24", "date");

const hyps: HypInfo[] = [
  { id: "H1", name: "price_level", status: "supported" }, { id: "H2", name: "price_driver_generation", status: "supported" }, { id: "H3", name: "weather_volume", status: "supported" },
  { id: "H4", name: "operational_change", status: "inconclusive" }, { id: "H5", name: "timing_shift", status: "ruled_out" }, { id: "H6", name: "one_off_day", status: "supported" },
  { id: "H7", name: "meter_fault", status: "ruled_out" }, { id: "H8", name: "tariff_change", status: "ruled_out" }, { id: "H9", name: "data_gap", status: "ruled_out" }, { id: "H10", name: "carbon", status: "inconclusive" },
];
const evidenceIds = ["E1", "E3", "E4", "E5", "E9", "E11", "E14", "E16", "E19", "E20"];
const ctx: VerifyCtx = { facts, evidenceIds, hypotheses: hyps };
const item = (text: string, f: string[], e: string[] = ["E1"]) => ({ text, facts: f, evidence: e });
const answerOf = (sentences: Answer["sentences"], over: Partial<Answer> = {}): Answer => ({ headline: "The bill went up", sentences, ruledOut: [], recommendation: { text: "", facts: [], evidence: [] }, ...over });
const errs = (a: Answer, c: VerifyCtx = ctx) => verifyAnswer(a, c).errors.map(errorLine);

describe("tokenize: number kinds", () => {
  const kinds = (s: string) => tokenize(s).map((t) => `${t.type}:${t.raw.trim()}`);
  it("currency with separators and signs", () => {
    assert.deepEqual(kinds("It cost £1,234.56 and £5"), ["money:£1,234.56", "money:£5"]);
    const t = tokenize("fell by −£12.34, then -£7 and £-3 and +£2");
    assert.deepEqual(t.map((x) => [x.value, x.sign]), [[12.34, -1], [7, -1], [3, -1], [2, 1]]);
    assert.equal(tokenize("£1,234.56")[0].decimals, 2);
  });
  it("abbreviated money is its own kind (never matches)", () => {
    assert.equal(tokenize("about £1.5k")[0].type, "abbrev");
    assert.equal(tokenize("about £2m")[0].type, "abbrev");
    assert.equal(tokenize("about 12k units")[0].type, "abbrev");
  });
  it("percentages in several spellings", () => {
    assert.deepEqual(kinds("up 12.3%, 12.3 %, 12 per cent, 12 percent").filter((k) => k.startsWith("pct")).length, 4);
    assert.equal(tokenize("12.3 pp")[0].type, "pp");
    assert.equal(tokenize("3.1 percentage points")[0].type, "pp");
  });
  it("kWh, p/kWh, pence and kg", () => {
    assert.deepEqual(kinds("4,567 kWh"), ["kwh:4,567 kWh"]);
    assert.equal(tokenize("21.4 p/kWh")[0].type, "pkwh");
    assert.equal(tokenize("21.4p")[0].type, "pkwh");
    assert.equal(tokenize("21.4 pence per kWh")[0].type, "pkwh");
    assert.equal(tokenize("21.4 p per kWh")[0].type, "pkwh");
    assert.equal(tokenize("103.0 kgCO2e")[0].type, "kg");
    assert.equal(tokenize("103 kg CO2e")[0].type, "kg");
    assert.equal(tokenize("103 kg")[0].type, "kg");
    assert.equal(tokenize("103.0 kgCO₂e")[0].type, "kg");
  });
  it("a kWh rate (per heating degree day, per day) is a plain number, not an amount", () => {
    assert.equal(tokenize("about 11.3 kWh per heating degree day")[0].type, "plain");
    assert.equal(tokenize("11.26 kWh/HDD")[0].type, "plain");
    assert.equal(tokenize("2.0 kWh/day")[0].type, "plain");
  });
  it("dates in ISO and written form; years inside dates are not plain numbers", () => {
    const t = tokenize("From 2026-09-24 to 17 Oct 2026, also 7 October, Oct 17, 2026 and March 5th");
    assert.deepEqual(t.map((x) => x.type), ["date", "date", "date", "date", "date"]);
    assert.deepEqual(t.map((x) => x.date), [{ y: 2026, m: 9, d: 24 }, { y: 2026, m: 10, d: 17 }, { y: null, m: 10, d: 7 }, { y: 2026, m: 10, d: 17 }, { y: null, m: 3, d: 5 }]);
  });
  it("a bare year or month-year is ignored", () => { assert.deepEqual(tokenize("In October 2026 and 2025, the bill rose."), []); });
  it("times of day", () => {
    const t = tokenize("between 16:00-19:00 and 4:30");
    assert.deepEqual(t.map((x) => [x.type, x.minutes]), [["time", 960], ["time", 1140], ["time", 270]]);
  });
  it("identifiers E#, F#, H#, S# are not numbers", () => { assert.deepEqual(tokenize("[E3][F12] H10 and H11 at S12 (E27)"), []); });
  it("plain numbers: >= 10 or with decimals are checked, small whole numbers are not", () => {
    assert.deepEqual(tokenize("3 sites, 4 weeks, 28 days, 0.34, 1,344 slots, 7.0").map((x) => x.raw), ["28", "0.34", "1,344", "7.0"]);
    assert.equal(tokenize("the 5th and 22nd day").length, 0);
    assert.equal(tokenize("a 28-day window")[0].value, 28);
  });
  it("a range is two unsigned numbers; a leading hyphen after a space is a sign", () => {
    const r = tokenize("10-13 units");
    assert.deepEqual(r.map((x) => [x.value, x.sign]), [[10, 0], [13, 0]]);
    assert.deepEqual(tokenize("correlation -0.34 or −0.34").map((x) => [x.value, x.sign]), [[0.34, -1], [0.34, -1]]);
  });
  it("sentence punctuation does not leak into numbers", () => { assert.deepEqual(tokenize("It was £339.91.").map((x) => x.value), [339.91]); assert.deepEqual(tokenize("(£339.91), then 12.3%.").map((x) => x.value), [339.91, 12.3]); });
});

describe("tokenMatchesFact: display or value within rounding", () => {
  const f = (id: string) => facts.find((x) => x.id === id)!;
  const m = (text: string, id: string) => tokenMatchesFact(tokenize(text)[0], f(id));
  it("the display matches verbatim", () => { assert.ok(m("£339.91", dC)); assert.ok(m("54.9%", Lshare)); assert.ok(m("8,312 kWh", kwhB)); assert.ok(m("25.5 p/kWh", price)); assert.ok(m("250.1 kgCO2e", emis)); });
  it("rounding the value to the precision written matches", () => {
    assert.ok(m("£340", dC)); assert.ok(m("£339.9", dC)); assert.ok(m("55%", Lshare)); assert.ok(m("54.91%", Lshare)); assert.ok(m("8312.1 kWh", kwhB)); assert.ok(m("8,312 kWh", kwhB)); assert.ok(m("26 p/kWh", price)); assert.ok(m("250 kgCO2e", emis));
  });
  it("a different number does not match, even by a little", () => {
    assert.ok(!m("£339.95", dC)); assert.ok(!m("£341", dC)); assert.ok(!m("54.8%", Lshare)); assert.ok(!m("8,400 kWh", kwhB)); assert.ok(!m("251 kgCO2e", emis));
  });
  it("the unit class must agree for typed tokens", () => {
    assert.ok(!m("54.9 kWh", Lshare)); assert.ok(!m("£54.9", Lshare)); assert.ok(!m("339.91%", dC)); assert.ok(!m("£8,312", kwhB)); assert.ok(!m("250.1 kWh", emis));
  });
  it("a plain number matches any numeric fact regardless of unit", () => { assert.ok(m("45.0", hddB)); assert.ok(m("45 heating degree days", hddB)); assert.ok(m("28", days)); assert.ok(m("11.3", beta)); assert.ok(m("37.65", standing)); });
  it("unsigned tokens match by magnitude; an explicit sign must agree", () => {
    assert.ok(m("£12.34", negGbp)); assert.ok(m("−£12.34", negGbp)); assert.ok(m("-£12.34", negGbp)); assert.ok(!m("+£12.34", negGbp));
    assert.ok(m("0.34", corr)); assert.ok(m("-0.34", corr)); assert.ok(!m("+0.34", corr));
    assert.ok(m("3.1 pp", wind)); assert.ok(m("−3.1 pp", wind)); assert.ok(!m("+3.1 pp", wind));
  });
  it("dates match in either format; a date without a year matches on month and day", () => {
    assert.ok(m("2026-10-17", topDay)); assert.ok(m("17 Oct 2026", topDay)); assert.ok(m("17 October 2026", topDay)); assert.ok(m("17 Oct", topDay)); assert.ok(m("Oct 17", topDay));
    assert.ok(!m("18 Oct 2026", topDay)); assert.ok(!m("17 Oct 2025", topDay)); assert.ok(!m("2026-10-18", topDay)); assert.ok(m("24 Sep 2026", windowStart));
  });
  it("times match the times in a text fact", () => { assert.ok(m("10:00", blocks)); assert.ok(m("13:00", blocks)); assert.ok(m("04:00", blocks)); assert.ok(!m("14:00", blocks)); assert.ok(!m("10:30", blocks)); });
  it("abbreviated numbers never match", () => { assert.ok(!tokenMatchesFact(tokenize("£340k")[0], facts.find((x) => x.id === dC)!)); });
});

describe("verifyAnswer: numbers and citations", () => {
  it("accepts a sentence whose numbers are fact displays and that cites facts and evidence", () => {
    const a = answerOf([item(`The bill rose by £339.91 [E1], from £2,002.05 to £2,341.97 over ${"28"} days.`, [dC, billA, billB, days])]);
    assert.deepEqual(errs(a), []);
    assert.equal(verifyAnswer(a, ctx).passed, true);
  });
  it("accepts numbers rounded to fewer decimals", () => { assert.deepEqual(errs(answerOf([item("Price changes added about £187, or 55% of the rise.", [L, Lshare], ["E3"])])), []); });
  it("accepts direction words with magnitudes of a negative fact", () => { assert.deepEqual(errs(answerOf([item("The best day went the other way, cutting the cost by £12.34.", [negGbp], ["E11"])])), []); });
  it("rejects a number that matches no cited fact and names facts that do hold it", () => {
    const e = errs(answerOf([item("Weather added £127.67.", [dC])]));
    assert.equal(e.length, 1);
    assert.match(e[0], /sentences\[0\]: the number "£127.67" matches none of the cited facts/);
    assert.match(e[0], new RegExp(`${vW} = £127.67`));
  });
  it("rejects an invented number with no matching fact anywhere", () => { const e = errs(answerOf([item("Costs rose by £400.", [dC])])); assert.match(e[0], /no fact has that value/); });
  it("rejects a number that matches only when the unit is wrong", () => { assert.equal(errs(answerOf([item("Prices explain 54.9 kWh.", [Lshare], ["E3"])])).length, 1); });
  it("rejects a sentence with no fact citation", () => { assert.match(errs(answerOf([item("The bill rose.", [])]))[0], /cites no fact/); });
  it("rejects a sentence with no evidence citation", () => { assert.match(errs(answerOf([item("The bill rose.", [dC], [])]))[0], /cites no evidence/); });
  it("rejects a fact id that does not exist and an evidence id that does not exist", () => {
    assert.match(errs(answerOf([item("The bill rose.", ["F999"])]))[0], /F999, which does not exist/);
    assert.match(errs(answerOf([item("The bill rose.", [dC], ["E99"])]))[0], /E99, which is not an evidence record/);
  });
  it("a sentence cannot lean on a fact cited by another sentence", () => {
    const a = answerOf([item("The bill rose by £339.91.", [dC]), item("Prices added £186.66 of it.", [Lshare], ["E3"])]);
    const e = errs(a);
    assert.equal(e.length, 1); assert.match(e[0], /^sentences\[1\]/);
  });
  it("inline [E#]/[F#] markers and hypothesis ids are not read as numbers", () => { assert.deepEqual(errs(answerOf([item("The bill rose by £339.91 [F1][E1]; H10 and S12 are ids.", [dC])])), []); });
  it("dates in either format and times are verified against cited facts", () => {
    assert.deepEqual(errs(answerOf([item("One day, 17 Oct 2026, stands out; the cheap window is 10:00 to 13:00.", [topDay, blocks], ["E11"])])), []);
    assert.equal(errs(answerOf([item("One day, 18 Oct 2026, stands out.", [topDay], ["E11"])])).length, 1);
    assert.equal(errs(answerOf([item("Run the oven from 14:00.", [blocks], ["E19"])])).length, 1);
  });
  it("an abbreviated number is an error", () => { assert.match(errs(answerOf([item("The bill rose by £0.3k.", [dC])]))[0], /abbreviated number/); });
  it("an empty sentence list and empty text are errors", () => {
    assert.match(errs(answerOf([]))[0], /there are no sentences/);
    assert.match(errs(answerOf([item("  ", [dC])]))[0], /text is empty/);
  });
  it("the headline needs no citations but its numbers must exist in the facts table", () => {
    assert.deepEqual(errs(answerOf([item("The bill rose.", [dC])], { headline: "The bill rose by £339.91 (up 17.0%)" })).filter((x) => x.startsWith("headline")), [`headline: the number "17.0%" matches no fact in the table; use a fact display verbatim or remove it`]);
    assert.deepEqual(errs(answerOf([item("The bill rose.", [dC])], { headline: "Your bill rose by £339.91" })), []);
    assert.match(errs(answerOf([item("The bill rose.", [dC])], { headline: "" }))[0], /headline is empty/);
  });
});

describe("verifyAnswer: hypothesis statuses", () => {
  it("a supported cause may be cited and named", () => { assert.deepEqual(errs(answerOf([item("Higher prices added £186.66 because of less wind.", [L, wind], ["E3", "E4"])])), []); });
  it("citing a ruled-out hypothesis's fact in sentences is an error", () => {
    const e = errs(answerOf([item("The timing of use came to £0.86.", [T], ["E9"])]));
    assert.equal(e.length, 1); assert.match(e[0], new RegExp(`cites ${T} \\(H5\\), but H5 is ruled_out`));
  });
  it("citing an inconclusive hypothesis's fact in sentences is an error", () => { assert.match(errs(answerOf([item("Emissions rose by 250.1 kgCO2e.", [emis], ["E16"])]))[0], /H10 is inconclusive/); });
  it("naming a non-supported hypothesis as a cause in the text is an error even without citing its facts", () => {
    assert.match(errs(answerOf([item("The bill rose by £339.91 because of the standing charge.", [dC])]))[0], /presents H8 \(tariff_change\) as a cause, but H8 is ruled_out/);
    assert.match(errs(answerOf([item("The bill rose by £339.91 due to a faulty meter.", [dC])]))[0], /H7/);
    assert.match(errs(answerOf([item("Opening hours explain the rise of £339.91.", [dC])]))[0], /H4 .* inconclusive/);
    assert.match(errs(answerOf([item("The bill rose by £339.91 driven by emissions rules.", [dC])]))[0], /H10/);
  });
  it("a hypothesis that was never tested cannot be named as a cause", () => {
    const small: VerifyCtx = { ...ctx, hypotheses: hyps.filter((h) => h.id !== "H3") };
    assert.match(errs(answerOf([item("The bill rose by £339.91 because of the cold weather.", [dC])]), small)[0], /H3 \(not tested\) as a cause, but H3 is not tested/);
  });
  it("mentioning a keyword without a cause phrase is allowed", () => { assert.deepEqual(errs(answerOf([item("The average price was 25.5 p/kWh, and the weather was mild.", [price])])), []); });
  it("'ruled out' belongs in ruledOut, not in sentences", () => { assert.match(errs(answerOf([item("Timing was ruled out as a cause of £339.91.", [dC])]))[0], /ruled-out causes belong in ruledOut/); });
});

describe("verifyAnswer: ruledOut and recommendation", () => {
  const withRuled = (hypothesis: string, text: string, f: string[], e = ["E9"]) => answerOf([item("The bill rose by £339.91.", [dC])], { ruledOut: [{ hypothesis, text, facts: f, evidence: e }] });
  it("accepts a ruled_out hypothesis by id, by name and with a title-like string", () => {
    for (const h of ["H5", "h5", "timing_shift", "timing shift", "H5 timing_shift"]) assert.deepEqual(errs(withRuled(h, "Timing changed the bill by only £0.86 (0.3% of the change).", [T, Tshare])), [], h);
  });
  it("rejects supported and inconclusive hypotheses in ruledOut, and unknown ones", () => {
    assert.match(errs(withRuled("H1", "Prices changed.", [L], ["E3"]))[0], /H1 \(price_level\) is supported, not ruled_out/);
    assert.match(errs(withRuled("H4", "Opening hours changed.", [dC]))[0], /H4 \(operational_change\) is inconclusive, not ruled_out/);
    assert.match(errs(withRuled("H77", "Something.", [dC]))[0], /not one of the tested hypotheses/);
    assert.match(errs(withRuled("lunar phase", "Something.", [dC]))[0], /not one of the tested hypotheses/);
  });
  it("ruledOut items are number-checked and citation-checked like sentences", () => {
    assert.match(errs(withRuled("H5", "Timing changed the bill by £9.99.", [T]))[0], /ruledOut\[0\]: the number "£9.99"/);
    assert.match(errs(withRuled("H5", "Timing changed nothing.", []))[0], /ruledOut\[0\]: cites no fact/);
  });
  it("a ruledOut item may not cite a fact of a supported hypothesis", () => { assert.match(errs(withRuled("H5", "Timing changed the bill by only £0.86 while prices added £186.66.", [T, L], ["E9", "E3"]))[0], /belongs to a supported hypothesis/); });
  it("recommendation: numbers and citations are checked; an empty one is an error only when required", () => {
    const a = answerOf([item("The bill rose by £339.91.", [dC])], { recommendation: { text: "Move the peak load to 10:00 to 13:00 to save £5.23.", facts: [blocks, recSaved], evidence: ["E19"] } });
    assert.deepEqual(errs(a), []);
    assert.match(errs({ ...a, recommendation: { ...a.recommendation, text: "Move the load to save £6.23." } })[0], /^recommendation: the number "£6.23"/);
    assert.match(errs({ ...a, recommendation: { text: "Do something.", facts: [], evidence: [] } })[0], /recommendation: cites no fact/);
    assert.deepEqual(errs({ ...a, recommendation: { text: "", facts: [], evidence: [] } }), []);
    assert.match(errs({ ...a, recommendation: { text: "", facts: [], evidence: [] } }, { ...ctx, requireRecommendation: true })[0], /recommendation is empty/);
  });
  it("tariff text without the counterfactual framing is rejected, with it accepted", () => {
    const base = answerOf([item("The bill rose by £339.91.", [dC])]);
    const mk = (text: string): Answer => ({ ...base, recommendation: { text, facts: [flat], evidence: ["E20"] } });
    assert.match(errs(mk("Switch to the flat tariff, which costs £504.69 more."))[0], /historical counterfactual/);
    assert.deepEqual(errs(mk("As a historical counterfactual, the flat tariff would have cost £504.69 more.")), []);
  });
});

describe("helpers", () => {
  it("resolveHypothesis: ids, names, unknown", () => {
    assert.equal(resolveHypothesis("H3", hyps)?.id, "H3");
    assert.equal(resolveHypothesis("weather volume", hyps)?.id, "H3");
    assert.equal(resolveHypothesis("H3: Weather-driven volume", hyps)?.id, "H3");
    assert.equal(resolveHypothesis("H99", hyps), null);
    assert.equal(resolveHypothesis("zodiac", hyps), null);
  });
  it("errorLine formats each part", () => {
    assert.equal(errorLine({ part: "sentences", index: 2, reason: "x" }), "sentences[2]: x");
    assert.equal(errorLine({ part: "headline", index: 0, reason: "x" }), "headline: x");
    assert.equal(errorLine({ part: "recommendation", index: 0, reason: "x" }), "recommendation: x");
  });
  it("malformed answers (missing fields) produce errors instead of throwing", () => {
    const r = verifyAnswer({} as Answer, ctx);
    assert.equal(r.passed, false);
    assert.ok(r.errors.length >= 2);
  });
});
