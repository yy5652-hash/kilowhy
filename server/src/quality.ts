// Meaning checks the number verifier cannot make (D5b). Pure; no I/O.
//  - headline: sentence case, at most 90 characters, contains the size of the change (repaired in code first, rejected otherwise);
//  - a question about a site is answered with that site's own change: the headline carries its ΔC, the first sentence cites ΔC and its largest supported cause
//    and never opens with a single-day statistic;
//  - ruled-out items are one short clause;
//  - the recommendation leads with the option of the largest computed £ effect, presents the others with their own small figures, says plainly when Agile
//    beat the flat tariff, and never turns a past one-off event (an unusual day, a logged fault) into a lever or a saving;
//  - an unusual day that falls in window A (the baseline) is said to be in the baseline.
import type { Fact } from "./facts.ts";
import { displayFor } from "./facts_format.ts";
import { rankOptions, type RecOption } from "./facts_options.ts";
import { tokenize, tokenMatchesFact, type Answer, type HypInfo, type VerifyError } from "./verifier.ts";

export type QuestionType = "why_cost_change" | "why_spike_day" | "why_emissions" | "what_to_change";
export const HEADLINE_MAX_CHARS = 90;
export const RULED_OUT_MAX_WORDS = 30;      // the model is asked for about 20; trimmed in code at 22, rejected here above 30 (text facts such as a logged event add words)

export interface QualityCtx {
  type: QuestionType;
  siteScoped: boolean;                      // the scope is some of the sites, not all of them
  siteName: string | null;                  // set when exactly one site is in scope
  sizeFacts: string[];                      // facts whose figure counts as "the size of the change" in a headline
  billFact: string | null;                  // the change in the bill (ΔC)
  topCause: { hyp: string; title: string; factIds: string[] } | null;   // the supported hypothesis with the largest share of ΔC (cost questions about a site)
  dayStatFacts: string[];                   // single-day statistics (one-off day, unusual days): never the opening of a cost answer
  oneOffFacts: string[];                    // past one-off events: explanations only, never a lever or a saving
  baselineSpikeFacts: string[];             // facts about an unusual day that falls in window A
  noteAllowed: Record<string, string[]>;    // remembered note (M#) -> the facts it may be used with: the facts it bears on and the other facts of the same tests
  oneOffWords: string[];                    // words that only the descriptions of past one-off events use ("freezer", "fault"): not for a recommendation
  options: RecOption[];                     // recommendation options, ranked
  fallbackHeadline: string | null;          // deterministic headline used when the model's is unusable
}

const COST_TYPES: QuestionType[] = ["why_cost_change", "what_to_change"];
const CAUSE_SHARES: [string, string][] = [["H1", "L_share"], ["H3", "v_weather_share"], ["H4", "v_operational_share"], ["H5", "T_share"]];
const num = (f: Fact | undefined): number | null => (f && typeof f.value === "number" && Number.isFinite(f.value) ? f.value : null);

/** "S2 (Crumb & Co Brixton)" -> "Crumb & Co Brixton"; null for several sites. */
function soleSiteName(facts: Fact[]): string | null {
  const d = facts.find((f) => f.key === "sites")?.display ?? "";
  const m = d.match(/^S\d+ \((.+)\)$/);
  return m && !d.includes("), S") ? m[1] : null;
}

export function fallbackHeadline(facts: Fact[], type: QuestionType, siteScoped: boolean, siteName: string | null): string | null {
  const get = (k: string) => facts.find((f) => f.key === k);
  const mag = (f: Fact) => displayFor(Math.abs(f.value as number), f.unit);
  if (type === "why_emissions") {
    const e = get("delta_emissions");
    return e && num(e) !== null ? `Emissions ${(e.value as number) >= 0 ? "rose" : "fell"} by ${mag(e)}` : null;
  }
  const bill = get("delta_bill"), pct = get("delta_bill_pct");
  if (!bill || num(bill) === null) return null;
  const subject = siteScoped ? (siteName ? `${siteName}'s electricity bill` : "The electricity bill of these sites") : "Your electricity bill";
  return `${subject} ${(bill.value as number) >= 0 ? "rose" : "fell"} by ${mag(bill)}${pct && num(pct) !== null ? ` (${mag(pct)})` : ""}`;
}

const STOP_WORDS = new Set(["sample", "extra", "consumed", "schedule", "events", "event", "which", "their", "later", "again"]);
/** Words from the descriptions of one-off events (unusual days): a recommendation that uses them is building advice on a past event. */
function oneOffWords(facts: Fact[]): string[] {
  const words = facts.filter((f) => /^spike_\d+_event$/.test(f.key)).flatMap((f) => String(f.display).toLowerCase().match(/[a-z]{5,}/g) ?? []);
  return [...new Set(words)].filter((w) => !STOP_WORDS.has(w));
}
/** A remembered note may be used with the facts it bears on and with the other facts of the same tests (the logged event and the timing result it explains). */
function noteBindings(facts: Fact[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of facts.filter((f) => f.memory?.bearsOn?.length)) {
    const bears = new Set(m.memory!.bearsOn!);
    const tags = new Set(facts.filter((f) => bears.has(f.id)).map((f) => f.hypothesis).filter(Boolean));
    out[m.id] = facts.filter((f) => !f.memory && (bears.has(f.id) || (f.hypothesis && tags.has(f.hypothesis)))).map((f) => f.id);
  }
  return out;
}

export function qualityContext(facts: Fact[], hyps: HypInfo[], o: { type: QuestionType; siteScoped: boolean }): QualityCtx {
  const keyId = (...keys: string[]) => keys.map((k) => facts.find((f) => f.key === k)?.id).filter((x): x is string => !!x);
  const status = new Map(hyps.map((h) => [h.id, h.status]));
  const bill = facts.find((f) => f.key === "delta_bill"), dC = num(bill);
  let topCause: QualityCtx["topCause"] = null;
  if (dC !== null && dC !== 0) {
    const shares: [string, number][] = CAUSE_SHARES.flatMap(([h, k]) => { const v = num(facts.find((f) => f.key === k)); return v === null ? [] : [[h, v] as [string, number]]; });
    const s = num(facts.find((f) => f.key === "S"));
    if (s !== null) shares.push(["H8", (s / dC) * 100]);
    const best = shares.filter(([h, v]) => status.get(h) === "supported" && v > 0).sort((a, b) => b[1] - a[1])[0];
    if (best) topCause = { hyp: best[0], title: hyps.find((h) => h.id === best[0])?.name ?? best[0], factIds: facts.filter((f) => f.hypothesis === best[0]).map((f) => f.id) };
  }
  const sizeFacts = o.type === "why_emissions" ? keyId("delta_emissions") : o.type === "why_spike_day" ? [] : o.siteScoped ? keyId("delta_bill", "delta_bill_pct") : keyId("delta_bill", "delta_bill_pct", "delta_kwh", "delta_kwh_pct");
  const dayStat = facts.filter((f) => f.hypothesis === "H6" || f.hypothesis === "H11").map((f) => f.id);
  const spikeA = new Set(facts.filter((f) => /^spike_\d+_window$/.test(f.key) && String(f.value).startsWith("window A")).map((f) => f.key.match(/\d+/)![0]));
  const siteName = soleSiteName(facts);
  return {
    type: o.type, siteScoped: o.siteScoped, siteName: o.siteScoped ? siteName : null, sizeFacts, billFact: bill?.id ?? null, topCause, dayStatFacts: dayStat,
    oneOffFacts: facts.filter((f) => f.hypothesis === "H6" || f.hypothesis === "H11" || (f.hypothesis === "H4" && /^event_/.test(f.key))).map((f) => f.id),
    baselineSpikeFacts: facts.filter((f) => { const k = f.key.match(/^spike_(\d+)_/)?.[1]; return !!k && spikeA.has(k); }).map((f) => f.id),
    noteAllowed: noteBindings(facts), oneOffWords: oneOffWords(facts),
    options: rankOptions(facts), fallbackHeadline: fallbackHeadline(facts, o.type, o.siteScoped, siteName),
  };
}

// ---------------------------------------------------------------- headline repair

const UNITS: [RegExp, string][] = [[/\bkwh\b/g, "kWh"], [/\bkgco2e\b/g, "kgCO2e"], [/\bgco2\b/g, "gCO2"], [/\bhdd\b/g, "HDD"], [/\bp\/kwh\b/g, "p/kWh"], [/\bco2\b/g, "CO2"], [/\buk\b/g, "UK"]];

/** Text written in capitals -> sentence case; units, hypothesis and site ids, and the site names and tariff names in the facts keep their spelling. */
export function sentenceCase(text: string, facts: Fact[] = []): string {
  let s = text.toLowerCase();
  for (const [re, rep] of UNITS) s = s.replace(re, rep);
  s = s.replace(/\b([sh])(\d+)\b/g, (_m, a: string, b: string) => a.toUpperCase() + b);
  const names = new Map<string, string>([["agile", "Agile"], ["octopus", "Octopus"]]);
  for (const w of (facts.find((f) => f.key === "sites")?.display ?? "").match(/[A-Za-z]{2,}/g) ?? []) names.set(w.toLowerCase(), w);
  s = s.replace(/[a-z]+/g, (w) => names.get(w) ?? w);
  return s.replace(/^(\W*)([a-z])/, (_m, lead: string, c: string) => lead + c.toUpperCase());
}

const isShouting = (t: string): boolean => { const l = t.replace(/[^A-Za-z]/g, ""); return l.length >= 8 && l.replace(/[^A-Z]/g, "").length / l.length > 0.8; };

/** The size of the change appears in the headline? */
function hasSize(text: string, q: QualityCtx, facts: Fact[]): boolean {
  if (!q.sizeFacts.length) return true;
  const sizes = q.sizeFacts.map((id) => facts.find((f) => f.id === id)!).filter(Boolean);
  return tokenize(text).some((t) => sizes.some((f) => tokenMatchesFact(t, f)));
}

const CUTS = [" — ", " – ", ": ", "; ", ", ", " (", " with ", " driven ", " mainly ", " because ", " while ", " as "];
/** Drops what a cut can leave hanging at the end ("…, driven", "…, mainly by") together with trailing punctuation. */
const DANGLING = /(?:[\s,;:—–(-]+(?:driven|mainly|largely|mostly|by|with|and|as|while|because|due|to))+$/i;
const trimCut = (p: string): string => p.replace(/[\s,;:—–(-]+$/, "").replace(DANGLING, "").replace(/[\s,;:—–(-]+$/, "");
/** Sentence case, one line, at most 90 characters, with the size of the change; falls back to the deterministic headline. Returns what it did. */
export function tidyHeadline(raw: string, q: QualityCtx | undefined, facts: Fact[]): { text: string; notes: string[] } {
  const notes: string[] = [];
  let t = raw.replace(/\s+/g, " ").trim().replace(/^["'“]+|["'”]+$/g, "").replace(/[.\s]+$/, "");
  if (!t) return { text: q?.fallbackHeadline ?? "", notes: q?.fallbackHeadline ? ["headline was empty: the deterministic headline was used"] : notes };
  if (isShouting(t)) { t = sentenceCase(t, facts); notes.push("headline was in capitals: set in sentence case"); }
  else if (/^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  if (!q) return { text: t, notes };
  if (t.length > HEADLINE_MAX_CHARS) {
    const before = t.length;
    const cuts = CUTS.flatMap((c) => { const out: number[] = []; for (let i = t.indexOf(c); i >= 0; i = t.indexOf(c, i + 1)) out.push(i); return out; }).sort((a, b) => b - a);
    const ok = cuts.map((i) => trimCut(t.slice(0, i))).find((p) => p.length <= HEADLINE_MAX_CHARS && p.length >= 20 && hasSize(p, q, facts));
    if (ok) { t = ok; notes.push(`headline was ${before} characters: cut to ${t.length}`); }
  }
  if (t.length > HEADLINE_MAX_CHARS || !hasSize(t, q, facts)) {
    if (q.fallbackHeadline) { notes.push(t.length > HEADLINE_MAX_CHARS ? "headline too long and could not be cut: the deterministic headline was used" : "headline lacked the size of the change: the deterministic headline was used"); t = q.fallbackHeadline; }
  }
  return { text: t, notes };
}

// ---------------------------------------------------------------- ruled-out items: one short clause

const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const CLAUSE_CUTS = [",", ";", ":", " — ", " – ", " - ", " (", " but ", " while ", " although ", " though ", " whereas ", " with ", " and "];
/** First sentence of a ruled-out item, cut at a clause boundary to at most `maxWords` words; the cut keeps a placeholder. Works on the raw text (placeholders still in it). */
export function oneClause(raw: string, maxWords = 22): { text: string; trimmed: boolean } {
  const original = raw.trim();
  const parts = original.split(/(?<=[.!?])\s+(?=[A-Z{[<(])/);
  const notes = parts.slice(1).filter((x) => /\{M\d+/.test(x));        // a sentence that carries a remembered note ({M1}) stays
  let t = parts[0];
  const keepsFact = (s: string) => /\bF\d+\b/.test(s);
  if (wordCount(t) > maxWords) {
    const cuts = CLAUSE_CUTS.flatMap((c) => { const out: number[] = []; for (let i = t.indexOf(c); i > 0; i = t.indexOf(c, i + 1)) out.push(i); return out; }).sort((a, b) => b - a);
    const best = cuts.map((i) => t.slice(0, i).replace(/[\s,;:—–(-]+$/, "")).find((p) => wordCount(p) <= maxWords && wordCount(p) >= 5 && keepsFact(p));
    if (best) t = best;
    else { const hard = t.split(/\s+/).slice(0, maxWords).join(" "); if (keepsFact(hard)) t = hard; }
  }
  t = t.replace(/[\s,;:—–-]+$/, "");
  if (t && !/[.!?]$/.test(t)) t += ".";
  if (notes.length) t = `${t} ${notes.join(" ")}`;
  return { text: t, trimmed: t !== original && t.replace(/\.$/, "") !== original.replace(/\.$/, "") };
}

// ---------------------------------------------------------------- the checks

const SAVING_WORDS = /\b(levers?|savings?|saves?|saved|saving|opportunit\w+)\b/i;
const err = (part: VerifyError["part"], index: number, reason: string): VerifyError => ({ part, index, reason });

export function makeChecks(q: QualityCtx, facts: Fact[]): (a: Answer) => VerifyError[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const fact = (id: string) => byId.get(id)!;
  const shown = (id: string) => `${id} = ${fact(id).display}`;
  return (a) => {
    const out: VerifyError[] = [];

    // ---- headline
    if (a.headline) {
      if (isShouting(a.headline)) out.push(err("headline", 0, "the headline is written in capitals; use sentence case"));
      if (a.headline.length > HEADLINE_MAX_CHARS) out.push(err("headline", 0, `the headline is ${a.headline.length} characters; keep it to ${HEADLINE_MAX_CHARS} or fewer`));
      if (!hasSize(a.headline, q, facts)) out.push(err("headline", 0, `the headline must contain the size of the change (${q.sizeFacts.slice(0, 2).map(shown).join(" or ")})`));
    }

    // ---- the lead of a cost answer
    const first = a.sentences[0];
    if (first && COST_TYPES.includes(q.type)) {
      if (q.billFact && !first.facts.includes(q.billFact)) out.push(err("sentences", 0, `the first sentence must give the size of the change: cite ${shown(q.billFact)}${q.siteScoped ? " (this site's own change)" : ""}`));
      const day = first.facts.find((id) => q.dayStatFacts.includes(id));
      if (day) out.push(err("sentences", 0, `the first sentence is about a single day (${shown(day)}); open with the change in the bill and its largest cause, and mention single days later`));
      if (q.siteScoped && q.topCause && !first.facts.some((id) => q.topCause!.factIds.includes(id))) {
        out.push(err("sentences", 0, `the first sentence must also name this site's largest supported cause (${q.topCause.hyp} ${q.topCause.title}): cite one of its facts`));
      }
    }

    // ---- past one-off events are explanations, never levers or savings; an unusual day in the baseline window is said to be in it
    a.sentences.forEach((s, i) => {
      // a sentence about prices shows a price figure (£, %, p/kWh or pp), not a bare usage figure such as "7,715 kWh from the price-level effect"
      if (/\bprices?\b|price[- ]level/i.test(s.text) && !tokenize(s.text).some((t) => ["money", "pct", "pkwh", "pp"].includes(t.type))) {
        out.push(err("sentences", i, `a sentence about prices needs a price figure (£, %, p/kWh or pp); this one shows only ${tokenize(s.text).map((t) => t.raw.trim()).slice(0, 3).join(", ") || "no figure"}, which is not the size of a price effect`));
      }
      if (s.facts.some((id) => q.oneOffFacts.includes(id)) && SAVING_WORDS.test(s.text)) out.push(err("sentences", i, "a past one-off event (an unusual day, a fault) explains a change; it is not a lever or a saving, so do not present it as one"));
      if (s.facts.some((id) => q.baselineSpikeFacts.includes(id)) && !/baseline|window A/i.test(s.text)) out.push(err("sentences", i, "this unusual day falls in window A, the baseline: say so (it raised the baseline, it did not add to the latest four weeks)"));
    });

    // ---- ruled-out: one short clause
    a.ruledOut.forEach((r, i) => {
      // a quoted logged-event description (a long text fact) counts as one word; a sentence that carries a remembered note (M#) may follow the clause
      let plain = r.text;
      for (const id of r.facts) { const f = byId.get(id); if (f && f.unit === "text" && f.display.length >= 20) plain = plain.split(f.display).join(f.memory ? "\u0001NOTE" : "QUOTED"); }
      const core = plain.split(/(?<=[.!?])\s+(?=[A-Z\u0001])/).filter((x) => !x.includes("\u0001NOTE"));
      if (core.length > 1 || wordCount(core.join(" ")) > RULED_OUT_MAX_WORDS) out.push(err("ruledOut", i, `a ruled-out item is one short clause (about 20 words, one sentence); this one has ${wordCount(core.join(" "))} words in ${core.length} sentence(s)`));
    });

    // ---- a remembered note is used only with the facts it explains
    const noteUse = (part: VerifyError["part"], i: number, ids: string[]) => {
      for (const id of ids) {
        const allowed = q.noteAllowed[id];
        if (!allowed) continue;
        const others = ids.filter((x) => !x.startsWith("M"));
        if (!others.some((x) => allowed.includes(x))) out.push(err(part, i, `the note ${id} explains ${byId.get(id)?.memory?.bearsOn?.slice(0, 1).map((b) => byId.get(b)?.label).join("") ?? "a different subject"}, not the facts cited here: use it only next to the facts it bears on, or leave it out`));
      }
    };
    a.sentences.forEach((s, i) => noteUse("sentences", i, s.facts));
    a.ruledOut.forEach((r, i) => noteUse("ruledOut", i, r.facts));
    noteUse("recommendation", 0, a.recommendation.facts);

    // ---- recommendation
    const rec = a.recommendation;
    if (rec.text.trim()) {
      if (/\blevers?\b/i.test(rec.text)) out.push(err("recommendation", 0, "do not call anything a lever: say what was computed"));
      const word = q.oneOffWords.find((w) => new RegExp(`\\b${w}`, "i").test(rec.text));
      if (word) out.push(err("recommendation", 0, `the recommendation mentions "${word}", which belongs to a past one-off event; an event explains a change, it is not something to act on`));
      const oneOff = rec.facts.find((id) => q.oneOffFacts.includes(id));
      if (oneOff) out.push(err("recommendation", 0, `the recommendation may not use ${shown(oneOff)}: a past one-off event explains a change, it is not an option`));
      const options = q.options;
      if (options.length) {
        const top = options[0];
        for (const o of options) if (!rec.facts.includes(o.factId)) out.push(err("recommendation", 0, `cite ${shown(o.factId)}: every option is presented with its own figure${o.rank === 1 ? ", and the largest comes first" : ""}`));
        const money = tokenize(rec.text).filter((t) => t.type === "money");
        const firstMoney = money[0];
        if (firstMoney && !tokenMatchesFact(firstMoney, fact(top.factId))) out.push(err("recommendation", 0, `the first £ figure must be the option with the largest effect (${shown(top.factId)}), not ${firstMoney.raw.trim()}; lead with it and mention the smaller options after it`));
        const at = options.map((o) => money.findIndex((t) => tokenMatchesFact(t, fact(o.factId))));
        for (let k = 1; k < options.length; k++) if (at[k] >= 0 && at[k - 1] >= 0 && at[k] < at[k - 1]) { out.push(err("recommendation", 0, `present the options from the largest £ effect to the smallest (${options.map((o) => shown(o.factId)).join(", then ")})`)); break; }
        for (const o of options) for (const id of o.extraFactIds) if (!rec.facts.includes(id) && num(fact(id)) !== null) out.push(err("recommendation", 0, `present the load shift with its carbon figure too: cite ${shown(id)}`));
        const tariff = options.find((o) => o.key === "tariff");
        const span = (n: number) => `(?:[^.;]|\\.(?=\\d)){0,${n}}`;              // within one clause: a decimal point does not end it
        const saysAgileWon = new RegExp(`\\b(stay(?:ing|ed)?|kept?|keep(?:ing)?) on Agile\\b|\\bAgile (?:was|is) (?:the )?cheaper\\b|\\bAgile saved\\b|\\bAgile\\b${span(60)}\\b(?:cheaper|saved|less|lower)\\b`, "i").test(rec.text);
        const saysFlatWon = new RegExp(`\\bflat\\b${span(90)}\\b(?:cheaper|less|lower)\\b|\\b(?:cheaper|less)\\b${span(40)}\\bflat\\b|\\bswitch`, "i").test(rec.text) && !/\b(stay(?:ing|ed)?|kept?|keep(?:ing)?) on Agile saved\b|\bAgile saved\b/i.test(rec.text);
        if (tariff?.direction === "agile_cheaper" && !saysAgileWon) out.push(err("recommendation", 0, "say plainly that Agile was cheaper than the flat tariff (staying on Agile saved this much over the four weeks), as a historical counterfactual"));
        if (tariff?.direction === "flat_cheaper" && !saysFlatWon) out.push(err("recommendation", 0, "say plainly that the flat tariff would have been cheaper than Agile, as a historical counterfactual (do not say that staying on Agile saved money)"));
      }
    }
    return out;
  };
}
