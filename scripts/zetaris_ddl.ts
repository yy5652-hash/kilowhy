// Generates and runs the Zetaris DDL for all Kilowhy sources, then flattened views.
// Usage: node scripts/zetaris_ddl.ts [--views-only] [--flat-only] [--dry]
//   --flat-only: only the flat-tariff comparison tables and kilowhy.flat_tariff (Octopus business variable tariff, see server/src/flat_tariff.ts)
// REST sources are real public data (Octopus, NESO, Open-Meteo, Elexon). Files are SAMPLE meter data.
import { zsql, sleep } from "./zetaris_client.ts";
import { flatRatesEndpoint, flatStandingEndpoint, flatViewSql } from "../server/src/flat_tariff.ts";

const DRY = process.argv.includes("--dry");
const VIEWS_ONLY = process.argv.includes("--views-only");
const FLAT_ONLY = process.argv.includes("--flat-only");
const WARM_ONLY = process.argv.includes("--warm");
const START = "2026-08-27"; // first day (UTC), 8 weeks ending 2026-10-21
const END_EXCL = "2026-10-22";
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const AGILE = "https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C";

interface Win { name: string; from: string; to: string } // [from, to) in UTC dates
const half = (): Win[] => [
  { name: "a", from: START, to: addDays(START, 28) },
  { name: "b", from: addDays(START, 28), to: END_EXCL },
];
const weeks = (): Win[] => Array.from({ length: 8 }, (_, i) => ({ name: `w${i + 1}`, from: addDays(START, 7 * i), to: addDays(START, 7 * i + 7) }));

const rest = (name: string, endpoint: string) =>
  `CREATE LIGHTNING REST TABLE ${name} FROM KILOWHY_REST REQUEST(endpoint "${endpoint}", method "get", response_type "json", http_encoding "JSON") HEADER () BODY ()`;

interface Src { table: string; sql: string }
const sources: Src[] = [];
for (const w of half()) {
  sources.push({ table: `agile_${w.name}_raw`, sql: rest(`agile_${w.name}_raw`, `${AGILE}/standard-unit-rates/?period_from=${w.from}T00:00:00Z&period_to=${w.to}T00:00:00Z&page_size=1500`) });
  sources.push({ table: `ci_london_${w.name}_raw`, sql: rest(`ci_london_${w.name}_raw`, `https://api.carbonintensity.org.uk/regional/intensity/${w.from}/${w.to}/regionid/13`) });
}
sources.push({ table: "agile_standing_raw", sql: rest("agile_standing_raw", `${AGILE}/standing-charges/`) });
sources.push({ table: "temp_raw", sql: rest("temp_raw", `https://archive-api.open-meteo.com/v1/archive?latitude=51.5072&longitude=-0.1276&start_date=${START}&end_date=${addDays(END_EXCL, -1)}&hourly=temperature_2m&timezone=UTC`) });
for (const w of weeks()) {
  sources.push({ table: `fuelhh_${w.name}_raw`, sql: rest(`fuelhh_${w.name}_raw`, `https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELHH?settlementDateFrom=${w.from}&settlementDateTo=${addDays(w.to, -1)}&format=json`) });
}

sources.push({ table: "flat_rates_raw", sql: rest("flat_rates_raw", flatRatesEndpoint(START, END_EXCL)) });
sources.push({ table: "flat_standing_raw", sql: rest("flat_standing_raw", flatStandingEndpoint(START, END_EXCL)) });

const T = (t: string) => `KILOWHY_REST.${t}`;
const ts = (c: string) => `to_timestamp(${c})`;
const union = (parts: string[]) => parts.join("\nUNION ALL\n");
const inWin = (col: string, w: Win) => `${col} >= timestamp '${w.from} 00:00:00' AND ${col} < timestamp '${w.to} 00:00:00'`;

const views: { name: string; sql: string }[] = [
  { name: "agile_rates", sql: union(half().map((w) =>
    `SELECT ${ts("r.valid_from")} AS slot_start, ${ts("r.valid_to")} AS slot_end, r.value_exc_vat AS p_kwh_exc_vat, r.value_inc_vat AS p_kwh_inc_vat FROM ${T(`agile_${w.name}_raw`)} LATERAL VIEW explode(results) t AS r WHERE ${inWin(ts("r.valid_from"), w)}`)) },
  { name: "agile_standing", sql: `SELECT r.value_exc_vat AS p_day_exc_vat, r.value_inc_vat AS p_day_inc_vat, ${ts("r.valid_from")} AS valid_from FROM ${T("agile_standing_raw")} LATERAL VIEW explode(results) t AS r` },
  { name: "ci_london", sql: union(half().map((w) =>
    `SELECT to_timestamp(d.\`from\`, "yyyy-MM-dd'T'HH:mm'Z'") AS slot_start, d.intensity.forecast AS forecast_gco2_kwh, d.intensity.\`index\` AS intensity_index, ` +
    ["wind", "gas", "solar", "nuclear", "imports", "biomass"].map((f) => `filter(d.generationmix, x -> x.fuel = '${f}')[0].perc AS ${f}_pct`).join(", ") +
    ` FROM ${T(`ci_london_${w.name}_raw`)} LATERAL VIEW explode(data.data) t AS d WHERE ${inWin(`to_timestamp(d.\`from\`, "yyyy-MM-dd'T'HH:mm'Z'")`, w)}`)) },
  { name: "temp_hourly", sql: `SELECT to_timestamp(z.\`time\`, "yyyy-MM-dd'T'HH:mm") AS ts, z.temperature_2m AS temp_c FROM ${T("temp_raw")} LATERAL VIEW explode(arrays_zip(hourly.\`time\`, hourly.temperature_2m)) t AS z` },
  { name: "fuel_hh", sql: union(weeks().map((w) =>
    `SELECT ${ts("d.startTime")} AS slot_start, d.settlementDate AS settlement_date, d.settlementPeriod AS settlement_period, d.fuelType AS fuel_type, d.generation AS mw FROM ${T(`fuelhh_${w.name}_raw`)} LATERAL VIEW explode(data) t AS d`)) },
  { name: "meter_hh", sql: `SELECT site_id, ts, CAST(kwh AS DOUBLE) AS kwh FROM KILOWHY_FILES.meter_hh_raw` },
  { name: "sites", sql: `SELECT * FROM KILOWHY_FILES.sites_raw` },
  { name: "ops_log", sql: `SELECT event_id, site_id, CAST(event_date AS DATE) AS event_date, description FROM KILOWHY_FILES.ops_log_raw` },
  { name: "contract", sql: `SELECT * FROM KILOWHY_FILES.contract_raw` },
  { name: "flat_tariff", sql: flatViewSql() },
];

async function step(label: string, sql: string, wait = 0): Promise<boolean> {
  if (DRY) { console.log(`-- ${label}\n${sql};\n`); return true; }
  let r = await zsql(sql);
  if (!r.ok) { await sleep(60000); r = await zsql(sql); } // one retry after a minute (rate limits)
  console.log(`${r.ok ? "OK  " : "FAIL"} ${label} ${r.ok ? "" : JSON.stringify(r.body).slice(0, 300)}`);
  if (wait) await sleep(wait);
  return r.ok;
}

// --warm: after a Zetaris restart the tables and views survive but CACHE TABLE (in memory) does not; re-cache every raw table, create nothing.
if (WARM_ONLY) {
  for (const f of ["meter_hh", "sites", "ops_log", "contract"]) await step(`cache ${f}`, `CACHE TABLE KILOWHY_FILES.${f}_raw`);
  for (const s of sources) await step(`cache ${s.table}`, `CACHE TABLE ${T(s.table)}`, 3000);
  process.exit(0);
}
if (!VIEWS_ONLY && !FLAT_ONLY) {
  await step("create db KILOWHY_REST", `CREATE LIGHTNING DATABASE KILOWHY_REST DESCRIBE BY "Kilowhy REST sources"`);
  await step("create db KILOWHY_FILES", `CREATE LIGHTNING DATABASE KILOWHY_FILES DESCRIBE BY "Kilowhy sample files"`);
  for (const f of ["meter_hh", "sites", "ops_log", "contract"]) {
    await step(`file ${f}`, `CREATE LIGHTNING FILESTORE TABLE ${f}_raw FROM KILOWHY_FILES FORMAT CSV OPTIONS (PATH "file:///home/zetaris/customer-data/shared/kw_${f}.csv", inferSchema "true", header "true")`);
    await step(`cache ${f}`, `CACHE TABLE KILOWHY_FILES.${f}_raw`);
  }
}
if (FLAT_ONLY) {
  for (const s of sources.filter((x) => x.table.startsWith("flat_"))) {
    await step(`rest ${s.table}`, s.sql, 15000);
    await step(`cache ${s.table}`, `CACHE TABLE ${T(s.table)}`, 5000);
  }
}
if (!VIEWS_ONLY && !FLAT_ONLY) {
  for (const s of sources) {
    await step(`rest ${s.table}`, s.sql, 15000);
    await step(`cache ${s.table}`, `CACHE TABLE ${T(s.table)}`, 5000);
  }
}
if (!FLAT_ONLY) await step("container", `CREATE SCHEMASTORE CONTAINER kilowhy`);
for (const v of FLAT_ONLY ? views.filter((x) => x.name === "flat_tariff") : views) await step(`view ${v.name}`, `CREATE OR REPLACE SCHEMASTORE VIEW ${v.name} WITH CONTAINER kilowhy AS\n${v.sql}`);
