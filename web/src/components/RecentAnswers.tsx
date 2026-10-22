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
}

export function RecentAnswers({ answers, busy, onOpen, activeSlug }: Props) {
  if (answers.length === 0) return null;

  return (
    <section className="recent-answers" aria-label="Recent answers">
      <h3>Recent answers</h3>
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
    </section>
  );
}
