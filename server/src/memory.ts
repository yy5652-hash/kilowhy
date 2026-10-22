// H-MEM (Meterless engine, vendor/meterless/hmem): the investigation memory. Notes the owner tells us ("Brixton moved its oven schedule...") and causes the agent
// confirmed are stored with provenance, recalled by hybrid ranking at the start of the next investigation, and every change or read lands in the append-only trust ledger.
// Store: data/cache/hmem/ (the engine's state.json + ledger.jsonl, plus vectors.json with the embeddings). Embedder: provider.embed (labelled route), injectable.
// The engine's services are used as they are (MemoryStoreService, MemoryMiningService, MemoryRetrievalService, TrustLedgerService); the one seam is ProviderRetrieval.score:
// the reference scores the semantic term with its module-level hash embedder, so here the provider's vectors are swapped in for that one term (same formula, same weights).
import { hmemLib } from "./engines.ts";
import type { LedgerEntry, MemoryRecord, QueryResult, FeedbackKind } from "../../vendor/meterless/hmem/reference/src/index.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface EmbedRoute { provider: string; requestedModel: string; routedModel: string | null; latencyMs: number; fallbackReason?: string }
export type EmbedFn = (texts: string[], opts: { inputType: "passage" | "query" }) => Promise<{ vectors: number[][]; route: EmbedRoute }>;
export interface MemoryOpts { dir?: string; embed?: EmbedFn | null; clock?: () => number; recall?: Partial<typeof RECALL_DEFAULTS> }
export type MemoryOrigin = "user" | "agent";
export interface RememberOpts {
  source: MemoryOrigin; site?: string; validFrom?: string;       // validFrom: the day the remembered thing started to hold (YYYY-MM-DD), kept as a tag
  evidence?: string[]; zetarisRunIds?: string[]; receiptIds?: string[];   // provenance of an agent memory
  confidence?: number; label?: string; key?: string; layer?: "working" | "long_term";
}
export interface RecalledMemory { id: string; text: string; relevance: number; origin: MemoryOrigin; site?: string; learnedAt: string; validFrom?: string; confidence: number; layer: string; provenance: MemoryRecord["provenance"] }
export interface Recall { query: string; site?: string; memories: RecalledMemory[]; context: string; trace: QueryResult["trace"]; embed: { route: string; ms: number; fallback?: string } }

export const USER_CONFIDENCE = 0.9, AGENT_CONFIDENCE = 0.7;   // what the owner says outranks what the agent concluded (AGENTS.md section 10.2: user_correction = high reliability)
export const RECALL_DEFAULTS = { k: 5, threshold: 0.28 };      // the engine's 0.35 is for chat-sized memories; recall here is already limited to one site's notes, so a little more reach is safe. Measured with Nemotron embed 1B: the note on its own site's question scores 0.34, unrelated questions 0.21-0.23.

const Retrieval = hmemLib.MemoryRetrievalService;
/** The reference class with the provider's vectors for the semantic term. Overrides the reference's score(), which is `private` in TypeScript only. */
class ProviderRetrieval extends Retrieval {
  queryVector: number[] | null = null;
  vectors = new Map<string, number[]>();
  // @ts-ignore private in the reference class; this is the seam for a real embedder
  score(m: MemoryRecord, queryEmbedding: number[], ...rest: unknown[]): number {
    const v = this.vectors.get(m.id);
    // @ts-ignore see above
    return super.score(this.queryVector && v ? { ...m, embedding: v } : m, this.queryVector && v ? this.queryVector : queryEmbedding, ...rest);
  }
}

const stamp = (ms: number): string => new Date(ms).toISOString();
const siteOf = (m: MemoryRecord): string | undefined => m.chatId;
const originOf = (m: MemoryRecord): MemoryOrigin => (m.source.startsWith("user") ? "user" : "agent");
const validFromOf = (m: MemoryRecord): string | undefined => m.tags.find((t) => t.startsWith("valid_from:"))?.slice(11);

export class KilowhyMemory {
  readonly dir: string | null;
  readonly store: InstanceType<typeof hmemLib.MemoryStoreService>;
  readonly ledger: InstanceType<typeof hmemLib.TrustLedgerService>;
  readonly mining: InstanceType<typeof hmemLib.MemoryMiningService>;
  private retrieval: ProviderRetrieval;
  private embedFn: EmbedFn | null;
  private clock: () => number;
  private defaults: typeof RECALL_DEFAULTS;
  private vectors = new Map<string, { model: string; v: number[] }>();
  private pendingNote = "";

  private constructor(o: MemoryOpts) {
    this.dir = o.dir ?? null;
    this.embedFn = o.embed ?? null;
    this.clock = o.clock ?? Date.now;
    this.defaults = { ...RECALL_DEFAULTS, ...o.recall };
    if (this.dir) mkdirSync(this.dir, { recursive: true });
    this.ledger = new hmemLib.TrustLedgerService(this.clock, this.dir ?? undefined);
    this.store = new hmemLib.MemoryStoreService(this.clock, this.ledger, "kilowhy-agent", this.dir ?? undefined);
    // An explicit note is its own extraction: the miner hook returns the owner's words unchanged (the model-free default would drop a sentence without a signal word).
    this.mining = new hmemLib.MemoryMiningService(this.store, this.clock, async () => JSON.stringify([this.pendingNote]));
    this.retrieval = new ProviderRetrieval(this.store, this.ledger, this.clock, "kilowhy-agent");
    const file = this.dir ? join(this.dir, "vectors.json") : null;
    if (file && existsSync(file)) for (const [id, e] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, { model: string; v: number[] }>)) this.vectors.set(id, e);
  }
  static create(o: MemoryOpts = {}): KilowhyMemory { return new KilowhyMemory(o); }

  /** Runs `fn` with the engine services acting as `actor`, so the ledger says who did it ("user" for notes and feedback, "kilowhy-agent" for the agent). Sequential use only. */
  private async as<T>(actor: string, fn: () => T | Promise<T>): Promise<T> {
    const parts = [this.store, this.retrieval] as unknown as { actor: string }[];
    const prev = parts.map((p) => p.actor);
    parts.forEach((p) => { p.actor = actor; });
    try { return await fn(); } finally { parts.forEach((p, i) => { p.actor = prev[i]; }); }
  }
  private asSync<T>(actor: string, fn: () => T): T {
    const parts = [this.store, this.retrieval] as unknown as { actor: string }[];
    const prev = parts.map((p) => p.actor);
    parts.forEach((p) => { p.actor = actor; });
    try { return fn(); } finally { parts.forEach((p, i) => { p.actor = prev[i]; }); }
  }
  private saveVectors(): void {
    if (this.dir) writeFileSync(join(this.dir, "vectors.json"), JSON.stringify(Object.fromEntries(this.vectors)) + "\n", "utf8");
  }
  private async embedPassages(records: MemoryRecord[]): Promise<void> {
    if (!this.embedFn || records.length === 0) return;
    const r = await this.embedFn(records.map((m) => m.content), { inputType: "passage" });
    records.forEach((m, i) => this.vectors.set(m.id, { model: r.route.routedModel ?? r.route.requestedModel, v: r.vectors[i] }));
    this.saveVectors();
  }

  /** Stores a memory. A user note goes through the engine's MemoryMiningService (event user_correction) and is then tagged with its site, validity day and provenance in one ledger "update"; an agent memory is added directly with its full provenance. */
  async remember(text: string, o: RememberOpts): Promise<MemoryRecord> {
    const content = text.replace(/\s+/g, " ").trim();
    if (content.length < 5) throw new Error("a memory needs some text");
    const refs = [...(o.evidence ?? []).map((e) => `evidence:${e}`), ...(o.zetarisRunIds ?? []).map((r) => `zetaris-run:${r}`), ...(o.receiptIds ?? []).map((r) => `nightshift-receipt:${r}`)];
    const tags = ["kilowhy", ...(o.site ? [`site:${o.site}`] : []), ...(o.validFrom ? [`valid_from:${o.validFrom}`] : []), ...(o.key ? [`key:${o.key}`] : [])];
    const now = this.clock();
    let rec: MemoryRecord;
    if (o.source === "user") {
      this.pendingNote = content;
      const [mined] = await this.as("user", () => this.mining.mineInteraction("user_correction", content, { chatId: o.site, layer: o.layer ?? "long_term" }));
      if (!mined) throw new Error("the note was not stored");
      // The miner files a user correction as a "preference" (domain "personal"); a note about how a site operates is a fact about the business.
      const allTags = [...mined.tags, ...tags], domain = this.store.classifyDomain(content, allTags, "factual");
      rec = this.asSync("user", () => this.store.update(mined.id, {
        type: "factual", domain, namespace: `${domain}/facts`, tags: allTags, confidence: o.confidence ?? USER_CONFIDENCE, source: "user:note",
        provenance: { origin: "user_correction", learnedAt: now, label: o.label ?? `note from the owner${o.site ? ` about ${o.site}` : ""}`, refs },
      }));
    } else {
      rec = this.asSync("kilowhy-agent", () => this.store.add({
        content, type: "factual", layer: o.layer ?? "working", tags, confidence: o.confidence ?? AGENT_CONFIDENCE, source: "agent:kilowhy-investigation", chatId: o.site,
        provenance: { origin: "plan_completion", learnedAt: now, label: o.label ?? "cause confirmed by a Kilowhy investigation", refs },
      }));
    }
    await this.embedPassages([rec]).catch(() => {});      // a failed embedding is backfilled at the next recall
    return rec;
  }

  /** Hybrid-ranked recall (the engine's formula; semantic term from provider vectors). Never throws on an embedding failure: the engine's own hash embedder takes over and the result says so. */
  async recall(query: string, o: { site?: string; k?: number; threshold?: number } = {}): Promise<Recall> {
    const t0 = performance.now();
    let route = this.embedFn ? "none (nothing remembered yet)" : "hash (no embedder configured)", fallback: string | undefined, qv: number[] | null = null;
    if (this.embedFn && this.store.all().length) {
      try {
        const q = await this.embedFn([query], { inputType: "query" });
        const model = q.route.routedModel ?? q.route.requestedModel;
        await this.embedPassages(this.store.all().filter((m) => this.vectors.get(m.id)?.model !== model));
        qv = q.vectors[0];
        route = `${q.route.provider}: ${model}${q.route.fallbackReason ? " (labelled fallback route)" : ""}`;
        this.retrieval.vectors = new Map([...this.vectors].filter(([, e]) => e.model === model).map(([id, e]) => [id, e.v]));
      } catch (e) { fallback = e instanceof Error ? e.message : String(e); route = "hash (provider.embed unavailable)"; }
    }
    this.retrieval.queryVector = qv;
    const res = this.asSync("kilowhy-agent", () => this.retrieval.query(query, { topN: o.k ?? this.defaults.k, threshold: o.threshold ?? this.defaults.threshold, chatId: o.site }));
    this.retrieval.queryVector = null;
    return {
      query, site: o.site, context: res.context, trace: res.trace, embed: { route, ms: Math.round(performance.now() - t0), ...(fallback ? { fallback } : {}) },
      memories: res.memories.map(({ memory: m, relevance }) => ({ ...describeMemory(m), relevance })),
    };
  }

  /** The trust-ledger history of one memory: creation, every update, every recall that returned it, every piece of feedback. */
  audit(id: string): LedgerEntry[] { return this.ledger.history(id); }
  feedback(id: string, kind: FeedbackKind, actor = "user"): void { this.asSync(actor, () => this.retrieval.feedback(id, kind)); }
  get(id: string): MemoryRecord | undefined { return this.store.get(id); }
  /** All memories (optionally one site's, plus those without a site), newest first. */
  list(o: { site?: string } = {}): RecalledMemory[] {
    return this.store.all().filter((m) => !o.site || !siteOf(m) || siteOf(m) === o.site).map((m) => ({ ...describeMemory(m), relevance: 0 })).sort((a, b) => b.learnedAt.localeCompare(a.learnedAt) || b.id.localeCompare(a.id));
  }
  findByKey(key: string): MemoryRecord | undefined { return this.store.all().find((m) => m.tags.includes(`key:${key}`)); }
}

export function describeMemory(m: MemoryRecord): Omit<RecalledMemory, "relevance"> {
  return { id: m.id, text: m.content, origin: originOf(m), site: siteOf(m), learnedAt: stamp(m.provenance.learnedAt), validFrom: validFromOf(m), confidence: m.confidence, layer: m.layer, provenance: m.provenance };
}
