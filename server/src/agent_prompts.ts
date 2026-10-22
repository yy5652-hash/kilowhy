// Prompts and reply parsers for the three LLM steps (intent, plan, narrative). The model only ever sees question text, site names, the hypothesis
// catalog, a decomposition summary and the facts table: no SQL results, no tokens, no keys. Replies are JSON; parsers are forgiving about types
// (a fact id as 12 or "F12", one id as a string) and strict about structure.
import { CATALOG } from "./hypotheses/index.ts";
import { ALLOWED_VIEWS } from "./sqlguard.ts";
import type { Fact } from "./facts.ts";
import type { ChatMessage } from "./provider_shared.ts";
import type { Checked } from "./agent_llm.ts";
import { INTENT_TYPES, type Intent, type IntentType } from "./agent_types.ts";
import type { Answer, AnswerItem, HypInfo } from "./verifier.ts";
import type { SiteRef } from "./agent_sites.ts";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[,;]/) : []).map((x) => String(x).trim()).filter(Boolean);

// ---------------------------------------------------------------- intent (mode auto)
export function intentMessages(question: string, sites: SiteRef[]): ChatMessage[] {
  return [
    { role: "system", content:
`You classify one question from the owner of a small multi-site UK business about their electricity bill.
Reply with ONE JSON object and nothing else:
{"type": "why_cost_change" | "why_spike_day" | "why_emissions" | "what_to_change", "sites": [string], "dates": [string]}
type: why_cost_change = why did the electricity cost or usage change or rise (the default for any "why more/higher/lower" question); why_spike_day = why did a site or a particular day spike; why_emissions = emissions, carbon, CO2; what_to_change = what should we change or do to save money or carbon.
sites: the site names or ids the question mentions, copied as written ("Brixton", "site 2", "S3"). [] if it names no site, ["ALL"] if it says all sites or the whole business.
dates: dates the question mentions as YYYY-MM-DD, otherwise [].
Known sites: ${sites.map((s) => `${s.id} = ${s.name}`).join("; ")}.` },
    { role: "user", content: question },
  ];
}
export function checkIntent(v: unknown): Checked<Omit<Intent, "source">> {
  const o = v as { type?: unknown; sites?: unknown; dates?: unknown } | null;
  const type = typeof o?.type === "string" ? (o.type.trim().toLowerCase() as IntentType) : null;
  if (!type || !INTENT_TYPES.includes(type)) return { ok: false, error: `"type" must be one of ${INTENT_TYPES.join(", ")}` };
  return { ok: true, value: { type, requestedSites: strs(o?.sites), dates: strs(o?.dates).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) } };
}

// ---------------------------------------------------------------- plan (mode deep)
const VIEW_COLUMNS: Record<string, string> = {
  agile_rates: "slot_start, slot_end, p_kwh_exc_vat, p_kwh_inc_vat", ci_london: "slot_start, forecast_gco2_kwh, intensity_index, wind_pct, gas_pct, solar_pct, nuclear_pct, imports_pct, biomass_pct",
  fuel_hh: "slot_start, settlement_date, settlement_period, fuel_type, mw", temp_hourly: "ts, temp_c", meter_hh: "site_id, ts, kwh (SAMPLE data)", sites: "site_id, name, postcode, region",
  ops_log: "event_id, site_id, event_date, description", contract: "product_code, tariff_code, standing_charge_p_per_day, vat_rate, valid_from", agile_standing: "valid_from, p_day_inc_vat", flat_tariff: "valid_from, valid_to, p_kwh_exc_vat, p_kwh_inc_vat",
};
export interface PlanInput { question: string; type: IntentType; scopeLabel: string; summary: string }
export function planMessages(i: PlanInput): ChatMessage[] {
  return [
    { role: "system", content:
`You plan which statistical tests to run to explain a change in a small business's electricity bill between window A (baseline, 28 days) and window B (current, the 28 days after). Code runs the tests and decides the outcome; you only choose.
Reply with ONE JSON object and nothing else:
{"hypotheses": ["H1", ...], "extraSql": [{"purpose": "why this query helps", "sql": "SELECT ..."}], "rationale": "one or two sentences"}
Rules:
- "hypotheses": ordered list of ids from the catalog below, most relevant first. Never invent an id. The data checks H7, H8 and H9 are always added by the system, so you need not list them.
- "extraSql": optional, at most 2 queries (an empty list is fine). Each must be one read-only SELECT (or WITH ... SELECT) over the views below using the kilowhy. prefix, with a LIMIT of at most 5000. No semicolons, no DDL or DML. Dialect is Spark SQL: CAST(x AS DATE), timestamp '2026-09-24 00:00:00' literals, date_sub(); no :: casts, no INTERVAL strings, no subqueries in WHERE. Keep each query simple (one or two views). Window A is 2026-08-27 to 2026-09-23 and window B is 2026-09-24 to 2026-10-21 (UTC).
Catalog:
${CATALOG.map((c) => `${c.id} ${c.name}: ${c.description}`).join("\n")}
Views (schema kilowhy): ${ALLOWED_VIEWS.map((v) => `${v}(${VIEW_COLUMNS[v] ?? ""})`).join("; ")}.` },
    { role: "user", content: `Question: ${i.question}\nQuestion type: ${i.type}\nScope: ${i.scopeLabel}\nDecomposition summary (window B minus window A): ${i.summary}` },
  ];
}
export interface PlanReply { hypotheses: string[]; extraSql: { purpose: string; sql: string }[]; rationale: string }
export function checkPlan(v: unknown): Checked<PlanReply> {
  const o = v as { hypotheses?: unknown; extraSql?: unknown; rationale?: unknown } | null;
  if (!o || typeof o !== "object" || !("hypotheses" in o)) return { ok: false, error: 'the object needs a "hypotheses" array' };
  const extra = (Array.isArray(o.extraSql) ? o.extraSql : []).filter((x): x is { purpose?: unknown; sql: string } => !!x && typeof (x as { sql?: unknown }).sql === "string")
    .map((x) => ({ purpose: typeof x.purpose === "string" ? x.purpose : "extra query", sql: x.sql }));
  return { ok: true, value: { hypotheses: strs(o.hypotheses).map((h) => h.toUpperCase().replace(/^(H)0+(\d)/, "$1$2")), extraSql: extra, rationale: typeof o.rationale === "string" ? o.rationale : "" } };
}

// ---------------------------------------------------------------- narrative (mode deep)
export interface NarrativeInput { question: string; type: IntentType; scopeText: string; facts: Fact[]; hypotheses: HypInfo[]; titles: Record<string, string>; focusDates: string[]; hasRecommendation: boolean }

const TYPE_HINT: Record<IntentType, string> = {
  why_cost_change: "Explain why the bill changed between the two windows.",
  why_spike_day: "Explain which day or site spiked and why; use the one-off-day and unusual-day facts if they are supported.",
  why_emissions: "Explain why emissions changed (volume, a dirtier or cleaner grid, timing), using the emissions facts.",
  what_to_change: "Open with the size of the change in one sentence, spend the rest on what the owner could change, and make the recommendation the focus.",
};

export function factsTable(facts: Fact[]): string {
  return facts.map((f) => `${f.id} | ${f.hypothesis ?? "-"} | ${f.label} | ${f.display} | ${f.evidence}`).join("\n");
}

export function narrativeMessages(i: NarrativeInput): ChatMessage[] {
  const statuses = i.hypotheses.map((h) => `${h.id} ${h.name} (${i.titles[h.id] ?? h.name}): ${h.status}`).join("\n");
  const system =
`You write the answer to a small-business owner's question about their electricity bill. Plain English, no jargon, no markdown. ${TYPE_HINT[i.type]}
You may use ONLY the facts table below. Reply with ONE JSON object and nothing else, in this schema:
{"headline": string,
 "sentences": [{"text": string, "facts": ["F3","F7"], "evidence": ["E1","E4"]}],
 "ruledOut": [{"hypothesis": "H5", "text": string, "facts": ["F20"], "evidence": ["E9"]}],
 "recommendation": {"text": string, "facts": ["F31"], "evidence": ["E19"]}}
Rules:
1. "sentences": 4 to 6 sentences. The first states the size of the change and the biggest supported cause; ${i.type === "what_to_change" ? "the next ones cover the supported causes the owner can act on (for example evening-peak prices or when the sites use power) and what could be changed, using the REC facts" : "the next ones give the other supported causes with their sizes"}. Only hypotheses whose status is "supported" may be presented as causes. Never mention an "inconclusive" hypothesis.
2. "ruledOut": one short item for each "ruled_out" hypothesis worth mentioning (at most 4), each with its "hypothesis" id and the facts that show it. Put nothing else there. Never put a ruled-out cause in "sentences".
3. "recommendation": one or two sentences that end the answer, using the facts tagged REC. If you mention the flat-tariff comparison, say it is a historical counterfactual on the same kWh, not advice. ${i.hasRecommendation ? "" : "There are no REC facts, so leave the recommendation text empty."}
4. Numbers: every number, date and time you write must be copied VERBATIM from the "display" column of a fact (for example "£339.91", "54.9%", "8,312 kWh", "2026-10-17"). Never calculate, add, subtract, round or estimate. Never write a number that is not in the table. Small whole words like "three sites" are fine.
5. Describe each number exactly as its "what it is" column says, and do not give it a cause that column does not name (for example, the total change in usage is not the weather part). Each sentence, ruled-out item and the recommendation lists in "facts" the F# ids whose displays it uses, and in "evidence" the E# ids of those facts (column "evidence"). Cite at least one of each. Every number, date or time in a sentence must appear in the display of a fact listed in THAT sentence's "facts" (the verifier checks sentence by sentence), so list a fact for every figure you write.
6. The headline is one short line that may repeat displays from the table; it needs no citations.
7. The meter readings are synthetic SAMPLE data; do not describe them as real measurements.
Hypothesis statuses:
${statuses}
Facts table (id | hypothesis | what it is | display | evidence):
${factsTable(i.facts)}`;
  const focus = i.focusDates.length ? `\nThe owner asked about: ${i.focusDates.join(", ")}.` : "";
  return [{ role: "system", content: system }, { role: "user", content: `Question: ${i.question}\nScope: ${i.scopeText}${focus}` }];
}

const item = (v: unknown): AnswerItem | null => {
  const o = v as { text?: unknown; facts?: unknown; evidence?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.text !== "string") return null;
  const ids = (x: unknown, p: string) => strs(x).map((s) => (/^\d+$/.test(s) ? `${p}${s}` : s.replace(/[\[\]\s]/g, "").toUpperCase()));
  return { text: o.text.trim(), facts: ids(o.facts, "F"), evidence: ids(o.evidence, "E") };
};

export function checkNarrative(v: unknown): Checked<Answer> {
  const o = v as { headline?: unknown; sentences?: unknown; ruledOut?: unknown; recommendation?: unknown } | null;
  if (!o || typeof o !== "object") return { ok: false, error: "the reply is not a JSON object" };
  if (!Array.isArray(o.sentences)) return { ok: false, error: 'the object needs a "sentences" array of {text, facts, evidence}' };
  const sentences = o.sentences.map(item);
  if (sentences.some((s) => s === null)) return { ok: false, error: 'every entry of "sentences" needs a "text" string, a "facts" array and an "evidence" array' };
  const ruled = (Array.isArray(o.ruledOut) ? o.ruledOut : []).map((r) => { const base = item(r); return base ? { ...base, hypothesis: String((r as { hypothesis?: unknown }).hypothesis ?? "") } : null; });
  if (ruled.some((r) => r === null)) return { ok: false, error: 'every entry of "ruledOut" needs "hypothesis", "text", "facts" and "evidence"' };
  const rec = item(o.recommendation) ?? { text: "", facts: [], evidence: [] };
  return { ok: true, value: { headline: typeof o.headline === "string" ? o.headline.trim() : "", sentences: sentences as AnswerItem[], ruledOut: ruled as Answer["ruledOut"], recommendation: rec } };
}
