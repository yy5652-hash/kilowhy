// The planner's optional extra SQL: every query goes through the read-only guard, runs in Zetaris, and becomes an evidence record
// (hypothesisId "EXTRA"). A rejected or failing query is recorded in the plan and never aborts the investigation.
import { guardSql } from "./sqlguard.ts";
import { makeEvidence, type EvidenceSource, type EvidenceStore, type Row, type SourceKind } from "./evidence.ts";
import type { ZSql } from "./data.ts";
import type { ExtraSql } from "./agent_types.ts";

export const MAX_EXTRA_SQL = 1;
const KINDS: Record<string, SourceKind> = {
  agile_rates: "REST: Octopus", agile_standing: "REST: Octopus", flat_tariff: "REST: Octopus", ci_london: "REST: NESO", fuel_hh: "REST: Elexon", temp_hourly: "REST: Open-Meteo",
  meter_hh: "FILE: sample", sites: "FILE: sample", ops_log: "FILE: sample", contract: "FILE: sample",
};
const sourcesOf = (tables: string[]): EvidenceSource[] => tables.map((t) => t.replace(/^kilowhy\./, "")).map((view) => ({ view, kind: KINDS[view] ?? "FILE: sample" }));

export async function runExtraSql(proposals: { purpose: string; sql: string }[], zsql: ZSql | undefined, store: EvidenceStore): Promise<ExtraSql[]> {
  const out: ExtraSql[] = [];
  for (const p of proposals.slice(0, MAX_EXTRA_SQL)) {
    const base = { purpose: p.purpose.slice(0, 200), sql: p.sql };
    const g = guardSql(p.sql);
    if (!g.ok) { out.push({ ...base, status: "rejected", reason: g.reason }); continue; }
    if (!zsql) { out.push({ ...base, sql: g.sql, status: "failed", reason: "no SQL runner configured" }); continue; }
    try {
      const z = await zsql(g.sql);
      const headers: unknown = z.body?.headers, data: unknown = z.body?.data;
      if (!z.ok || !Array.isArray(headers) || !Array.isArray(data)) throw new Error(`Zetaris HTTP ${z.status}: ${String(typeof z.body === "string" ? z.body : JSON.stringify(z.body?.message ?? z.body)).slice(0, 200)}`);
      const rows: Row[] = data.map((d: unknown[]) => Object.fromEntries((headers as string[]).map((h, i) => [h, d[i]])));
      const e = makeEvidence(store, { hypothesisId: "EXTRA", title: base.purpose, sql: g.sql, zetarisRunId: z.runId, rows, sources: sourcesOf(g.tables) });
      out.push({ ...base, sql: g.sql, status: "ran", evidence: e.id, rows: rows.length });
    } catch (e) {
      out.push({ ...base, sql: g.sql, status: "failed", reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  return out;
}

/** Numeric cells of a single-row result as (column, value) pairs: the only extra-query output that becomes a fact. */
export function singleRowNumbers(store: EvidenceStore, evidenceId: string): [string, number][] {
  const e = store.get(evidenceId);
  if (!e || e.rowCount !== 1) return [];
  return Object.entries(e.sampleRows[0] ?? {}).map(([k, v]) => [k, typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN] as [string, number]).filter(([, v]) => Number.isFinite(v)).slice(0, 8);
}
