// Real public data for the evaluation: the Zetaris snapshot of per-slot Agile price, carbon intensity, generation mix and hourly temperature
// for windows A and B (eval/data/real_windows.json, written by scripts/eval_snapshot.ts). It holds NO meter data.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { WINDOW_A, WINDOW_B } from "../server/src/windows.ts";

export interface RealSlot { ts: string; p: number; intensity: number | null; windPct: number | null; gasPct: number | null; importsPct: number | null }
export interface RealTemp { ts: string; tempC: number }
export interface RealStanding { validFrom: string; excVat: number; incVat: number }
export interface SnapshotQuery { id: string; sql: string; zetarisRunId: string; rowCount: number; resultSha256: string }
export interface RealWindows {
  generatedAt: string; note: string;
  windows: { A: typeof WINDOW_A; B: typeof WINDOW_B };
  queries: SnapshotQuery[];
  slots: RealSlot[]; temps: RealTemp[]; standing: RealStanding[];
}

export const SNAPSHOT_PATH = new URL("./data/real_windows.json", import.meta.url);
export const SNAPSHOT_NOTE = "Real public data read once from Zetaris: Octopus Agile price (inc VAT), NESO carbon intensity and generation mix (London), Open-Meteo hourly temperature, Octopus published Agile standing charge. No meter data (meter kWh in this project are SAMPLE data).";

export const SNAPSHOT_SQL = {
  slots: `SELECT r.slot_start AS ts, r.p_kwh_inc_vat AS p, c.forecast_gco2_kwh AS intensity, c.wind_pct, c.gas_pct, c.imports_pct\n` +
    `FROM kilowhy.agile_rates r LEFT JOIN kilowhy.ci_london c ON r.slot_start = c.slot_start\n` +
    `WHERE r.slot_start >= timestamp '${WINDOW_A.from} 00:00:00' AND r.slot_start < timestamp '${WINDOW_B.toExclusive} 00:00:00' ORDER BY r.slot_start`,
  temps: `SELECT ts, temp_c FROM kilowhy.temp_hourly WHERE ts >= timestamp '${WINDOW_A.from} 00:00:00' AND ts < timestamp '${WINDOW_B.toExclusive} 00:00:00' ORDER BY ts`,
  standing: `SELECT CAST(valid_from AS STRING) AS valid_from, p_day_exc_vat, p_day_inc_vat FROM kilowhy.agile_standing ORDER BY valid_from`,
} as const;

export interface RawRun { sql: string; runId: string; ok: boolean; status: number; body: any }
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const isoTs = (z: string): string => (z.includes("T") ? new Date(z).toISOString() : z.replace(" ", "T").replace(/\.0+$/, "") + "Z").replace(".000Z", "Z");

function table(run: RawRun, what: string): Record<string, unknown>[] {
  const { headers, data } = run.body ?? {};
  if (!run.ok || !Array.isArray(headers) || !Array.isArray(data)) throw new Error(`Zetaris ${what} query failed (HTTP ${run.status})`);
  return data.map((d: unknown[]) => Object.fromEntries((headers as string[]).map((h, i) => [h, d[i]])));
}
const query = (id: string, run: RawRun, rows: Record<string, unknown>[]): SnapshotQuery =>
  ({ id, sql: run.sql, zetarisRunId: run.runId, rowCount: rows.length, resultSha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") });

/** Builds the snapshot object from the three Zetaris responses (pure; the script does the fetching). */
export function buildSnapshot(runs: { slots: RawRun; temps: RawRun; standing: RawRun }, generatedAt: string): RealWindows {
  const s = table(runs.slots, "slots"), t = table(runs.temps, "temperature"), g = table(runs.standing, "standing charge");
  const need = (v: unknown, what: string): number => { const x = num(v); if (x === null) throw new Error(`missing ${what}`); return x; };
  return {
    generatedAt, note: SNAPSHOT_NOTE, windows: { A: WINDOW_A, B: WINDOW_B },
    queries: [query("slots", runs.slots, s), query("temps", runs.temps, t), query("standing", runs.standing, g)],
    slots: s.map((r) => ({ ts: isoTs(String(r.ts)), p: need(r.p, "price"), intensity: num(r.intensity), windPct: num(r.wind_pct), gasPct: num(r.gas_pct), importsPct: num(r.imports_pct) })),
    temps: t.map((r) => ({ ts: isoTs(String(r.ts)), tempC: need(r.temp_c, "temperature") })),
    standing: g.map((r) => ({ validFrom: String(r.valid_from).slice(0, 10), excVat: need(r.p_day_exc_vat, "standing"), incVat: need(r.p_day_inc_vat, "standing") })),
  };
}

/** Problems with a snapshot (empty list = usable): 2 x 28 days x 48 slots, every price finite, hourly temperature for every hour. */
export function validateSnapshot(r: RealWindows): string[] {
  const out: string[] = [];
  const nSlots = (WINDOW_A.days + WINDOW_B.days) * 48, nHours = (WINDOW_A.days + WINDOW_B.days) * 24;
  if (r.slots.length !== nSlots) out.push(`expected ${nSlots} priced slots, got ${r.slots.length}`);
  if (r.temps.length !== nHours) out.push(`expected ${nHours} hourly temperatures, got ${r.temps.length}`);
  const t0 = Date.parse(WINDOW_A.from + "T00:00:00Z");
  r.slots.forEach((s, i) => { if (Date.parse(s.ts) !== t0 + i * 1800e3) out.push(`slot ${i} has ts ${s.ts}`); });
  r.temps.forEach((s, i) => { if (Date.parse(s.ts) !== t0 + i * 3600e3) out.push(`hour ${i} has ts ${s.ts}`); });
  if (r.slots.some((s) => s.intensity === null || s.windPct === null || s.gasPct === null)) out.push("some slots lack carbon intensity or generation mix");
  if (!r.standing.length) out.push("no published standing charge");
  if (!r.queries.length || r.queries.some((q) => !q.zetarisRunId || !q.sql)) out.push("queries lack sql or run id");
  return out.slice(0, 10);
}

const COLS = { slots: ["ts", "p", "intensity", "wind_pct", "gas_pct", "imports_pct"], temps: ["ts", "temp_c"], standing: ["valid_from", "p_day_exc_vat", "p_day_inc_vat"] } as const;
/** Compact JSON: header fields indented, one table row per line. */
export function serializeSnapshot(r: RealWindows): string {
  const rows = (cols: readonly string[], xs: unknown[][]) => `{ "columns": ${JSON.stringify(cols)}, "rows": [\n${xs.map((x) => "    " + JSON.stringify(x)).join(",\n")}\n  ] }`;
  return `{\n  "generatedAt": ${JSON.stringify(r.generatedAt)},\n  "note": ${JSON.stringify(r.note)},\n  "windows": ${JSON.stringify(r.windows)},\n  "queries": ${JSON.stringify(r.queries, null, 2).replace(/\n/g, "\n  ")},\n` +
    `  "slots": ${rows(COLS.slots, r.slots.map((s) => [s.ts, s.p, s.intensity, s.windPct, s.gasPct, s.importsPct]))},\n` +
    `  "temps": ${rows(COLS.temps, r.temps.map((s) => [s.ts, s.tempC]))},\n  "standing": ${rows(COLS.standing, r.standing.map((s) => [s.validFrom, s.excVat, s.incVat]))}\n}\n`;
}

export function parseSnapshot(text: string): RealWindows {
  const j = JSON.parse(text);
  return {
    generatedAt: j.generatedAt, note: j.note, windows: j.windows, queries: j.queries,
    slots: j.slots.rows.map((x: any[]) => ({ ts: x[0], p: x[1], intensity: x[2], windPct: x[3], gasPct: x[4], importsPct: x[5] })),
    temps: j.temps.rows.map((x: any[]) => ({ ts: x[0], tempC: x[1] })),
    standing: j.standing.rows.map((x: any[]) => ({ validFrom: x[0], excVat: x[1], incVat: x[2] })),
  };
}

export function loadReal(path: URL | string = SNAPSHOT_PATH): RealWindows {
  const r = parseSnapshot(readFileSync(path, "utf8"));
  const bad = validateSnapshot(r);
  if (bad.length) throw new Error(`invalid real-data snapshot: ${bad.join("; ")}`);
  return r;
}
