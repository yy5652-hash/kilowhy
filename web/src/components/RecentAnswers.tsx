import { sentenceCaseHeadline } from "../format";

interface AnswerMeta {
  slug: string;
  question: string;
  headline?: string;
  generatedAt?: string;
}

interface Props {
  answers: AnswerMeta[];
  busy: boolean;
  onOpen: (slug: string) => void;
  activeSlug?: string | null;
  /** List heading. */
  title: string;
  /** Live mode keeps earlier answers folded away under the question box. */
  collapsible?: boolean;
}

export function RecentAnswers({ answers, busy, onOpen, activeSlug, title, collapsible }: Props) {
  if (answers.length === 0) return null;

  const list = (
      <ul>
        {answers.map((a) => (
          <li key={a.slug}>
            <button
              type="button"
              className={`recent-item ${activeSlug === a.slug ? "active" : ""}`}
              disabled={busy}
              onClick={() => onOpen(a.slug)}
            >
              <span className="recent-q">{a.question}</span>
              {a.headline && (
                <span className="recent-h muted small">{sentenceCaseHeadline(a.headline)}</span>
              )}
              {a.generatedAt && (
                <time className="muted small" dateTime={a.generatedAt}>
                  {new Date(a.generatedAt).toLocaleString("en-GB", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              )}
            </button>
          </li>
        ))}
      </ul>
  );
  if (collapsible)
    return (
      <details className="recent-answers fold-inline">
        <summary>
          {title} ({answers.length})
        </summary>
        {list}
      </details>
    );
  return (
    <section className="recent-answers" aria-label={title}>
      <h3>{title}</h3>
      {list}
    </section>
  );
}
