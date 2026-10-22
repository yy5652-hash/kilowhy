import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VARIANTS, requestFor, summarize, type ProbeRow } from "./reasoning_variants.ts";

const msgs = [{ role: "system" as const, content: "SYS" }, { role: "user" as const, content: "Q" }];

describe("reasoning variants", () => {
  it("ids are unique and the baseline sends nothing extra", () => {
    assert.equal(new Set(VARIANTS.map((v) => v.id)).size, VARIANTS.length);
    const r = requestFor(VARIANTS[0], msgs);
    assert.deepEqual(r.messages, msgs); assert.equal("max_tokens" in r, false); assert.equal("extra" in r, false); assert.equal(r.mode, "deep");
  });
  it("a system line goes on the first system message only; extra and the cap are passed through", () => {
    const v = VARIANTS.find((x) => x.id === "kwargs_and_line")!;
    const r = requestFor(v, msgs);
    assert.equal(r.messages[0].content, "SYS\ndetailed thinking off"); assert.equal(r.messages[1].content, "Q");
    assert.deepEqual(r.extra, { chat_template_kwargs: { enable_thinking: false } }); assert.equal(r.max_tokens, 500);
    assert.equal(msgs[0].content, "SYS", "input not mutated");
  });
});

describe("summarize", () => {
  const row = (variant: string, over: Partial<ProbeRow> = {}): ProbeRow => ({ variant, ok: true, wallMs: 1000, outputTokens: 100, routedModel: "m1", leaked: false, jsonOk: true, ...over });
  it("medians, rates and models per variant; failed calls count against the rates only", () => {
    const s = summarize([row("a", { wallMs: 1000, outputTokens: 300, leaked: true }), row("a", { wallMs: 3000, outputTokens: 500, routedModel: "m2" }), row("a", { ok: false, jsonOk: false, wallMs: 99999, error: "x" }), row("b")]);
    const a = s.find((x) => x.variant === "a")!;
    assert.equal(a.n, 3); assert.equal(a.okRate, 2 / 3); assert.equal(a.jsonRate, 2 / 3); assert.equal(a.leakRate, 0.5);
    assert.equal(a.medianWallMs, 2000); assert.equal(a.medianOutputTokens, 400); assert.deepEqual(a.models, ["m1", "m2"]);
    assert.equal(s.find((x) => x.variant === "b")!.medianWallMs, 1000);
  });
  it("a variant with no successful call has null medians", () => {
    const s = summarize([row("c", { ok: false, jsonOk: false })]);
    assert.equal(s[0].medianWallMs, null); assert.equal(s[0].medianOutputTokens, null); assert.equal(s[0].leakRate, 0);
  });
});
