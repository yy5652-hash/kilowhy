// Site resolution with the World Model engine's bands (pure, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mentionedSites, resolveSite, siteAliases, type SiteRef } from "./worldmodel_resolve.ts";
import { worldLib } from "./engines.ts";

const known: SiteRef[] = [{ id: "S1", name: "Crumb & Co Shoreditch" }, { id: "S2", name: "Crumb & Co Brixton" }, { id: "S3", name: "Crumb & Co Hampstead" }];
const out = (r: ReturnType<typeof resolveSite>) => (r.ok ? r.ids : { ambiguous: r.ambiguous, near: r.near ?? [] });

describe("aliases", () => {
  it("full name, distinctive part, id and 'site N'", () => {
    assert.deepEqual(siteAliases(known[1], known).sort(), ["brixton", "crumb and co brixton", "s2", "site 2"].sort());
  });
  it("a name shared by two sites stays an alias of both, and the longer phrase tells them apart", () => {
    const two: SiteRef[] = [{ id: "S1", name: "Crumb & Co Brixton Hill" }, { id: "S2", name: "Crumb & Co Brixton Market" }];
    assert.deepEqual(out(resolveSite("Brixton", two)), { ambiguous: ["S1", "S2"], near: [] });
    assert.deepEqual(out(resolveSite("Brixton Hill", two)), ["S1"]);
    assert.deepEqual(out(resolveSite("the brixton market bakery", two)), ["S2"]);
  });
});

describe("the engine's resolve bands", () => {
  it("uses the engine's own similarity and thresholds", () => {
    assert.equal(worldLib.decide(worldLib.nameSimilarity("brixton", "brixten")), "auto-merge");   // 0.857
    assert.equal(worldLib.decide(0.85), "auto-merge"); assert.equal(worldLib.decide(0.82), "review"); assert.equal(worldLib.decide(0.8), "new");
  });
  it(">= 0.85 resolves: one wrong letter in a seven-letter name", () => {
    assert.deepEqual(out(resolveSite("Brixten", known)), ["S2"]);
    assert.deepEqual(out(resolveSite("Hampsted", known)), ["S3"]);
  });
  it("[0.82, 0.85) is the review band: a six-letter name with one wrong letter is near, never guessed", () => {
    const cam: SiteRef[] = [{ id: "S1", name: "Crumb & Co Camden" }, { id: "S2", name: "Crumb & Co Brixton" }];
    assert.equal(worldLib.nameSimilarity("camdon", "camden").toFixed(3), "0.833");
    assert.deepEqual(out(resolveSite("Camdon", cam)), { ambiguous: [], near: ["S1"] });
    assert.deepEqual(mentionedSites("why did Camdon spike", cam), [], "a question mention in the review band is not taken as a site");
  });
  it("below 0.82 is unknown", () => {
    assert.deepEqual(out(resolveSite("Peckham", known)), { ambiguous: [], near: [] });
    assert.deepEqual(out(resolveSite("Brix", known)), { ambiguous: [], near: [] });
    assert.deepEqual(out(resolveSite("Crumb", known)), { ambiguous: [], near: [] });
  });
});

describe("exact forms are not fuzzy", () => {
  it("ids, numbers and ALL", () => {
    assert.deepEqual(out(resolveSite("s3", known)), ["S3"]); assert.deepEqual(out(resolveSite("branch no 2", known)), ["S2"]); assert.deepEqual(out(resolveSite("all sites", known)), ["S1", "S2", "S3"]);
    assert.deepEqual(out(resolveSite("site 9", known)), { ambiguous: [], near: [] });
    assert.deepEqual(out(resolveSite("site 10", known)), { ambiguous: [], near: [] }, "one digit away from site 1 is not site 1");
    assert.deepEqual(mentionedSites("why did site 10 spike", known), []);
  });
  it("mentions in a question, in site order", () => {
    assert.deepEqual(mentionedSites("compare Hampstead with S1 please", known), ["S1", "S3"]);
    assert.deepEqual(mentionedSites("Why did our electricity cost more in the last four weeks than the four weeks before?", known), []);
    assert.deepEqual(mentionedSites("why did site 2 and shoreditch spike", known), ["S1", "S2"]);
  });
});
