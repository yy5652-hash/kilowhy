import type { InvestigationResult } from "../types";
import { memoryIdFromChip, recallSummaryLine, sentenceCaseHeadline } from "../format";
import { SentenceWithCites } from "./CitedText";
import { Waterfall } from "./Waterfall";

interface Props {
  result: InvestigationResult;
  onEvidence: (id: string) => void;
  onMemory?: (memoryId: string) => void;
}

export function AnswerCard({ result, onEvidence, onMemory }: Props) {
  const { answer, verification, facts, decomposition, sampleDataNote } = result;
  const verified = verification.passed && verification.mode === "llm";
  const template = verification.mode === "template";
  const recallLine = recallSummaryLine(result);

  const openMemory = (chip: string) => {
    const id = memoryIdFromChip(facts, chip);
    if (id) onMemory?.(id);
  };

  return (
    <section className="answer-card" aria-label="Answer">
      <div className="answer-head">
        <h2>{sentenceCaseHeadline(answer.headline)}</h2>
        {verified && (
          <span className="verify-badge ok">Verified: every figure matches its source</span>
        )}
        {template && <span className="verify-badge template">Template answer</span>}
        {!verified && !template && verification.passed === false && (
          <span className="verify-badge warn">Verification incomplete</span>
        )}
      </div>

      {recallLine && <p className="recall-banner">{recallLine}</p>}

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
            onMemory={openMemory}
          />
        ))}
      </div>

      <p className="sample-note">{sampleDataNote || "Meter kWh are SAMPLE data."}</p>
    </section>
  );
}
