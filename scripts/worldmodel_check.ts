// World Model check: ingests the Kilowhy data from Zetaris twice and asserts that the second ingest changes nothing (empty diff), then prints
// the entity / relationship / fact counts and some resolutions. Each ingest uses a fresh data layer, so Zetaris answers with new run ids.
// Usage: node scripts/worldmodel_check.ts [--mutate] [--local]
//   --mutate  second ingest sees one edited ops_log row: the diff must be NON-empty (proves the check can fail)
//   --local   keep the world on disk (data/cache/worldmodel/.world/kilowhy.json): a later process starts from it and also appends nothing
// SAMPLE data: sites, meters, events and the contract come from sample files.
import { zsql } from "./zetaris_client.ts";
import { createZetarisData, type DataLayer } from "../server/src/data.ts";
import { KilowhyWorld } from "../server/src/worldmodel.ts";
import { WINDOW_A, WINDOW_B } from "../server/src/windows.ts";

const mutate = process.argv.includes("--mutate"), local = process.argv.includes("--local");
const world = KilowhyWorld.create(local ? { storage: "local", directory: new URL("../data/cache/worldmodel", import.meta.url).pathname } : {});
const show = (label: string, s: Awaited<ReturnType<KilowhyWorld["ingest"]>>) =>
  console.log(`${label}: entities +${s.entities.added} ~${s.entities.updated} =${s.entities.unchanged}, relationships +${s.relationships.added} =${s.relationships.existing}, facts +${s.facts.added} =${s.facts.existing}, events appended ${s.eventsAppended}, changed ${s.changed}; Zetaris runs ${Object.entries(s.runIds).map(([v, r]) => `${v}:${r.slice(0, 8)}`).join(" ")}`);

const first = await world.ingest(createZetarisData(zsql));
show("ingest 1", first);
const shape1 = world.shape();
const data2: DataLayer = createZetarisData(zsql);
if (mutate) { const real = data2.opsLog.bind(data2); data2.opsLog = async (q, meta) => { const f = await real(q, meta); if (f.rows[0]) f.rows[0] = { ...f.rows[0], description: `${f.rows[0].description} (edited)` }; return f; }; }
const second = await world.ingest(data2);
show("ingest 2", second);
const diffEmpty = world.shape() === shape1;
console.log(`diff after re-ingest: ${diffEmpty ? "empty" : "NON-EMPTY"}`);

const c = world.counts();
console.log(`world: ${Object.entries(c.entities).map(([t, n]) => `${n} ${t}`).join(", ")}; ${c.relationships} relationships; ${c.facts} facts; ${c.events} events in the log; ${c.audit} audit entries`);
for (const s of world.sites()) console.log(`  ${s.id} ${s.name}: aliases ${s.aliases?.join(" | ")}`);
for (const t of ["Brixton", "Shoreditch", "site 3", "Brixtn", "Peckham"]) {
  const r = world.resolveSite(t);
  console.log(`  resolveSite(${JSON.stringify(t)}) -> ${r.ok ? r.ids.join(",") : `unresolved${r.near?.length ? ` (close to ${r.near.join(",")})` : ""}`}`);
}
for (const s of world.sites()) for (const e of world.factsFor(s.id, { from: WINDOW_A.from, toExclusive: WINDOW_B.toExclusive })) console.log(`  event ${e.eventId} at ${e.siteId} on ${e.eventDate} (view ${e.source.view}, Zetaris run ${e.source.zetarisRunId.slice(0, 8)}): ${e.description}`);
const ok = mutate ? !diffEmpty : diffEmpty && second.eventsAppended === 0;
console.log(ok ? (mutate ? "OK: the mutation was detected" : "OK: idempotent") : "FAIL");
process.exit(ok ? 0 : 1);
