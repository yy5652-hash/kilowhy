import { useEffect, useRef, useState } from "react";
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

/** Small zigzag break mark at the truncated baseline of a total bar. */
function AxisBreak({ x, y, w }: { x: number; y: number; w: number }) {
  const mid = x + w / 2;
  return (
    <g className="wf-break" aria-hidden>
      <path
        d={`M ${mid - 7} ${y + 5} L ${mid - 2} ${y - 5} M ${mid - 2} ${y + 5} L ${mid + 3} ${y - 5}`}
        fill="none"
        stroke="var(--bg)"
        strokeWidth={4}
        strokeLinecap="round"
      />
      <path
        d={`M ${mid - 7} ${y + 5} L ${mid - 2} ${y - 5} M ${mid - 2} ${y + 5} L ${mid + 3} ${y - 5}`}
        fill="none"
        stroke="var(--ink-muted)"
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </g>
  );
}

/** Same mark for the horizontal layout (baseline on the left edge of the bar). */
function AxisBreakH({ x, y, h }: { x: number; y: number; h: number }) {
  const mid = y + h / 2;
  const d = `M ${x - 5} ${mid + 7} L ${x + 5} ${mid + 2} M ${x - 5} ${mid + 2} L ${x + 5} ${mid - 3}`;
  return (
    <g className="wf-break" aria-hidden>
      <path d={d} fill="none" stroke="var(--bg)" strokeWidth={4} strokeLinecap="round" />
      <path d={d} fill="none" stroke="var(--ink-muted)" strokeWidth={1.4} strokeLinecap="round" />
    </g>
  );
}

const SHORT_LABEL: Record<string, string> = {
  "Weather volume": "Weather",
  "Operational volume": "Operations",
};

function wrapLabel(label: string): string[] {
  const parts = label.split(" ");
  if (parts.length < 2 || label.length <= 10) return [label];
  return [parts[0], parts.slice(1).join(" ")];
}

/** Width of the container, so the chart is drawn in real pixels and its text never shrinks. */
function useWidth(): [React.RefObject<HTMLElement>, number] {
  const ref = useRef<HTMLElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = Math.round(entries[0].contentRect.width);
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function Waterfall({ decomposition, facts }: Props) {
  const [ref, width] = useWidth();
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

  const narrow = width < 560;
  const n = bars.length;

  // Running level for floating bars (bridge chart)
  let level = 0;
  const levels: number[] = [];
  for (const b of bars) {
    if (b.kind === "total") {
      levels.push(0);
      level = b.gbp;
    } else {
      levels.push(b.gbp >= 0 ? level : level + b.gbp);
      level += b.gbp;
    }
  }

  const totalA = penceToGbp(r.totalA);
  const totalB = penceToGbp(r.totalB);
  // Zoom: start the axis near the smaller total so increments read clearly.
  const floor = 0.9 * Math.min(totalA, totalB);
  const tops = bars.flatMap((b, i) =>
    b.kind === "total" ? [b.gbp] : [levels[i], levels[i] + Math.abs(b.gbp)],
  );
  const maxY = Math.max(...tops, floor + 1) * 1.04;
  const minY = floor;
  const span = maxY - minY || 1;
  const axisStart = `£${(Math.floor(floor / 10) * 10).toLocaleString("en-GB")}`;

  const fillOf = (b: Bar) =>
    b.kind === "total"
      ? "var(--wf-total)"
      : b.kind === "up"
        ? "var(--wf-up)"
        : b.kind === "down"
          ? "var(--wf-down)"
          : "var(--wf-zero)";
  const isZeroBar = (b: Bar) => b.kind === "zero" || (b.kind !== "total" && Math.abs(b.gbp) < 1e-9);

  let svg: React.ReactNode;

  if (!narrow) {
    // Vertical bridge: window A, the movements, window B.
    const W = Math.min(width, 900);
    const H = 250;
    const padL = 8;
    const padR = 8;
    const padT = 28;
    const padB = 52;
    const gap = 10;
    const barW = (W - padL - padR - gap * (n - 1)) / n;
    const plotH = H - padT - padB;
    const yScale = (v: number) => padT + ((maxY - Math.max(v, minY)) / span) * plotH;
    const hScale = (from: number, to: number) =>
      Math.max(0, ((Math.min(to, maxY) - Math.max(from, minY)) / span) * plotH);

    svg = (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Bill change waterfall">
        {bars.map((b, i) => {
          const x = padL + i * (barW + gap);
          const isTotal = b.kind === "total";
          const isZero = isZeroBar(b);
          let top: number;
          let height: number;
          if (isTotal) {
            top = yScale(b.gbp);
            height = Math.max(yScale(minY) - top, 2);
          } else if (isZero) {
            top = yScale(levels[i]) - 1;
            height = 2;
          } else {
            const lo = levels[i];
            const hi = levels[i] + Math.abs(b.gbp);
            top = yScale(hi);
            height = Math.max(hScale(lo, hi), 2);
          }
          const lines = wrapLabel(b.label);
          return (
            <g key={b.key}>
              <rect x={x} y={top} width={barW} height={height} rx={isZero ? 0 : 3} fill={fillOf(b)} />
              {isTotal && <AxisBreak x={x} y={yScale(minY)} w={barW} />}
              <text x={x + barW / 2} y={top - 6} textAnchor="middle" className="wf-value">
                {isZero ? "£0.00" : b.display}
              </text>
              {lines.map((ln, li) => (
                <text
                  key={li}
                  x={x + barW / 2}
                  y={H - 30 + li * 13}
                  textAnchor="middle"
                  className="wf-label"
                >
                  {ln}
                </text>
              ))}
            </g>
          );
        })}
        {bars.map((b, i) => {
          if (i === 0 || b.kind === "total") return null;
          const prev = bars[i - 1];
          const x0 = padL + (i - 1) * (barW + gap) + barW;
          const x1 = padL + i * (barW + gap);
          const y =
            prev.kind === "total" ? yScale(prev.gbp) : yScale(levels[i - 1] + Math.max(prev.gbp, 0));
          if (y > yScale(minY) + 2) return null;
          return <line key={`c-${b.key}`} x1={x0} x2={x1} y1={y} y2={y} className="wf-connector" />;
        })}
      </svg>
    );
  } else {
    // Narrow screens: the same bridge laid on its side, one row per bar, real-size text.
    const W = Math.max(width, 240);
    const rowH = 30;
    const barH = 16;
    const padT = 6;
    const padL = W < 340 ? 78 : 92;
    const padR = 70;
    const H = padT + n * rowH + 4;
    const plotW = Math.max(W - padL - padR, 60);
    const xScale = (v: number) => padL + ((Math.max(v, minY) - minY) / span) * plotW;
    const wScale = (from: number, to: number) =>
      Math.max(0, ((Math.min(to, maxY) - Math.max(from, minY)) / span) * plotW);

    svg = (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Bill change waterfall">
        {bars.map((b, i) => {
          const y = padT + i * rowH + (rowH - barH) / 2;
          const isTotal = b.kind === "total";
          const isZero = isZeroBar(b);
          let left: number;
          let w: number;
          if (isTotal) {
            left = xScale(minY);
            w = Math.max(xScale(b.gbp) - left, 2);
          } else if (isZero) {
            left = xScale(levels[i]) - 1;
            w = 2;
          } else {
            const lo = levels[i];
            const hi = levels[i] + Math.abs(b.gbp);
            left = xScale(lo);
            w = Math.max(wScale(lo, hi), 2);
          }
          return (
            <g key={b.key}>
              <text x={padL - 8} y={y + barH / 2 + 4} textAnchor="end" className="wf-label">
                {SHORT_LABEL[b.label] ?? b.label}
              </text>
              <rect x={left} y={y} width={w} height={barH} rx={isZero ? 0 : 3} fill={fillOf(b)} />
              {isTotal && <AxisBreakH x={left} y={y} h={barH} />}
              <text x={left + w + 6} y={y + barH / 2 + 4} className="wf-value">
                {isZero ? "£0.00" : b.display}
              </text>
            </g>
          );
        })}
        {bars.map((b, i) => {
          if (i === 0 || b.kind === "total") return null;
          const prev = bars[i - 1];
          const x =
            prev.kind === "total" ? xScale(prev.gbp) : xScale(levels[i - 1] + Math.max(prev.gbp, 0));
          const y0 = padT + (i - 1) * rowH + (rowH + barH) / 2;
          const y1 = padT + i * rowH + (rowH - barH) / 2;
          return <line key={`c-${b.key}`} x1={x} x2={x} y1={y0} y2={y1} className="wf-connector" />;
        })}
      </svg>
    );
  }

  return (
    <figure className={`waterfall ${narrow ? "narrow" : ""}`} ref={ref as React.RefObject<HTMLElement>}>
      <figcaption>How the bill moved (window A → window B)</figcaption>
      {svg}
      <p className="wf-legend muted small">
        <span className="wf-key up" aria-hidden /> adds to the bill
        <span className="wf-key down" aria-hidden /> reduces it
        <span className="wf-axis-note">Axis starts at {axisStart} (zoomed; break marks on the totals)</span>
      </p>
    </figure>
  );
}
