import type { Fact, InvestigationResult } from "../types";
import { factDisplay } from "../format";
import { SentenceWithCites } from "./CitedText";

interface Props {
  result: InvestigationResult;
  onEvidence: (id: string) => void;
}

function moneyFact(facts: Fact[], key: string, fallback: string): string {
  return factDisplay(facts, key) ?? fallback;
}

export function RecommendationCard({ result, onEvidence }: Props) {
  const { recommendation, answer, facts } = result;
  const tariff = recommendation.tariff;
  const load = recommendation.loadShift;
  if (!tariff && !load && !answer.recommendation?.text) return null;

  const agileA = moneyFact(facts, "agile_total_A", "—");
  const agileB = moneyFact(facts, "agile_total_B", "—");
  const flatA = moneyFact(facts, "flat_total_A", "—");
  const flatB = moneyFact(facts, "flat_total_B", "—");
  const saved = moneyFact(facts, "rec_saved", load ? `£${load.total.savedGbp.toFixed(2)}` : "—");
  const kg =
    factDisplay(facts, "rec_saved_kg") ??
    (load?.total.savedKgCo2e != null ? `${load.total.savedKgCo2e.toFixed(2)} kgCO2e` : "—");

  return (
    <section className="rec-card" aria-label="Recommendations">
      <h2>What to change</h2>

      {answer.recommendation?.text && (
        <SentenceWithCites
          text={answer.recommendation.text}
          evidenceIds={answer.recommendation.evidence}
          factIds={answer.recommendation.facts}
          facts={facts}
          onEvidence={onEvidence}
        />
      )}

      {tariff?.ok && tariff.windows && (
        <div className="tariff-table-wrap">
          <h3>Tariff counterfactual</h3>
          <p className="muted small">{tariff.tariff.name} vs Agile · {tariff.notAdvice}</p>
          <table className="tariff-table">
            <thead>
              <tr>
                <th>Window</th>
                <th>Agile (actual)</th>
                <th>Flat business</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>A</td>
                <td>{agileA}</td>
                <td>{flatA}</td>
              </tr>
              <tr>
                <td>B</td>
                <td>{agileB}</td>
                <td>{flatB}</td>
              </tr>
            </tbody>
          </table>
          {tariff.cheaperInWindowB && (
            <p className="muted">
              Cheaper in window B:{" "}
              {tariff.cheaperInWindowB === "equal" ? "roughly equal" : tariff.cheaperInWindowB}
            </p>
          )}
          {tariff.evidence[0] && (
            <button type="button" className="cite cite-e" onClick={() => onEvidence(tariff.evidence[0])}>
              {tariff.evidence[0]}
            </button>
          )}
        </div>
      )}

      {load?.ok && (
        <div className="load-shift">
          <h3>Load shift (peak → cheaper hours)</h3>
          <p>
            Potential save <strong>{saved}</strong>
            {load.total.savedKgCo2e != null && (
              <>
                {" "}
                and <strong>{kg}</strong>
              </>
            )}{" "}
            on window-B prices (sample meter data).
          </p>
          <p className="muted small">{load.text}</p>
          {load.evidence[0] && (
            <button type="button" className="cite cite-e" onClick={() => onEvidence(load.evidence[0])}>
              {load.evidence[0]}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
