// The agent resolves sites through the World Model and uses its events as evidence context. Scripted LLM, synthetic data: no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { investigate } from "./agent.ts";
import { isClarification, type InvestigationResult } from "./agent_types.ts";
import { scenario, fakeChat, INTENT_OK, PLAN_OK, goodNarrative } from "./agent_testkit.ts";
import { KilowhyWorld } from "./worldmodel.ts";

const ok = (o: Awaited<ReturnType<typeof investigate>>): InvestigationResult => { assert.ok(!isClarification(o)); return o as InvestigationResult; };
const chat = () => fakeChat({ intent: [INTENT_OK({ sites: ["Brixton"] })], plan: [PLAN_OK()], narrative: [goodNarrative] });

describe("investigate uses the World Model", () => {
  it("ingests the data layer into the world it is given, and resolves Brixton through the world's aliases", async () => {
    const world = KilowhyWorld.create();
    const o = ok(await investigate("Why did Brixton use more electricity?", { engine: "plain", data: scenario().data, chat: chat(), world }));
    assert.equal(o.scope.label, "S2");
    assert.deepEqual(world.counts().entities.site, 3); assert.equal(world.counts().entities.ops_event, 1);
    assert.deepEqual(world.sites()[1].aliases?.slice(0, 1), ["Brixton"]);
  });
  it("a second question on the same world appends nothing to it", async () => {
    const world = KilowhyWorld.create();
    const d = scenario().data;
    await investigate("Why did Brixton use more electricity?", { engine: "plain", data: d, chat: chat(), world });
    const log = world.counts().events;
    await investigate("Why did Brixton use more electricity?", { engine: "plain", data: d, chat: chat(), world });
    assert.equal(world.counts().events, log);
  });
  it("the ops_log evidence of H4, H5 and H11 carries the World Model's event count, equal to the Zetaris count", async () => {
    const o = ok(await investigate("Why did our electricity cost more in the last four weeks?", { engine: "plain", data: scenario().data, chat: chat() }));
    const opsEvidence = o.evidence.filter((e) => /ops_log events/.test(e.title) && ["H4", "H5", "H11"].includes(e.hypothesisId));
    assert.deepEqual(opsEvidence.map((e) => e.hypothesisId).sort(), ["H11", "H4", "H5"]);
    for (const e of opsEvidence) {
      assert.equal(e.metrics.world_model_events_in_windows.value, 1, e.hypothesisId);
      if (e.metrics.events_in_scope) assert.equal(e.metrics.world_model_events_in_windows.value, e.metrics.events_in_scope.value, `${e.hypothesisId}: world model and Zetaris agree`);
    }
  });
  it("a name in the engine's review band is a clarification that names the near site", async () => {
    const sites = scenario({ siteNames: { S1: "Crumb & Co Camden", S2: "Crumb & Co Brixton", S3: "Crumb & Co Hampstead" } }).data;
    const o = await investigate("Why did Camdon use more electricity?", { engine: "plain", data: sites, chat: fakeChat({ intent: [INTENT_OK({ sites: ["Camdon"] })], plan: [PLAN_OK()], narrative: [goodNarrative] }) });
    assert.ok(isClarification(o));
    if (isClarification(o)) assert.match(o.clarification, /"Camdon" is close to S1 \(Crumb & Co Camden\), but not close enough/);
  });
});
