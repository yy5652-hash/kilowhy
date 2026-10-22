import { useEffect, useRef, useState } from "react";
import type { Evidence } from "../types";
import { shortSha, sourceBadges } from "../format";

interface Props {
  evidence: Evidence | null;
  open: boolean;
  onClose: () => void;
}

export function EvidenceDrawer({ evidence, open, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  // Move focus into the drawer when it opens and give it back to the chip that opened it.
  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const t = window.setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 30);
      return () => window.clearTimeout(t);
    }
    returnTo.current?.focus({ preventScroll: true });
    returnTo.current = null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    setCopied(false);
  }, [evidence?.id]);

  const copySql = async () => {
    if (!evidence) return;
    try {
      await navigator.clipboard.writeText(evidence.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? "show" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`evidence-drawer ${open ? "open" : ""}`}
        aria-hidden={!open}
        role="dialog"
        aria-label="Evidence detail"
      >
        {evidence && (
          <>
            <header className="drawer-head">
              <div>
                <p className="drawer-id">{evidence.id}</p>
                <h2>{evidence.title}</h2>
              </div>
              <button
                type="button"
                className="icon-btn"
                ref={closeRef}
                onClick={onClose}
                aria-label="Close evidence"
              >
                ×
              </button>
            </header>

            <div className="drawer-badges">
              {sourceBadges(evidence.sources).map((b) => (
                <span key={b} className="src-badge">
                  {b}
                </span>
              ))}
              <span className="src-badge muted">{evidence.hypothesisId}</span>
            </div>

            <div className="drawer-meta">
              <div>
                <span className="meta-label">Zetaris run</span>
                <code>{evidence.zetarisRunId || "—"}</code>
              </div>
              <div>
                <span className="meta-label">Rows</span>
                <span>{evidence.rowCount}</span>
              </div>
              <div>
                <span className="meta-label">sha256</span>
                <code title={evidence.resultSha256}>{shortSha(evidence.resultSha256, 12)}</code>
              </div>
            </div>

            <div className="sql-block">
              <div className="sql-head">
                <span>SQL as sent to Zetaris</span>
                <button type="button" className="text-btn" onClick={copySql}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre>
                <code>{evidence.sql}</code>
              </pre>
            </div>

            {Object.keys(evidence.metrics).length > 0 && (
              <div className="metrics">
                <h3>Metrics</h3>
                <dl>
                  {Object.entries(evidence.metrics).map(([k, m]) => (
                    <div key={k} className="metric-row">
                      <dt>{k}</dt>
                      <dd>
                        {String(m.value)}
                        {m.unit ? ` ${m.unit}` : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {evidence.sampleRows.length > 0 && (
              <div className="sample-rows">
                <h3>Sample rows</h3>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        {Object.keys(evidence.sampleRows[0]).map((k) => (
                          <th key={k}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {evidence.sampleRows.map((row, i) => (
                        <tr key={i}>
                          {Object.keys(evidence.sampleRows[0]).map((k) => (
                            <td key={k}>{formatCell(row[k])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  return String(v);
}
