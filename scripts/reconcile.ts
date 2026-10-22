// Reconciliation: 4-week cost per site from ONE federated Zetaris SQL (meter_hh JOIN agile_rates)
// vs an independent computation from raw Octopus API pulls + the sample CSV, in code. Must match to the penny.
// Meter kWh are SAMPLE data; Agile prices are real. Output: eval/reconciliation.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { zsql } from "./zetaris_client.ts";

const WINDOWS = { A: ["2026-08-27", "2026-09-24"], B: ["2026-09-24", "2026-10-22"] } as const; // [from, to) UTC
const AGILE = "https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/";

// --- independent side: raw API (follow `next`), raw CSV ---
const rates = new Map<string, number>(); // slot start ISO -> p/kWh inc VAT
let url: string | null = `${AGILE}?period_from=2026-08-27T00:00:00Z&period_to=2026-10-22T00:00:00Z&page_size=1500`;
while (url) {
  const j: any = await (await fetch(url)).json();
  for (const r of j.results) rates.set(new Date(r.valid_from).toISOString(), r.value_inc_vat);
  url = j.next;
}
const rows = readFileSync(new URL("../data/sample/meter_hh.csv", import.meta.url), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
const indep: Record<string, Record<string, { kwh: number; pence: number; n: number }>> = {};
for (const [site, ts, kwh] of rows) {
  const iso = new Date(ts).toISOString();
  const w = Object.entries(WINDOWS).find(([, [f, t]]) => iso >= f && iso < t)?.[0];
  const p = rates.get(iso);
  if (!w || p === undefined) continue;
  const o = ((indep[site] ??= {})[w] ??= { kwh: 0, pence: 0, n: 0 });
  o.kwh += Number(kwh); o.pence += Number(kwh) * p; o.n++;
}

// --- federated side: one Zetaris SQL ---
const ts = (d: string) => `timestamp '${d} 00:00:00'`;
const sql = `SELECT m.site_id, CASE WHEN m.ts >= ${ts(WINDOWS.A[0])} AND m.ts < ${ts(WINDOWS.A[1])} THEN 'A' ELSE 'B' END AS win,
  COUNT(*) AS n, SUM(m.kwh) AS kwh, SUM(m.kwh * r.p_kwh_inc_vat) AS pence
FROM kilowhy.meter_hh m JOIN kilowhy.agile_rates r ON m.ts = r.slot_start
WHERE m.ts >= ${ts(WINDOWS.A[0])} AND m.ts < ${ts(WINDOWS.B[1])}
GROUP BY 1, 2 ORDER BY 1, 2`;
const z = await zsql(sql);
if (!z.ok) { console.error("Zetaris query failed", JSON.stringify(z.body).slice(0, 500)); process.exit(2); }

const out: any[] = []; let pass = true;
for (const [site, w, n, kwh, pence] of z.body.data) {
  const i = indep[site]?.[w];
  const zGBP = Math.round(Number(pence)) / 100, iGBP = Math.round(i.pence) / 100;
  const ok = zGBP === iGBP && Number(n) === i.n && Math.abs(Number(kwh) - i.kwh) < 0.01;
  pass &&= ok;
  out.push({ site, window: w, slots_zetaris: Number(n), slots_independent: i.n, kwh_zetaris: Number(kwh), kwh_independent: +i.kwh.toFixed(3), cost_gbp_zetaris: zGBP, cost_gbp_independent: iGBP, match: ok });
}
const expected = Object.keys(indep).length * 2;
pass &&= out.length === expected;
mkdirSync(new URL("../eval", import.meta.url), { recursive: true });
const report = { checked_at: new Date().toISOString(), note: "meter kWh are SAMPLE data; Agile unit rates are real (Octopus AGILE-24-10-01 region C, inc VAT)", zetaris_run_id: z.runId, sql, pass, rows: out };
writeFileSync(new URL("../eval/reconciliation.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.table(out);
console.log(pass ? "RECONCILIATION PASS" : "RECONCILIATION FAIL");
process.exit(pass ? 0 : 1);
