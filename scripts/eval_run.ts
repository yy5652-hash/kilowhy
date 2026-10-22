// Evaluation run: 12 planted-cause scenarios on the real price / carbon / temperature windows (eval/data/real_windows.json), through the injectable data layer
// (no Zetaris). Writes eval/results/eval_report.json and eval/results/eval_report.md. Meter kWh are SAMPLE data. Usage: node scripts/eval_run.ts [--only 1,6]
import { mkdirSync, writeFileSync } from "node:fs";
import { loadReal } from "../eval/real.ts";
import { buildReport, renderMarkdown } from "../eval/report.ts";
import { runScenarios } from "../eval/run.ts";
import { SCENARIOS } from "../eval/scenarios.ts";

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",").map(Number) : null;
const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.n)) : SCENARIOS;
const real = loadReal();
const runs = await runScenarios(real, scenarios);
const BUGS_FIXED: string[] = [];
const report = buildReport(real, runs, BUGS_FIXED);
if (only) { console.log(`SAMPLE meter data. Partial run of scenarios ${only.join(", ")}: report files not written.`); }
else {
  const dir = new URL("../eval/results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("eval_report.json", dir), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(new URL("eval_report.md", dir), renderMarkdown(report) + "\n");
}
const s = report.summary, o = s.supported_class, f = (x: number | null) => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");
console.log(`SAMPLE meter data (kWh synthetic); prices, carbon and weather are real.`);
console.log(`${s.scenarios} scenarios, ${s.scenarios_passed} fully as expected; ${s.exact_matches}/${s.scored_pairs} scored pairs match`);
console.log(`"supported": precision ${f(o.precision)} recall ${f(o.recall)} F1 ${f(o.f1)} (TP ${o.tp} FP ${o.fp} FN ${o.fn} TN ${o.tn} hedged ${o.hedged})`);
console.log(`identity ${s.decomposition_identity.passed}/${s.decomposition_identity.checked} (max ${s.decomposition_identity.max_error_pence} pence); cause named ${s.identification.found}/${s.identification.checked}; reference same ${s.reference_same}/${s.reference_total}; recommendation ${s.recommendation.matches}/${s.recommendation.total}`);
for (const m of report.misses) console.log(`MISS #${m.scenario} ${m.hypothesis}: expected ${m.expected}, got ${m.got}; ${m.measured} [${m.threshold}]`);
if (!only) console.log("wrote eval/results/eval_report.json and eval_report.md");
process.exit(s.decomposition_identity.passed === s.decomposition_identity.checked ? 0 : 1);
