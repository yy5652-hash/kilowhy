// World Model tests: ingest from the synthetic data layer, provenance, idempotent re-ingest, events in a window, persistence. No network, no Zetaris.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KilowhyWorld, AS_OF } from "./worldmodel.ts";
import { scenario, SITE_NAMES } from "./agent_testkit.ts";
import { synth } from "./hypotheses/testkit.ts";
import type { DataLayer } from "./data.ts";
import type { OpsEvent } from "./data.ts";

const EVENTS: OpsEvent[] = [
  { eventId: "E1", siteId: "S2", eventDate: "2026-10-07", description: "SAMPLE: Oven schedule moved 2h later from this date (new sourdough line)." },
  { eventId: "E2", siteId: "S3", eventDate: "2026-09-20", description: "SAMPLE: One-off freezer fault." },
  { eventId: "E3", siteId: "S2", eventDate: "2026-09-01", description: "SAMPLE: New fridge installed." },
];
const data = (): DataLayer => synth({ sites: ["S1", "S2", "S3"], siteNames: SITE_NAMES, ops: EVENTS }).data;
/** The same data, but every query comes back with a new Zetaris run id (as a real second ingest does). */
const withNewRunIds = (d: DataLayer, tag: string): DataLayer => ({
  ...d,
  async opsLog(q, m) { const f = await d.opsLog(q, m); return { ...f, evidence: { ...f.evidence, zetarisRunId: `run-${tag}-ops` } }; },
  async contract(m) { const f = await d.contract(m); return { ...f, evidence: { ...f.evidence, zetarisRunId: `run-${tag}-contract` } }; },
  async siteInfo() { return (await d.siteInfo!()).map((s) => ({ ...s, zetarisRunId: `run-${tag}-sites` })); },
});

describe("ingest", () => {
  it("creates sites with aliases, the contract, both tariffs and the events as entities, edges and facts", async () => {
    const w = KilowhyWorld.create();
    const s = await w.ingest(data());
    assert.deepEqual(w.counts().entities, { site: 3, contract: 1, tariff: 2, ops_event: 3 });
    assert.equal(w.counts().relationships, 3 + 1 + 3, "on_contract x3, uses_tariff x1, occurred_at x3");
    assert.equal(w.counts().facts, 3);
    assert.equal(s.entities.added, 9); assert.equal(s.changed, true);
    assert.deepEqual(w.sites().map((x) => x.id), ["S1", "S2", "S3"]);
    assert.deepEqual(w.sites()[1].aliases, ["Brixton", "S2", "Site 2", SITE_NAMES.S2]);
    assert.equal(w.sites()[1].name, SITE_NAMES.S2, "the canonical name is the last one written");
  });
  it("meters come from the sites view (mpan label) and hang off their site", async () => {
    const base = data();
    const w = KilowhyWorld.create();
    await w.ingest({ ...base, async siteInfo() { return (await base.siteInfo!()).map((s) => ({ ...s, postcode: "SW9 8PR", region: "London", mpanLabel: `SAMPLE-MPAN-${s.id}`, zetarisRunId: "run-sites" })); } });
    assert.equal(w.counts().entities.meter, 3);
    const meter = w.model.view("graph").entity("meter:zetaris:SAMPLE-MPAN-S2")!;
    assert.deepEqual(meter.attrs, { mpanLabel: "SAMPLE-MPAN-S2", siteId: "S2", dataKind: "FILE: sample" });
    assert.deepEqual(w.model.view("graph").neighborsOf("site:zetaris:S2", { via: "has_meter" }).map((e) => e.id), ["meter:zetaris:SAMPLE-MPAN-S2"]);
    assert.equal(w.model.view("graph").entity("site:zetaris:S2")!.attrs.postcode, "SW9 8PR");
  });
  it("every record carries provenance {view, zetarisRunId, at}; event times come from the data, never the clock", async () => {
    const w = KilowhyWorld.create();
    await w.ingest(withNewRunIds(data(), "a"));
    const g = w.model.view("graph");
    const site = g.entity("site:zetaris:S2")!, ev = g.entity("ops_event:zetaris:E1")!, tariff = g.entity("tariff:octopus:BUS-VAR-AUG25")!;
    assert.deepEqual({ view: (site.source as any).view, run: (site.source as any).zetarisRunId, at: site.source.at }, { view: "sites", run: "run-a-sites", at: AS_OF });
    assert.deepEqual({ view: (ev.source as any).view, run: (ev.source as any).zetarisRunId, at: ev.source.at }, { view: "ops_log", run: "run-a-ops", at: "2026-10-07T00:00:00.000Z" });
    assert.equal(ev.createdAt, "2026-10-07T00:00:00.000Z");
    assert.equal(tariff.source.kind, "file"); assert.match(tariff.source.url ?? "", /BUS-VAR-AUG25/);
    const fact = w.model.view("facts").about("site:zetaris:S2").find((f) => f.predicate === "ops_event:E1")!;
    assert.equal(fact.assertedAt, "2026-10-07T00:00:00.000Z"); assert.equal(fact.confidence, 1); assert.equal((fact.source as any).zetarisRunId, "run-a-ops");
    const edge = [...(w.model.stateShape() as any).relationships].find((r: any) => r.type === "occurred_at" && r.from === ev.id);
    assert.equal(edge.validFrom, "2026-10-07T00:00:00.000Z"); assert.equal(edge.to, "site:zetaris:S2");
  });
});

describe("idempotent re-ingest", () => {
  it("a second ingest with new Zetaris run ids appends no event and the state diff is empty", async () => {
    const w = KilowhyWorld.create();
    await w.ingest(withNewRunIds(data(), "a"));
    const before = w.shape(), log = w.counts().events;
    const s = await w.ingest(withNewRunIds(data(), "b"));
    assert.equal(w.shape(), before); assert.equal(w.counts().events, log);
    assert.deepEqual(s, { runIds: { sites: "run-b-sites", contract: "run-b-contract", ops_log: "run-b-ops" }, entities: { added: 0, updated: 0, unchanged: 9 }, relationships: { added: 0, existing: 7 }, facts: { added: 0, existing: 3 }, eventsAppended: 0, changed: false });
  });
  it("a changed row is detected: the entity is updated and the diff is not empty", async () => {
    const w = KilowhyWorld.create();
    await w.ingest(data());
    const before = w.shape();
    const edited = synth({ sites: ["S1", "S2", "S3"], siteNames: SITE_NAMES, ops: [{ ...EVENTS[0], description: "SAMPLE: Oven schedule moved 3h later." }, EVENTS[1], EVENTS[2]] }).data;
    const s = await w.ingest(edited);
    assert.equal(s.entities.updated, 1); assert.equal(s.changed, true); assert.notEqual(w.shape(), before);
    assert.equal(w.model.view("graph").entity("ops_event:zetaris:E1")!.attrs.description, "SAMPLE: Oven schedule moved 3h later.");
  });
  it("a new event is added and nothing else changes", async () => {
    const w = KilowhyWorld.create();
    await w.ingest(data());
    const s = await w.ingest(synth({ sites: ["S1", "S2", "S3"], siteNames: SITE_NAMES, ops: [...EVENTS, { eventId: "E4", siteId: "S1", eventDate: "2026-10-03", description: "SAMPLE: Extra Saturday opening hours." }] }).data);
    assert.deepEqual([s.entities.added, s.entities.unchanged, s.relationships.added, s.facts.added], [1, 9, 1, 1]);
  });
  it("a world kept on disk is picked up by a new process and an ingest still appends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kilowhy-world-"));
    try {
      const a = KilowhyWorld.create({ storage: "local", directory: dir });
      await a.ingest(data());
      const b = KilowhyWorld.create({ storage: "local", directory: dir });
      assert.deepEqual(b.counts(), a.counts(), "the event log replays to the same entities, relationships and facts");
      const s = await b.ingest(withNewRunIds(data(), "c"));
      assert.equal(s.eventsAppended, 0); assert.deepEqual(b.counts(), a.counts());
      assert.deepEqual(b.sites(), a.sites());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("factsFor and resolution", () => {
  it("returns the events of a site inside a window, oldest first, with provenance", async () => {
    const w = KilowhyWorld.create();
    await w.ingest(withNewRunIds(data(), "a"));
    const all = w.factsFor("S2", { from: "2026-08-27", toExclusive: "2026-10-22" });
    assert.deepEqual(all.map((e) => e.eventId), ["E3", "E1"]);
    assert.deepEqual(all[1].source, { view: "ops_log", zetarisRunId: "run-a-ops", at: "2026-10-07T00:00:00.000Z" });
    assert.equal(all[1].validFrom, "2026-10-07T00:00:00.000Z");
    assert.deepEqual(w.factsFor("S2", { from: "2026-09-24", toExclusive: "2026-10-22" }).map((e) => e.eventId), ["E1"]);
    assert.deepEqual(w.factsFor("S2", { from: "2026-10-08", toExclusive: "2026-10-22" }), []);
    assert.deepEqual(w.factsFor("S2", { from: "2026-10-07", toExclusive: "2026-10-08" }).map((e) => e.eventId), ["E1"], "from is inclusive, toExclusive is not");
    assert.deepEqual(w.factsFor("S9", { from: "2026-08-27", toExclusive: "2026-10-22" }), []);
  });
  it("resolveSite and mentionedSites work from the ingested aliases; unknown stays unknown", async () => {
    const w = KilowhyWorld.create();
    await w.ingest(data());
    assert.deepEqual(w.resolveSite("Brixton"), { ok: true, ids: ["S2"] });
    assert.deepEqual(w.resolveSite("Peckham"), { ok: false, ambiguous: [] });
    assert.deepEqual(w.mentionedSites("Why did Brixton and Hampstead use more?"), ["S2", "S3"]);
  });
});
