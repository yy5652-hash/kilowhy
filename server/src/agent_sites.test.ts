// Entity resolution, fallback intent and slug tests (pure).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSite, mentionedSites, unknownNumberedSites, appearsIn, fallbackIntentType, datesIn, slugify, isAllRequest, type SiteRef } from "./agent_sites.ts";

const known: SiteRef[] = [{ id: "S1", name: "Crumb & Co Shoreditch" }, { id: "S2", name: "Crumb & Co Brixton" }, { id: "S3", name: "Crumb & Co Hampstead" }];
const ids = (r: ReturnType<typeof resolveSite>) => (r.ok ? r.ids : `unresolved:${r.ambiguous.join(",")}`);

describe("resolveSite", () => {
  it("by id, case-insensitively", () => { assert.deepEqual(ids(resolveSite("S2", known)), ["S2"]); assert.deepEqual(ids(resolveSite("s3", known)), ["S3"]); });
  it("by number in several spellings", () => {
    for (const t of ["site 2", "Site 2", "2", "shop 2", "branch no 2", "bakery #2", "site number 2"]) assert.deepEqual(ids(resolveSite(t, known)), ["S2"], t);
  });
  it("by name, by the distinctive word, and with a one-letter misspelling", () => {
    assert.deepEqual(ids(resolveSite("Brixton", known)), ["S2"]);
    assert.deepEqual(ids(resolveSite("the Brixton bakery", known)), ["S2"]);
    assert.deepEqual(ids(resolveSite("Crumb & Co Hampstead", known)), ["S3"]);
    assert.deepEqual(ids(resolveSite("brixten", known)), ["S2"]);
    assert.deepEqual(ids(resolveSite("Shoreditch", known)), ["S1"]);
  });
  it("ALL phrases give every site", () => {
    for (const t of ["ALL", "all sites", "all", "the whole business", "every site", "all bakeries", "everything"]) assert.deepEqual(ids(resolveSite(t, known)), ["S1", "S2", "S3"], t);
    assert.ok(isAllRequest("All sites") && !isAllRequest("Brixton"));
  });
  it("unknown sites are not guessed", () => {
    assert.deepEqual(ids(resolveSite("Peckham", known)), "unresolved:");
    assert.deepEqual(ids(resolveSite("site 9", known)), "unresolved:");
    assert.deepEqual(ids(resolveSite("", known)), "unresolved:");
    assert.deepEqual(ids(resolveSite("Crumb", known)), "unresolved:"); // only a shared word: no single site
  });
  it("a name word shared by two sites is ambiguous", () => {
    const two: SiteRef[] = [{ id: "S1", name: "Crumb & Co Brixton Hill" }, { id: "S2", name: "Crumb & Co Brixton Market" }];
    assert.deepEqual(ids(resolveSite("Brixton", two)), "unresolved:S1,S2");
  });
});

describe("mentionedSites / appearsIn", () => {
  it("finds sites named in a question", () => {
    assert.deepEqual(mentionedSites("Why did Brixton use more electricity?", known), ["S2"]);
    assert.deepEqual(mentionedSites("Why did site 3 spike?", known), ["S3"]);
    assert.deepEqual(mentionedSites("compare S1 and Hampstead", known), ["S1", "S3"]);
    assert.deepEqual(mentionedSites("Why did our electricity cost more in the last four weeks than the four weeks before?", known), []);
  });
  it("appearsIn: whole words only", () => {
    assert.ok(appearsIn("Peckham", "Why did Peckham use more electricity?"));
    assert.ok(!appearsIn("S9", "Why did our bill rise?"));
    assert.ok(!appearsIn("Peck", "Why did Peckham use more?"));
    assert.ok(!appearsIn("", "anything"));
  });
});

describe("unknownNumberedSites", () => {
  it("flags numbered sites that do not exist, and only those", () => {
    assert.deepEqual(unknownNumberedSites("Why did site 9 spike?", known), ["site 9"]);
    assert.deepEqual(unknownNumberedSites("compare shop no 2 with branch 7", known), ["branch 7"]);
    assert.deepEqual(unknownNumberedSites("Why did site 2 spike?", known), []);
    assert.deepEqual(unknownNumberedSites("Why did our bill rise in the last 4 weeks?", known), []);
  });
});

describe("fallback intent and dates", () => {
  it("keyword rules", () => {
    assert.equal(fallbackIntentType("Why were our emissions higher?"), "why_emissions");
    assert.equal(fallbackIntentType("what is our carbon footprint doing"), "why_emissions");
    assert.equal(fallbackIntentType("What should we change to save money?"), "what_to_change");
    assert.equal(fallbackIntentType("How can we reduce the bill"), "what_to_change");
    assert.equal(fallbackIntentType("Why did site 2 spike on 2026-10-17?"), "why_spike_day");
    assert.equal(fallbackIntentType("Why did our electricity cost more in the last four weeks?"), "why_cost_change");
  });
  it("datesIn finds ISO dates once each", () => { assert.deepEqual(datesIn("on 2026-10-17 and 2026-10-17 and 2026-09-01"), ["2026-10-17", "2026-09-01"]); assert.deepEqual(datesIn("no dates"), []); });
});

describe("slugify", () => {
  it("lowercase words, at most 10, optional suffix", () => {
    assert.equal(slugify("Why did our electricity cost more in the last four weeks than the four weeks before?"), "why-did-our-electricity-cost-more-in-the-last-four");
    assert.equal(slugify("Why did Brixton use more electricity?"), "why-did-brixton-use-more-electricity");
    assert.equal(slugify("Why did Brixton use more electricity?", "S2"), "why-did-brixton-use-more-electricity-s2");
    assert.equal(slugify("???"), "question");
  });
});
