import type { RuledOutItem } from "../types";

interface Props {
  items: RuledOutItem[];
  onEvidence: (id: string) => void;
}

export function RuledOut({ items, onEvidence }: Props) {
  if (!items.length) return null;
  return (
    <section className="ruled-out" aria-label="Ruled-out causes">
      <h2>Ruled out</h2>
      <ul className="ruled-chips">
        {items.map((item, i) => (
          <li key={`${item.hypothesis}-${i}`}>
            <button
              type="button"
              className="ruled-chip"
              onClick={() => item.evidence[0] && onEvidence(item.evidence[0])}
              title={item.evidence.join(", ")}
            >
              <span className="ruled-hyp">{item.hypothesis}</span>
              <span className="ruled-text">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
