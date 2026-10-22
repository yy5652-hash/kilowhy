// Types of the agent loop (spec section 13): the InvestigationResult and the pieces it is made of. Meter kWh are SAMPLE data.
import type { Decomp, HypothesisId, HypothesisResult } from "./hypotheses/types.ts";
import type { Evidence } from "./evidence.ts";
import type { Fact } from "./facts.ts";
import type { Answer, VerifyError } from "./verifier.ts";
import type { Recommendation, TariffComparison } from "./recommend.ts";
import type { Route } from "./provider_shared.ts";
import type { DateWindow } from "./windows.ts";
import type { MarkovianReport } from "./investigate_markovian.ts";

export const INTENT_TYPES = ["why_cost_change", "why_spike_day", "why_emissions", "what_to_change"] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

export interface Intent {
  type: IntentType;
  requestedSites: string[];                   // as written by the model or the user ("Brixton", "site 2", "ALL")
  dates: string[];                            // YYYY-MM-DD
  source: "llm" | "fallback";                 // fallback: deterministic keyword rules after the model failed twice
}

export interface ExtraSql {
  purpose: string; sql: string;
  status: "ran" | "rejected" | "failed";
  reason?: string;                            // why it was rejected by the guard or failed in Zetaris
  evidence?: string; rows?: number;
}
export interface Plan {
  hypotheses: HypothesisId[];                 // in run order, including the ones the system added
  added: HypothesisId[];                      // added by code: H7-H9 data checks, and the tests the question type needs
  dropped: string[];                          // ids the model proposed that are not in the catalog
  extraSql: ExtraSql[];
  rationale: string;
  source: "llm" | "default";
}

export interface LlmCall { step: string; route?: Route; error?: string; wallMs?: number; rejected?: string }   // rejected: why the reply could not be used, with the start and end of its text   // wallMs: the whole call as the agent saw it, including a Meterless attempt that timed out before the fallback answered
export interface Timings { total: number; [step: string]: number }   // milliseconds

export interface Verification {
  passed: boolean; attempts: number; mode: "llm" | "template";
  errors: string[];                           // why the model's last attempt failed (empty when an LLM answer passed); template runs append their own check
  errorDetail: VerifyError[];
  history: { attempt: number; errors: string[]; repairs: string[] }[];   // every failed narrative attempt with its errors (what the corrections fixed)
  repairs: string[];                          // repairs code applied to the accepted answer (digits turned into placeholders, sentences dropped for status contradictions)
}

export interface ScopeInfo { label: string; sites: { id: string; name: string }[]; windowA: DateWindow; windowB: DateWindow }

/** The decomposition without the per-slot arrays (those stay in the evidence store / Zetaris). */
export type DecompositionSummary = Omit<Decomp, "windowA" | "windowB" | "aligned"> & { slotsAligned: number; slotsExpected: number };

export interface InvestigationResult {
  question: string;
  intent: Intent;
  scope: ScopeInfo;
  decomposition: DecompositionSummary;
  plan: Plan;
  results: HypothesisResult[];
  evidence: Evidence[];
  facts: Fact[];
  recommendation: { loadShift: Recommendation | null; tariff: TariffComparison | null };
  answer: Answer;
  verification: Verification;
  llmCalls: LlmCall[];
  timings: Timings;
  notes: string[];
  sampleDataNote: string;
  memory?: MemoryReport;                      // present when the investigation ran with H-MEM
  engine?: "markovian" | "plain";             // how the LLM part ran
  markovian?: MarkovianReport;                // the chunks of the Markovian chain with their tokens (engine "markovian")
}
/** What H-MEM did in this investigation: memories recalled at the start (each is an M# fact) and causes written at the end. */
export interface MemoryReport {
  query: string; embedRoute: string; recallMs: number;
  recalled: { id: string; factId: string; relevance: number; origin: "user" | "agent"; site?: string; learnedAt: string; text: string; citedIn: number }[];   // citedIn: answer items that cite its M#
  written: { id: string; hypothesis: string; text: string; skipped: boolean }[];                                                                                // skipped: the same cause for the same windows was already remembered
}
export interface ClarificationResult { question: string; clarification: string; knownSites: { id: string; name: string }[]; llmCalls: LlmCall[]; timings: Timings }
export type InvestigateOutcome = InvestigationResult | ClarificationResult;
export const isClarification = (o: InvestigateOutcome): o is ClarificationResult => "clarification" in o;

export const SAMPLE_NOTE = "Meter kWh are SAMPLE data (synthetic, Crumb & Co); Agile prices (Octopus), carbon intensity (NESO) and temperatures (Open-Meteo) are real public data.";
