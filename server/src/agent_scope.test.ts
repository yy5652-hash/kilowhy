import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessSites, resolveScope } from "./agent_scope.ts";
import { WINDOW_A, WINDOW_B } from "./windows.ts";
import type { SiteRef } from "./agent_sites.ts";

const known: SiteRef[] = [{ id: "S1", name: "Crumb & Co Shoreditch" }, { id: "S2", name: "Crumb & Co Brixton" }, { id: "S3", name: "Crumb & Co Hampstead" }];
const intent = (requestedSites: string[] = [], dates: string[] = []) => ({ requestedSites, dates });

describe("guessSites (before the model answers)", () => {
  it("the sites the question mentions, or every site", () => {
    assert.deepEqual(guessSites("Why did Brixton use more electricity?", known), ["S2"]);
    assert.deepEqual(guessSites("Why did our bill rise?", known), ["S1", "S2", "S3"]);
    assert.deepEqual(guessSites("compare S3 and Shoreditch", known), ["S1", "S3"]);
  });
  it("an explicit site wins; an unknown explicit site falls back to every site (the clarification comes later)", () => {
    assert.deepEqual(guessSites("Why did our bill rise?", known, "Hampstead"), ["S3"]);
    assert.deepEqual(guessSites("Why did our bill rise?", known, "Peckham"), ["S1", "S2", "S3"]);
  });
});

describe("resolveScope", () => {
  const scope = (q: string, i = intent(), only?: string) => resolveScope(q, i, known, WINDOW_A, WINDOW_B, only);
  it("ALL when nothing names a site; the label is ALL or the joined ids", () => {
    const a = scope("Why?"); assert.ok(a.ok && a.label === "ALL" && a.siteIds.length === 3);
    const b = scope("Why?", intent(["Brixton", "S3"])); assert.ok(b.ok && b.label === "S2+S3");
  });
  it("model-requested sites that the question never mentions are ignored with a note", () => {
    const r = scope("Why?", intent(["S9"]));
    assert.ok(r.ok && r.label === "ALL" && r.notes.length === 1);
  });
  it("clarifies unknown names, ambiguous names, numbered sites that do not exist, and dates outside the data", () => {
    const unknown = scope("Why did Peckham spike?", intent(["Peckham"]));
    assert.ok(!unknown.ok && /could not find a site called "Peckham"/.test(unknown.clarification));
    const numbered = scope("Why did site 7 spike?", intent(["S7"]));
    assert.ok(!numbered.ok && /"site 7"/.test(numbered.clarification));
    const dated = scope("Why did Brixton spike on 2026-11-01?", intent(["Brixton"], ["2026-11-01"]));
    assert.ok(!dated.ok && /2026-08-27 to 2026-10-21/.test(dated.clarification));
    const inside = scope("Why did Brixton spike on 2026-10-01?", intent(["Brixton"], ["2026-10-01"]));
    assert.ok(inside.ok && inside.label === "S2");
  });
  it("the boundary days of the data are accepted", () => {
    assert.ok(scope("q", intent([], ["2026-08-27"])).ok); assert.ok(scope("q", intent([], ["2026-10-21"])).ok); assert.ok(!scope("q", intent([], ["2026-10-22"])).ok); assert.ok(!scope("q", intent([], ["2026-08-26"])).ok);
  });
  it("an explicit site overrides what the model said", () => {
    const r = scope("Why?", intent(["Brixton"]), "S3");
    assert.ok(r.ok && r.label === "S3");
    const bad = scope("Why?", intent(), "S9"); assert.ok(!bad.ok);
  });
});
