// Shared data fetchers for the hypotheses. Each fetcher runs ONE federated Zetaris query (joins across REST and file sources happen in Zetaris),
// returns typed rows and an Evidence record (sql, run id, row count, sha256 of the full result, sample rows, sources).
// Meter kWh are SAMPLE data. Prices (Octopus), carbon (NESO) and temperature (Open-Meteo) are real.
// The layer is injectable: hypotheses depend on the DataLayer interface only, tests pass a fake, the live scripts pass createZetarisData(zsql).
import { makeEvidence, type Evidence, type EvidenceSource, type EvidenceStore, type Row } from "./evidence.ts";
import { toIso } from "./bands.ts";
import type { DateWindow } from "./windows.ts";

export type ZSql = (sql: string) => Promise<{ ok: boolean; status: number; body: any; runId: string }>;
export interface FetchMeta { store: EvidenceStore; hypothesisId: string; title: string }
export interface Fetched<T> { rows: T[]; evidence: Evidence }
export interface Windows { A: DateWindow; B: DateWindow }

export interface SlotRow {
  site: string; ts: string; win: "A" | "B";
  kwh: number; p: number;                              // pence/kWh inc VAT (Octopus Agile)
  intensity: number | null;                            // gCO2/kWh forecast (NESO, London)
  windPct: number | null; gasPct: number | null; importsPct: number | null;
}
export interface DailyRow { site: string; date: string; kwh: number; nSlots: number; tMean: number | null; nHours: number }
export interface OpsEvent { eventId: string; siteId: string; eventDate: string; description: string }
export interface ContractRow { src: "contract" | "agile_standing"; productCode: string | null; tariffCode: string | null; standingPencePerDay: number | null; vatRate: number | null; validFrom: string }
export type QualityCheck = "zero_run" | "flatline" | "duplicate_ts" | "slots_per_day" | "rows";
export interface QualityRow { check: QualityCheck; site: string; start: string; end: string; n: number; value: number | null }
export interface CoverageRow { site: string; win: "A" | "B"; nMeter: number; nPriced: number; nCarbon: number }

export interface DataLayer {
  siteIds(): Promise<string[]>;
  slots(q: { sites: string[]; windows: Windows }, meta: FetchMeta): Promise<Fetched<SlotRow>>;
  daily(q: { sites: string[]; windows: Windows }, meta: FetchMeta): Promise<Fetched<DailyRow>>;
  opsLog(q: { sites: string[] }, meta: FetchMeta): Promise<Fetched<OpsEvent>>;
  contract(meta: FetchMeta): Promise<Fetched<ContractRow>>;
  quality(q: { sites: string[]; windows: Windows }, meta: FetchMeta): Promise<Fetched<QualityRow>>;
  coverage(q: { sites: string[]; windows: Windows }, meta: FetchMeta): Promise<Fetched<CoverageRow>>;
}

// ---------------------------------------------------------------- SQL (vetted templates; identifiers are validated, never interpolated raw)
const SRC = {
  meter: { view: "meter_hh", kind: "FILE: sample" },
  rates: { view: "agile_rates", kind: "REST: Octopus" },
  carbon: { view: "ci_london", kind: "REST: NESO" },
  temp: { view: "temp_hourly", kind: "REST: Open-Meteo" },
  ops: { view: "ops_log", kind: "FILE: sample" },
  contract: { view: "contract", kind: "FILE: sample" },
  standing: { view: "agile_standing", kind: "REST: Octopus" },
  sites: { view: "sites", kind: "FILE: sample" },
} as const satisfies Record<string, EvidenceSource>;

const siteList = (sites: string[]): string => {
  if (sites.length === 0) throw new Error("no sites in scope");
  for (const s of sites) if (!/^[A-Za-z0-9_-]{1,32}$/.test(s)) throw new Error(`invalid site id ${JSON.stringify(s)}`);
  return sites.map((s) => `'${s}'`).join(", ");
};
const dateLit = (d: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`invalid date ${JSON.stringify(d)}`);
  return `timestamp '${d} 00:00:00'`;
};
const rangeSql = (col: string, w: Windows): string =>
  w.A.toExclusive === w.B.from ? `${col} >= ${dateLit(w.A.from)} AND ${col} < ${dateLit(w.B.toExclusive)}`
    : `((${col} >= ${dateLit(w.A.from)} AND ${col} < ${dateLit(w.A.toExclusive)}) OR (${col} >= ${dateLit(w.B.from)} AND ${col} < ${dateLit(w.B.toExclusive)}))`;
const winSql = (col: string, w: Windows): string => `CASE WHEN ${col} >= ${dateLit(w.A.from)} AND ${col} < ${dateLit(w.A.toExclusive)} THEN 'A' ELSE 'B' END`;

export const sitesSql = (): string => `SELECT site_id FROM kilowhy.sites ORDER BY site_id`;

export const slotsSql = (sites: string[], w: Windows): string =>
  `SELECT m.site_id, m.ts, ${winSql("m.ts", w)} AS win, m.kwh, r.p_kwh_inc_vat AS p, c.forecast_gco2_kwh AS intensity, c.wind_pct, c.gas_pct, c.imports_pct\n` +
  `FROM kilowhy.meter_hh m JOIN kilowhy.agile_rates r ON m.ts = r.slot_start LEFT JOIN kilowhy.ci_london c ON m.ts = c.slot_start\n` +
  `WHERE m.site_id IN (${siteList(sites)}) AND ${rangeSql("m.ts", w)}\nORDER BY m.site_id, m.ts`;

export const dailySql = (sites: string[], w: Windows): string =>
  `WITH k AS (SELECT site_id, CAST(ts AS DATE) AS d, SUM(kwh) AS kwh, COUNT(*) AS n_slots FROM kilowhy.meter_hh WHERE site_id IN (${siteList(sites)}) AND ${rangeSql("ts", w)} GROUP BY site_id, CAST(ts AS DATE)),\n` +
  `t AS (SELECT CAST(ts AS DATE) AS d, AVG(temp_c) AS t_mean, COUNT(*) AS n_hours FROM kilowhy.temp_hourly WHERE ${rangeSql("ts", w)} GROUP BY CAST(ts AS DATE))\n` +
  `SELECT k.site_id, k.d, k.kwh, k.n_slots, t.t_mean, t.n_hours FROM k LEFT JOIN t ON k.d = t.d ORDER BY k.site_id, k.d`;

export const opsLogSql = (sites: string[]): string =>
  `SELECT event_id, site_id, CAST(event_date AS STRING) AS event_date, description FROM kilowhy.ops_log WHERE site_id IN (${siteList(sites)}) ORDER BY event_date, event_id`;

export const contractSql = (): string =>
  `SELECT 'contract' AS src, product_code, tariff_code, CAST(standing_charge_p_per_day AS DOUBLE) AS standing_p_per_day, CAST(vat_rate AS DOUBLE) AS vat_rate, CAST(valid_from AS STRING) AS valid_from FROM kilowhy.contract\n` +
  `UNION ALL\nSELECT 'agile_standing', CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(p_day_inc_vat AS DOUBLE), CAST(NULL AS DOUBLE), CAST(valid_from AS STRING) FROM kilowhy.agile_standing\nORDER BY src, valid_from`;

/** Meter faults in one query: consecutive identical readings (zero runs >= 4, non-zero flatlines >= 12), duplicate timestamps, days without 48 slots, plus one summary row per site. */
export const qualitySql = (sites: string[], w: Windows, zeroRun = 4, flatRun = 12, slotsPerDay = 48): string =>
  `WITH base AS (SELECT site_id, ts, kwh FROM kilowhy.meter_hh WHERE site_id IN (${siteList(sites)}) AND ${rangeSql("ts", w)}),\n` +
  `lagged AS (SELECT site_id, ts, kwh, LAG(kwh) OVER (PARTITION BY site_id ORDER BY ts) AS prev_kwh FROM base),\n` +
  `grp AS (SELECT site_id, ts, kwh, SUM(CASE WHEN prev_kwh IS NULL OR kwh <> prev_kwh THEN 1 ELSE 0 END) OVER (PARTITION BY site_id ORDER BY ts) AS g FROM lagged),\n` +
  `runs AS (SELECT site_id, kwh, g, MIN(ts) AS start_ts, MAX(ts) AS end_ts, COUNT(*) AS n FROM grp GROUP BY site_id, kwh, g)\n` +
  `SELECT CASE WHEN kwh = 0 THEN 'zero_run' ELSE 'flatline' END AS check_name, site_id, CAST(start_ts AS STRING) AS start_ts, CAST(end_ts AS STRING) AS end_ts, n, kwh AS value FROM runs WHERE (kwh = 0 AND n >= ${zeroRun}) OR (kwh <> 0 AND n >= ${flatRun})\n` +
  `UNION ALL\nSELECT 'duplicate_ts', site_id, CAST(ts AS STRING), CAST(ts AS STRING), COUNT(*), CAST(NULL AS DOUBLE) FROM base GROUP BY site_id, ts HAVING COUNT(*) > 1\n` +
  `UNION ALL\nSELECT 'slots_per_day', site_id, CAST(CAST(ts AS DATE) AS STRING), CAST(CAST(ts AS DATE) AS STRING), COUNT(*), CAST(NULL AS DOUBLE) FROM base GROUP BY site_id, CAST(ts AS DATE) HAVING COUNT(*) <> ${slotsPerDay}\n` +
  `UNION ALL\nSELECT 'rows', site_id, CAST(MIN(ts) AS STRING), CAST(MAX(ts) AS STRING), COUNT(*), SUM(kwh) FROM base GROUP BY site_id\nORDER BY check_name, site_id, start_ts`;

export const coverageSql = (sites: string[], w: Windows): string =>
  `SELECT m.site_id, ${winSql("m.ts", w)} AS win, COUNT(*) AS n_meter, COUNT(r.slot_start) AS n_priced, COUNT(c.slot_start) AS n_carbon\n` +
  `FROM kilowhy.meter_hh m LEFT JOIN kilowhy.agile_rates r ON m.ts = r.slot_start LEFT JOIN kilowhy.ci_london c ON m.ts = c.slot_start\n` +
  `WHERE m.site_id IN (${siteList(sites)}) AND ${rangeSql("m.ts", w)}\nGROUP BY m.site_id, ${winSql("m.ts", w)} ORDER BY m.site_id, win`;

// ---------------------------------------------------------------- row parsing
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const need = (v: unknown, what: string): number => { const x = num(v); if (x === null) throw new Error(`expected a number for ${what}, got ${JSON.stringify(v)}`); return x; };
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export const parseSlot = (r: Row): SlotRow => ({
  site: str(r.site_id), ts: toIso(str(r.ts)), win: r.win === "A" ? "A" : "B", kwh: need(r.kwh, "kwh"), p: need(r.p, "p"),
  intensity: num(r.intensity), windPct: num(r.wind_pct), gasPct: num(r.gas_pct), importsPct: num(r.imports_pct),
});
export const parseDaily = (r: Row): DailyRow => ({ site: str(r.site_id), date: str(r.d).slice(0, 10), kwh: need(r.kwh, "kwh"), nSlots: need(r.n_slots, "n_slots"), tMean: num(r.t_mean), nHours: num(r.n_hours) ?? 0 });
export const parseOps = (r: Row): OpsEvent => ({ eventId: str(r.event_id), siteId: str(r.site_id), eventDate: str(r.event_date).slice(0, 10), description: str(r.description) });
export const parseContract = (r: Row): ContractRow => ({
  src: r.src === "agile_standing" ? "agile_standing" : "contract", productCode: r.product_code === null ? null : str(r.product_code), tariffCode: r.tariff_code === null ? null : str(r.tariff_code),
  standingPencePerDay: num(r.standing_p_per_day), vatRate: num(r.vat_rate), validFrom: str(r.valid_from).slice(0, 10),
});
export const parseQuality = (r: Row): QualityRow => ({ check: str(r.check_name) as QualityCheck, site: str(r.site_id), start: str(r.start_ts), end: str(r.end_ts), n: need(r.n, "n"), value: num(r.value) });
export const parseCoverage = (r: Row): CoverageRow => ({ site: str(r.site_id), win: r.win === "A" ? "A" : "B", nMeter: need(r.n_meter, "n_meter"), nPriced: need(r.n_priced, "n_priced"), nCarbon: need(r.n_carbon, "n_carbon") });

// ---------------------------------------------------------------- Zetaris implementation
interface QueryResult { sql: string; runId: string; rows: Row[] }

/** Runs vetted SQL through `zsql`; identical SQL is executed once per layer instance (the evidence keeps the run id of that execution). */
export function createZetarisData(zsql: ZSql): DataLayer {
  const cache = new Map<string, Promise<QueryResult>>();
  const run = (sql: string): Promise<QueryResult> => {
    let p = cache.get(sql);
    if (!p) {
      p = (async () => {
        const z = await zsql(sql);
        const headers: unknown = z.body?.headers, data: unknown = z.body?.data;
        if (!z.ok || !Array.isArray(headers) || !Array.isArray(data)) {
          const msg = typeof z.body === "string" ? z.body : JSON.stringify(z.body?.message ?? z.body?.error ?? z.body);
          throw new Error(`Zetaris query failed (HTTP ${z.status}): ${String(msg).slice(0, 300)}`);
        }
        const rows: Row[] = data.map((d: unknown[]) => Object.fromEntries((headers as string[]).map((h, i) => [h, d[i]])));
        return { sql, runId: z.runId, rows };
      })();
      cache.set(sql, p);
      p.catch(() => cache.delete(sql));
    }
    return p;
  };
  const fetched = async <T>(sql: string, sources: EvidenceSource[], parse: (r: Row) => T, meta: FetchMeta): Promise<Fetched<T>> => {
    const q = await run(sql);
    const evidence = makeEvidence(meta.store, { hypothesisId: meta.hypothesisId, title: meta.title, sql: q.sql, zetarisRunId: q.runId, rows: q.rows, sources });
    return { rows: q.rows.map(parse), evidence };
  };
  return {
    async siteIds() { return (await run(sitesSql())).rows.map((r) => str(r.site_id)); },
    slots: (q, meta) => fetched(slotsSql(q.sites, q.windows), [SRC.meter, SRC.rates, SRC.carbon], parseSlot, meta),
    daily: (q, meta) => fetched(dailySql(q.sites, q.windows), [SRC.meter, SRC.temp], parseDaily, meta),
    opsLog: (q, meta) => fetched(opsLogSql(q.sites), [SRC.ops], parseOps, meta),
    contract: (meta) => fetched(contractSql(), [SRC.contract, SRC.standing], parseContract, meta),
    quality: (q, meta) => fetched(qualitySql(q.sites, q.windows), [SRC.meter], parseQuality, meta),
    coverage: (q, meta) => fetched(coverageSql(q.sites, q.windows), [SRC.meter, SRC.rates, SRC.carbon], parseCoverage, meta),
  };
}
