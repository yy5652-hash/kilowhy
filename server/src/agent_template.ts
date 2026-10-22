// Deterministic fallback narrative (verification.mode "template"): built from the facts table and hypothesis statuses only, so it passes the verifier
// by construction. Every number is a fact display (or the magnitude of one: "fell by £12.34" for −£12.34), every sentence cites its facts and their evidence.
// It follows the same meaning rules as the model's narrative (quality.ts): a site question opens with that site's own change and largest cause, ruled-out items
// are one short clause, the recommendation leads with the option of the largest £ effect, and the headline is sentence case within 90 characters.
import { displayFor } from "./facts_format.ts";
import type { Fact } from "./facts.ts";
import type { IntentType } from "./agent_types.ts";
import type { Answer, AnswerItem, HypInfo, RuledOutItem } from "./verifier.ts";
import { rankOptions } from "./facts_options.ts";
import { HEADLINE_MAX_CHARS, type QualityCtx } from "./quality.ts";

type Part = string | Fact | { fact: Fact; text: string } | AnswerItem;
const mag = (f: Fact): Part => ({ fact: f, text: typeof f.value === "number" ? displayFor(Math.abs(f.value), f.unit) : f.display });
const dot = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const isItem = (v: Part): v is AnswerItem => typeof v === "object" && "facts" in v && "evidence" in v;

function build(strings: TemplateStringsArray, vals: Part[], final: boolean): AnswerItem {
  const facts: string[] = [], evidence: string[] = [];
  const use = (f: Fact) => { facts.push(f.id); if (f.evidence) evidence.push(f.evidence); };
  let text = strings[0];
  vals.forEach((v, i) => {
    if (typeof v === "string") text += v;
    else if (isItem(v)) { text += v.text; facts.push(...v.facts); evidence.push(...v.evidence); }
    else if ("display" in v) { use(v); text += v.display; }
    else { use(v.fact); text += v.text; }
    text += strings[i + 1];
  });
  return { text: final ? dot(text) : text.trim(), facts: [...new Set(facts)], evidence: [...new Set(evidence)] };
}
/** Tagged template: facts print their display and are collected as citations; the result ends with a full stop. */
const say = (strings: TemplateStringsArray, ...vals: Part[]): AnswerItem => build(strings, vals, true);
/** Same, without the full stop: a clause to be nested in another sentence. */
const frag = (strings: TemplateStringsArray, ...vals: Part[]): AnswerItem => build(strings, vals, false);
const join = (...items: (AnswerItem | null)[]): AnswerItem => {
  const xs = items.filter((x): x is AnswerItem => !!x);
  return { text: xs.map((x) => x.text).join(" "), facts: [...new Set(xs.flatMap((x) => x.facts))], evidence: [...new Set(xs.flatMap((x) => x.evidence))] };
};

interface Cause { id: string; weight: number; phrase: string; item: AnswerItem }

export function templateAnswer(facts: Fact[], hyps: HypInfo[], type: IntentType, quality?: QualityCtx): Answer {
  const get = (k: string) => facts.find((f) => f.key === k);
  const num = (k: string): number => { const v = get(k)?.value; return typeof v === "number" ? v : 0; };
  /** Runs `fn` with the facts of `keys` when all of them exist, else null. */
  const when = (keys: string[], fn: (g: Fact[]) => AnswerItem): AnswerItem | null => { const g = keys.map(get); return g.every((f) => f) ? fn(g as Fact[]) : null; };
  const status = (id: string) => hyps.find((h) => h.id === id)?.status;
  /** The owner's remembered note for a site (or for all sites): it explains a change the tests found, it adds no figure. */
  const noteFact = (siteId: unknown): Fact | undefined => facts.find((f) => f.memory?.origin === "user" && (!f.memory.site || f.memory.site === siteId));
  const noteFor = (siteId: unknown): AnswerItem | null => { const m = noteFact(siteId); return m ? say`Your note on file says ${m}.` : null; };
  const sgn = (k: string, pos: string, neg: string): string => (num(k) >= 0 ? pos : neg);
  const dC = num("delta_bill");
  const spike = type === "why_spike_day";
  /** An emissions question is answered with the emissions causes and the data checks, not with cost effects in pounds. */
  const relevant = (id: string): boolean => type !== "why_emissions" || ["H10", "H7", "H9"].includes(id);

  // ---- supported causes, biggest first
  const causes: Cause[] = [];
  const cause = (id: string, weight: number, phrase: string, item: AnswerItem | null) => { if (status(id) === "supported" && item && relevant(id)) causes.push({ id, weight: weight + (spike && (id === "H11" || id === "H6") ? 1000 : 0), phrase, item }); };
  cause("H1", Math.abs(num("L_share")), "mainly because of higher unit prices", when(["L", "L_share", "avg_price_A", "avg_price_B_on_A_shape"], (g) =>
    say`${sgn("L", "Higher", "Lower")} unit prices on the same usage pattern ${sgn("L", "added", "cut")} ${mag(g[0])} (${mag(g[1])} of the change): the average price paid on the window A usage pattern went from ${g[2]} to ${g[3]}.`));
  cause("H2", 5, "", when(["delta_wind_pp", "delta_gas_pp", "corr_price_wind_B"], (g) =>
    say`The price move lines up with the generation mix: the wind share of generation ${sgn("delta_wind_pp", "rose", "fell")} by ${mag(g[0])} and the gas share ${sgn("delta_gas_pp", "rose", "fell")} by ${mag(g[1])}, and half-hourly prices move against wind (correlation ${g[2]}).`));
  cause("H3", Math.abs(num("v_weather_share")), "mainly because of colder weather", when(["v_weather", "v_weather_share", "hdd_A", "hdd_B"], (g) =>
    say`${sgn("v_weather", "Colder", "Warmer")} weather ${sgn("v_weather", "added", "cut")} ${mag(g[0])} (${mag(g[1])} of the change): window B had ${g[3]} (heating degree days) against ${g[2]} in window A.`));
  const steps = facts.filter((x) => /^event_\d+_t$/.test(x.key) && Math.abs(Number(x.value)) >= 2).map((x) => x.key.match(/\d+/)![0]);
  cause("H4", Math.abs(num("v_operational_share")), "mainly because of a change in how the sites operate", when(["v_operational", "v_operational_share"], (g) =>
    join(say`Usage that weather does not explain ${sgn("v_operational", "added", "cut")} ${mag(g[0])} (${mag(g[1])} of the change).`,
      ...steps.map((k) => when([`event_${k}_site`, `event_${k}`, `event_${k}_date`], (e) => say`A logged event at ${e[0]} from ${e[2]} fits: ${e[1]}`)),
      ...steps.slice(0, 1).map((k) => noteFor(String(get(`event_${k}_site`)?.value ?? "").split(" ")[0])))));
  cause("H5", Math.abs(num("T_share")), "mainly because usage moved to dearer times of day", when(["T", "T_share"], (g) =>
    say`Moving usage between cheaper and dearer times of day ${sgn("T", "added", "cut")} ${mag(g[0])} (${mag(g[1])} of the change).`));
  cause("H6", Math.abs(num("top_day_share")) * 0.9, "largely because of one day", when(["top_day", "top_day_share", "top_day_delta"], (g) =>
    join(say`One day, ${g[0]}, accounts for ${g[1]} of the change (${g[2]}).`, when(["top_day_driver", "top_day_driver_z"], (d) =>
      say`On that day pair, ${d[0]} was ${mag(d[1])} ${sgn("top_day_driver_z", "above", "below")} its window mean.`))));
  cause("H8", dC === 0 ? 0 : Math.abs((num("S") / dC) * 100), "partly because the standing charge changed", when(["standing_A", "standing_B", "S"], (g) =>
    say`The standing charge changed from ${g[0]} to ${g[1]}, which ${sgn("S", "added", "cut")} ${mag(g[2])}.`));
  cause("H7", 60, "", when(["meter_faults"], (g) => say`Meter faults were found (${g[0]} in total), so the readings themselves may be distorting the comparison.`));
  cause("H9", 60, "", when(["data_gap_site_windows", "data_checked_site_windows"], (g) => say`${g[0]} of ${g[1]} site-windows had missing or extra half-hours, so the two windows are not fully comparable.`));
  // An unusual day explains a change; one in window A raised the baseline instead of adding to the latest four weeks, and the sentence says so.
  cause("H11", 15, "partly because of one unusual day", when(["spike_1_site", "spike_1_day", "spike_1_kwh", "spike_1_expected_kwh", "spike_1_z", "spike_1_window"], (g) =>
    join(say`${g[0]} used ${g[2]} on ${g[1]} against ${g[3]} expected from its weather and weekday (${mag(g[4])} away); that day falls in ${g[5]}${String(g[5].value).startsWith("window A") ? ", so it raised the baseline rather than the latest four weeks" : ""}.`,
      when(["spike_1_event"], (e) => say`That date matches a logged event: ${e[0]}`))));
  for (const [name, more, less] of [["emissions_volume", "Using more electricity", "Using less electricity"], ["emissions_intensity", "A dirtier grid", "A cleaner grid"], ["emissions_timing", "Usage moving to dirtier times", "Usage moving to cleaner times"]] as const) {
    cause("H10", type === "why_emissions" ? 500 + Math.abs(num(`${name}_share`)) : 8, "", when([name, `${name}_share`], (g) =>
      Math.abs(Number(g[1].value)) >= 20 ? say`${sgn(name, more, less)} ${sgn(name, "added", "cut")} ${mag(g[0])} of emissions (${mag(g[1])} of the change).` : null as unknown as AnswerItem));
  }
  causes.sort((a, b) => b.weight - a.weight);

  // ---- a question about a site opens with that site's own change and its largest supported cause (quality.ts checks it); that cause is then not repeated
  const siteLead = !!quality?.siteScoped && (type === "why_cost_change" || type === "what_to_change");
  const topHyp = siteLead ? quality?.topCause?.hyp ?? null : null;
  const CLAUSES: Record<string, [string[], (g: Fact[]) => AnswerItem]> = {
    H1: [["L", "L_share"], (g) => frag`mostly because unit prices were ${sgn("L", "higher", "lower")} (${mag(g[0])}, ${mag(g[1])} of the change)`],
    H3: [["v_weather", "v_weather_share"], (g) => frag`mostly because of ${sgn("v_weather", "colder", "warmer")} weather (${mag(g[0])}, ${mag(g[1])} of the change)`],
    H4: [["v_operational", "v_operational_share"], (g) => frag`mostly because of usage that weather does not explain (${mag(g[0])}, ${mag(g[1])} of the change)`],
    H5: [["T", "T_share"], (g) => frag`mostly because usage moved between cheaper and dearer times of day (${mag(g[0])}, ${mag(g[1])} of the change)`],
    H8: [["S"], (g) => frag`mostly because the standing charge changed (${mag(g[0])})`],
  };
  const folded = topHyp && CLAUSES[topHyp] ? when(CLAUSES[topHyp][0], CLAUSES[topHyp][1]) : null;
  const siteName = quality?.siteName ?? null;
  const subjectBill = siteLead ? (siteName ? `${siteName}'s electricity bill` : "The electricity bill of these sites") : "Your electricity bill";

  // ---- opening sentence and headline
  const emissionsLead = type === "why_emissions" && status("H10") === "supported"
    ? when(["delta_emissions", "emissions_A", "emissions_B"], (g) => say`Emissions ${sgn("delta_emissions", "rose", "fell")} by ${mag(g[0])}, from ${g[1]} in window A to ${g[2]} in window B.`) : null;
  const billLead = siteLead
    ? when(["delta_bill", "delta_bill_pct", "bill_A", "bill_B"], (g) => say`${subjectBill} ${sgn("delta_bill", "rose", "fell")} by ${mag(g[0])} (${mag(g[1])}), from ${g[2]} to ${g[3]}${folded ? ", " : ""}${folded ?? ""}`)
    : when(["delta_bill", "delta_bill_pct", "bill_A", "bill_B", "window_A_start", "window_A_end", "window_B_start", "window_B_end"], (g) =>
      say`Your electricity bill ${sgn("delta_bill", "rose", "fell")} by ${mag(g[0])} (${mag(g[1])}) between window A (${g[4]} to ${g[5]}) and window B (${g[6]} to ${g[7]}), from ${g[2]} to ${g[3]}.`);
  const windows = siteLead ? when(["window_A_start", "window_A_end", "window_B_start", "window_B_end"], (g) => say`This compares window A (${g[0]} to ${g[1]}) with window B (${g[2]} to ${g[3]}).`) : null;
  const lead = emissionsLead ?? billLead;
  const sentences: AnswerItem[] = lead ? [lead] : [];
  if (!emissionsLead && windows) sentences.push(windows);
  const shown = causes.filter((c) => !(folded && c.id === topHyp)).slice(0, type === "what_to_change" ? 2 : 5);
  for (const c of shown) sentences.push(c.item);
  if (causes.length === 0 && get("delta_bill")) sentences.push(say`None of the tested explanations is strong enough to be called the cause of this change in ${get("delta_bill")!}.`);
  const subject = emissionsLead ? `Emissions ${sgn("delta_emissions", "rose", "fell")} by ${(mag(get("delta_emissions")!) as { text: string }).text}` : get("delta_bill") ? `${subjectBill} ${sgn("delta_bill", "rose", "fell")} by ${(mag(get("delta_bill")!) as { text: string }).text}` : "";
  const full = subject && causes[0]?.phrase ? `${subject}, ${causes[0].phrase}` : subject;
  const headline = !subject ? "No comparison could be made" : full.length <= HEADLINE_MAX_CHARS ? full : subject;

  // ---- ruled-out hypotheses: one short clause each
  const ruled: RuledOutItem[] = [];
  const out = (id: string, item: AnswerItem | null) => { if (status(id) === "ruled_out" && item && relevant(id)) ruled.push({ hypothesis: id, ...item }); };
  out("H1", when(["L", "L_share"], (g) => say`Price changes are ruled out: the price-level effect was ${g[0]} (${g[1]} of the change).`));
  out("H2", when(["delta_wind_pp", "delta_gas_pp"], (g) => say`The generation mix is ruled out as a price driver: wind changed by ${g[0]} and gas by ${g[1]}.`));
  out("H3", when(["v_weather", "v_weather_share"], (g) => say`Weather is ruled out: its part of the volume effect was ${g[0]} (${g[1]} of the change).`));
  out("H4", when(["v_operational", "v_operational_share"], (g) => say`An operational change is ruled out: only ${g[0]} (${g[1]} of the change) is left after weather.`));
  out("H5", when(["T", "T_share"], (g) => {
    const moved = !(Math.abs(num("schedule_delta_pp")) >= 10 || get("schedule_event")) ? null : when(["schedule_site", "schedule_band", "schedule_delta_pp", "schedule_change_date"], (s) => frag`, though the ${s[1]} share at ${s[0]} moved ${mag(s[2])} from ${s[3]}`);
    const note = moved ? noteFact(get("schedule_site")?.value) : undefined;
    return say`Timing is ruled out: it moved the bill by only ${g[0]} (${g[1]} of the change)${moved ?? ""}${note ? frag`; your note on file says ${note}` : ""}.`;
  }));
  out("H6", when(["top_day", "top_day_share"], (g) => say`A one-off day is ruled out: the largest day, ${g[0]}, is only ${g[1]} of the change.`));
  out("H7", when(["meter_faults", "meter_sites_checked"], (g) => say`Meter faults are ruled out: ${g[0]} zero runs, flatlines or incomplete days across ${g[1]} sites.`));
  out("H8", when(["standing_A", "standing_B", "S"], (g) => say`A tariff change is ruled out: the standing charge was ${g[0]} then ${g[1]} (effect ${g[2]}).`));
  out("H9", when(["data_gap_site_windows", "data_checked_site_windows"], (g) => say`A data gap is ruled out: ${g[0]} of ${g[1]} site-windows had missing half-hours.`));
  out("H10", when(["delta_emissions"], (g) => say`Higher emissions are ruled out: emissions changed by ${g[0]}.`));
  out("H11", when(["max_abs_z"], (g) => say`An unusual day is ruled out: the largest deviation from expected usage was only ${g[0]}.`));

  // ---- recommendation: the options in the order of their computed £ effect, largest first
  const options = rankOptions(facts);
  const parts = options.map((o) => {
    if (o.key === "tariff") return when(["tariff_name", "flat_minus_agile_B", "flat_total_B", "agile_total_B"], (g) => o.direction === "agile_cheaper"
      ? say`Staying on Agile saved ${mag(g[1])} against the flat ${g[0]} tariff over the four weeks (${g[3]} against ${g[2]}); that is a historical counterfactual on the same electricity, not advice, and nothing to change`
      : say`The flat ${g[0]} tariff would have cost ${mag(g[1])} less than Agile over the four weeks (${g[2]} against ${g[3]}); that is a historical counterfactual on the same electricity, not advice, but worth checking`);
    return when(["rec_saved", "rec_saved_kg", "rec_shifted_kwh", "peak_band", "rec_blocks"], (g) => Number(g[0].value) > 0
      ? say`Shifting ${g[2]} of flexible load out of the ${g[3]} peak into the cheapest same-day blocks (${g[4]}) would have saved ${options[0].key === "load_shift" ? "" : "only "}${g[0]} and ${g[1]} on window B prices`
      : say`Shifting load would have saved ${g[0]} and ${g[1]}: only ${g[2]} of flexible load was found in the ${g[3]} peak above the night baseline`);
  });
  const rec = join(...parts);
  return { headline, sentences, ruledOut: ruled, recommendation: { text: rec.text, facts: rec.facts, evidence: rec.evidence } };
}
