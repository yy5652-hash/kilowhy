import type { Fact, DecompositionSummary } from "../types";
import { factDisplay } from "../format.ts";

export interface DriverBar {
  key: string;
  label: string;
  display: string;
  gbp: number;
  total: boolean;
  evidence: string;
  share: string;
}
/** Preserve the original pence-to-GBP decomposition and fact-based weather split. */
export function waterfallBars(
  decomposition: DecompositionSummary,
  facts: Fact[],
): DriverBar[] {
  const r = decomposition.result;
  if (!r) return [];
  const fact = (key: string) => facts.find((f) => f.key === key);
  const weather = fact("v_weather");
  const weatherValue =
    typeof weather?.value === "number" ? weather.value : null;
  // Facts are rounded for display; retain the unrounded volume residual for an exact bridge.
  const entries: [string, string, number, boolean][] = [
    ["bill_A", "Window A", r.totalA / 100, true],
    ["S", "Standing", r.standing / 100, false],
    ...(weatherValue !== null
      ? ([
          ["v_weather", "Weather", weatherValue, false],
          ["v_operational", "Operations", r.volume / 100 - weatherValue, false],
        ] as [string, string, number, boolean][])
      : ([["V", "Volume", r.volume / 100, false]] as [
          string,
          string,
          number,
          boolean,
        ][])),
    ["L", "Price", r.price / 100, false],
    ["T", "Timing", r.timing / 100, false],
    ["bill_B", "Window B", r.totalB / 100, true],
  ];
  return entries.map(([key, label, gbp, total]) => ({
    key,
    label,
    gbp,
    total,
    display:
      factDisplay(facts, key) ??
      new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
      }).format(gbp),
    evidence: fact(key)?.evidence ?? decomposition.evidenceId,
    share:
      factDisplay(facts, `${key}_share`) ??
      (r.deltaTotal
        ? `${((gbp / (r.deltaTotal / 100)) * 100).toFixed(1)}%`
        : "—"),
  }));
}
