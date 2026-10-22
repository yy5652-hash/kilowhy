import type { EvidenceSource, LlmCall, ProgressEvent, StepName } from "../types";
import { formatRoute, sourceBadges, stepLabel } from "../format";

export interface TimelineEvidence {
  id: string;
  title: string;
  sources: EvidenceSource[];
  rowCount: number;
}

export interface TimelineState {
  steps: Partial<Record<StepName, { status: "started" | "finished"; ms?: number }>>;
  evidence: TimelineEvidence[];
  hypotheses: { id: string; name: string; status: string }[];
  llmCalls: LlmCall[];
  doneMs?: number;
  resetReason?: string;
}

export function emptyTimeline(): TimelineState {
  return { steps: {}, evidence: [], hypotheses: [], llmCalls: [] };
}

export function reduceTimeline(state: TimelineState, event: ProgressEvent): TimelineState {
  switch (event.type) {
    case "reset":
      return { ...emptyTimeline(), resetReason: event.reason };
    case "step":
      return {
        ...state,
        steps: {
          ...state.steps,
          [event.step]: { status: event.status, ms: event.ms },
        },
      };
    case "evidence":
      if (state.evidence.some((e) => e.id === event.evidence.id)) return state;
      return {
        ...state,
        evidence: [
          ...state.evidence,
          {
            id: event.evidence.id,
            title: event.evidence.title,
            sources: event.evidence.sources,
            rowCount: event.evidence.rowCount,
          },
        ],
      };
    case "hypothesis":
      return {
        ...state,
        hypotheses: [
          ...state.hypotheses.filter((h) => h.id !== event.id),
          { id: event.id, name: event.name, status: event.status },
        ],
      };
    case "llm":
      return { ...state, llmCalls: [...state.llmCalls, event.call] };
    case "done":
      return { ...state, doneMs: event.totalMs };
    default:
      return state;
  }
}

const STAGE_ORDER: { label: string; steps: StepName[] }[] = [
  { label: "Understand question", steps: ["sites", "intent", "plan"] },
  { label: "Split the bill", steps: ["data"] },
  { label: "Test hypotheses", steps: ["hypotheses", "extraSql", "recommend"] },
  { label: "Write answer", steps: ["facts", "narrative", "template"] },
  { label: "Verify every figure", steps: ["narrative", "template"] },
];

interface Props {
  state: TimelineState;
  visible: boolean;
  onOpenEvidence: (id: string) => void;
}

export function Timeline({ state, visible, onOpenEvidence }: Props) {
  if (!visible) return null;

  return (
    <section className="timeline" aria-live="polite" aria-label="Live investigation">
      <h2>Investigation</h2>
      {state.resetReason && (
        <p className="timeline-reset">Scope changed — restarting evidence ({state.resetReason})</p>
      )}
      <ol className="timeline-stages">
        {STAGE_ORDER.map((stage) => {
          const statuses = stage.steps.map((s) => state.steps[s]?.status);
          const active = statuses.includes("started");
          const done = stage.steps.some((s) => state.steps[s]?.status === "finished");
          const ms = stage.steps.reduce((a, s) => a + (state.steps[s]?.ms ?? 0), 0);
          return (
            <li key={stage.label} className={`stage ${active ? "active" : ""} ${done ? "done" : ""}`}>
              <span className="stage-dot" aria-hidden />
              <span className="stage-label">{stage.label}</span>
              {done && ms > 0 && <span className="stage-ms">{(ms / 1000).toFixed(1)} s</span>}
            </li>
          );
        })}
      </ol>

      {state.llmCalls.length > 0 && (
        <ul className="llm-routes">
          {state.llmCalls.map((call, i) => (
            <li key={`${call.step}-${i}`} className={call.route?.provider === "nvidia-direct" ? "fallback" : ""}>
              <span className="llm-step">{stepLabel(call.step)}</span>
              {call.route ? (
                <span className="llm-route">{formatRoute(call.route)}</span>
              ) : (
                <span className="llm-route error">{call.error ?? "no route"}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {state.evidence.length > 0 && (
        <div className="evidence-stream">
          <h3>Evidence gathered</h3>
          <ul>
            {state.evidence.map((e) => (
              <li key={e.id}>
                <button type="button" className="evidence-pill" onClick={() => onOpenEvidence(e.id)}>
                  <strong>{e.id}</strong>
                  <span className="ev-title">{e.title}</span>
                  <span className="ev-badges">
                    {sourceBadges(e.sources).map((b) => (
                      <span key={b} className="src-badge">
                        {b}
                      </span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.doneMs != null && (
        <p className="timeline-done">Finished in {(state.doneMs / 1000).toFixed(1)} s</p>
      )}
    </section>
  );
}
