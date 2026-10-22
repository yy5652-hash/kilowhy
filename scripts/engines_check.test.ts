import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ENGINES, parseVitest } from "./engines_check.ts";

describe("parseVitest", () => {
  it("reads the vitest summary line, with or without colour codes and failures", () => {
    assert.deepEqual(parseVitest(" Test Files  1 passed (1)\n      Tests  10 passed (10)\n"), { passed: 10, failed: 0, total: 10 });
    assert.deepEqual(parseVitest("\u001b[2m      Tests\u001b[22m  \u001b[1m\u001b[31m2 failed\u001b[39m | \u001b[32m8 passed\u001b[39m (10)\n"), { passed: 8, failed: 2, total: 10 });
    assert.equal(parseVitest("no summary here"), null);
  });
  it("covers the three engines", () => { assert.deepEqual([...ENGINES], ["hmem", "world-model", "markovian"]); });
});
