// Builds eval_report.json (all numbers) and eval_report.md (readable) from scenario runs. Deterministic: no wall-clock time, so a re-run reproduces the files byte for byte.
// Meter kWh are SAMPLE data; prices, carbon, generation mix and temperature are the real Zetaris snapshot (eval/data/real_windows.json).
import { THRESHOLDS } from "../server/src/hypotheses/thresholds.ts";
import { identify, type Identification } from "./identify.ts";
import type { RealWindows } from "./real.ts";
import type { ScenarioRun } from "./run.ts";
import { REFERENCE, SCORED } from "./scenarios.ts";
import { isMatch, pairsOf, references, tally, type Pair } from "./score.ts";

const r4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10000) / 10000);
const pc = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const SHORT = { supported: "SUP", ruled_out: "OUT", inconclusive: "INC" } as const;

export function buildReport(real: RealWindows, runs: ScenarioRun[], bugsFixed: string[] = []) {
  const pairs = pairsOf(runs);
  const refs = references(runs);
  const ids = runs.map((r) => identify(r));
  const overall = tally(pairs), planted = tally(pairs.filter((p) => p.planted)), realOnly = tally(pairs.filter((p) => p.expected === "supported" && !p.planted));
  const byHyp = Object.fromEntries(SCORED.map((h) => [h, tally(pairs.filter((p) => p.id === h))]));
  const scenarios = runs.map((run, k) => {
    const mine = pairs.filter((p) => p.scenario === run.scenario.n);
    return {
      n: run.scenario.n, id: run.scenario.id, title: run.scenario.title, because: run.scenario.because, plants: run.scenario.plants, real_data_causes: run.scenario.real, not_scored: run.scenario.notScored ?? {},
      passed: mine.every((p) => isMatch(p.outcome)), exact_matches: mine.filter((p) => isMatch(p.outcome)).length, scored: mine.length,
      decomposition: run.decomposition,
      truth_shares: { weather: r4(run.truth.share.weather), operational: r4(run.truth.share.operational), timing: r4(run.truth.share.timing), largest_day: r4(run.truth.share.topDay), largest_day_date: run.truth.topDay.date },
      hypotheses: [...mine.map((p) => ({ id: p.id, scored: true, expected: p.expected, got: p.got, outcome: p.outcome, planted_cause: p.planted, statistic: p.stat, headline: p.headline })),
        ...refs.rows.filter((x) => x.scenario === run.scenario.n).map((x) => ({ id: x.id, scored: false, expected: x.ref, got: x.got, outcome: x.same ? "same_as_reference" : "differs_from_reference", planted_cause: false, statistic: x.stat, headline: run.results.find((h) => h.id === x.id)!.headline }))],
      identification: ids[k],
      recommendation: run.recommendation,
    };
  });
  const misses = pairs.filter((p) => !isMatch(p.outcome)).map((p) => ({ scenario: p.scenario, hypothesis: p.id, expected: p.expected, got: p.got, outcome: p.outcome, measured: p.stat.text, threshold: p.stat.threshold, value: p.stat.value }));
  const idErr = Math.max(...runs.map((r) => r.decomposition.identityErrorPence));
  const idAll = ids.flat().filter((i) => i.found !== null);
  return {
    title: "Kilowhy evaluation: recovery of planted causes on real price, carbon and weather windows",
    sample_meter_data: true,
    note: "Meter kWh are SAMPLE data (synthetic, Crumb & Co site S1, generator seed 0xc0ffee, dated sample events switched off). Prices (Octopus Agile), carbon intensity and generation mix (NESO), and temperature (Open-Meteo) are the real series of eval/data/real_windows.json.",
    snapshot: { generatedAt: real.generatedAt, windows: real.windows, queries: real.queries },
    thresholds: THRESHOLDS,
    summary: {
      scenarios: runs.length, scenarios_passed: scenarios.filter((s) => s.passed).length, scored_pairs: pairs.length, exact_matches: pairs.filter((p) => isMatch(p.outcome)).length,
      supported_class: overall, planted_causes_only: planted, real_data_causes_only: realOnly, by_hypothesis: byHyp,
      decomposition_identity: { checked: runs.length, passed: runs.filter((r) => r.decomposition.identityOk).length, max_error_pence: idErr, max_compensated_error_pence: Math.max(...runs.map((r) => r.decomposition.compensatedErrorPence)), bound_pence: 1 },
      reference_statuses: refs.ref, reference_same: refs.rows.filter((x) => x.same).length, reference_total: refs.rows.length,
      identification: { checked: idAll.length, found: idAll.filter((i) => i.found).length },
      recommendation: { matches: runs.filter((r) => r.recommendation.match).length, total: runs.length },
    },
    scenarios, misses, bugs_fixed: bugsFixed,
  };
}
export type Report = ReturnType<typeof buildReport>;

export function renderMarkdown(rep: Report): string {
  const s = rep.summary, o = s.supported_class;
  const L: string[] = [];
  L.push(`# Kilowhy evaluation report`, ``, `**SAMPLE meter data.** ${rep.note}`, ``,
    `Question: how well does the deterministic hypothesis layer (decomposition, H1-H11, recommendation) recover causes that are planted in a clean baseline site, on the real Octopus Agile / NESO / Open-Meteo windows (A: ${rep.snapshot.windows.A.from} to ${rep.snapshot.windows.A.toExclusive}, B: ${rep.snapshot.windows.B.from} to ${rep.snapshot.windows.B.toExclusive}, exclusive)? Expected statuses were written down from the plants before any scenario was run (\`eval/scenarios.ts\`); thresholds are the fixed constants of \`server/src/hypotheses/thresholds.ts\` and were not changed.`, ``,
    `## Result`, ``,
    `| Measure | Value |`, `|---|---|`,
    `| Scenarios with every scored hypothesis exactly as expected | ${s.scenarios_passed} of ${s.scenarios} |`,
    `| Scored (scenario, hypothesis) pairs matching exactly | ${s.exact_matches} of ${s.scored_pairs} |`,
    `| "supported" precision | ${pc(o.precision)} (${o.tp} true positives, ${o.fp} false positives) |`,
    `| "supported" recall | ${pc(o.recall)} (${o.tp} of ${o.tp + o.fn}; ${o.fn - o.fnHedged} ruled out, ${o.fnHedged} inconclusive) |`,
    `| "supported" F1 | ${pc(o.f1)} |`,
    `| Planted causes only (supported labels that come from a plant) | precision ${pc(s.planted_causes_only.precision)}, recall ${pc(s.planted_causes_only.recall)}, F1 ${pc(s.planted_causes_only.f1)} (${s.planted_causes_only.tp} of ${s.planted_causes_only.tp + s.planted_causes_only.fn}) |`,
    `| Real-data causes only (cold snap for H3, 17 Oct price day for H6) | recall ${pc(s.real_data_causes_only.recall)} (${s.real_data_causes_only.tp} of ${s.real_data_causes_only.tp + s.real_data_causes_only.fn}) |`,
    `| Expected "ruled out" answered "inconclusive" (hedged) | ${o.hedged} of ${o.tn + o.hedged + o.fp} |`,
    `| Decomposition identity: V+L+T+S equals dC to within 1 pence (0.01 GBP) | ${s.decomposition_identity.passed} of ${s.decomposition_identity.checked} scenarios (largest error ${s.decomposition_identity.max_error_pence} pence in a plain sum, ${s.decomposition_identity.max_compensated_error_pence.toExponential(1)} pence compensated) |`,
    `| Planted cause named correctly (event, day, change point, standing effect) | ${s.identification.found} of ${s.identification.checked} |`,
    `| Real-data hypotheses H1, H2, H10 same as scenario 1 | ${s.reference_same} of ${s.reference_total} (reference: ${Object.entries(s.reference_statuses).map(([k, v]) => `${k} ${v}`).join(", ")}) |`,
    `| Load-shift recommendation finds flexible peak load exactly where it is planted | ${s.recommendation.matches} of ${s.recommendation.total} scenarios |`, ``);
  L.push(`Positive class is "supported". A false negative is an expected "supported" answered "ruled out" or "inconclusive". The supported labels split into causes planted in the series and effects that the real data carries in every scenario: the real windows are about 3.3 C colder in B (heating kWh of the site 46 to 251, weather about 43% of the baseline change) and 17 Oct, whose baseline partner 19 Sep was a very cheap windy day, is about 31% of it. Both are labelled "supported" by the arithmetic of the true series and are marked *real* below.`, ``);
  L.push(`## Per hypothesis`, ``, `| Hypothesis | Pairs | TP | FP | FN | TN | Hedged | Precision | Recall | F1 |`, `|---|---|---|---|---|---|---|---|---|---|`);
  for (const h of SCORED) { const t = s.by_hypothesis[h]; L.push(`| ${h} | ${t.n} | ${t.tp} | ${t.fp} | ${t.fn} | ${t.tn} | ${t.hedged} | ${pc(t.precision)} | ${pc(t.recall)} | ${pc(t.f1)} |`); }
  L.push(``, `## Expected versus got, all scenarios`, ``, `Cell: expected / got (SUP supported, OUT ruled out, INC inconclusive; "-" not scored). Lower-case *r* marks a supported label that comes from real data. Last three columns: H1, H2, H10 against the scenario-1 reference.`, ``,
    `| # | Scenario | ${SCORED.join(" | ")} | H1 | H2 | H10 | Identity | Rec |`, `|---|---|${[...SCORED, "H1", "H2", "H10"].map(() => "---").join("|")}|---|---|`);
  for (const sc of rep.scenarios) {
    const cell = (h: string) => { const x = sc.hypotheses.find((y) => y.id === h && y.scored); return x ? `${SHORT[x.expected as keyof typeof SHORT]}${sc.real_data_causes.includes(h as never) && x.expected === "supported" ? "r" : ""} / ${SHORT[x.got as keyof typeof SHORT]}${x.outcome === "tp" || x.outcome === "tn" ? "" : " **x**"}` : "-"; };
    const ref = (h: string) => { const x = sc.hypotheses.find((y) => y.id === h && !y.scored)!; return `${SHORT[x.got as keyof typeof SHORT]}${x.outcome === "same_as_reference" ? "" : " **x**"}`; };
    L.push(`| ${sc.n} | ${sc.id} | ${SCORED.map(cell).join(" | ")} | ${ref("H1")} | ${ref("H2")} | ${ref("H10")} | ${sc.decomposition.identityOk ? "ok" : "**FAIL**"} | ${sc.recommendation.match ? "ok" : "**x**"} |`);
  }
  L.push(``, `## Misses`, ``);
  if (!rep.misses.length) L.push(`None: every scored pair matched.`);
  else {
    L.push(`Every scored pair whose answer differs from the expectation, with the measured statistic against the rule's threshold (thresholds untouched).`, ``, `| # | Hypothesis | Expected | Got | Kind | Measured | Threshold |`, `|---|---|---|---|---|---|---|`);
    for (const m of rep.misses) L.push(`| ${m.scenario} | ${m.hypothesis} | ${m.expected} | ${m.got} | ${m.outcome === "fn_missed" ? "missed" : m.outcome === "fn_hedged" ? "missed (inconclusive)" : m.outcome === "fp" ? "false alarm" : "hedged"} | ${m.measured} | ${m.threshold} |`);
  }
  L.push(``, `## Bugs found and fixed`, ``);
  L.push(rep.bugs_fixed.length ? rep.bugs_fixed.map((b) => `- ${b}`).join("\n") : `None. Every miss above is a threshold or model outcome, not a defect.`);
  L.push(``, `## Scenarios`, ``);
  for (const sc of rep.scenarios) {
    L.push(`<details><summary>#${sc.n} ${sc.id}: ${sc.title} (${sc.passed ? "pass" : "not all as expected"}, ${sc.exact_matches} of ${sc.scored})</summary>`, ``, sc.because, ``);
    const d = sc.decomposition;
    L.push(`Bill change dC £${d.deltaGbp} = volume £${d.volumeGbp} + price level £${d.priceGbp} + timing £${d.timingGbp} + standing £${d.standingGbp}; identity error ${d.identityErrorPence} pence; ${d.slotsKept} of ${d.slotsExpected} half-hours aligned; the true series (independent calculation) gives dC £${d.trueDeltaGbp}. True shares of the change: weather ${pc(sc.truth_shares.weather)}, operational step ${pc(sc.truth_shares.operational)}, timing ${pc(sc.truth_shares.timing)}, largest day ${pc(sc.truth_shares.largest_day)} (${sc.truth_shares.largest_day_date}).`, ``);
    L.push(`| Hypothesis | Expected | Got | Result | Measured statistic against threshold |`, `|---|---|---|---|---|`);
    for (const h of sc.hypotheses) L.push(`| ${h.id}${h.scored ? "" : " (reference)"} | ${h.expected} | ${h.got} | ${h.outcome} | ${h.statistic.text} |`);
    for (const [h, why] of Object.entries(sc.not_scored)) L.push(``, `${h} not scored: ${why}.`);
    if (sc.identification.length) { L.push(``, `Cause identification:`, ``); for (const i of sc.identification as Identification[]) L.push(`- ${i.cause}: ${i.found === null ? "measured" : i.found ? "found" : "**not found**"}; ${i.detail}`); }
    const r = sc.recommendation;
    L.push(``, `Recommendation: ${r.ok ? `shifts ${r.shiftedKwh} kWh over ${r.daysShifted} site-days, saves £${r.savedGbp}` : "none"}; flexible peak load planted: ${r.expectedFound ? "yes" : "no"}, found: ${r.found ? "yes" : "no"}.`, ``, `</details>`, ``);
  }
  L.push(`## Method`, ``,
    `- Baseline: \`scripts/generate_sample.ts\` (Crumb & Co generator, site S1, seed 0xc0ffee) with the dated sample events off, driven by the real hourly temperature; heating responds to temperature per half-hour, the analysis windows use daily mean temperature (HDD base 15.5 C).`,
    `- Plants (\`eval/plants.ts\`): heating sensitivity, sustained kWh step with a logged ops_log event, oven schedule shift with an event, one-off fault day with an event (oven load 4.6 kWh per half-hour all day), zero run, flatline, missing rows, standing-charge change.`,
    `- Truth (\`eval/oracle.ts\`, \`eval/labels.ts\`): the bill split, the weather-driven and operational costs and the largest day are computed from the planted series and the real prices by a separate implementation, not by the hypothesis library. \`eval/scenarios.test.ts\` checks every expected status against it.`,
    `- Data layer: the injectable layer of \`server/src/hypotheses/testkit.ts\` filled with the planted series and the real snapshot; Zetaris is used only by \`scripts/eval_snapshot.ts\`. H7's four SQL checks (zero run >= ${THRESHOLDS.H7_ZERO_RUN_SLOTS}, flatline >= ${THRESHOLDS.H7_FLATLINE_SLOTS}, duplicate timestamps, days without 48 slots) are re-implemented over the planted rows with the same rules.`,
    `- H1, H2 and H10 depend on real data only, so their expected status is the one measured on scenario 1 (nothing planted); they are reported, not scored. A planted cause that enlarges the change can lower the share H1 or H10 test, so a difference from the reference would be a dilution effect, not a detection error.`,
    `- Snapshot: Zetaris runs ${rep.snapshot.queries.map((q) => `${q.id} ${q.zetarisRunId} (${q.rowCount} rows, sha256 ${q.resultSha256.slice(0, 12)}...)`).join(", ")}.`,
    `- Reproduce: \`node scripts/eval_snapshot.ts\` (needs Zetaris; optional, the snapshot is committed), then \`node scripts/eval_run.ts\`.`, ``);
  return L.join("\n");
}
