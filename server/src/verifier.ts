// Narrative verifier (spec section 13, step 7). Pure: no I/O, no clock. It checks a drafted answer against the facts table and the hypothesis statuses:
//  - every number token in a sentence (currency, %, kWh, p/kWh, kg / kgCO2e, pp, dates in ISO or "17 Oct 2026" form, times, plain numbers >= 10 or with decimals)
//    must match a fact CITED IN THAT SENTENCE, by its display string or by its value within the rounding of the token as written;
//  - every sentence cites at least one existing F# and one existing E#;
//  - a hypothesis presented as a cause must be supported; every ruledOut item must be a ruled_out hypothesis.
// Unsigned tokens are compared by magnitude ("fell by £12.34" matches −£12.34); an explicit sign must agree with the fact.
import type { Fact } from "./facts.ts";
import { kindOfUnit, type TokenKind } from "./facts_format.ts";

export type TokenType = TokenKind | "date" | "time" | "abbrev";
export interface Token {
  type: TokenType; raw: string;
  value: number; decimals: number;            // numeric tokens: parsed value and number of decimals as written
  sign: -1 | 0 | 1;                           // explicit sign as written (0: none)
  date?: { y: number | null; m: number; d: number };
  minutes?: number;                           // time of day
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
const SIGN = "[+\\u2212\\u2013-]";
const TOKEN_RE = new RegExp([
  "(?<iso>\\b(\\d{4})-(\\d{2})-(\\d{2})\\b)",
  `(?<dmy>\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\b\\.?(?:,?\\s+(\\d{4})\\b)?)`,
  `(?<mdy>\\b${MON}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?)`,
  "(?<time>\\b(\\d{1,2}):(\\d{2})\\b)",
  `(?<money>(?<![\\w.,])(${SIGN})?\\s?£\\s?(${SIGN})?(${NUM})(\\s?(?:[kKmM]|bn)\\b)?)`,
  `(?<unit>(?<![\\w.,])(${SIGN})?(${NUM})\\s?(%|per ?cent(?![a-z])|percent(?![a-z])|percentage points?(?![a-z])|pp(?![a-z])|kg(?:\\s?CO[2\\u2082]e?)?(?![A-Za-z])|kWh(?![A-Za-z])|p/kWh|p per kWh|pence per kWh|pence/kWh|pence(?![a-z])|p(?![\\w/])))`,
  `(?<plain>(?<![\\w.,])(${SIGN})?(${NUM})(?!\\d))`,
].join("|"), "g");

const signOf = (s: string | undefined): -1 | 0 | 1 => (!s ? 0 : s === "+" ? 1 : -1);
const parseNum = (s: string): { value: number; decimals: number } => ({ value: Number(s.replace(/,/g, "")), decimals: s.includes(".") ? s.length - s.indexOf(".") - 1 : 0 });
const monthIndex = (m: string): number => MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1;

/** Identifiers that look like numbers but are not: [E3], F12, M1, H10, S2. Blanked out (same length) before tokenising. */
const ID_RE = /\[?\b[EFHMS]\d+\b\]?/g;

export function tokenize(text: string): Token[] {
  const clean = text.replace(ID_RE, (m) => " ".repeat(m.length));
  const out: Token[] = [];
  for (const m of clean.matchAll(TOKEN_RE)) {
    const g = m.groups ?? {};
    const raw = m[0];
    if (g.iso) {
      const [, y, mo, d] = g.iso.match(/(\d{4})-(\d{2})-(\d{2})/)!;
      out.push({ type: "date", raw, value: 0, decimals: 0, sign: 0, date: { y: Number(y), m: Number(mo), d: Number(d) } });
    } else if (g.dmy || g.mdy) {
      const s = (g.dmy ?? g.mdy)!;
      const mm = g.dmy ? s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\b\\.?(?:,?\\s+(\\d{4}))?`)) : s.match(new RegExp(`^${MON}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`));
      if (!mm) continue;
      const day = Number(g.dmy ? mm[1] : mm[2]), mon = monthIndex(g.dmy ? mm[2] : mm[1]);
      if (day < 1 || day > 31) continue;
      out.push({ type: "date", raw, value: 0, decimals: 0, sign: 0, date: { y: mm[3] ? Number(mm[3]) : null, m: mon, d: day } });
    } else if (g.time) {
      const [, h, mi] = g.time.match(/(\d{1,2}):(\d{2})/)!;
      out.push({ type: "time", raw, value: 0, decimals: 0, sign: 0, minutes: Number(h) * 60 + Number(mi) });
    } else if (g.money) {
      const mm = g.money.match(new RegExp(`^(${SIGN})?\\s?£\\s?(${SIGN})?(${NUM})(\\s?(?:[kKmM]|bn)\\b)?$`))!;
      const n = parseNum(mm[3]);
      out.push({ type: mm[4] ? "abbrev" : "money", raw, ...n, sign: signOf(mm[1] ?? mm[2]) });
    } else if (g.unit) {
      const mm = g.unit.match(new RegExp(`^(${SIGN})?(${NUM})\\s?(.+)$`))!;
      const u = mm[3], n = parseNum(mm[2]);
      const after = clean.slice((m.index ?? 0) + raw.length);
      let type: TokenType;
      if (u === "%" || /^(per ?cent|percent)$/.test(u)) type = "pct";
      else if (/^(pp|percentage points?)$/.test(u)) type = "pp";
      else if (/^kg/.test(u)) type = "kg";
      else if (u === "kWh") type = /^\s*(\/|per\b)/.test(after) ? "plain" : "kwh"; // "11.3 kWh per heating degree day" is a rate, not an amount
      else type = "pkwh";
      out.push({ type, raw, ...n, sign: signOf(mm[1]) });
    } else if (g.plain) {
      const mm = g.plain.match(new RegExp(`^(${SIGN})?(${NUM})$`))!;
      const n = parseNum(mm[2]);
      const after = clean.slice((m.index ?? 0) + raw.length);
      if (/^(st|nd|rd|th)\b/.test(after)) continue;                       // ordinal: "the 5th"
      if (/^[kKmM]\b/.test(after)) { out.push({ type: "abbrev", raw: raw + after[0], ...n, sign: signOf(mm[1]) }); continue; }
      if (n.decimals === 0 && !mm[1] && !mm[2].includes(",") && n.value >= 1990 && n.value <= 2100) continue; // a bare year
      if (n.decimals === 0 && Math.abs(n.value) < 10) continue;            // small whole numbers ("3 sites", "four weeks") are not checked
      out.push({ type: "plain", raw, ...n, sign: signOf(mm[1]) });
    }
  }
  return out;
}

const factTokenCache = new WeakMap<Fact, Token[]>();
const factTokens = (f: Fact): Token[] => factTokenCache.get(f) ?? (factTokenCache.set(f, tokenize(String(f.display))), factTokenCache.get(f)!);

const numEq = (t: Token, v: number): boolean => {
  if (t.sign !== 0 && v !== 0 && Math.sign(v) !== t.sign) return false;
  return Math.abs(Math.abs(t.value) - Math.abs(v)) <= 0.5 * 10 ** -t.decimals + 1e-9;
};
const dateEq = (a: NonNullable<Token["date"]>, b: NonNullable<Token["date"]>): boolean => a.m === b.m && a.d === b.d && (a.y === null || b.y === null || a.y === b.y);

/** Does the fact support this token? Numeric tokens compare against the fact's value (unit class must agree for typed tokens) and against the numbers in its display. */
export function tokenMatchesFact(t: Token, f: Fact): boolean {
  if (t.type === "abbrev") return false;
  const shown = factTokens(f);
  if (t.type === "date") return shown.some((x) => x.type === "date" && dateEq(t.date!, x.date!));
  if (t.type === "time") return shown.some((x) => x.type === "time" && x.minutes === t.minutes);
  const numericShown = shown.filter((x) => x.type !== "date" && x.type !== "time" && x.type !== "abbrev");
  const byDisplay = numericShown.some((x) => (t.type === "plain" || x.type === t.type) && numEq(t, x.value * (x.sign < 0 ? -1 : 1)));
  if (byDisplay) return true;
  if (typeof f.value !== "number") return false;
  return (t.type === "plain" || kindOfUnit(f.unit) === t.type) && numEq(t, f.value);
}

// ---------------------------------------------------------------- answer-level checks

export type HypStatus = "supported" | "ruled_out" | "inconclusive";
export interface HypInfo { id: string; name: string; status: HypStatus }
export interface AnswerItem { text: string; facts: string[]; evidence: string[] }
export interface RuledOutItem extends AnswerItem { hypothesis: string }
export interface Answer { headline: string; sentences: AnswerItem[]; ruledOut: RuledOutItem[]; recommendation: AnswerItem }
export interface VerifyCtx { facts: Fact[]; evidenceIds: Iterable<string>; hypotheses: HypInfo[]; requireRecommendation?: boolean }
export type Part = "headline" | "sentences" | "ruledOut" | "recommendation";
export interface VerifyError { part: Part; index: number; reason: string }
export interface VerifyResult { passed: boolean; errors: VerifyError[] }

export const errorLine = (e: VerifyError): string => (e.part === "headline" ? `headline: ${e.reason}` : e.part === "recommendation" ? `recommendation: ${e.reason}` : `${e.part}[${e.index}]: ${e.reason}`);

/** Words that name a hypothesis, used to catch "because of the cold weather" when weather is not supported. */
const ALIASES: Record<string, RegExp> = {
  H1: /\b(prices?|unit rates?|tariff rates?)\b/i,
  H2: /\b(wind|gas|generation mix|imports?)\b/i,
  H3: /\b(weather|cold|colder|temperatures?|heating degree)/i,
  H4: /\b(operational|operations?|opening hours|oven|schedules?)\b/i,
  H5: /\b(timing|time of day|peak[- ]time|shifted (?:usage|demand|use))\b/i,
  H6: /\b(one-off|single day|spike)\b/i,
  H7: /\b(meter (?:fault|error)s?|faulty meter|flatlines?|zero readings?)\b/i,
  H8: /\b(tariff change|changed tariff|standing charges?)\b/i,
  H9: /\b(data gaps?|missing data|missing (?:readings|half-hours))\b/i,
  H10: /\b(emissions?|carbon)\b/i,
  H11: /\b(unusual (?:day|usage)|anomal\w+|outliers?)\b/i,
};
const CAUSE_BEFORE = "(?:because of|because|due to|driven by|caused by|explained by|attributable to|owing to|thanks to|result of|resulting from)";
const CAUSE_AFTER = "(?:explains?|accounts? for|drove|drives|caused|causes|pushed|added|contributed|led to|is behind|was behind)";
function namedAsCause(text: string, alias: RegExp): boolean {
  const a = alias.source;
  return new RegExp(`${CAUSE_BEFORE}[^.;]{0,80}?(?:${a})`, "i").test(text) || new RegExp(`(?:${a})(?:\\s+[\\w'-]+)?\\s+${CAUSE_AFTER}\\b`, "i").test(text);
}

export function resolveHypothesis(ref: string, hyps: HypInfo[]): HypInfo | null {
  const id = ref.match(/\bH\d+\b/i)?.[0].toUpperCase();
  if (id) return hyps.find((h) => h.id === id) ?? null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return hyps.find((h) => norm(h.name) === norm(ref)) ?? null;
}

function checkText(text: string, factIds: unknown, evIds: unknown, ctx: VerifyCtx, evSet: Set<string>, byId: Map<string, Fact>, needCite: boolean): { errors: string[]; cited: Fact[] } {
  const errors: string[] = [];
  const cited: Fact[] = [];
  const fids = Array.isArray(factIds) ? factIds.map(String) : [];
  const eids = Array.isArray(evIds) ? evIds.map(String) : [];
  if (needCite && fids.length === 0) errors.push("cites no fact (facts[] is empty); cite at least one F#");
  if (needCite && eids.length === 0) errors.push("cites no evidence (evidence[] is empty); cite at least one E#");
  for (const id of fids) { const f = byId.get(id); if (f) cited.push(f); else errors.push(`cites ${id}, which does not exist in the facts table`); }
  for (const id of eids) if (!evSet.has(id)) errors.push(`cites ${id}, which is not an evidence record of this investigation`);
  for (const t of tokenize(text)) {
    if (t.type === "abbrev") { errors.push(`"${t.raw}" is an abbreviated number; copy the exact display string of a fact`); continue; }
    if (cited.some((f) => tokenMatchesFact(t, f))) continue;
    const hints = ctx.facts.filter((f) => tokenMatchesFact(t, f)).slice(0, 3).map((f) => `${f.id} = ${f.display}`);
    errors.push(`the number "${t.raw}" matches none of the cited facts${cited.length ? ` (${cited.map((f) => `${f.id} = ${f.display}`).join(", ")})` : ""}${hints.length ? `; facts with that value: ${hints.join(", ")} (cite one of them)` : "; no fact has that value, so remove the number"}`);
  }
  return { errors, cited };
}

/** Verifies a whole answer. Errors name the part and index ("sentences[2]") so they can be fed back to the model verbatim. */
export function verifyAnswer(answer: Answer, ctx: VerifyCtx): VerifyResult {
  const errors: VerifyError[] = [];
  const byId = new Map(ctx.facts.map((f) => [f.id, f]));
  const evSet = new Set(ctx.evidenceIds);
  const statusOf = new Map(ctx.hypotheses.map((h) => [h.id, h.status]));
  const push = (part: Part, index: number, reason: string) => errors.push({ part, index, reason });

  if (typeof answer?.headline !== "string" || !answer.headline.trim()) push("headline", 0, "the headline is empty");
  else for (const t of tokenize(answer.headline)) {
    if (t.type === "abbrev") push("headline", 0, `"${t.raw}" is an abbreviated number; copy the exact display string of a fact`);
    else if (!ctx.facts.some((f) => tokenMatchesFact(t, f))) push("headline", 0, `the number "${t.raw}" matches no fact in the table; use a fact display verbatim or remove it`);
  }

  const sentences = Array.isArray(answer?.sentences) ? answer.sentences : [];
  if (sentences.length === 0) push("sentences", 0, "there are no sentences");
  sentences.forEach((s, i) => {
    const text = typeof s?.text === "string" ? s.text : "";
    if (!text.trim()) { push("sentences", i, "the sentence text is empty"); return; }
    const { errors: errs, cited } = checkText(text, s.facts, s.evidence, ctx, evSet, byId, true);
    errs.forEach((r) => push("sentences", i, r));
    for (const f of cited) {
      const st = f.hypothesis ? statusOf.get(f.hypothesis) : undefined;
      if (st && st !== "supported") push("sentences", i, `cites ${f.id} (${f.hypothesis}), but ${f.hypothesis} is ${st}; only supported causes belong in sentences${st === "ruled_out" ? " (put it in ruledOut)" : " (leave it out)"}`);
    }
    for (const [id, alias] of Object.entries(ALIASES)) {
      const st = statusOf.get(id);
      if (st !== "supported" && namedAsCause(text, alias)) push("sentences", i, `presents ${id} (${ctx.hypotheses.find((h) => h.id === id)?.name ?? "not tested"}) as a cause, but ${id} is ${st ?? "not tested"}`);
    }
    if (/\brul(?:ed|e|es|ing)[- ]out\b/i.test(text)) push("sentences", i, "mentions ruling something out; ruled-out causes belong in ruledOut, not in sentences");
  });

  (Array.isArray(answer?.ruledOut) ? answer.ruledOut : []).forEach((r, i) => {
    const h = typeof r?.hypothesis === "string" ? resolveHypothesis(r.hypothesis, ctx.hypotheses) : null;
    if (!h) push("ruledOut", i, `the hypothesis "${String(r?.hypothesis)}" is not one of the tested hypotheses`);
    else if (h.status !== "ruled_out") push("ruledOut", i, `${h.id} (${h.name}) is ${h.status}, not ruled_out`);
    const text = typeof r?.text === "string" ? r.text : "";
    if (!text.trim()) { push("ruledOut", i, "the text is empty"); return; }
    const { errors: errs, cited } = checkText(text, r.facts, r.evidence, ctx, evSet, byId, true);
    errs.forEach((e) => push("ruledOut", i, e));
    for (const f of cited) if (f.hypothesis && statusOf.get(f.hypothesis) === "supported") push("ruledOut", i, `cites ${f.id} (${f.hypothesis}), which belongs to a supported hypothesis`);
  });

  const rec = answer?.recommendation;
  const recText = typeof rec?.text === "string" ? rec.text : "";
  if (!recText.trim()) { if (ctx.requireRecommendation) push("recommendation", 0, "the recommendation is empty"); }
  else {
    const { errors: errs, cited } = checkText(recText, rec.facts, rec.evidence, ctx, evSet, byId, true);
    errs.forEach((r) => push("recommendation", 0, r));
    if (cited.some((f) => f.key.startsWith("flat_") || f.key.startsWith("agile_") || f.key === "tariff_name") && !/counterfactual|would have/i.test(recText)) {
      push("recommendation", 0, "the tariff comparison must be framed as a historical counterfactual (say \"counterfactual\" or \"would have\")");
    }
  }
  return { passed: errors.length === 0, errors };
}
