// Recommendation options ranked by their computed £ effect (D5b): the flat-tariff counterfactual and the load shift, largest first.
// The ranking is deterministic and comes only from facts: the narrative is told the order, and the verifier rejects a recommendation that leads with a smaller option.
import type { Fact } from "./facts.ts";

export type OptionKey = "tariff" | "load_shift";
export interface RecOption {
  key: OptionKey;
  rank: number;                       // 1 = largest £ effect
  factId: string;                     // the fact that holds the £ figure
  extraFactIds: string[];             // facts presented with it (kgCO2e of the load shift)
  gbp: number;                        // magnitude of the effect over window B
  direction: "agile_cheaper" | "flat_cheaper" | "saving";
}

const num = (f: Fact | undefined): number | null => (f && typeof f.value === "number" && Number.isFinite(f.value) ? f.value : null);

/** The options present in the facts table, ranked by £ (ties: the tariff finding first). Empty when there are no recommendation facts. */
export function rankOptions(facts: Fact[]): RecOption[] {
  const get = (key: string) => facts.find((f) => f.key === key && f.hypothesis === "REC");
  const out: Omit<RecOption, "rank">[] = [];
  const tariff = get("flat_minus_agile_B"), v = num(tariff);
  if (tariff && v !== null && v !== 0) out.push({ key: "tariff", factId: tariff.id, extraFactIds: [], gbp: Math.abs(v), direction: v > 0 ? "agile_cheaper" : "flat_cheaper" });
  const shift = get("rec_saved"), s = num(shift), kg = get("rec_saved_kg");
  if (shift && s !== null) out.push({ key: "load_shift", factId: shift.id, extraFactIds: kg && num(kg) !== null ? [kg.id] : [], gbp: Math.abs(s), direction: "saving" });
  return out.sort((a, b) => b.gbp - a.gbp).map((o, i) => ({ ...o, rank: i + 1 }));
}

/** Writes the rank of each option onto its £ fact (Fact.rank, Fact.option) so the facts table in the result shows it. */
export function annotateOptions(facts: Fact[]): RecOption[] {
  const options = rankOptions(facts);
  for (const o of options) { const f = facts.find((x) => x.id === o.factId)!; f.rank = o.rank; f.option = o.key; }
  return options;
}

/** The ranked options in words, for the narrative prompt: placeholders stand for the figures. */
export function optionsBlock(options: RecOption[]): string {
  if (!options.length) return "";
  const line = (o: RecOption): string => {
    const f = `{${o.factId}:abs}`;
    if (o.key === "tariff") return o.direction === "agile_cheaper"
      ? `staying on Agile saved ${f} against a flat business tariff over the four weeks (a historical counterfactual on the same kWh, not advice); this is a finding to keep, not a change to make`
      : `a flat business tariff would have cost ${f} less than Agile over the four weeks (a historical counterfactual on the same kWh, not advice); worth checking`;
    return `shifting flexible peak-band load saved ${f}${o.extraFactIds.length ? ` and ${o.extraFactIds.map((id) => `{${id}}`).join(" ")}` : ""} on window B prices`;
  };
  return options.map((o) => `${o.rank}. ${line(o)}`).join("\n");
}
