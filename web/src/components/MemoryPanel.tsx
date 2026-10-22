import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { fetchAudit, fetchMemory, postNote } from "../api/client";
import type { LedgerEntry, MemoryRecord } from "../types";

interface Props {
  site: string;
  sites: { id: string; name: string }[];
  apiOnline: boolean;
  /** Underlying memory id (mem-…) or M# fact id resolved by the parent. */
  focusId?: string | null;
  recallLine?: string | null;
}

function siteLabel(sites: { id: string; name: string }[], id?: string): string {
  if (!id) return "All sites";
  const s = sites.find((x) => x.id === id);
  if (!s) return id;
  return s.name.replace(/^Crumb & Co\s+/, "");
}

function day(iso?: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export function MemoryPanel({ site, sites, apiOnline, focusId, recallLine }: Props) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<MemoryRecord[]>([]);
  const [noteSite, setNoteSite] = useState(site === "ALL" ? (sites[0]?.id ?? "S1") : site);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [auditById, setAuditById] = useState<Record<string, LedgerEntry[] | "loading" | "error">>({});
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const load = useCallback(async () => {
    if (!apiOnline) {
      setNotes([]);
      setError("Memory API unavailable offline");
      return;
    }
    try {
      setError(null);
      const list = await fetchMemory(site === "ALL" ? "" : site);
      setNotes(Array.isArray(list) ? list : []);
    } catch {
      setNotes([]);
      setError("Memory not available yet.");
    }
  }, [apiOnline, site]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (site !== "ALL") setNoteSite(site);
  }, [site]);

  useEffect(() => {
    if (!focusId) return;
    setOpen(true);
    setHighlightId(focusId);
    // Scroll after list may load
    const t = window.setTimeout(() => {
      const el = itemRefs.current.get(focusId);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [focusId]);

  useEffect(() => {
    if (!highlightId || notes.length === 0) return;
    const el = itemRefs.current.get(highlightId);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlightId, notes]);

  const grouped = useMemo(() => {
    const map = new Map<string, MemoryRecord[]>();
    for (const n of notes) {
      const key = n.site ?? "_none";
      const arr = map.get(key) ?? [];
      arr.push(n);
      map.set(key, arr);
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (a === "_none") return 1;
      if (b === "_none") return -1;
      return a.localeCompare(b);
    });
    return keys.map((k) => ({ siteId: k === "_none" ? undefined : k, items: map.get(k)! }));
  }, [notes]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !apiOnline) return;
    setBusy(true);
    try {
      await postNote(noteSite, text.trim());
      setText("");
      await load();
    } catch {
      setError("Could not save note.");
    } finally {
      setBusy(false);
    }
  };

  const toggleAudit = async (id: string) => {
    if (auditById[id] && auditById[id] !== "error") {
      setAuditById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setAuditById((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const data = await fetchAudit(id);
      setAuditById((prev) => ({ ...prev, [id]: Array.isArray(data) ? data : [] }));
    } catch {
      setAuditById((prev) => ({ ...prev, [id]: "error" }));
    }
  };

  return (
    <section className="memory-panel" id="memory-panel">
      <button type="button" className="memory-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : "Show"} H-MEM memory
      </button>
      {recallLine && <p className="recall-banner">{recallLine}</p>}
      {open && (
        <div className="memory-body">
          {error && <p className="muted small">{error}</p>}
          {grouped.length === 0 && !error && <p className="muted">No memories yet.</p>}
          {grouped.map(({ siteId, items }) => (
            <div key={siteId ?? "none"} className="memory-group">
              <h3 className="memory-site">{siteLabel(sites, siteId)}</h3>
              <ul className="memory-list">
                {items.map((n) => {
                  const audit = auditById[n.id];
                  const focused = highlightId === n.id;
                  return (
                    <li
                      key={n.id}
                      id={`memory-${n.id}`}
                      className={focused ? "focus" : ""}
                      ref={(el) => {
                        if (el) itemRefs.current.set(n.id, el);
                        else itemRefs.current.delete(n.id);
                      }}
                    >
                      <div className="note-meta">
                        <span className={`origin-badge ${n.origin}`}>
                          {n.origin === "user" ? "your note" : "agent finding"}
                        </span>
                        <span title="Learned">learned {day(n.learnedAt)}</span>
                        {n.validFrom && <span title="Valid from">from {day(n.validFrom)}</span>}
                        <span title="Confidence">confidence {(n.confidence * 100).toFixed(0)}%</span>
                        <button
                          type="button"
                          className="text-btn"
                          aria-expanded={!!audit && audit !== "error"}
                          onClick={() => void toggleAudit(n.id)}
                        >
                          Audit trail
                        </button>
                      </div>
                      <p>{n.text}</p>
                      {audit === "loading" && <p className="muted small">Loading ledger…</p>}
                      {audit === "error" && <p className="muted small">Audit trail not available.</p>}
                      {Array.isArray(audit) && (
                        <ol className="audit-list">
                          {audit.length === 0 && <li className="muted">No ledger entries.</li>}
                          {audit.map((e, i) => (
                            <li key={`${e.timestamp}-${i}`}>
                              <span className="audit-action">{e.action}</span>
                              <span className="audit-actor">{e.actor}</span>
                              <time dateTime={new Date(e.timestamp).toISOString()}>
                                {new Date(e.timestamp).toLocaleString()}
                              </time>
                            </li>
                          ))}
                        </ol>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <form className="note-form" onSubmit={(e) => void submit(e)}>
            <label htmlFor="note-site">Add a note</label>
            <label className="site-select compact">
              <span>Site</span>
              <select
                id="note-site"
                value={noteSite}
                disabled={!apiOnline || busy}
                onChange={(e) => setNoteSite(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name.replace(/^Crumb & Co\s+/, "")} ({s.id})
                  </option>
                ))}
              </select>
            </label>
            <textarea
              id="note-text"
              rows={3}
              value={text}
              disabled={!apiOnline || busy}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Freezer at Hampstead was repaired on 12 Oct"
              maxLength={1000}
            />
            <button type="submit" disabled={!apiOnline || busy || !text.trim()}>
              Save note
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
