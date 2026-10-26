import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { waterfallBars } from "../src/lib/bill-model.ts";
const slugs = [
  "why-did-our-electricity-cost-more-in-the-last-four",
  "why-did-brixton-use-more-electricity-s2",
  "what-should-we-change-to-save-money",
];
const fixtures = slugs.map((s) =>
  JSON.parse(
    readFileSync(new URL(`../src/fixtures/${s}.json`, import.meta.url)),
  ),
);
for (const [i, result] of fixtures.entries()) {
  test(`${slugs[i]}: exact bridge, original displays and valid evidence`, () => {
    const bars = waterfallBars(result.decomposition, result.facts);
    const drivers = bars.filter((b) => !b.total);
    const delta = drivers.reduce((s, b) => s + b.gbp, 0);
    assert.ok(
      Math.abs(delta - result.decomposition.result.deltaTotal / 100) < 1e-9,
    );
    assert.ok(Math.abs(bars[0].gbp + delta - bars.at(-1).gbp) < 1e-9);
    assert.equal(bars.length, 7);
    for (const bar of bars) {
      assert.equal(
        bar.display,
        result.facts.find((f) => f.key === bar.key).display,
      );
      assert.ok(result.evidence.some((e) => e.id === bar.evidence));
    }
    const displayed = drivers.reduce(
      (s, b) =>
        s + Math.round(Number(b.display.replace(/[^0-9.-]/g, "")) * 100),
      0,
    );
    assert.equal(displayed, Math.round(result.decomposition.result.deltaTotal));
  });
}
test("missing weather facts: show volume without inventing a weather allocation", () => {
  const result = fixtures[0];
  const bars = waterfallBars(
    result.decomposition,
    result.facts.filter((f) => !f.key.startsWith("v_")),
  );
  assert.ok(!bars.some((b) => b.key === "v_weather"));
  assert.equal(
    bars.find((b) => b.key === "V").gbp,
    result.decomposition.result.volume / 100,
  );
});
test("no decomposition produces no invented bars", () =>
  assert.deepEqual(
    waterfallBars(
      { ...fixtures[0].decomposition, result: null },
      fixtures[0].facts,
    ),
    [],
  ));
test("negative price contribution is signed and keeps the bill identity", () => {
  const result = structuredClone(fixtures[0]);
  const r = result.decomposition.result;
  r.price = -r.price;
  r.deltaTotal = r.volume + r.price + r.timing + r.standing;
  r.totalB = r.totalA + r.deltaTotal;
  const bars = waterfallBars(result.decomposition, result.facts);
  assert.ok(bars.find((b) => b.key === "L").gbp < 0);
  assert.ok(
    Math.abs(
      bars.filter((b) => !b.total).reduce((s, b) => s + b.gbp, 0) -
        r.deltaTotal / 100,
    ) < 1e-9,
  );
});
