import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, answerFile } from "./ask_args.ts";

describe("ask.ts arguments", () => {
  it("a quoted question", () => { assert.deepEqual(parseArgs(["Why did Brixton use more electricity?"]), { question: "Why did Brixton use more electricity?" }); });
  it("--site in both spellings, before or after the question", () => {
    assert.deepEqual(parseArgs(["Why the spike?", "--site", "S2"]), { question: "Why the spike?", site: "S2" });
    assert.deepEqual(parseArgs(["--site=S3", "Why", "the", "spike?"]), { question: "Why the spike?", site: "S3" });
  });
  it("no question gives an empty string (the CLI then prints usage)", () => { assert.equal(parseArgs([]).question, ""); assert.equal(parseArgs(["--site", "S1"]).question, ""); });
  it("answer file names come from the question, with the site as a suffix", () => {
    assert.equal(answerFile("Why did Brixton use more electricity?"), "eval/answers/why-did-brixton-use-more-electricity.json");
    assert.equal(answerFile("What should we change to save money?", "S2"), "eval/answers/what-should-we-change-to-save-money-s2.json");
  });
});
