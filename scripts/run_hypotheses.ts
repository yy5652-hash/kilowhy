// D2c live run: for each site (S1, S2, S3) and ALL, build the exact decomposition, run hypotheses H1..H10 and the recommendation
// against Zetaris (one federated SQL per fetch, evidence with run ids and result hashes), then write eval/hypotheses_d2.json and print a compact table.
// Meter kWh are SAMPLE data; Agile prices (Octopus), carbon intensity (NESO) and temperatures (Open-Meteo) are real.
// Thresholds are fixed constants (server/src/hypotheses/thresholds.ts); nothing here is tuned to the planted events.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { zsql } from "./zetaris_client.ts";
import { createZetarisData } from "../server/src/data.ts";
import { buildContext, runAll, CATALOG, THRESHOLDS } from "../server/src/hypotheses/index.ts";
import type { HypCtx, HypothesisId, HypothesisResult } from "../server/src/hypotheses/types.ts";
import { recommend, type Recommendation } from "../server/src/recommend.ts";
import { WINDOW_A, WINDOW_B } from "../server/src/windows.ts";
import { addDays } from "../server/src/bands.ts";
import { sum } from "../server/src/decompose.ts";
import { gbp } from "../server/src/hypotheses/util.ts";

const NOTE = "meter kWh are SAMPLE data (synthetic, Crumb & Co); prices (Octopus Agile), carbon intensity (NESO) and temperatures (Open-Meteo) are real public data";
const data = createZetarisData((sql) => zsql(sql));
const siteIds = await data.siteIds();
const scopes = [...siteIds.map((s) => ({ label: s, sites: [s] })), { label: "ALL", sites: siteIds }];

const checks: { check: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) => { checks.push({ check: name, pass, detail }); if (!pass) console.error(`CHECK FAIL: ${name} ${detail ?? ""}`); };

interface ScopeRun { ctx: HypCtx; results: HypothesisResult[]; rec: Recommendation }
const runs = new Map<string, ScopeRun>();
for (const sc of scopes) {
  process.stderr.write(`running ${sc.label} ...\n`);
  const ctx = await buildContext({ data, scope: sc, windowA: WINDOW_A, windowB: WINDOW_B });
  const results = await runAll(ctx);
  const rec = await recommend(ctx);
  runs.set(sc.label, { ctx, results, rec });
}

// ---- consistency checks against the earlier D2a run and internal identities
const d2a = existsSync(new URL("../eval/decompose_d2.json", import.meta.url)) ? JSON.parse(readFileSync(new URL("../eval/decompose_d2.json", import.meta.url), "utf8")) : null;
for (const [label, { ctx, results, rec }] of runs) {
  const r = ctx.decomposition.result;
  check(`${label} decomposition ok`, !!r, ctx.decomposition.error);
  if (r) {
    check(`${label} identityError < 1e-6 pence`, r.identityError < 1e-6, String(r.identityError));
    const prev = d2a?.results?.find((x: any) => x.site === label);
    if (prev) {
      check(`${label} dC matches eval/decompose_d2.json`, Math.abs(gbp(r.deltaTotal) - prev.gbp.delta_total) < 0.011, `${gbp(r.deltaTotal)} vs ${prev.gbp.delta_total}`);
      check(`${label} L matches eval/decompose_d2.json`, Math.abs(gbp(r.price) - prev.gbp.price) < 0.011, `${gbp(r.price)} vs ${prev.gbp.price}`);
    }
  }
  check(`${label} all ${CATALOG.length} hypotheses ran`, results.length === CATALOG.length && CATALOG.every((c) => results.some((x) => x.id === c.id)));
  check(`${label} no hypothesis errored`, results.every((x) => x.summary.error === undefined), results.filter((x) => x.summary.error !== undefined).map((x) => `${x.id}: ${x.summary.error}`).join("; "));
  check(`${label} every cited evidence id exists`, results.every((x) => x.evidence.every((id) => ctx.evidence.get(id))));
  check(`${label} evidence hashes are sha256`, ctx.evidence.list().every((e) => /^[0-9a-f]{64}$/.test(e.resultSha256) && e.zetarisRunId.length > 0));
  check(`${label} recommendation ok`, rec.ok, rec.reason);
}
const allR = runs.get("ALL")?.ctx.decomposition.result;
if (allR) check("ALL dC = sum of site dC", Math.abs(allR.deltaTotal - sum(siteIds.map((s) => runs.get(s)!.ctx.decomposition.result!.deltaTotal))) < 1e-6);

// ---- planted sample events: does H4 / H6 / H5 see them? (mechanical, reported either way)
const dayShift = (d: string, n: number) => addDays(d, n);
const planted: any[] = [];
const opsFor = (site: string) => (runs.get(site)?.results.find((x) => x.id === "H4")?.details?.events as any[] | undefined) ?? [];
for (const ev of siteIds.flatMap(opsFor)) {
  const h4 = ev;                                         // EventTest from H4 of the event's own site scope
  const h6 = runs.get(ev.siteId)!.results.find((x) => x.id === "H6")!;
  const h5 = runs.get(ev.siteId)!.results.find((x) => x.id === "H5")!;
  const h11 = runs.get(ev.siteId)!.results.find((x) => x.id === "H11")!;
  const flagged = ((h11.details?.flagged as any[]) ?? []).filter((a) => a.site === ev.siteId);
  const shift = ((h5.details?.scheduleCandidates as any[]) ?? []).find((x) => x.site === ev.siteId) ?? null;
  const inA = ev.date >= WINDOW_A.from && ev.date < WINDOW_A.toExclusive;
  const partner = inA ? dayShift(ev.date, WINDOW_B.days) : dayShift(ev.date, -WINDOW_A.days); // the aligned day in the other window
  const dates = new Set([ev.date, partner]);
  const near = (d: unknown) => typeof d === "string" && dates.has(d);
  planted.push({
    event: `${ev.eventId} ${ev.siteId} ${ev.date}`, description: ev.description,
    h4_step_detected: h4.testable && Math.abs(h4.tAdjusted) >= THRESHOLDS.H4_T, h4_t_adjusted: h4.tAdjusted, h4_t_raw: h4.tRaw, h4_step_kwh_per_day: h4.diffKwhPerDay, h4_profile_shift: h4.profileShift,
    h4_status_for_site: runs.get(ev.siteId)!.results.find((x) => x.id === "H4")!.status,
    h6_top_day_is_event_day: near(h6.summary.top_day), h6_opposite_day_is_event_day: near(h6.summary.opposite_day), h6_status_for_site: h6.status,
    h6_most_unusual_day: h6.summary.anomalous_day, h6_most_unusual_day_z: h6.summary.anomalous_day_z, h6_most_unusual_day_is_event_day: h6.summary.anomalous_day === ev.date,
    h5_status_for_site: h5.status, h5_T_share_of_delta: h5.summary.T_share_of_delta,
    h5_schedule_shift: shift ? { detected: shift.detected, band: shift.band, delta_pp: shift.deltaPp, change_point: shift.changePoint, nearest_event: shift.nearestEvent?.eventId ?? null, near_this_event: shift.nearestEvent?.eventId === ev.eventId } : null,
    h11_flagged_on_event_day: flagged.some((a) => a.date === ev.date), h11_status_for_site: h11.status, h11_max_abs_z: h11.summary.max_abs_z,
  });
}

// ---- output JSON
const scopeOut = [...runs].map(([label, { ctx, results, rec }]) => {
  const r = ctx.decomposition.result;
  return {
    scope: label, sites: ctx.sites, sample_meter_data: true,
    decomposition: r ? {
      delta_total_gbp: gbp(r.deltaTotal), volume_gbp: gbp(r.volume), price_level_gbp: gbp(r.price), timing_gbp: gbp(r.timing), standing_gbp: gbp(r.standing),
      kwh_A: r.QA, kwh_B: r.QB, avg_price_A_p: r.pbarA, avg_price_B_p: r.pbarB, avg_price_B_on_A_shape_p: r.pbarBStar, identity_error_pence: r.identityError,
      slots_aligned: ctx.decomposition.aligned.kept, warnings: ctx.decomposition.warnings, evidence: ctx.decomposition.evidenceId,
    } : { error: ctx.decomposition.error },
    hypotheses: results,
    recommendation: rec,
    evidence: ctx.evidence.toJSON(),
  };
});
const pass = checks.every((c) => c.pass);
const report = {
  generated_at: new Date().toISOString(), note: NOTE,
  windows: { A: WINDOW_A, B: WINDOW_B },
  method: "Each evidence record is one federated Zetaris query (sql, run id, row count, sha256 of canonical JSON of all rows, <=10 sample rows, metrics). Records for different hypotheses may share a query/run id when they use the same rows. H4 step test uses weather- and weekday-adjusted daily kWh (pooled OLS, spec H3 design); the unadjusted t is reported too.",
  thresholds: THRESHOLDS, catalog: CATALOG,
  planted_events: planted,
  pass, checks, scopes: scopeOut,
};
mkdirSync(new URL("../eval", import.meta.url), { recursive: true });
writeFileSync(new URL("../eval/hypotheses_d2.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");

// ---- compact table: hypotheses x scopes, "STATUS headline-number"
const ABBR = { supported: "SUP", ruled_out: "OUT", inconclusive: "INC" } as const;
const sg = (x: unknown, d = 2) => (typeof x === "number" ? `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(d)}` : "n/a");
const pc = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "n/a");
function short(r: HypothesisResult): string {
  const s = r.summary;
  switch (r.id) {
    case "H1": return `L ${sg(s.L_gbp)} ${pc(s.L_share_of_delta)}`;
    case "H2": return `corr ${sg(s.corr_price_wind_B)}`;
    case "H3": return `Vw ${sg(s.v_weather_gbp)} ${pc(s.v_weather_share)}`;
    case "H4": return `Vop ${sg(s.v_operational_gbp)} ${pc(s.v_operational_share)} ${s.steps}`;
    case "H5": return `T ${sg(s.T_gbp)} ${pc(s.T_share_of_delta)}${s.schedule_shift_detected ? " +shift" : ""}`;
    case "H6": return `${String(s.top_day).slice(5)} ${pc(s.top_day_share)}`;
    case "H7": return `${(s.zero_runs as number) + (s.flatlines as number) + (s.duplicate_timestamps as number) + (s.days_not_48_slots as number)} faults`;
    case "H8": return `S ${sg(s.standing_effect_gbp)}`;
    case "H9": return `${s.site_windows_with_gap} gaps`;
    case "H10": return `${sg(s.delta_kg, 1)} kg`;
    case "H11": return s.n_flagged ? `${s.top_site} ${String(s.top_day).slice(5)} z${sg(s.top_z, 1)}` : `max z ${s.max_abs_z}`;
  }
}
const labels = [...runs.keys()];
const cell = (r: HypothesisResult | undefined) => (r ? `${ABBR[r.status]} ${short(r)}` : "-");
const w0 = 28, wc = 26;
console.log(`\nSAMPLE meter data (kWh synthetic); prices, carbon and weather are real. Window B (${WINDOW_B.from}..${addDays(WINDOW_B.toExclusive, -1)}) minus window A (${WINDOW_A.from}..${addDays(WINDOW_A.toExclusive, -1)}).`);
console.log("SUP supported, OUT ruled out, INC inconclusive. GBP; shares are of the bill change.\n");
console.log("hypothesis".padEnd(w0) + labels.map((l) => l.padEnd(wc)).join(""));
for (const c of CATALOG) console.log(`${c.id} ${c.name}`.slice(0, w0 - 1).padEnd(w0) + labels.map((l) => cell(runs.get(l)!.results.find((x) => x.id === (c.id as HypothesisId))).slice(0, wc - 1).padEnd(wc)).join(""));
console.log("\nbill change dC (GBP): " + labels.map((l) => `${l} ${sg(runs.get(l)!.ctx.decomposition.result ? gbp(runs.get(l)!.ctx.decomposition.result!.deltaTotal) : NaN)}`).join("   "));
console.log("\nRecommendation (counterfactual on window-B prices):");
for (const [l, { rec }] of runs) console.log(`  ${l}: ${rec.text}`);
console.log("\nPlanted sample events (reported as found, thresholds untouched):");
for (const p of planted) {
  console.log(`  ${p.event}: H4 step ${p.h4_step_detected ? "DETECTED" : "not detected"} (adjusted t ${p.h4_t_adjusted === null ? "n/a" : p.h4_t_adjusted.toFixed(2)}, raw t ${p.h4_t_raw === null ? "n/a" : p.h4_t_raw.toFixed(2)}, ${p.h4_step_kwh_per_day === null ? "n/a" : p.h4_step_kwh_per_day.toFixed(2)} kWh/day); H4 status ${p.h4_status_for_site}; H6 top day ${p.h6_top_day_is_event_day ? "IS" : "is not"} the event day, status ${p.h6_status_for_site}; most unusual day ${p.h6_most_unusual_day} (z ${p.h6_most_unusual_day_z})${p.h6_most_unusual_day_is_event_day ? " = event day" : ""}; H5 ${p.h5_status_for_site}${p.h5_schedule_shift ? ` (${p.h5_schedule_shift.detected ? "schedule shift" : "sub-threshold schedule move"} ${p.h5_schedule_shift.band} ${p.h5_schedule_shift.delta_pp.toFixed(1)} pp from ${p.h5_schedule_shift.change_point}, ${p.h5_schedule_shift.near_this_event ? "matches this event" : "nearest event " + p.h5_schedule_shift.nearest_event})` : ""}; H11 ${p.h11_status_for_site} (max |z| ${p.h11_max_abs_z}${p.h11_flagged_on_event_day ? ", flagged on the event day" : ""})${p.h4_profile_shift ? `; intraday ${p.h4_profile_shift.band} share ${p.h4_profile_shift.pp.toFixed(1)} pp` : ""}`);
}
console.log(`\n${checks.length} checks, ${checks.filter((c) => !c.pass).length} failed. Wrote eval/hypotheses_d2.json (${scopeOut.reduce((n, s) => n + s.evidence.length, 0)} evidence records).`);
console.log(pass ? "HYPOTHESES PASS" : "HYPOTHESES FAIL");
process.exit(pass ? 0 : 1);
