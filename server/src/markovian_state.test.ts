// The Markovian carryover: shape, survival of the engine's sanitiser, and the budget (pure; no engine, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clean, citedFacts, estimateTokens, fitState, newState, parseState, serialize, STATUS_CODE, type ChainState } from "./markovian_state.ts";

const hypIds = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11"];
const base = (): ChainState => newState({
  q: "Why did Brixton use more electricity than before?", type: "why_cost_change", scope: "S2 Crumb & Co Brixton", win: "A 2026-08-27..2026-09-23 | B 2026-09-24..2026-10-21",
  plan: hypIds, mem: ["M1"], hyp: Object.fromEntries(hypIds.map((h, i) => [h, i % 3 === 0 ? "s" : i % 3 === 1 ? "r" : "i"])), ev: Object.fromEntries(hypIds.map((h, i) => [h, [`E${i + 1}`, `E${i + 20}`, `E${i + 40}`]])),
});
const big = (n: number): ChainState => { const s = base(); for (const h of hypIds) s.read[h] = `${h} reading ${"x".repeat(n)} {F12} and {F13}`; s.err = ["sentences[1]: the number matches none of the cited facts; ".repeat(5)]; return s; };

describe("state", () => {
  it("round-trips through JSON and a state that is not ours does not parse", () => {
    const s = base();
    assert.deepEqual(parseState(serialize(s)), s);
    assert.equal(parseState("not json"), null); assert.equal(parseState('{"v":2}'), null); assert.equal(parseState('{"v":1,"next":"x"}'), null);
    assert.equal(s.next, "plan"); assert.deepEqual(s.done, []);
  });
  it("status codes", () => { assert.deepEqual(STATUS_CODE, { supported: "s", ruled_out: "r", inconclusive: "i" }); });
  it("clean() removes what the engine's marker sanitiser would eat, so the state survives it unchanged", () => {
    assert.equal(clean("a <b> [c] @d --- e ----- f"), "a b c d - e - f");
    // the engine strips runs of three of < > [ ] @ - from a checkpoint; a serialised state of cleaned text has none
    const s = big(40); for (const h of hypIds) s.read[h] = clean(`[${h}] <b> @x --- ${s.read[h]}`);
    assert.equal(/[<>[\]@-]{3,}/.test(serialize(s)), false);
  });
  it("cited facts of a reading", () => { assert.deepEqual(citedFacts("up {F3}, down {F9:abs}, note {M1}"), ["F3", "F9"]); });
});

describe("fitState keeps the state inside the carryover budget", () => {
  const BUDGET = 800 * 4;
  it("a state that fits is returned as it is", () => {
    const f = fitState(base(), BUDGET);
    assert.deepEqual(f.shrunk, []); assert.equal(f.text, serialize(base()));
  });
  it("long readings are shortened step by step until the state fits, and the structure is never cut", () => {
    const f = fitState(big(400), BUDGET);
    assert.ok(f.text.length <= BUDGET, `${f.text.length} > ${BUDGET}`);
    assert.ok(f.shrunk.length >= 1 && f.shrunk[0] === "readings to 140 characters");
    const back = parseState(f.text)!;
    assert.deepEqual(back.hyp, base().hyp); assert.equal(back.next, "plan"); assert.deepEqual(back.plan, hypIds); assert.deepEqual(back.mem, ["M1"]);
    assert.ok(Object.values(back.read).every((r) => r.length <= 140));
  });
  it("the estimate used by the engine (chars / 4) stays at or below the carryover tokens for every size of reading", () => {
    for (const n of [0, 30, 100, 300, 1000, 5000]) {
      const f = fitState(big(n), BUDGET);
      assert.ok(estimateTokens(f.text) <= 800, `n=${n}: ${estimateTokens(f.text)} tokens`);
    }
  });
  it("only as much is cut as needed: a moderately large state keeps its evidence ids", () => {
    const f = fitState(big(60), BUDGET);
    const back = parseState(f.text)!;
    assert.ok(Object.keys(back.ev).length > 0);
  });
  it("the input state is not modified", () => {
    const s = big(400), before = serialize(s);
    fitState(s, BUDGET);
    assert.equal(serialize(s), before);
  });
});
