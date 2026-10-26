import { ArrowDownRight, Lightbulb } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { InvestigationResult } from "../types";
import { factDisplay } from "../format";
import { SentenceWithCites } from "./CitedText";
export function RecommendationCard({
  result,
  onEvidence,
  compact = false,
}: {
  result: InvestigationResult;
  onEvidence: (id: string) => void;
  compact?: boolean;
}) {
  const { recommendation, answer, facts } = result;
  const tariff = recommendation.tariff,
    load = recommendation.loadShift;
  const f = (key: string) => factDisplay(facts, key) ?? "—";
  return (
    <Card className="recommendation-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lightbulb size={18} />
          What to change
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {tariff?.ok && tariff.windows && (
          <>
            <div className="saving-callout">
              <span>
                {tariff.cheaperInWindowB === "flat"
                  ? "Potential saving on the flat tariff · window B"
                  : "Saved by staying on Agile · window B"}
              </span>
              <strong>
                {tariff.cheaperInWindowB === "flat"
                  ? new Intl.NumberFormat("en-GB", {
                      style: "currency",
                      currency: "GBP",
                    }).format(Math.abs(tariff.windows.B.flatMinusAgileGbp))
                  : f("flat_minus_agile_B")}
              </strong>
              <span>Compared with {tariff.tariff.name}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Window</TableHead>
                  <TableHead>Agile</TableHead>
                  <TableHead>Flat business</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(["A", "B"] as const).map((w) => (
                  <TableRow key={w}>
                    <TableCell>{w}</TableCell>
                    <TableCell className="font-semibold">
                      {f(`agile_total_${w}`)}
                    </TableCell>
                    <TableCell>{f(`flat_total_${w}`)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="muted small">
              Historical comparison on the same usage. {tariff.notAdvice}{" "}
              {tariff.evidence.map((id) => (
                <button
                  className="cite cite-e"
                  key={id}
                  onClick={() => onEvidence(id)}
                >
                  {id}
                </button>
              ))}
            </p>
          </>
        )}
        {load?.ok && (
          <div className="load-shift">
            <ArrowDownRight size={18} />
            <div>
              Moving flexible load would save <strong>{f("rec_saved")}</strong>
              <p className="muted small">
                On window-B prices · meter readings: sample data{" "}
                {load.evidence.map((id) => (
                  <button
                    className="cite cite-e"
                    key={id}
                    onClick={() => onEvidence(id)}
                  >
                    {id}
                  </button>
                ))}
              </p>
            </div>
          </div>
        )}
        {!compact && answer.recommendation?.text && (
          <SentenceWithCites
            text={answer.recommendation.text}
            evidenceIds={answer.recommendation.evidence}
            factIds={answer.recommendation.facts}
            facts={facts}
            onEvidence={onEvidence}
          />
        )}
      </CardContent>
    </Card>
  );
}
