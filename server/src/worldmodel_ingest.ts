// World Model ingest from the Zetaris data layer: sites (with aliases), meters, the contract and the tariff products used in counterfactuals,
// and ops_log events as bitemporal records (an edge valid from event_date, plus a fact). Every write carries provenance {view, zetarisRunId, at}.
// Idempotent: record timestamps come from the data (the event date, the first day of the data), never the wall clock, and an entity whose
// attributes and aliases are already present is not written again, so a second ingest appends no event and the state diff is empty even though
// Zetaris answers with new run ids. Meter kWh, sites, events and the contract are SAMPLE data (FILE: sample).
import { worldLib } from "./engines.ts";
import type { WorldModel } from "../../vendor/meterless/world-model/reference/src/index.ts";
import { EvidenceStore } from "./evidence.ts";
import type { DataLayer, FetchMeta, SiteInfo } from "./data.ts";
import { FLAT_TARIFF } from "./flat_tariff.ts";
import { WINDOW_A } from "./windows.ts";
import { norm, siteAliases } from "./worldmodel_resolve.ts";

export interface IngestSummary {
  runIds: Record<string, string>;                         // view -> Zetaris run id seen by this ingest
  entities: { added: number; updated: number; unchanged: number };
  relationships: { added: number; existing: number };
  facts: { added: number; existing: number };
  eventsAppended: number; changed: boolean;
}
type Entities = Awaited<ReturnType<WorldModel["upsertEntity"]>>;
type Prov = Parameters<WorldModel["upsertEntity"]>[0]["source"];

const iso = (date: string): string => `${date.slice(0, 10)}T00:00:00.000Z`;
export const AS_OF = iso(WINDOW_A.from);                    // "the data as of its first day": observation time of static rows
const SAMPLE = "FILE: sample";
const same = (a: unknown, b: unknown): boolean => worldLib.canonicalJson(a) === worldLib.canonicalJson(b);
const pretty = (alias: string): string => (/^s\d+$/.test(alias) ? alias.toUpperCase() : alias.replace(/\b[a-z]/g, (c) => c.toUpperCase()));
export const siteEntityId = (siteId: string): string => worldLib.externalId("site", "zetaris", siteId);

/** Provenance of a record read from a Zetaris view: {view, zetarisRunId, at}; `runId` is the engine's own field for the same run. */
export const zetarisSource = (view: string, zetarisRunId: string, at: string): Prov => ({ kind: "zetaris", by: `zetaris:${view}`, at, url: `zetaris://kilowhy/${view}`, runId: zetarisRunId, view, zetarisRunId } as Prov);

class Writer {
  entities = { added: 0, updated: 0, unchanged: 0 };
  relationships = { added: 0, existing: 0 };
  facts = { added: 0, existing: 0 };
  readonly model: WorldModel;
  constructor(model: WorldModel) { this.model = model; }

  /** Writes the entity unless its attributes and aliases are already there. Aliases go in first so the canonical name is the last one written. */
  async entity(e: { type: string; system: string; id: string; name: string; aliases?: string[]; attrs: Record<string, unknown> }, source: Prov): Promise<Entities> {
    const key = { system: e.system, id: e.id };
    const id = worldLib.externalId(e.type, e.system, e.id);
    const cur = this.model.view("graph").entity(id);
    const wanted = [...(e.aliases ?? []), e.name];
    if (cur && cur.name === e.name && Object.entries(e.attrs).every(([k, v]) => same(cur.attrs[k], v)) && wanted.every((a) => cur.aliases.includes(a))) { this.entities.unchanged++; return cur; }
    for (const alias of e.aliases ?? []) await this.model.upsertEntity({ type: e.type, externalKey: key, name: alias, attrs: e.attrs, source });
    const out = await this.model.upsertEntity({ type: e.type, externalKey: key, name: e.name, attrs: e.attrs, source });
    this.entities[cur ? "updated" : "added"]++;
    return out;
  }
  async relate(from: string, type: string, to: string, validFrom: string, source: Prov): Promise<void> {
    const before = this.model.events().length;
    await this.model.relate({ from, type, to, validFrom, source });
    this.relationships[this.model.events().length > before ? "added" : "existing"]++;
  }
  async fact(about: string, predicate: string, value: unknown, source: Prov): Promise<void> {
    const before = this.model.events().length;
    await this.model.assertFact({ about, predicate, value, confidence: 1, source });
    this.facts[this.model.events().length > before ? "added" : "existing"]++;
  }
}

async function sitesAndMeters(w: Writer, info: SiteInfo[], runIds: Record<string, string>): Promise<void> {
  for (const s of info) {
    const runId = s.zetarisRunId ?? "n/a";
    runIds.sites = runId;
    const src = zetarisSource("sites", runId, AS_OF);
    const aliases = siteAliases(s, info).map(pretty).filter((a) => norm(a) !== norm(s.name));
    await w.entity({ type: "site", system: "zetaris", id: s.id, name: s.name, aliases, attrs: { siteId: s.id, postcode: s.postcode ?? null, region: s.region ?? null, dataKind: SAMPLE } }, src);
    if (s.mpanLabel) {
      await w.entity({ type: "meter", system: "zetaris", id: s.mpanLabel, name: s.mpanLabel, attrs: { mpanLabel: s.mpanLabel, siteId: s.id, dataKind: SAMPLE } }, src);
      await w.relate(siteEntityId(s.id), "has_meter", worldLib.externalId("meter", "zetaris", s.mpanLabel), AS_OF, src);
    }
  }
}

async function contractAndTariffs(w: Writer, info: SiteInfo[], contract: Awaited<ReturnType<DataLayer["contract"]>>, runIds: Record<string, string>): Promise<void> {
  runIds.contract = contract.evidence.zetarisRunId;
  for (const c of contract.rows.filter((r) => r.src === "contract" && r.productCode).sort((a, b) => a.validFrom.localeCompare(b.validFrom))) {
    const at = iso(c.validFrom), src = zetarisSource("contract", contract.evidence.zetarisRunId, at);
    const tariff = await w.entity({ type: "tariff", system: "zetaris", id: c.productCode!, name: `Octopus ${c.productCode}`, attrs: { productCode: c.productCode, tariffCode: c.tariffCode, role: "actual tariff (Agile)" } }, src);
    const cid = `${c.productCode}@${c.validFrom}`;
    const ce = await w.entity({ type: "contract", system: "zetaris", id: cid, name: `Contract ${cid}`, attrs: { productCode: c.productCode, tariffCode: c.tariffCode, standingPencePerDay: c.standingPencePerDay, vatRate: c.vatRate, validFrom: c.validFrom, dataKind: SAMPLE } }, src);
    await w.relate(ce.id, "uses_tariff", tariff.id, at, src);
    for (const s of info) await w.relate(siteEntityId(s.id), "on_contract", ce.id, at, src);
  }
  const flat = zetarisSource("flat_tariff", "n/a", AS_OF);
  Object.assign(flat, { kind: "file", by: "server/src/flat_tariff.ts", url: FLAT_TARIFF.baseUrl });
  await w.entity({ type: "tariff", system: "octopus", id: FLAT_TARIFF.productCode, name: FLAT_TARIFF.name, attrs: { productCode: FLAT_TARIFF.productCode, tariffCode: FLAT_TARIFF.tariffCode, region: FLAT_TARIFF.region, role: "counterfactual comparison (recommend.ts)" } }, flat);
}

async function events(w: Writer, ops: Awaited<ReturnType<DataLayer["opsLog"]>>, runIds: Record<string, string>): Promise<void> {
  runIds.ops_log = ops.evidence.zetarisRunId;
  for (const e of ops.rows) {
    const at = iso(e.eventDate), src = zetarisSource("ops_log", ops.evidence.zetarisRunId, at);
    const ev = await w.entity({ type: "ops_event", system: "zetaris", id: e.eventId, name: `${e.eventId} ${e.eventDate}`, attrs: { eventId: e.eventId, siteId: e.siteId, eventDate: e.eventDate, description: e.description, dataKind: SAMPLE } }, src);
    await w.relate(ev.id, "occurred_at", siteEntityId(e.siteId), at, src);          // bitemporal edge: valid from the event date
    await w.fact(siteEntityId(e.siteId), `ops_event:${e.eventId}`, { eventId: e.eventId, eventDate: e.eventDate, description: e.description }, src);
  }
}

/** Reads sites, ops_log and contract through the data layer (a throwaway evidence store, so the investigation's E# numbering is untouched) and writes them. */
export async function ingestFromData(model: WorldModel, data: DataLayer): Promise<IngestSummary> {
  const store = new EvidenceStore();
  const meta = (title: string): FetchMeta => ({ store, hypothesisId: "WORLD", title });
  const info: SiteInfo[] = data.siteInfo ? await data.siteInfo() : (await data.siteIds()).map((id) => ({ id, name: id }));
  const [ops, contract] = await Promise.all([info.length ? data.opsLog({ sites: info.map((s) => s.id) }, meta("ops_log events (World Model ingest)")) : null, data.contract(meta("Contract (World Model ingest)"))]);
  const w = new Writer(model);
  const runIds: Record<string, string> = {};
  const eventsBefore = model.events().length, shapeBefore = model.stateShapeCanonical();
  await sitesAndMeters(w, info, runIds);
  await contractAndTariffs(w, info, contract, runIds);
  if (ops) await events(w, ops, runIds);
  return { runIds, entities: w.entities, relationships: w.relationships, facts: w.facts, eventsAppended: model.events().length - eventsBefore, changed: model.stateShapeCanonical() !== shapeBefore };
}
