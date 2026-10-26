import { SUGGESTED_QUESTIONS } from "../fixtures";

interface Props {
  question: string;
  site: string;
  sites: { id: string; name: string }[];
  busy: boolean;
  onQuestion: (q: string) => void;
  onSite: (s: string) => void;
  onAsk: () => void;
}

export function QuestionBox({
  question,
  site,
  sites,
  busy,
  onQuestion,
  onSite,
  onAsk,
}: Props) {
  return (
    <section className="question-box" aria-label="Ask a question">
      <div className="question-head">
        <label htmlFor="question-input">Your question</label>
        <span
          className="sample-badge"
          title="Meter kWh are synthetic sample data"
        >
          Meter readings: sample data
        </span>
      </div>
      <textarea
        id="question-input"
        rows={3}
        value={question}
        disabled={busy}
        onChange={(e) => onQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onAsk();
        }}
        placeholder="Why did our electricity cost more in the last four weeks?"
      />
      <div className="question-row">
        <label className="site-select">
          <span>Site</span>
          <select
            value={site}
            disabled={busy}
            onChange={(e) => onSite(e.target.value)}
          >
            <option value="ALL">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name.replace(/^Crumb & Co\s+/, "")} ({s.id})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ask-btn"
          disabled={busy || !question.trim()}
          onClick={onAsk}
        >
          {busy ? "Investigating…" : "Ask Kilowhy"}
        </button>
      </div>
      <div className="suggestions" role="list">
        {SUGGESTED_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className="suggestion"
            role="listitem"
            disabled={busy}
            onClick={() => {
              onQuestion(q);
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </section>
  );
}
