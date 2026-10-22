/** Client-side mirrors of server investigation types (web/ only; do not import from server/). */

export type SourceKind =
  | "REST: Octopus"
  | "REST: NESO"
  | "REST: Elexon"
  | "REST: Open-Meteo"
  | "FILE: sample";

export interface EvidenceSource {
  view: string;
  kind: SourceKind;
}

export interface MetricValue {
  value: number | string | boolean | null;
  unit: string;
}

export type Row = Record<string, unknown>;

export interface Evidence {
  id: string;
  hypothesisId: string;
  title: string;
  sql: string;
  zetarisRunId: string;
  rowCount: number;
  resultSha256: string;
  sampleRows: Row[];
  metrics: Record<string, MetricValue>;
  sources: EvidenceSource[];
}

export interface FactMemoryRef {
  id: string;
  origin: "user" | "agent";
  site?: string;
  learnedAt: string;
  validFrom?: string;
  confidence: number;
  relevance: number;
  bearsOn?: string[];
}

export interface Fact {
  id: string;
  key: string;
  label: string;
  value: number | string | boolean | null;
  unit: string;
  display: string;
  evidence: string;
  hypothesis?: string;
  memory?: FactMemoryRef;
}

export interface AnswerItem {
  text: string;
  facts: string[];
  evidence: string[];
}

export interface RuledOutItem extends AnswerItem {
  hypothesis: string;
}

export interface Answer {
  headline: string;
  sentences: AnswerItem[];
  ruledOut: RuledOutItem[];
  recommendation: AnswerItem;
}

export type HypothesisStatus = "supported" | "ruled_out" | "inconclusive";

export interface HypothesisResult {
  id: string;
  name: string;
  status: HypothesisStatus;
  headline: string;
  summary: Record<string, unknown>;
  evidence: string[];
  notes: string[];
  details?: Record<string, unknown>;
}

export interface DateWindow {
  id: "A" | "B";
  from: string;
  toExclusive: string;
  days: number;
}

export interface ScopeInfo {
  label: string;
  sites: { id: string; name: string }[];
  windowA: DateWindow;
  windowB: DateWindow;
}

export interface DecomposeOk {
  ok: true;
  QA: number;
  QB: number;
  CA: number;
  CB: number;
  pbarA: number;
  pbarB: number;
  pbarBStar: number;
  standingA: number;
  standingB: number;
  totalA: number;
  totalB: number;
  deltaEnergy: number;
  deltaTotal: number;
  volume: number;
  price: number;
  timing: number;
  standing: number;
  identityError: number;
}

export interface DecompositionSummary {
  ok: boolean;
  error?: string;
  result: DecomposeOk | null;
  standing: { A: number; B: number };
  vatRate: number | null;
  evidenceId: string;
  contractEvidenceId: string;
  warnings: string[];
  slotsAligned: number;
  slotsExpected: number;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  outputTps: number | null;
  routerLatencyMs: number | null;
}

export interface Route {
  provider: "meterless" | "nvidia-direct";
  requestedModel: string;
  routedModel: string | null;
  label: string | null;
  kind: string | null;
  tier: string | null;
  latencyMs: number;
  receiptId: string | null;
  raceWidth: number | null;
  usage: Usage;
  fallbackReason?: string;
  fromCache?: boolean;
}

export interface LlmCall {
  step: string;
  route?: Route;
  error?: string;
  wallMs?: number;
  rejected?: string;
}

export interface Verification {
  passed: boolean;
  attempts: number;
  mode: "llm" | "template";
  errors: string[];
  errorDetail: { part: string; index: number; reason: string }[];
  history: { attempt: number; errors: string[]; repairs: string[] }[];
  repairs: string[];
}

export interface TariffSide {
  energyGbp: number;
  standingGbp: number;
  totalGbp: number;
}

export interface TariffWindow {
  win: "A" | "B";
  slots: number;
  days: number;
  kwh: number;
  agile: TariffSide;
  flat: TariffSide;
  flatMinusAgileGbp: number;
  flatUnitRateRangeP: [number, number];
  coverageComplete: boolean;
}

export interface TariffComparison {
  scope: string;
  ok: boolean;
  reason?: string;
  historicalCounterfactual: true;
  notAdvice: string;
  tariff: {
    productCode: string;
    tariffCode: string;
    name: string;
    region: string;
    why: string;
    vatRate: number | null;
    vatBasis: string;
  };
  windows: { A: TariffWindow; B: TariffWindow } | null;
  sites: { site: string; A: TariffWindow; B: TariffWindow }[];
  cheaperInWindowB: "agile" | "flat" | "equal" | null;
  text: string;
  evidence: string[];
}

export interface Recommendation {
  scope: string;
  ok: boolean;
  reason?: string;
  maxKwhPerDay: number;
  blockSlots: number;
  sites: unknown[];
  total: {
    daysUsed: number;
    daysShifted: number;
    shiftedKwh: number;
    costBeforeGbp: number;
    costAfterGbp: number;
    savedGbp: number;
    savedKgCo2e: number | null;
  };
  text: string;
  evidence: string[];
}

export interface Intent {
  type: string;
  requestedSites: string[];
  dates: string[];
  source: "llm" | "fallback";
}

export interface Plan {
  hypotheses: string[];
  added: string[];
  dropped: string[];
  extraSql: unknown[];
  rationale: string;
  source: "llm" | "default";
}

export interface MarkovianChunk {
  id: number;
  kind: string;
  label: string;
  ms: number;
  llmCalls: number;
  inputTokens: { estimated: number; measured: number | null };
  outputTokens: { estimated: number; measured: number | null };
  carryoverIn: number;
  carryoverOut: number;
  taskTokens: number;
  naiveInputTokens: number;
  route: string | null;
  receiptIds: string[];
  note?: string;
}

export interface MarkovianTotals {
  label?: string;
  markovianInputEstimated?: number;
  naiveInputEstimated?: number;
  savedEstimated?: number;
  savedPercentEstimated?: number;
  markovianInputMeasured?: number | null;
  plainLoopInputEstimated?: number;
}
export interface MarkovianReport {
  engine: "markovian";
  reference: string;
  config: { chunkSize: number; maxChunks: number; carryoverTokens: number; batchSize: number };
  status: string;
  chunks: MarkovianChunk[];
  totals?: MarkovianTotals;
  finalState?: unknown;
  carryoverShrunk?: string[];
  notes?: string[];
}

export interface MemoryRecalled {
  id: string;
  factId: string;
  relevance: number;
  origin: "user" | "agent";
  site?: string;
  learnedAt: string;
  text: string;
  citedIn: number;
}

export interface MemoryReport {
  query: string;
  embedRoute: string;
  recallMs: number;
  recalled: MemoryRecalled[];
  written: { id: string; hypothesis: string; text: string; skipped: boolean }[];
  trace?: unknown;
}

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
  timings: { total: number; [step: string]: number };
  notes: string[];
  sampleDataNote: string;
  generatedAt?: string;
  memory?: MemoryReport;
  engine?: "markovian" | "plain";
  markovian?: MarkovianReport;
}

export interface ClarificationResult {
  question: string;
  clarification: string;
  knownSites: { id: string; name: string }[];
  llmCalls: LlmCall[];
  timings: { total: number; [step: string]: number };
}

export type InvestigateOutcome = InvestigationResult | ClarificationResult;

export const isClarification = (o: InvestigateOutcome): o is ClarificationResult =>
  "clarification" in o;

export type StepName =
  | "sites"
  | "intent"
  | "plan"
  | "data"
  | "hypotheses"
  | "recommend"
  | "extraSql"
  | "facts"
  | "narrative"
  | "template"
  | "memory";

export type ProgressEvent =
  | { type: "step"; step: StepName; status: "started" | "finished"; ms?: number }
  | {
      type: "evidence";
      evidence: {
        id: string;
        hypothesisId: string;
        title: string;
        rowCount: number;
        zetarisRunId: string;
        sources: EvidenceSource[];
      };
    }
  | { type: "hypothesis"; id: string; name: string; status: string }
  | { type: "llm"; call: LlmCall }
  | {
      type: "memory";
      action: "recall";
      query: string;
      count: number;
      ids: string[];
      route: string;
      ms: number;
    }
  | {
      type: "memory";
      action: "write";
      written: { id: string; hypothesis: string }[];
      skipped: number;
    }
  | {
      type: "chunk";
      id: number;
      kind: string;
      label: string;
      ms: number;
      llmCalls: number;
      inputTokens: number;
      outputTokens: number;
      carryoverTokens: number;
      route: string | null;
    }
  | { type: "reset"; reason: string }
  | { type: "done"; totalMs: number };

export type MeterlessStatus = "online" | "unauthorized" | "offline";

export interface ApiStatus {
  zetaris: { ok: boolean; ms?: number; views: number };
  meterless: { status: MeterlessStatus; baseUrl: string | null };
  fallback: { enabled: boolean };
  lastRoute?: Route | null;
  busy?: boolean;
}

export interface MemoryRecord {
  id: string;
  text: string;
  relevance: number;
  origin: "user" | "agent";
  site?: string;
  learnedAt: string;
  validFrom?: string;
  key?: string;
  confidence: number;
  layer: string;
  provenance?: unknown;
}

/** @deprecated use MemoryRecord — kept for older call sites */
export type MemoryNote = MemoryRecord & { createdAt?: string; source?: string };

export interface LedgerEntry {
  memoryId?: string;
  action: string;
  actor: string;
  timestamp: number;
  previousState?: unknown;
  newState?: unknown;
  details?: unknown;
}

export interface EntityCounts {
  entities: Record<string, number>;
  relationships: number;
  facts: number;
  events?: number;
  audit?: number;
}

export interface EntitiesResponse {
  sites: { id: string; name: string; aliases?: string[] }[];
  counts: EntityCounts;
}

export interface AnswerListItem {
  slug: string;
  question: string;
  generatedAt?: string;
  headline?: string;
  site?: { id: string; name: string }[];
}

export interface AskHandlers {
  onProgress: (event: ProgressEvent) => void;
  onResult: (result: InvestigateOutcome) => void;
  onError: (message: string) => void;
}
