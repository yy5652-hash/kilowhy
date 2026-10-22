// Shared types for the hypothesis library.
import type { DecomposeOk, Window as DecWindow } from "../decompose.ts";
import type { DataLayer, SlotRow } from "../data.ts";
import type { EvidenceStore, MetricValue } from "../evidence.ts";
import type { DateWindow } from "../windows.ts";

export type Status = "supported" | "ruled_out" | "inconclusive";
export type HypothesisId = "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8" | "H9" | "H10";
export type SummaryValue = MetricValue["value"];

export interface HypothesisResult {
  id: HypothesisId;
  name: string;                               // price_level, weather_volume, ...
  status: Status;
  headline: string;                           // one short line with the key number
  summary: Record<string, SummaryValue>;      // flat key metrics (pence values are converted to GBP where the key says gbp)
  evidence: string[];                         // evidence ids (E#) in the store of this investigation
  notes: string[];
  details?: Record<string, unknown>;          // structured extras (events, per-band tables, ...)
}

export interface Hypothesis {
  id: HypothesisId;
  name: string;
  title: string;
  description: string;                        // one line for the LLM planner
  run(ctx: HypCtx): Promise<HypothesisResult>;
}

export interface Scope { label: string; sites: string[] }  // label "S1" / "ALL"

/** One half-hour slot summed over the sites of the scope. */
export interface SlotAgg {
  ts: string; kwh: number; p: number;
  intensity: number | null; windPct: number | null; gasPct: number | null; importsPct: number | null;
}
/** Slot i of A is aligned with slot i of B (same weekday and half-hour); only slots present for all sites in both windows are kept. */
export interface Aligned { A: SlotAgg[]; B: SlotAgg[]; expected: number; kept: number }

export interface Decomp {
  ok: boolean;
  error?: string;
  result: DecomposeOk | null;
  windowA: DecWindow | null;                  // decompose() input windows (price p in pence/kWh)
  windowB: DecWindow | null;
  aligned: Aligned;
  standing: { A: number; B: number };         // pence per day per site
  evidenceId: string;                         // DECOMP evidence of the slot query
  contractEvidenceId: string;
  warnings: string[];
}

export interface HypCtx {
  scope: Scope;
  sites: string[];
  windowA: DateWindow;
  windowB: DateWindow;
  decomposition: Decomp;
  data: DataLayer;
  evidence: EvidenceStore;
}

export type { SlotRow };
