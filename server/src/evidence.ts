// Evidence records (spec section 12): one per Zetaris query + the deterministic metrics computed from its rows.
// Ids are sequential per investigation (E1, E2, ...), the result hash is sha256 over canonical JSON (sorted keys) of ALL result rows.
// Meter kWh in this project are SAMPLE data; sources carry the kind label ("FILE: sample").
import { createHash } from "node:crypto";

export type SourceKind = "REST: Octopus" | "REST: NESO" | "REST: Elexon" | "REST: Open-Meteo" | "FILE: sample";
export interface EvidenceSource { view: string; kind: SourceKind }
export interface MetricValue { value: number | string | boolean | null; unit: string }
export type Row = Record<string, unknown>;

export interface Evidence {
  id: string;                       // "E1", "E2", ...
  hypothesisId: string;             // "H1".."H10", "DECOMP", "REC"
  title: string;
  sql: string;
  zetarisRunId: string;
  rowCount: number;                 // full result size
  resultSha256: string;             // sha256 of canonicalJson(all rows)
  sampleRows: Row[];                // first <= 10 rows
  metrics: Record<string, MetricValue>;
  sources: EvidenceSource[];
}

export const MAX_SAMPLE_ROWS = 10;

/** JSON with object keys sorted at every level; undefined members are dropped, non-finite numbers become null. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  return "null";
}
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");
export const hashRows = (rows: Row[]): string => sha256Hex(canonicalJson(rows));

/** Metric values must be JSON-safe: NaN / Infinity become null. */
export function cleanMetrics(m: Record<string, MetricValue>): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const [k, mv] of Object.entries(m)) out[k] = { value: typeof mv.value === "number" && !Number.isFinite(mv.value) ? null : mv.value, unit: mv.unit };
  return out;
}

export class EvidenceStore {
  private items: Evidence[] = [];
  private byId = new Map<string, Evidence>();
  private counter = 0;

  /** Reserves the next id of this investigation. */
  nextId(): string { return `E${++this.counter}`; }
  add(e: Evidence): Evidence {
    if (this.byId.has(e.id)) throw new Error(`duplicate evidence id ${e.id}`);
    this.items.push(e); this.byId.set(e.id, e);
    return e;
  }
  get(id: string): Evidence | undefined { return this.byId.get(id); }
  list(): Evidence[] { return [...this.items]; }
  get size(): number { return this.items.length; }
  /** Adds (or overwrites) metrics on an existing record; the query provenance stays untouched. */
  addMetrics(id: string, metrics: Record<string, MetricValue>): Evidence {
    const e = this.byId.get(id);
    if (!e) throw new Error(`unknown evidence id ${id}`);
    e.metrics = { ...e.metrics, ...cleanMetrics(metrics) };
    return e;
  }
  toJSON(): Evidence[] { return this.items; }
}

export interface EvidenceInput {
  hypothesisId: string;
  title: string;
  sql: string;
  zetarisRunId: string;
  rows: Row[];                       // the FULL result rows (hashed); only the first 10 are kept as sampleRows
  sources: EvidenceSource[];
  metrics?: Record<string, MetricValue>;
}

/** Builds an Evidence object with the next sequential id of `store` and registers it there. */
export function makeEvidence(store: EvidenceStore, input: EvidenceInput): Evidence {
  const e: Evidence = {
    id: store.nextId(),
    hypothesisId: input.hypothesisId,
    title: input.title,
    sql: input.sql,
    zetarisRunId: input.zetarisRunId,
    rowCount: input.rows.length,
    resultSha256: hashRows(input.rows),
    sampleRows: input.rows.slice(0, MAX_SAMPLE_ROWS),
    metrics: cleanMetrics(input.metrics ?? {}),
    sources: input.sources.map((s) => ({ ...s })),
  };
  return store.add(e);
}

/** Convenience for metric maps: m(1.5, "GBP"). */
export const metric = (value: MetricValue["value"], unit: string): MetricValue => ({ value, unit });
