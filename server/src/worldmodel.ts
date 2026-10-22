// World Model (Meterless engine, vendor/meterless/world-model): the grounded entities of the business, read from Zetaris. Used by the agent for
// site resolution (aliases + the engine's resolve bands, worldmodel_resolve.ts) and for the ops_log events in a window (factsFor, evidence context of H4/H5/H11).
// Entities: site (aliases from sites.name), meter, contract, tariff (the actual Agile product and the flat counterfactual), ops_event.
// Meter kWh are SAMPLE data; sites, events and the contract come from sample files too (dataKind "FILE: sample").
import { worldLib } from "./engines.ts";
import type { WorldModel } from "../../vendor/meterless/world-model/reference/src/index.ts";
import type { DataLayer } from "./data.ts";
import type { DateWindow } from "./windows.ts";
import { ingestFromData, siteEntityId, type IngestSummary } from "./worldmodel_ingest.ts";
import { mentionedSites, resolveSite, type Resolution, type SiteRef } from "./worldmodel_resolve.ts";

export type { IngestSummary, SiteRef, Resolution };
export { zetarisSource, AS_OF } from "./worldmodel_ingest.ts";

export interface WorldSource { view: string; zetarisRunId: string; at: string }
export interface WorldEventFact { eventId: string; siteId: string; eventDate: string; description: string; validFrom: string; source: WorldSource }
export interface WorldCounts { entities: Record<string, number>; relationships: number; facts: number; events: number; audit: number }
export interface WorldOpts { storage?: "memory" | "local"; directory?: string; namespace?: string }

export class KilowhyWorld {
  readonly model: WorldModel;
  private constructor(model: WorldModel) { this.model = model; }

  /** In memory by default; `storage: "local"` keeps the event log under <directory>/.world/<namespace>.json and replays it on the next start. */
  static create(opts: WorldOpts = {}): KilowhyWorld {
    return new KilowhyWorld(new worldLib.WorldModel({ namespace: opts.namespace ?? "kilowhy", storage: opts.storage ?? "memory", directory: opts.directory }));
  }

  /** Idempotent: ingesting the same data again appends nothing. */
  ingest(data: DataLayer): Promise<IngestSummary> { return ingestFromData(this.model, data); }

  /** The sites the world knows, with the aliases they answer to. */
  sites(): SiteRef[] {
    return this.model.view("graph").query({ type: "site" })
      .map((e) => ({ id: String(e.attrs.siteId), name: e.name ?? String(e.attrs.siteId), aliases: e.aliases }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  resolveSite(text: string): Resolution { return resolveSite(text, this.sites()); }
  mentionedSites(question: string): string[] { return mentionedSites(question, this.sites()); }

  /** ops_log events of a site whose date falls in [window.from, window.toExclusive), oldest first, with their provenance. */
  factsFor(siteId: string, window: Pick<DateWindow, "from" | "toExclusive">): WorldEventFact[] {
    return this.model.view("graph").incoming(siteEntityId(siteId), { via: "occurred_at" })
      .filter((e) => String(e.attrs.eventDate) >= window.from && String(e.attrs.eventDate) < window.toExclusive)
      .map((e) => ({
        eventId: String(e.attrs.eventId), siteId, eventDate: String(e.attrs.eventDate), description: String(e.attrs.description), validFrom: `${String(e.attrs.eventDate)}T00:00:00.000Z`,
        source: { view: String((e.source as { view?: string }).view), zetarisRunId: String((e.source as { zetarisRunId?: string }).zetarisRunId), at: e.source.at },
      }))
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.eventId.localeCompare(b.eventId));
  }

  counts(): WorldCounts {
    const shape = this.model.stateShape() as { entities: { type: string }[]; relationships: unknown[]; facts: unknown[] };
    const entities: Record<string, number> = {};
    for (const e of shape.entities) entities[e.type] = (entities[e.type] ?? 0) + 1;
    return { entities, relationships: shape.relationships.length, facts: shape.facts.length, events: this.model.events().length, audit: this.model.audit().length };
  }
  /** Canonical JSON of the whole derived state: two equal strings mean an empty diff. */
  shape(): string { return this.model.stateShapeCanonical(); }
}
