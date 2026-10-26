import { CheckCircle2, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RuledOutItem } from "../types";
export function RuledOut({
  items,
  onEvidence,
}: {
  items: RuledOutItem[];
  onEvidence: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Ruled out</CardTitle>
        <p className="muted small">Checked against the evidence.</p>
      </CardHeader>
      <CardContent>
        <ul className="ruled-list">
          {items.map((item, i) => (
            <li key={i}>
              <button
                onClick={() => item.evidence[0] && onEvidence(item.evidence[0])}
              >
                <CheckCircle2 className="text-emerald-600 shrink-0" size={17} />
                <span>
                  <span className="mono muted small">{item.hypothesis}</span>
                  <span className="block">{item.text}</span>
                </span>
                <ChevronRight size={14} className="shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
