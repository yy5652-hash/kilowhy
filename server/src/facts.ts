// Facts table (spec section 13, step 5): every number the narrative may use, as F1.. with a pre-formatted display string and the evidence it comes from.
// Built deterministically from the decomposition, the hypothesis metrics held in the evidence store, and the recommendations. The LLM never computes a number.
// Meter kWh in this project are SAMPLE data; prices, carbon and weather are real public data.
import { allocateRounded } from "./decompose.ts";
import { addDays } from "./bands.ts";
import type { EvidenceStore } from "./evidence.ts";
import { displayFor, type FactValue } from "./facts_format.ts";
import type { Decomp, HypothesisResult, Scope } from "./hypotheses/types.ts";
import type { Recommendation, TariffComparison } from "./recommend.ts";
import type { DateWindow } from "./windows.ts";
import { hypothesisFacts } from "./facts_hyp.ts";
import { singleRowNumbers } from "./agent_extra.ts";
import { annotateOptions } from "./facts_options.ts";

export interface Fact {
  id: string;                 // "F1", "F2", ...
  key: string;                // stable machine key ("delta_bill", "L", "v_weather"), used by the template narrative
  label: string;
  value: FactValue;           // number in the unit of `unit` (percent as 54.91, pounds as 339.91), or text / date string
  unit: string;               // GBP | % | kWh | p/kWh | kgCO2e | pp | sd | HDD | date | text | ...
  display: string;            // the string the narrative must copy: £339.91, 54.9%, 8,312 kWh, 21.4 p/kWh, 103.0 kgCO2e, 2026-10-17
  evidence: string;           // E# the value comes from ("" for a remembered note)
  hypothesis?: string;        // H1..H11 when the fact belongs to one hypothesis; REC for the recommendation; absent for neutral facts
  memory?: FactMemory;        // M# facts only: a memory recalled from H-MEM (it has no E#: evidence is "")
  rank?: number;              // recommendation facts only: 1 = the option with the largest £ effect (facts_options.ts)
  option?: "tariff" | "load_shift";
}
export interface FactMemory { id: string; origin: "user" | "agent"; site?: string; learnedAt: string; validFrom?: string; confidence: number; relevance: number; bearsOn?: string[] }   // bearsOn: facts about the same subject (a logged event whose text overlaps the note)

export interface FactsInput {
  scope: Scope;
  siteNames: Record<string, string>;
  windowA: DateWindow; windowB: DateWindow;
  decomposition: Decomp;
  results: HypothesisResult[];
  evidence: EvidenceStore;
  rec: Recommendation | null;
  tariff: TariffComparison | null;
  extras?: { purpose: string; evidence: string; rows: number }[];   // planner-proposed SQL that ran: row count, and the numbers of a single-row result
}

const roundTo = (x: number, dp: number): number => Math.round(x * 10 ** dp) / 10 ** dp;

/** Append-only fact list with sequential ids; null / non-finite values are skipped so a missing metric simply yields no fact. */
export class FactTable {
  readonly facts: Fact[] = [];
  add(key: string, label: string, value: FactValue | undefined, unit: string, evidence: string | null | undefined, hypothesis?: string): Fact | null {
    if (value === null || value === undefined || !evidence) return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    const v = typeof value === "number" ? roundTo(value, 4) : value;
    const fact: Fact = { id: `F${this.facts.length + 1}`, key, label, value: v, unit, display: displayFor(v, unit), evidence, ...(hypothesis ? { hypothesis } : {}) };
    this.facts.push(fact);
    return fact;
  }
  get(key: string): Fact | undefined { return this.facts.find((f) => f.key === key); }
}

const pct = (part: number, whole: number): number | null => (whole === 0 ? null : (part / whole) * 100);

function decompositionFacts(t: FactTable, i: FactsInput): void {
  const r = i.decomposition.result;
  if (!r) return;
  const e = i.decomposition.evidenceId;
  const names = i.scope.sites.map((s) => (i.siteNames[s] ? `${s} (${i.siteNames[s]})` : s)).join(", ");
  // V, L, T, S are rounded to whole pence so that V + L + T + S = the bill change exactly as displayed (largest-remainder rounding).
  const [V, L, T, S] = allocateRounded([r.volume, r.price, r.timing, r.standing]).map((p) => p / 100);
  const dC = Math.round(r.deltaTotal) / 100;
  t.add("sites", "Sites in scope", names, "text", e);
  t.add("window_days", "Days in each window", i.windowA.days, "days", e);
  t.add("window_A_start", "Window A (baseline) first day", i.windowA.from, "date", e);
  t.add("window_A_end", "Window A (baseline) last day", addDays(i.windowA.toExclusive, -1), "date", e);
  t.add("window_B_start", "Window B (current) first day", i.windowB.from, "date", e);
  t.add("window_B_end", "Window B (current) last day", addDays(i.windowB.toExclusive, -1), "date", e);
  t.add("bill_A", "Electricity bill in window A (energy + standing charge)", Math.round(r.totalA) / 100, "GBP", e);
  t.add("bill_B", "Electricity bill in window B (energy + standing charge)", Math.round(r.totalB) / 100, "GBP", e);
  t.add("delta_bill", "Change in the bill, window B minus window A", dC, "GBP", e);
  t.add("delta_bill_pct", "Change in the bill as a share of the window A bill", pct(r.deltaTotal, r.totalA), "%", e);
  t.add("V", "Volume effect V: using more or less electricity at the window A average price", V, "GBP", e);
  t.add("V_share", "Volume effect V as a share of the bill change", pct(V, dC), "%", e);
  t.add("L", "Price-level effect L: window B prices on the window A usage pattern", L, "GBP", e, "H1");
  t.add("L_share", "Price-level effect L as a share of the bill change", pct(L, dC), "%", e, "H1");
  t.add("T", "Timing effect T: usage moving to dearer or cheaper times of day", T, "GBP", e, "H5");
  t.add("T_share", "Timing effect T as a share of the bill change", pct(T, dC), "%", e, "H5");
  t.add("S", "Standing-charge effect S", S, "GBP", e, "H8");
  t.add("kwh_A", "Electricity used in window A (SAMPLE meter data)", r.QA, "kWh", e);
  t.add("kwh_B", "Electricity used in window B (SAMPLE meter data)", r.QB, "kWh", e);
  t.add("delta_kwh", "Change in electricity used, window B minus window A", r.QB - r.QA, "kWh", e);
  t.add("delta_kwh_pct", "Change in electricity used as a share of window A", pct(r.QB - r.QA, r.QA), "%", e);
  t.add("avg_price_A", "Average unit price paid in window A", r.pbarA, "p/kWh", e);
  t.add("avg_price_B", "Average unit price paid in window B", r.pbarB, "p/kWh", e);
  t.add("avg_price_B_on_A_shape", "Average window B unit price on the window A usage pattern", r.pbarBStar, "p/kWh", e);
}

function recommendationFacts(t: FactTable, i: FactsInput): void {
  const { rec, tariff, evidence } = i;
  if (rec?.ok && rec.evidence[0]) {
    const e = rec.evidence[0];
    const m = evidence.get(e)?.metrics ?? {};
    const blocks = [...new Set(rec.sites.map((s) => s.targetBlock).filter((b): b is string => !!b))];
    t.add("rec_saved", "Load shift: money saved on window B prices", rec.total.savedGbp, "GBP", e, "REC");
    t.add("rec_saved_kg", "Load shift: carbon saved", rec.total.savedKgCo2e, "kgCO2e", e, "REC");
    t.add("rec_shifted_kwh", "Load shift: electricity moved out of the 16:00-19:00 peak band", rec.total.shiftedKwh, "kWh", e, "REC");
    t.add("rec_site_days", "Load shift: site-days on which a shift saved money", m.days_shifted_site_days?.value as number | undefined, "count", e, "REC");
    t.add("peak_band", "Peak band (local time)", "16:00-19:00", "text", e, "REC");
    t.add("rec_cap", "Load shift: cap on the flexible load moved per site per day", rec.maxKwhPerDay, "kWh", e, "REC");
    t.add("rec_blocks", "Load shift: cheapest same-day block(s) the load moves into (local time)", blocks.join(", ") || null, "text", e, "REC");
  }
  if (tariff?.ok && tariff.windows && tariff.evidence[0]) {
    const e = tariff.evidence[0], w = tariff.windows;
    t.add("tariff_name", "Comparison flat tariff (single unit rate, business, region C)", tariff.tariff.name, "text", e, "REC");
    for (const k of ["B", "A"] as const) {
      t.add(`flat_total_${k}`, `Flat tariff bill for the same kWh in window ${k} (energy + standing, VAT at the contract rate)`, w[k].flat.totalGbp, "GBP", e, "REC");
      t.add(`agile_total_${k}`, `Actual Agile bill in window ${k} (energy + standing)`, w[k].agile.totalGbp, "GBP", e, "REC");
      t.add(`flat_minus_agile_${k}`, `Flat tariff minus Agile in window ${k} (positive: the flat tariff would have cost more, so staying on Agile saved this much; negative: the flat tariff would have been cheaper)`, w[k].flatMinusAgileGbp, "GBP", e, "REC");
    }
    t.add("tariff_cheaper_B", "Cheaper tariff in window B on the same kWh", tariff.cheaperInWindowB, "text", e, "REC");
  }
}

/** The deterministic facts table of one investigation. Ids F1.. follow the build order, so the same inputs always give the same table. */
export function buildFacts(input: FactsInput): Fact[] {
  const t = new FactTable();
  decompositionFacts(t, input);
  hypothesisFacts(t, input);
  recommendationFacts(t, input);
  annotateOptions(t.facts);
  (input.extras ?? []).forEach((x, n) => {
    t.add(`extra_${n + 1}_rows`, `Extra query ${n + 1} (${x.purpose}): rows returned`, x.rows, "count", x.evidence, "EXTRA");
    for (const [col, v] of singleRowNumbers(input.evidence, x.evidence)) t.add(`extra_${n + 1}_${col}`, `Extra query ${n + 1} (${x.purpose}): ${col}`, v, "number", x.evidence, "EXTRA");
  });
  return t.facts;
}
