import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import type { Fact, DecompositionSummary } from "../types";
import { waterfallBars, type DriverBar } from "../lib/bill-model";

const colour = (b: DriverBar) =>
  b.total ? "#64748b" : b.gbp > 0 ? "#ea8b47" : "#0d9488";
export function Waterfall({
  decomposition,
  facts,
  onEvidence,
  preview = false,
}: {
  decomposition: DecompositionSummary;
  facts: Fact[];
  onEvidence?: (id: string) => void;
  preview?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [selected, setSelected] = useState<DriverBar | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setNarrow(e.contentRect.width < 500),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setSelected(null), [decomposition, facts]);
  const bars = waterfallBars(decomposition, facts);
  let running = 0;
  const levels = bars.map((b) => {
    const base = b.total ? 0 : Math.min(running, running + b.gbp);
    running = b.total ? b.gbp : running + b.gbp;
    return { ...b, base, amount: Math.abs(b.gbp) };
  });
  const low =
    Math.floor(
      (Math.min(
        ...levels.filter((b) => b.total).map((b) => b.gbp),
        ...levels.filter((b) => !b.total).map((b) => b.base),
      ) *
        0.9) /
        50,
    ) * 50;
  const high =
    Math.ceil(
      (Math.max(...levels.map((b) => (b.total ? b.gbp : b.base + b.amount))) *
        1.04) /
        50,
    ) * 50;
  const data = levels.map((b) => ({
    ...b,
    base: b.total ? low : b.base,
    amount: b.total ? b.gbp - low : b.amount,
  }));
  const select = (b: DriverBar) => {
    setSelected(b);
    if (!preview && !b.total) onEvidence?.(b.evidence);
  };
  return (
    <div ref={ref} className="waterfall">
      <ChartContainer
        config={{ amount: { label: "Bill contribution", color: "#ea8b47" } }}
        className={`w-full aspect-auto ${narrow ? "h-[300px]" : "h-[250px]"}`}
      >
        <BarChart
          data={data}
          layout={narrow ? "vertical" : "horizontal"}
          margin={{ top: 12, right: 12, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} strokeDasharray="3 5" />
          {narrow ? (
            <>
              <XAxis
                type="number"
                domain={[low, high]}
                allowDataOverflow
                tickFormatter={(n) => `£${n.toLocaleString()}`}
                fontSize={10}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={78}
                tickLine={false}
                axisLine={false}
                fontSize={11}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                fontSize={11}
              />
              <YAxis
                domain={[low, high]}
                allowDataOverflow
                tickFormatter={(n) => `£${n.toLocaleString()}`}
                width={53}
                tickLine={false}
                axisLine={false}
                fontSize={10}
              />
            </>
          )}
          <ChartTooltip
            cursor={{ fill: "var(--muted)", opacity: 0.5 }}
            content={({ active, payload }) => {
              const b = payload?.[0]?.payload as DriverBar | undefined;
              return active && b ? (
                <div className="chart-tip">
                  <strong>
                    {b.label} · {b.display}
                  </strong>
                  <span>
                    {b.total
                      ? "Total bill"
                      : `${b.share} of the change · click to inspect`}
                  </span>
                </div>
              ) : null;
            }}
          />
          <Bar
            dataKey="base"
            stackId="bill"
            fill="transparent"
            isAnimationActive={false}
            tooltipType="none"
          />
          <Bar
            dataKey="amount"
            stackId="bill"
            radius={3}
            maxBarSize={45}
            isAnimationActive={false}
            onClick={(_, i) => select(data[i])}
          >
            {data.map((b) => (
              <Cell key={b.key} fill={colour(b)} cursor="pointer" />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <div className="chart-legend">
        <span>
          <i className="dot orange" />
          Adds to the bill
        </span>
        <span>
          <i className="dot teal" />
          Reduces it
        </span>
        <span>
          <i className="dot slate" />
          Total
        </span>
      </div>
      <p className="axis-note">
        Axis starts at £{low.toLocaleString("en-GB")} (zoomed). Meter readings:
        sample data.
      </p>
      <div className="driver-controls" aria-label="Inspect bill drivers">
        {bars
          .filter((b) => !b.total)
          .map((b) => (
            <button
              key={b.key}
              onClick={() => select(b)}
              aria-label={`Inspect ${b.label}: ${b.display}`}
            >
              <span>{b.label}</span>
              <strong>{b.display}</strong>
            </button>
          ))}
      </div>
      {selected && (
        <p className="bar-reason" role="status">
          {selected.label === "Price"
            ? "Higher wholesale prices"
            : selected.label}{" "}
          {selected.total
            ? "totalled"
            : selected.gbp >= 0
              ? "added"
              : "reduced the bill by"}{" "}
          {selected.display}
          {!selected.total && `, ${selected.share} of the change`}.
        </p>
      )}
    </div>
  );
}
