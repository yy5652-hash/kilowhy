import { useCallback, useEffect, useState, type FormEvent } from "react";
import { fetchAudit, fetchMemory, postNote } from "../api/client";
import type { MemoryNote } from "../types";

interface Props {
  site: string;
  apiOnline: boolean;
  focusId?: string | null;
}

export function MemoryPanel({ site, apiOnline, focusId }: Props) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setError("Memory not available yet (endpoint may 404).");
    }
  }, [apiOnline, site]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (focusId) setOpen(true);
  }, [focusId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !apiOnline) return;
    setBusy(true);
    try {
      await postNote(site === "ALL" ? "ALL" : site, text.trim());
      setText("");
      await load();
    } catch {
      setError("Could not save note.");
    } finally {
      setBusy(false);
    }
  };

  const showAudit = async (id: string) => {
    try {
      const data = await fetchAudit(id);
      setAudit(JSON.stringify(data, null, 2));
    } catch {
      setAudit("Audit trail not available yet.");
    }
  };

  return (
    <section className="memory-panel">
      <button type="button" className="memory-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide memory" : "Show memory"} — notes about sites
      </button>
      {open && (
        <div className="memory-body">
          {error && <p className="muted small">{error}</p>}
          <ul className="memory-list">
            {notes.length === 0 && !error && <li className="muted">No notes yet.</li>}
            {notes.map((n) => (
              <li key={n.id} className={focusId === n.id ? "focus" : ""}>
                <div className="note-meta">
                  <time dateTime={n.createdAt}>
                    {n.createdAt ? new Date(n.createdAt).toLocaleString() : "—"}
                  </time>
                  <span>{n.site}</span>
                  {n.source && <span>{n.source}</span>}
                  <button type="button" className="text-btn" onClick={() => void showAudit(n.id)}>
                    Audit trail
                  </button>
                </div>
                <p>{n.text}</p>
              </li>
            ))}
          </ul>
          <form className="note-form" onSubmit={(e) => void submit(e)}>
            <label htmlFor="note-text">Add a note</label>
            <textarea
              id="note-text"
              rows={3}
              value={text}
              disabled={!apiOnline || busy}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Freezer at Hampstead was repaired on 12 Oct"
            />
            <button type="submit" disabled={!apiOnline || busy || !text.trim()}>
              Save note
            </button>
          </form>
          {audit && (
            <pre className="audit-pre">
              <code>{audit}</code>
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
