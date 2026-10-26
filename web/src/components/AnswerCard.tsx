import { BadgeCheck, BarChart3, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { InvestigationResult } from "../types";
import { memoryIdFromChip, recallSummaryLine } from "../format";
import { SentenceWithCites } from "./CitedText";
import { Waterfall } from "./Waterfall";
export function AnswerCard({
  result,
  onEvidence,
  onMemory,
}: {
  result: InvestigationResult;
  onEvidence: (id: string) => void;
  onMemory?: (id: string) => void;
}) {
  const { answer, facts, decomposition } = result;
  return (
    <div className="answer-column">
      <Card>
        <CardHeader>
          <div className="card-heading">
            <CardTitle>
              <BarChart3 size={17} />
              Every pound, accounted for
            </CardTitle>
            <span className="muted small">Window A → Window B</span>
          </div>
        </CardHeader>
        <CardContent>
          <Waterfall
            decomposition={decomposition}
            facts={facts}
            onEvidence={onEvidence}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <FileText size={17} />
            The answer, with receipts
          </CardTitle>
          <p className="muted small">
            E = query evidence · F = verified fact · M = remembered note
          </p>
        </CardHeader>
        <CardContent>
          <div className="answer-body">
            {answer.sentences.map((s, i) => (
              <SentenceWithCites
                key={i}
                text={s.text}
                evidenceIds={s.evidence}
                factIds={s.facts}
                facts={facts}
                onEvidence={onEvidence}
                onMemory={(chip) => {
                  const id = memoryIdFromChip(facts, chip);
                  if (id) onMemory?.(id);
                }}
              />
            ))}
          </div>
          {recallSummaryLine(result) && (
            <div className="recall-banner">
              <BadgeCheck size={16} />
              {recallSummaryLine(result)}{" "}
              {result.memory?.recalled.map((m) => (
                <button
                  key={m.id}
                  className="cite cite-m"
                  onClick={() => onMemory?.(m.id)}
                >
                  {m.factId}
                </button>
              ))}
            </div>
          )}
          <p className="sample-note">
            Meter readings: sample data. Prices, weather, carbon and generation:
            real public data.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
