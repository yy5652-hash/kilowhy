import type { Fact, DecompositionSummary } from "../types";
import { factDisplay } from "../format";

interface Props {
  decomposition: DecompositionSummary;
  facts: Fact[];
}

interface Bar {
  key: string;
  label: string;
  display: string;
  /** Signed GBP for geometry only (from decomposition pence / 100, or fact value). */
  gbp: number;
  kind: "total" | "up" | "down" | "zero";
}

function penceToGbp(p: number): number {
  return p / 100;
}

export function Waterfall({ decomposition, facts }: Props) {
  const r = decomposition.result;
  if (!r) return null;

  const billA = factDisplay(facts, "bill_A") ?? `£${penceToGbp(r.totalA).toFixed(2)}`;
  const billB = factDisplay(facts, "bill_B") ?? `£${penceToGbp(r.totalB).toFixed(2)}`;
  const standing = factDisplay(facts, "S") ?? `£${penceToGbp(r.standing).toFixed(2)}`;
  const weather = factDisplay(facts, "v_weather");
  const operational = factDisplay(facts, "v_operational");
  const volume = factDisplay(facts, "V") ?? `£${penceToGbp(r.volume).toFixed(2)}`;
  const price = factDisplay(facts, "L") ?? `£${penceToGbp(r.price).toFixed(2)}`;
  const timing = factDisplay(facts, "T") ?? `£${penceToGbp(r.timing).toFixed(2)}`;

  const weatherGbp =
    typeof facts.find((f) => f.key === "v_weather")?.value === "number"
      ? (facts.find((f) => f.key === "v_weather")!.value as number)
      : penceToGbp(r.volume) * 0.8;
  const opsGbp =
    typeof facts.find((f) => f.key === "v_operational")?.value === "number"
      ? (facts.find((f) => f.key === "v_operational")!.value as number)
      : penceToGbp(r.volume) - weatherGbp;

  const bars: Bar[] = [
    { key: "A", label: "Window A", display: billA, gbp: penceToGbp(r.totalA), kind: "total" },
    {
      key: "S",
      label: "Standing",
      display: standing,
      gbp: penceToGbp(r.standing),
      kind: r.standing === 0 ? "zero" : r.standing > 0 ? "up" : "down",
    },
    {
      key: "Vw",
      label: "Weather volume",
      display: weather ?? volume,
      gbp: weather ? weatherGbp : penceToGbp(r.volume),
      kind: (weather ? weatherGbp : r.volume) === 0 ? "zero" : (weather ? weatherGbp : r.volume) > 0 ? "up" : "down",
    },
    ...(weather
      ? [
          {
            key: "Vo",
            label: "Operational volume",
            display: operational ?? "£0.00",
            gbp: opsGbp,
            kind: (opsGbp === 0 ? "zero" : opsGbp > 0 ? "up" : "down") as Bar["kind"],
          },
        ]
      : []),
    {
      key: "L",
      label: "Price",
      display: price,
      gbp: penceToGbp(r.price),
      kind: r.price === 0 ? "zero" : r.price > 0 ? "up" : "down",
    },
    {
      key: "T",
      label: "Timing",
      display: timing,
      gbp: penceToGbp(r.timing),
      kind: r.timing === 0 ? "zero" : r.timing > 0 ? "up" : "down",
    },
    { key: "B", label: "Window B", display: billB, gbp: penceToGbp(r.totalB), kind: "total" },
  ];

  const W = 640;
  const H = 220;
  const padL = 8;
  const padR = 8;
  const padT = 28;
  const padB = 48;
  const gap = 10;
  const n = bars.length;
  const barW = (W - padL - padR - gap * (n - 1)) / n;

  // Running level for floating bars (bridge chart)
  let level = 0;
  const levels: number[] = [];
  for (const b of bars) {
    if (b.kind === "total") {
      levels.push(0);
      level = b.gbp;
    } else {
      const start = b.gbp >= 0 ? level : level + b.gbp;
      levels.push(start);
      level += b.gbp;
    }
  }

  const values = bars.flatMap((b, i) =>
    b.kind === "total" ? [b.gbp] : [levels[i], levels[i] + Math.abs(b.gbp)],
  );
  const minY = Math.min(0, ...values) * 0.98;
  const maxY = Math.max(...values) * 1.02;
  const span = maxY - minY || 1;
  const yScale = (v: number) => padT + ((maxY - v) / span) * (H - padT - padB);
  const hScale = (v: number) => (Math.abs(v) / span) * (H - padT - padB);

  return (
    <figure className="waterfall">
      <figcaption>How the bill moved (window A → window B)</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bill change waterfall">
        {bars.map((b, i) => {
          const x = padL + i * (barW + gap);
          const isTotal = b.kind === "total";
          const top = isTotal ? yScale(Math.max(b.gbp, 0)) : yScale(levels[i] + Math.max(b.gbp, 0));
          const height = Math.max(hScale(isTotal ? b.gbp : b.gbp), 2);
          const fill =
            b.kind === "total"
              ? "var(--wf-total)"
              : b.kind === "up"
                ? "var(--wf-up)"
                : b.kind === "down"
                  ? "var(--wf-down)"
                  : "var(--wf-zero)";
          return (
            <g key={b.key}>
              <rect x={x} y={top} width={barW} height={height} rx={3} fill={fill} />
              <text
                x={x + barW / 2}
                y={top - 6}
                textAnchor="middle"
                className="wf-value"
              >
                {b.display}
              </text>
              <text
                x={x + barW / 2}
                y={H - 18}
                textAnchor="middle"
                className="wf-label"
              >
                {b.label}
              </text>
            </g>
          );
        })}
        {/* connector lines between floating bars */}
        {bars.map((b, i) => {
          if (i === 0 || b.kind === "total") return null;
          const prev = bars[i - 1];
          const x0 = padL + (i - 1) * (barW + gap) + barW;
          const x1 = padL + i * (barW + gap);
          const y =
            prev.kind === "total"
              ? yScale(prev.gbp)
              : yScale(levels[i - 1] + Math.max(prev.gbp, 0));
          return (
            <line
              key={`c-${b.key}`}
              x1={x0}
              x2={x1}
              y1={y}
              y2={y}
              className="wf-connector"
            />
          );
        })}
      </svg>
    </figure>
  );
}
