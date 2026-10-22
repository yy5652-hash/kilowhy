import type { InvestigationResult } from "../types";
import { SentenceWithCites } from "./CitedText";
import { Waterfall } from "./Waterfall";

interface Props {
  result: InvestigationResult;
  onEvidence: (id: string) => void;
  onMemory?: (id: string) => void;
}

export function AnswerCard({ result, onEvidence, onMemory }: Props) {
  const { answer, verification, facts, decomposition, sampleDataNote } = result;
  const verified = verification.passed && verification.mode === "llm";
  const template = verification.mode === "template";

  return (
    <section className="answer-card" aria-label="Answer">
      <div className="answer-head">
        <h2>{answer.headline}</h2>
        {verified && (
          <span className="verify-badge ok">Verified: every figure matches its source</span>
        )}
        {template && <span className="verify-badge template">Template answer</span>}
        {!verified && !template && verification.passed === false && (
          <span className="verify-badge warn">Verification incomplete</span>
        )}
      </div>

      <Waterfall decomposition={decomposition} facts={facts} />

      <div className="answer-body">
        {answer.sentences.map((s, i) => (
          <SentenceWithCites
            key={i}
            text={s.text}
            evidenceIds={s.evidence}
            factIds={s.facts}
            facts={facts}
            onEvidence={onEvidence}
            onMemory={onMemory}
          />
        ))}
      </div>

      <p className="sample-note">{sampleDataNote || "Meter kWh are SAMPLE data."}</p>
    </section>
  );
}
