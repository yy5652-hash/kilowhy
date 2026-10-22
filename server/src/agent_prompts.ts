// Prompts and reply parsers for the three LLM steps (intent, plan, narrative). The model only ever sees the question, site names, the hypothesis
// catalog and a compact facts table: no SQL results, no tokens, no keys. Replies are small JSON objects; the narrative model writes {F#} placeholders
// instead of numbers (see placeholders.ts). Parsers are forgiving about types and strict about structure.
import { CATALOG } from "./hypotheses/index.ts";
import { ALLOWED_VIEWS } from "./sqlguard.ts";
import type { Fact } from "./facts.ts";
import type { ChatMessage } from "./provider_shared.ts";
import type { Checked } from "./agent_llm.ts";
import { INTENT_TYPES, type Intent, type IntentType } from "./agent_types.ts";
import { createHash } from "node:crypto";
import type { HypInfo } from "./verifier.ts";
import type { SiteRef } from "./agent_sites.ts";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/[,;]/) : []).map((x) => String(x).trim()).filter(Boolean);

// Nightshift's response cache is keyed on the user message only (the system prompt is ignored: measured, docs/latency.md), so each step's user message
// must be unique to the step and, for the narrative, to the facts it was written from; otherwise one step can be answered with another step's cached reply.
// ---------------------------------------------------------------- intent (mode auto)
// Caps only stop a runaway: through Meterless the model writes its reasoning as plain text before the JSON (about 300-700 tokens, see docs/latency.md),
// so a tight cap truncates the JSON itself.
export const INTENT_MAX_TOKENS = 800;
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
    { role: "user", content: `Classify this question: ${question}` },
  ];
}
export function checkIntent(v: unknown): Checked<Omit<Intent, "source">> {
  const o = v as { type?: unknown; sites?: unknown; dates?: unknown } | null;
  const type = typeof o?.type === "string" ? (o.type.trim().toLowerCase() as IntentType) : null;
  if (!type || !INTENT_TYPES.includes(type)) return { ok: false, error: `"type" must be one of ${INTENT_TYPES.join(", ")}` };
  return { ok: true, value: { type, requestedSites: strs(o?.sites), dates: strs(o?.dates).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) } };
}

// ---------------------------------------------------------------- plan (mode deep)
// The plan only orders the tests and may add one query: the code runs every catalog hypothesis anyway, so the model sees just the question.
const VIEW_COLUMNS: Record<string, string> = {
  agile_rates: "slot_start, p_kwh_inc_vat", ci_london: "slot_start, forecast_gco2_kwh, wind_pct, gas_pct, imports_pct", fuel_hh: "slot_start, fuel_type, mw", temp_hourly: "ts, temp_c",
  meter_hh: "site_id, ts, kwh (SAMPLE data)", sites: "site_id, name", ops_log: "site_id, event_date, description", contract: "standing_charge_p_per_day, valid_from", agile_standing: "valid_from, p_day_inc_vat", flat_tariff: "valid_from, p_kwh_exc_vat",
};
export interface PlanInput { question: string }
export const PLAN_MAX_TOKENS = 1200;
export function planMessages(i: PlanInput): ChatMessage[] {
  return [
    { role: "system", content:
`You plan which tests to emphasise when explaining a change in a small business's electricity bill (window B, the latest 28 days, against window A, the 28 days before). Code runs every test; you only order them.
Reply with ONE JSON object and nothing else: {"hypotheses": ["H3", "H1", ...], "extraSql": []}
- "hypotheses": ids from the catalog, most relevant to the question first. Never invent an id.
- "extraSql": [] unless one specific figure is missing. At most ONE item {"purpose": "...", "sql": "SELECT ..."}: a single read-only Spark SQL SELECT over kilowhy.<view> with LIMIT <= 5000 (CAST(x AS DATE), timestamp '2026-09-24 00:00:00' literals; no :: casts, no INTERVAL strings, no subqueries in WHERE). Window A is 2026-08-27 to 2026-09-23, window B is 2026-09-24 to 2026-10-21.
Catalog: ${CATALOG.map((c) => `${c.id} ${c.title}`).join("; ")}.
Views: ${ALLOWED_VIEWS.map((v) => `${v}(${VIEW_COLUMNS[v] ?? ""})`).join("; ")}. Most questions need no extra query: answer [] and be quick.` },
    { role: "user", content: `Order the tests for this question: ${i.question}` },
  ];
}
export interface PlanReply { hypotheses: string[]; extraSql: { purpose: string; sql: string }[] }
export function checkPlan(v: unknown): Checked<PlanReply> {
  const o = v as { hypotheses?: unknown; extraSql?: unknown } | null;
  if (!o || typeof o !== "object" || !("hypotheses" in o)) return { ok: false, error: 'the object needs a "hypotheses" array' };
  const extra = (Array.isArray(o.extraSql) ? o.extraSql : []).filter((x): x is { purpose?: unknown; sql: string } => !!x && typeof (x as { sql?: unknown }).sql === "string")
    .map((x) => ({ purpose: typeof x.purpose === "string" ? x.purpose : "extra query", sql: x.sql }));
  return { ok: true, value: { hypotheses: strs(o.hypotheses).map((h) => h.toUpperCase().replace(/^(H)0+(\d)/, "$1$2")), extraSql: extra } };
}

// ---------------------------------------------------------------- narrative (mode deep): placeholders, never digits
export const NARRATIVE_MAX_TOKENS = 2200;   // the JSON itself is about 530 tokens; the reasoning before it about 700 (a 500 or 900 cap truncated every reply)
export interface NarrativeInput { question: string; type: IntentType; scopeText: string; facts: Fact[]; hypotheses: HypInfo[]; titles: Record<string, string>; focusDates: string[]; hasRecommendation: boolean }

const TYPE_HINT: Record<IntentType, string> = {
  why_cost_change: "Explain why the bill changed between the two windows.",
  why_spike_day: "Explain which day or site spiked and why; use the one-off-day and unusual-day facts if their hypotheses are supported.",
  why_emissions: "Explain why emissions changed (more electricity, a dirtier or cleaner grid, timing), using the emissions facts.",
  what_to_change: "Open with the size of the change in one sentence, then cover the supported causes the owner can act on, and make the recommendation the focus.",
};

/** The facts the narrative model needs: neutral headline facts, plus the facts of supported and ruled-out hypotheses (inconclusive ones are left out; the model must not mention them). */
export const offHypotheses = (type?: IntentType): string[] => (type === "why_emissions" ? ["H1", "H2", "H5", "H8"] : type ? ["H10"] : []);   // a cost question is not answered with emissions, nor an emissions question with pounds
export function relevantFacts(facts: Fact[], hyps: HypInfo[], emphasis: string[] = [], type?: IntentType): Fact[] {
  const status = new Map(hyps.map((h) => [h.id, h.status]));
  const perRuledOut = new Map<string, number>();
  const off = offHypotheses(type);
  return facts.filter((f) => {
    if (f.hypothesis && off.includes(f.hypothesis)) return false;
    if (!f.hypothesis || f.hypothesis === "REC" || f.hypothesis === "EXTRA") return true;
    const st = status.get(f.hypothesis);
    if (st === "supported") return true;
    if (st !== "ruled_out") return false;
    const n = (perRuledOut.get(f.hypothesis) ?? 0) + 1;   // a ruled-out hypothesis needs only a few facts unless the planner stressed it
    perRuledOut.set(f.hypothesis, n);
    return emphasis.includes(f.hypothesis) || n <= 3;
  });
}

/** One line per fact: id, hypothesis tag, description, current value (the model reads the value to judge size but must not copy it). */
export function factsTable(facts: Fact[]): string {
  return facts.map((f) => `${f.id}${f.hypothesis ? ` [${f.hypothesis}]` : ""} ${f.label} = ${f.display}`).join("\n");
}

export function narrativeMessages(i: NarrativeInput): ChatMessage[] {
  const statuses = i.hypotheses.filter((h) => h.status !== "inconclusive").map((h) => `${h.id} ${i.titles[h.id] ?? h.name}: ${h.status}`).join("\n");
  const system =
`You write the answer to a small-business owner's question about their electricity bill, in plain English: no jargon, no markdown. ${TYPE_HINT[i.type]}
Reply with ONE JSON object and nothing else: {"headline": "...", "sentences": [{"text": "..."}], "ruledOut": [{"hypothesis": "H5", "text": "..."}], "recommendation": {"text": "..."}}
Rules:
1. NEVER write a digit. Wherever a number, amount, percentage, date or time belongs, write the placeholder of the fact, for example {F9}; the code replaces it with the exact figure. Use {F9:abs} to drop a minus sign when you write "fell by" or "cut". A placeholder already contains its unit (£, %, kWh, pp, sd), so never write a unit word after it. Spell small counts in words, and do not mention thresholds, limits or window lengths as numbers.
2. "sentences": 4 to 6 sentences, each with at least one placeholder. The first gives the size of the change and the biggest supported cause; ${i.type === "what_to_change" ? "the rest cover the supported causes the owner can act on and what could be changed (REC facts)" : "the rest give the other supported causes with their sizes"}. Only hypotheses marked supported may be presented as causes; never mention a hypothesis that is not listed below.
3. "ruledOut": one short item per ruled_out hypothesis worth a mention (at most four), with its id and at least one placeholder. Nothing else goes there.
4. "recommendation": one or two sentences using the REC facts. ${i.hasRecommendation ? "A flat-tariff comparison must be called a historical counterfactual, not advice." : "There are no REC facts, so leave the text empty."}
5. Say what each fact says, no more: do not give a figure a cause its description does not name. The data are synthetic SAMPLE meter readings; do not call them real measurements.
6. "headline": one short line; placeholders allowed.
Hypotheses:
${statuses}
Facts (id [hypothesis] description = value):
${factsTable(i.facts)}`;
  const focus = i.focusDates.length ? `\nThe owner asked about: ${i.focusDates.join(", ")}.` : "";
  const fingerprint = createHash("sha256").update(`${statuses}\n${factsTable(i.facts)}`).digest("hex").slice(0, 12);   // a cached reply is only valid for the same facts table
  return [{ role: "system", content: system }, { role: "user", content: `Question: ${i.question}\nScope: ${i.scopeText}${focus}\nFacts table ${fingerprint}: write the answer from it.` }];
}

/** Structure check only; placeholders, digits and statuses are handled by narration.ts and the verifier. Plain strings are accepted for {"text": ...} entries. */
export function checkNarrativeShape(v: unknown): Checked<{ headline?: unknown; sentences: unknown[]; ruledOut?: unknown; recommendation?: unknown }> {
  const o = v as { headline?: unknown; sentences?: unknown; ruledOut?: unknown; recommendation?: unknown } | null;
  if (!o || typeof o !== "object") return { ok: false, error: "the reply is not a JSON object" };
  const asItem = (x: unknown): unknown => (typeof x === "string" ? { text: x } : x);
  if (!Array.isArray(o.sentences)) return { ok: false, error: 'the object needs a "sentences" array of {"text": ...}' };
  const sentences = o.sentences.map(asItem);
  if (sentences.some((s) => !s || typeof (s as { text?: unknown }).text !== "string")) return { ok: false, error: 'every entry of "sentences" needs a "text" string' };
  return { ok: true, value: { headline: o.headline, sentences, ruledOut: Array.isArray(o.ruledOut) ? o.ruledOut.map(asItem) : o.ruledOut, recommendation: asItem(o.recommendation) } };
}
