import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { fetchAudit, fetchMemory, postNote } from "../api/client";
import { shortSiteName } from "../format";
import type { LedgerEntry, MemoryRecord } from "../types";

export interface MemoryFocus {
  id: string;
  /** Changes on every click so the same chip can be pressed twice. */
  n: number;
}

interface Props {
  site: string;
  sites: { id: string; name: string }[];
  apiOnline: boolean;
  focus?: MemoryFocus | null;
  /** Memory ids the current answer recalled (marked in the list). */
  recalledIds?: string[];
  /** Changes when a new answer arrives, so the list picks up the findings it wrote. */
  refreshKey?: string;
  /** Without the API (replay), the notes the current answer recalled, taken from the saved answer. */
  offlineNotes?: MemoryRecord[];
}

function siteLabel(sites: { id: string; name: string }[], id?: string): string {
  if (!id) return "All sites";
  const s = sites.find((x) => x.id === id);
  return s ? `${shortSiteName(s.name)} (${s.id})` : id;
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function provenanceLabel(p: unknown): string | null {
  if (p && typeof p === "object" && "label" in p && typeof (p as { label: unknown }).label === "string") {
    return (p as { label: string }).label;
  }
  return null;
}

export function MemoryPanel({ site, sites, apiOnline, focus, recalledIds = [], refreshKey, offlineNotes = [] }: Props) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<MemoryRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [noteSite, setNoteSite] = useState(site === "ALL" ? (sites[0]?.id ?? "S1") : site);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [auditById, setAuditById] = useState<Record<string, LedgerEntry[] | "loading" | "error">>({});
  const [busy, setBusy] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const itemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const sectionRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    if (!apiOnline) {
      setNotes(offlineNotes);
      setError(offlineNotes.length ? null : "This saved answer recalled no notes.");
      setLoaded(true);
      return;
    }
    try {
      setError(null);
      // Always the full list: chips can point at any site, and the grouping shows the rest.
      const list = await fetchMemory("");
      setNotes(Array.isArray(list) ? list : []);
    } catch {
      setNotes([]);
      setError("Memory is not available right now.");
    } finally {
      setLoaded(true);
    }
  }, [apiOnline, offlineNotes]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, refreshKey]);

  useEffect(() => {
    if (site !== "ALL") setNoteSite(site);
  }, [site]);

  // A chip was pressed: open the panel, mark the memory, scroll to it once it is rendered.
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    setHighlightId(focus.id);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    if (!highlightId || !open) return;
    const el = itemRefs.current.get(highlightId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus({ preventScroll: true });
  }, [highlightId, open, notes, focus]);

  const grouped = useMemo(() => {
    const map = new Map<string, MemoryRecord[]>();
    for (const n of notes) {
      const key = n.site ?? "_none";
      map.set(key, [...(map.get(key) ?? []), n]);
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (a === "_none") return 1;
      if (b === "_none") return -1;
      if (a === site) return -1;
      if (b === site) return 1;
      return a.localeCompare(b);
    });
    return keys.map((k) => ({ siteId: k === "_none" ? undefined : k, items: map.get(k)! }));
  }, [notes, site]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !apiOnline || busy) return;
    setBusy(true);
    setSaved(null);
    try {
      await postNote(noteSite, text.trim());
      setText("");
      setSaved(`Saved. It will be recalled the next time a question touches ${siteLabel(sites, noteSite)}.`);
      await load();
    } catch {
      setError("Could not save the note.");
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
    <section className="memory-panel" id="memory-panel" ref={sectionRef} aria-label="H-MEM memory">
      <button
        type="button"
        className="memory-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="toggle-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        H-MEM memory
        {loaded && <span className="muted memory-count">{notes.length} remembered</span>}
      </button>
      {!open && (
        <p className="muted small memory-lede">
          Notes from the owner and findings from earlier investigations, with an audit trail for each.
        </p>
      )}
      {open && (
        <div className="memory-body" id={bodyId}>
          {error && <p className="muted small">{error}</p>}
          {grouped.length === 0 && !error && loaded && <p className="muted">No memories yet.</p>}
          {grouped.map(({ siteId, items }) => (
            <div key={siteId ?? "none"} className="memory-group">
              <h3 className="memory-site">{siteLabel(sites, siteId)}</h3>
              <ul className="memory-list">
                {items.map((n) => {
                  const audit = auditById[n.id];
                  const auditOpen = !!audit && audit !== "error";
                  const focused = highlightId === n.id;
                  const recalled = recalledIds.includes(n.id);
                  const prov = n.origin === "agent" ? provenanceLabel(n.provenance) : null;
                  return (
                    <li
                      key={n.id}
                      id={`memory-${n.id}`}
                      tabIndex={-1}
                      className={`memory-item ${focused ? "focus" : ""}`}
                      ref={(el) => {
                        if (el) itemRefs.current.set(n.id, el);
                        else itemRefs.current.delete(n.id);
                      }}
                    >
                      <div className="note-meta">
                        <span className={`origin-badge ${n.origin}`}>
                          {n.origin === "user" ? "your note" : "agent finding"}
                        </span>
                        {recalled && <span className="recalled-tag">recalled in this answer</span>}
                        <span title="When the memory was learned">learned {fmtDate(n.learnedAt)}</span>
                        {n.validFrom && <span title="The date it applies from">valid from {fmtDate(n.validFrom)}</span>}
                        {Number.isFinite(n.confidence) && <span title="Confidence">confidence {(n.confidence * 100).toFixed(0)}%</span>}
                      </div>
                      <p className="memory-text">{n.text}</p>
                      {prov && <p className="muted small memory-prov">Source: {prov}</p>}
                      {apiOnline && <button
                        type="button"
                        className="text-btn audit-toggle"
                        aria-expanded={auditOpen}
                        onClick={() => void toggleAudit(n.id)}
                      >
                        {auditOpen ? "Hide audit trail" : "Audit trail"}
                      </button>}
                      {audit === "loading" && <p className="muted small">Loading ledger…</p>}
                      {audit === "error" && <p className="muted small">Audit trail not available.</p>}
                      {Array.isArray(audit) && (
                        <ol className="audit-list">
                          {audit.length === 0 && <li className="muted">No ledger entries.</li>}
                          {audit.map((e, i) => (
                            <li key={`${e.timestamp}-${i}`}>
                              <span className="audit-action">{e.action}</span>
                              <span className="audit-actor">by {e.actor}</span>
                              <time dateTime={new Date(e.timestamp).toISOString()}>
                                {fmtDateTime(e.timestamp)}
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

          {apiOnline && <form className="note-form" onSubmit={(e) => void submit(e)}>
            <h3 className="note-form-title">Add a note</h3>
            <label className="site-select compact" htmlFor="note-site">
              <span>Site</span>
              <select
                id="note-site"
                value={noteSite}
                disabled={!apiOnline || busy}
                onChange={(e) => setNoteSite(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {shortSiteName(s.name)} ({s.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="site-select compact" htmlFor="note-text">
              <span>What should Kilowhy know?</span>
              <textarea
                id="note-text"
                rows={3}
                value={text}
                disabled={!apiOnline || busy}
                onChange={(e) => setText(e.target.value)}
                placeholder="e.g. Brixton moved its oven schedule 2 hours later from 7 Oct"
                maxLength={1000}
              />
            </label>
            <div className="note-actions">
              <button type="submit" className="ask-btn small-btn" disabled={!apiOnline || busy || !text.trim()}>
                {busy ? "Saving…" : "Save note"}
              </button>
              {saved && (
                <p className="muted small" role="status">
                  {saved}
                </p>
              )}
            </div>
          </form>}
        </div>
      )}
    </section>
  );
}
