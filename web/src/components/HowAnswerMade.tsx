import { useEffect, useState } from "react";
import { fetchEntities } from "../api/client";
import type { EntityCounts, InvestigationResult, MarkovianChunk } from "../types";
import { recallSummaryLine, stepLabel } from "../format";
import { LlmReceipt } from "./LlmReceipt";

interface Props {
  result: InvestigationResult;
  apiOnline: boolean;
}

function tokenBarValue(c: MarkovianChunk): { actual: number; naive: number; actualSource: string } {
  const actual = c.inputTokens.measured ?? c.inputTokens.estimated;
  const actualSource = c.inputTokens.measured != null ? "measured" : "estimated";
  return { actual, naive: c.naiveInputTokens, actualSource };
}

function MarkovianChart({ chunks }: { chunks: MarkovianChunk[] }) {
  if (chunks.length === 0) return <p className="muted small">No Markovian chunks recorded.</p>;

  const rows = chunks.map((c) => ({ ...c, ...tokenBarValue(c) }));
  const max = Math.max(...rows.flatMap((r) => [r.actual, r.naive]), 1);
  const W = 560;
  const rowH = 36;
  const padL = 120;
  const padR = 16;
  const barMax = W - padL - padR;
  const H = rows.length * rowH + 28;

  return (
    <figure className="markov-chart">
      <figcaption>
        Input tokens per chunk vs naive full-history estimate (estimates labelled)
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Markovian token comparison">
        {rows.map((r, i) => {
          const y = 8 + i * rowH;
          const aw = (r.actual / max) * barMax;
          const nw = (r.naive / max) * barMax;
          const label = r.label.length > 22 ? `${r.label.slice(0, 20)}…` : r.label;
          return (
            <g key={r.id}>
              <text x={padL - 8} y={y + 14} textAnchor="end" className="markov-label">
                {label}
              </text>
              <rect
                x={padL}
                y={y}
                width={Math.max(nw, 1)}
                height={10}
                rx={2}
                className="markov-naive"
              />
              <text x={padL + nw + 4} y={y + 9} className="markov-num">
                {r.naive} est.
              </text>
              <rect
                x={padL}
                y={y + 14}
                width={Math.max(aw, 1)}
                height={10}
                rx={2}
                className="markov-actual"
              />
              <text x={padL + aw + 4} y={y + 23} className="markov-num">
                {r.actual}
                {r.actualSource === "estimated" ? " est." : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="markov-legend muted small">
        <span className="swatch naive" /> naive full-history (estimated)
        <span className="swatch actual" /> chunk input
        {rows.some((r) => r.actualSource === "estimated") && " (est. when not measured)"}
      </p>
    </figure>
  );
}

export function HowAnswerMade({ result, apiOnline }: Props) {
  const [counts, setCounts] = useState<EntityCounts | null>(null);
  const [entityError, setEntityError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiOnline) {
      setCounts(null);
      setEntityError("World model unavailable offline");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchEntities();
        if (!cancelled) {
          setCounts(data.counts);
          setEntityError(null);
        }
      } catch {
        if (!cancelled) {
          setCounts(null);
          setEntityError("Could not load world-model entities");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiOnline, result.generatedAt]);

  const recallLine = recallSummaryLine(result);
  const timingEntries = Object.entries(result.timings)
    .filter(([k]) => k !== "total")
    .sort((a, b) => b[1] - a[1]);

  return (
    <section className="how-answer" aria-label="How this answer was made">
      <h2>How this answer was made</h2>

      {result.markovian && (
        <div className="how-block">
          <h3>Markovian chain</h3>
          <p className="muted small">
            Engine {result.markovian.engine} · status {result.markovian.status}
            {result.engine && result.engine !== "markovian" && ` · result engine ${result.engine}`}
          </p>
          <MarkovianChart chunks={result.markovian.chunks} />
        </div>
      )}

      <div className="how-block">
        <h3>H-MEM recall</h3>
        {recallLine ? (
          <p>{recallLine}</p>
        ) : result.memory ? (
          <p className="muted">No memories recalled for this question.</p>
        ) : (
          <p className="muted">H-MEM report not present on this answer.</p>
        )}
        {result.memory && result.memory.recalled.length > 0 && (
          <ul className="recall-list">
            {result.memory.recalled.map((m) => (
              <li key={m.id}>
                <span className="origin-badge">{m.origin === "user" ? "your note" : "agent finding"}</span>
                <span className="mono">{m.factId}</span>
                <span className="muted small">{m.site ?? "all sites"}</span>
                <span>{m.text.length > 120 ? `${m.text.slice(0, 118)}…` : m.text}</span>
              </li>
            ))}
          </ul>
        )}
        {result.memory?.embedRoute && (
          <p className="muted small">Embed route: {result.memory.embedRoute}</p>
        )}
      </div>

      <div className="how-block">
        <h3>World model</h3>
        {entityError && <p className="muted small">{entityError}</p>}
        {counts && (
          <ul className="entity-counts">
            {Object.entries(counts.entities)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([type, n]) => (
                <li key={type}>
                  <strong>{n}</strong> {type}
                  {n === 1 ? "" : "s"}
                </li>
              ))}
            <li>
              <strong>{counts.relationships}</strong> relationships
            </li>
            <li>
              <strong>{counts.facts}</strong> facts
            </li>
          </ul>
        )}
      </div>

      <div className="how-block">
        <h3>Step timings</h3>
        <ul className="timing-list">
          {timingEntries.map(([step, ms]) => (
            <li key={step}>
              <span>{stepLabel(step)}</span>
              <span className="mono">{(ms / 1000).toFixed(1)} s</span>
            </li>
          ))}
          {result.timings.total != null && (
            <li className="timing-total">
              <span>Total</span>
              <span className="mono">{(result.timings.total / 1000).toFixed(1)} s</span>
            </li>
          )}
        </ul>
      </div>

      {result.llmCalls.length > 0 && (
        <div className="how-block">
          <h3>LLM compute receipts</h3>
          <ul className="llm-routes">
            {result.llmCalls.map((call, i) => (
              <li key={`${call.step}-${i}`}>
                <LlmReceipt call={call} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
