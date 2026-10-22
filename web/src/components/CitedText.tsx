import type { ReactNode } from "react";
import type { Fact } from "../types";
import { factById } from "../format";

interface Props {
  text: string;
  facts: Fact[];
  onEvidence: (id: string) => void;
  onMemory?: (id: string) => void;
}

const CHIP_RE = /\[([EFM]\d+)\]/g;

export function CitedText({ text, facts, onEvidence, onMemory }: Props) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(CHIP_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const id = m[1];
    const kind = id[0];
    if (kind === "E") {
      nodes.push(
        <button
          key={`${id}-${m.index}`}
          type="button"
          className="cite cite-e"
          onClick={() => onEvidence(id)}
          title={`Open evidence ${id}`}
        >
          {id}
        </button>,
      );
    } else if (kind === "F") {
      const fact = factById(facts, id);
      const tip = fact ? `${fact.label}: ${fact.display}` : id;
      nodes.push(
        <span key={`${id}-${m.index}`} className="cite cite-f" title={tip} tabIndex={0}>
          {id}
        </span>,
      );
    } else {
      nodes.push(
        <button
          key={`${id}-${m.index}`}
          type="button"
          className="cite cite-m"
          onClick={() => onMemory?.(id)}
          title={`Open memory ${id}`}
        >
          {id}
        </button>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));

  // Also chip bare E# / F# / M# that the narrative lists without brackets
  // (sentences often cite via the AnswerItem arrays; text already has figures).
  return <span className="cited-text">{nodes}</span>;
}

/** Append citation chips from the answer item's evidence/facts arrays when not already in the text. */
export function SentenceWithCites({
  text,
  evidenceIds,
  factIds,
  facts,
  onEvidence,
  onMemory,
}: {
  text: string;
  evidenceIds: string[];
  factIds: string[];
  facts: Fact[];
  onEvidence: (id: string) => void;
  onMemory?: (id: string) => void;
}) {
  const present = new Set<string>();
  for (const m of text.matchAll(/\[?([EFM]\d+)\]?/g)) present.add(m[1]);
  const extraE = evidenceIds.filter((id) => !present.has(id));
  const extraAll = factIds.filter((id) => !present.has(id));
  const extraM = extraAll.filter((id) => id.startsWith("M"));
  const extraF = extraAll.filter((id) => !id.startsWith("M")).slice(0, 6);

  return (
    <p className="sentence">
      <CitedText text={text} facts={facts} onEvidence={onEvidence} onMemory={onMemory} />
      {(extraE.length > 0 || extraF.length > 0 || extraM.length > 0) && (
        <span className="cite-trail">
          {extraE.map((id) => (
            <button
              key={id}
              type="button"
              className="cite cite-e"
              onClick={() => onEvidence(id)}
              title={`Open evidence ${id}`}
            >
              {id}
            </button>
          ))}
          {extraM.map((id) => (
            <button
              key={id}
              type="button"
              className="cite cite-m"
              onClick={() => onMemory?.(id)}
              title={`Open memory ${id}`}
            >
              {id}
            </button>
          ))}
          {extraF.map((id) => {
            const fact = factById(facts, id);
            return (
              <span
                key={id}
                className="cite cite-f"
                title={fact ? `${fact.label}: ${fact.display}` : id}
                tabIndex={0}
              >
                {id}
              </span>
            );
          })}
        </span>
      )}
    </p>
  );
}
