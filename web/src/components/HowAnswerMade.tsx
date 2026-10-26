import { useEffect, useState } from "react";
import { fetchEntities } from "../api/client";
import type { EntityCounts, InvestigationResult, MarkovianReport } from "../types";
import { chunkName, parseChunkRoute, recallSummaryLine, shortSiteName, stepLabel } from "../format";
import { LlmReceipt } from "./LlmReceipt";

interface Props {
  result: InvestigationResult;
  apiOnline: boolean;
  onMemory?: (memoryId: string) => void;
}

function siteName(result: InvestigationResult, id: string): string {
  return result.scope.sites.find((s) => s.id === id)?.name ?? id;
}

function fmt(n: number): string {
  return n.toLocaleString("en-GB");
}

function pct(v: number, max: number): string {
  if (v <= 0) return "2px";
  return `${Math.max((v / max) * 100, 1.5).toFixed(2)}%`;
}

function MarkovianChart({ report }: { report: MarkovianReport }) {
  const { chunks, totals } = report;
  if (chunks.length === 0) return <p className="muted small">No Markovian chunks recorded.</p>;

  // Both series are estimates (ceil(chars / 4)) so they compare like for like;
  // provider-reported counts are shown as a separate, measured detail line.
  const rows = chunks.map((c) => ({
    c,
    ...chunkName(c.label),
    route: parseChunkRoute(c.route),
    chain: c.inputTokens.estimated,
    naive: c.naiveInputTokens,
    measured: c.inputTokens.measured,
  }));
  const max = Math.max(...rows.flatMap((r) => [r.chain, r.naive]), 1);
  const chainTotal = totals?.markovianInputEstimated ?? rows.reduce((a, r) => a + r.chain, 0);
  const naiveTotal = totals?.naiveInputEstimated ?? rows.reduce((a, r) => a + r.naive, 0);
  const less =
    totals?.savedPercentEstimated ??
    (naiveTotal > 0 ? Math.round((1 - chainTotal / naiveTotal) * 100) : 0);
  const hasMeasured = rows.some((r) => r.measured != null);

  return (
    <figure className="markov-chart">
      <figcaption className="markov-summary">
        Chain total ≈ <strong>{fmt(chainTotal)}</strong> tokens vs ≈ <strong>{fmt(naiveTotal)}</strong>{" "}
        naive{less > 0 ? ` (${less}% less)` : ""}, estimated
      </figcaption>
      <ul className="markov-legend" aria-label="Legend">
        <li>
          <span className="swatch chain" aria-hidden /> Chain: input sent to each step
        </li>
        <li>
          <span className="swatch naive" aria-hidden /> Naive: full history re-sent each step
        </li>
      </ul>
      <ol className="markov-rows">
        {rows.map((r) => (
          <li key={r.c.id} className="markov-row">
            <div className="markov-name">
              <strong>{r.name}</strong>
              {r.detail && <span className="markov-detail">{r.detail}</span>}
            </div>
            <div className="markov-bars">
              <div className="markov-bar-row">
                <span className="markov-track">
                  <span className="markov-bar chain" style={{ width: pct(r.chain, max) }} />
                </span>
                <span className="markov-val">
                  {fmt(r.chain)} {r.chain > 0 && <span className="est">est.</span>}
                </span>
              </div>
              <div className="markov-bar-row">
                <span className="markov-track">
                  <span className="markov-bar naive" style={{ width: pct(r.naive, max) }} />
                </span>
                <span className="markov-val">
                  {fmt(r.naive)} {r.naive > 0 && <span className="est">est.</span>}
                </span>
              </div>
            </div>
            {(r.route || r.measured != null) && (
              <p className="markov-meta">
                {r.route && (
                  <span className={`route-badge ${r.route.fallback ? "fallback" : "nightshift"}`}>
                    {r.route.fallback ? "NVIDIA direct · fallback" : "Nightshift"}
                  </span>
                )}
                {r.route && <span className="mono">{r.route.model}</span>}
                {r.measured != null && <span>provider-reported input {fmt(r.measured)}</span>}
              </p>
            )}
          </li>
        ))}
      </ol>
      <p className="markov-foot muted small">
        Estimated = characters ÷ 4 of what each step sends; the naive series re-sends every earlier
        prompt and reply.
        {hasMeasured && " Provider-reported (measured) input counts are listed under the steps that have them."}
      </p>
    </figure>
  );
}

export function HowAnswerMade({ result, apiOnline, onMemory }: Props) {
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
  const maxMs = Math.max(...timingEntries.map(([, ms]) => ms), 1);
  const writtenCount = result.memory?.written.filter((w) => !w.skipped).length ?? 0;

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
          <MarkovianChart report={result.markovian} />
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
                <span className={`origin-badge ${m.origin}`}>
                  {m.origin === "user" ? "your note" : "agent finding"}
                </span>
                <button
                  type="button"
                  className="cite cite-m"
                  onClick={() => onMemory?.(m.id)}
                  title="Open this memory"
                >
                  {m.factId}
                </button>
                <span className="muted small">{m.site ? shortSiteName(siteName(result, m.site)) : "all sites"}</span>
                <span className="recall-text">{m.text}</span>
              </li>
            ))}
          </ul>
        )}
        {writtenCount > 0 && (
          <p className="muted small">
            Wrote {writtenCount} new finding{writtenCount === 1 ? "" : "s"} to memory after verifying
            this answer.
          </p>
        )}
        {result.memory?.embedRoute && (
          <p className="muted small">Embed route: {result.memory.embedRoute}</p>
        )}
      </div>

      {apiOnline && <div className="how-block">
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
      </div>}

      <div className="how-block">
        <h3>Step timings</h3>
        <ul className="timing-list">
          {timingEntries.map(([step, ms]) => (
            <li key={step}>
              <span className="timing-name">{stepLabel(step)}</span>
              <span className="timing-track" aria-hidden>
                <span className="timing-bar" style={{ width: pct(ms, maxMs) }} />
              </span>
              <span className="mono">{(ms / 1000).toFixed(1)} s</span>
            </li>
          ))}
          {result.timings.total != null && (
            <li className="timing-total">
              <span className="timing-name">Total</span>
              <span />
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
