import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNoteArgs } from "./note_args.ts";

describe("parseNoteArgs", () => {
  it("a note with a site and a start date", () => {
    assert.deepEqual(parseNoteArgs(["--site", "S2", "Brixton", "moved", "its", "oven"]), { kind: "remember", text: "Brixton moved its oven", site: "S2", from: undefined });
    assert.deepEqual(parseNoteArgs(["--site=Brixton", "--from", "2026-10-07", "The oven moved"]), { kind: "remember", text: "The oven moved", site: "Brixton", from: "2026-10-07" });
  });
  it("list, recall, audit and feedback", () => {
    assert.deepEqual(parseNoteArgs(["--list", "--site", "S1"]), { kind: "list", site: "S1" });
    assert.deepEqual(parseNoteArgs(["--recall", "why did Brixton", "--site", "S2"]), { kind: "recall", query: "why did Brixton", site: "S2" });
    assert.deepEqual(parseNoteArgs(["--audit", "mem-1"]), { kind: "audit", id: "mem-1" });
    assert.deepEqual(parseNoteArgs(["--feedback", "mem-1:wrong"]), { kind: "feedback", id: "mem-1", verdict: "wrong" });
  });
  it("bad input gives usage", () => {
    assert.equal(parseNoteArgs([]).kind, "usage");
    assert.match((parseNoteArgs(["--from", "7 Oct", "x"]) as { error: string }).error, /--from needs a date/);
    assert.match((parseNoteArgs(["--feedback", "mem-1:great"]) as { error: string }).error, /--feedback needs/);
    assert.match((parseNoteArgs(["--bogus", "x"]) as { error: string }).error, /unknown option/);
    assert.equal(parseNoteArgs(["--recall", " "]).kind, "usage");
  });
});
