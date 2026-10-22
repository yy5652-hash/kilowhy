// dropContradictions: status contradictions are repaired by leaving the offending entries out.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropContradictions } from "./narration.ts";
import type { Answer, VerifyError } from "./verifier.ts";

const item = (text: string) => ({ text, facts: ["F1"], evidence: ["E1"] });
const answer = (n = 4): Answer => ({ headline: "h", sentences: Array.from({ length: n }, (_, i) => item(`s${i}`)), ruledOut: [{ hypothesis: "H5", ...item("r0") }, { hypothesis: "H3", ...item("r1") }], recommendation: item("rec") });
const err = (part: VerifyError["part"], index: number, reason: string): VerifyError => ({ part, index, reason });

describe("dropContradictions", () => {
  it("drops sentences that present a non-supported hypothesis as a cause or cite its facts", () => {
    const r = dropContradictions(answer(), [err("sentences", 1, "presents H4 (operational_change) as a cause, but H4 is inconclusive"), err("sentences", 3, "cites F7 (H5), but H5 is ruled_out; only supported causes belong in sentences (put it in ruledOut)")])!;
    assert.deepEqual(r.answer.sentences.map((s) => s.text), ["s0", "s2"]);
    assert.equal(r.notes.length, 2); assert.match(r.notes[0], /^sentences\[1\] dropped: presents H4/);
  });
  it("drops ruled-out items for hypotheses that are not ruled out", () => {
    const r = dropContradictions(answer(), [err("ruledOut", 1, "H3 (weather_volume) is supported, not ruled_out")])!;
    assert.deepEqual(r.answer.ruledOut.map((x) => x.hypothesis), ["H5"]);
  });
  it("does nothing when any error is of another kind (numbers, citations), or when fewer than two sentences would remain", () => {
    assert.equal(dropContradictions(answer(), [err("sentences", 1, "presents H4 (operational_change) as a cause, but H4 is inconclusive"), err("sentences", 2, 'the number "£9" matches none of the cited facts')]), null);
    assert.equal(dropContradictions(answer(3), [err("sentences", 0, "presents H4 (x) as a cause, but H4 is inconclusive"), err("sentences", 1, "presents H4 (x) as a cause, but H4 is inconclusive")]), null);
    assert.equal(dropContradictions(answer(), []), null);
    assert.equal(dropContradictions(answer(), [err("recommendation", 0, "the recommendation is empty")]), null);
  });
  it("does not change its input", () => {
    const a = answer();
    dropContradictions(a, [err("sentences", 0, "presents H4 (x) as a cause, but H4 is inconclusive")]);
    assert.equal(a.sentences.length, 4);
  });
});
