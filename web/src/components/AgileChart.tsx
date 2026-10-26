import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import prices from "../data/agile-2026-10-17.json";
const data = prices.slots.map((s) => {
  const time = new Date(s.from).toLocaleTimeString("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
  });
  return { ...s, time, peak: time >= "16:00" && time < "19:00" };
});
const min = Math.min(...data.map((s) => s.p)),
  max = Math.max(...data.map((s) => s.p));
export function AgileChart() {
  return (
    <div className="agile-chart">
      <div className="price-extremes">
        <span>
          Lowest <strong>{min.toFixed(2)}p</strong>
        </span>
        <span className="orange-text">
          Highest{" "}
          <strong>
            {max.toFixed(2)}p at {data.find((s) => s.p === max)?.time}
          </strong>
        </span>
      </div>
      <ChartContainer
        config={{ p: { label: "Agile price", color: "#0d9488" } }}
        className="h-[220px] w-full aspect-auto"
      >
        <BarChart
          data={data}
          margin={{ top: 12, right: 5, left: -16, bottom: 0 }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} strokeDasharray="3 5" />
          <XAxis
            dataKey="time"
            interval={7}
            tickLine={false}
            axisLine={false}
            fontSize={11}
          />
          <YAxis
            tickFormatter={(n) => `${n}p`}
            tickLine={false}
            axisLine={false}
            fontSize={11}
          />
          <ChartTooltip
            content={({ active, payload }) => {
              const s = payload?.[0]?.payload;
              return active && s ? (
                <div className="chart-tip">
                  <strong>
                    {s.time} London · {s.p.toFixed(2)}p/kWh
                  </strong>
                  <span>{s.peak ? "Peak hours" : "Off-peak hours"}</span>
                </div>
              ) : null;
            }}
          />
          <Bar dataKey="p" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((s) => (
              <Cell key={s.from} fill={s.peak ? "#ea8b47" : "#0d9488"} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <p className="muted small">
        London time ·{" "}
        <span className="orange-text">16:00–19:00 peak highlighted</span> ·{" "}
        {data.length} half-hourly prices
      </p>
      <p className="source-caption">{prices.source}</p>
    </div>
  );
}
