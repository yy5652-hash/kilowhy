import { useId, useState } from "react";
import type { LlmCall } from "../types";
import { stepLabel } from "../format";

interface Props {
  call: LlmCall;
  /** The compact one-line summary is always visible; expand for the Nightshift receipt fields. */
  defaultOpen?: boolean;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function num(n: number): string {
  return n.toLocaleString("en-GB");
}

export function LlmReceipt({ call, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const route = call.route;
  const isFallback = route?.provider === "nvidia-direct";
  const usage = route?.usage;
  const hasUsage = usage != null && (usage.inputTokens != null || usage.outputTokens != null);
  const totalTok =
    usage?.totalTokens ?? (hasUsage ? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) : null);

  return (
    <div className={`llm-receipt ${isFallback ? "fallback" : ""} ${open ? "open" : ""}`}>
      <button
        type="button"
        className="llm-receipt-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={!route}
        onClick={() => route && setOpen((v) => !v)}
      >
        <span className="llm-step">{stepLabel(call.step)}</span>
        {route ? (
          <>
            <span className={`route-badge ${isFallback ? "fallback" : "nightshift"}`}>
              {isFallback ? "NVIDIA direct · fallback" : "Nightshift receipt"}
            </span>
            <span className="llm-route">
              {route.label ?? route.routedModel ?? "Nemotron"}
              <span className="llm-sep"> · </span>
              {secs(route.latencyMs)}
              {totalTok != null && (
                <>
                  <span className="llm-sep"> · </span>
                  {num(totalTok)} tok
                </>
              )}
              {!isFallback && route.raceWidth != null && route.raceWidth > 1 && (
                <>
                  <span className="llm-sep"> · </span>race of {route.raceWidth}
                </>
              )}
              {route.fromCache && (
                <>
                  <span className="llm-sep"> · </span>cached
                </>
              )}
            </span>
          </>
        ) : (
          <span className="llm-route error">{call.error ?? "no route reported"}</span>
        )}
        {route && (
          <span className="llm-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>

      {open && route && (
        <dl className="receipt-fields" id={panelId}>
          <div>
            <dt>Receipt id</dt>
            <dd>
              {route.receiptId ? (
                <code>{route.receiptId}</code>
              ) : (
                <span className="muted">
                  none{isFallback ? " (a NVIDIA-direct fallback has no Nightshift receipt)" : ""}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Route</dt>
            <dd>
              {isFallback ? (
                <span className="fallback-tag">NVIDIA direct (fallback)</span>
              ) : (
                <span className="nightshift-tag">Meterless Nightshift</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Requested → routed</dt>
            <dd>
              <code>{route.requestedModel}</code>
              <span className="arrow"> → </span>
              <code>{route.routedModel ?? "—"}</code>
            </dd>
          </div>
          <div>
            <dt>Label</dt>
            <dd>{route.label ?? "—"}</dd>
          </div>
          <div>
            <dt>Tier</dt>
            <dd>
              {route.tier ?? "—"}
              {route.kind && <span className="muted"> ({route.kind})</span>}
            </dd>
          </div>
          <div>
            <dt>Race width</dt>
            <dd>{route.raceWidth ?? "—"}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>
              {secs(route.latencyMs)}
              {call.wallMs != null && Math.abs(call.wallMs - route.latencyMs) > 50 && (
                <span className="muted"> (wall {secs(call.wallMs)})</span>
              )}
              {usage?.routerLatencyMs != null && (
                <span className="muted"> · router {secs(usage.routerLatencyMs)}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Token usage</dt>
            <dd>
              {hasUsage ? (
                <>
                  in {usage?.inputTokens != null ? num(usage.inputTokens) : "—"} · out{" "}
                  {usage?.outputTokens != null ? num(usage.outputTokens) : "—"}
                  {totalTok != null && <> · total {num(totalTok)}</>}
                  {usage?.outputTps != null && <> · {usage.outputTps.toFixed(1)} tok/s</>}
                </>
              ) : (
                <span className="muted">not reported</span>
              )}
            </dd>
          </div>
          {route.fallbackReason && (
            <div>
              <dt>Fallback reason</dt>
              <dd>{route.fallbackReason}</dd>
            </div>
          )}
          {route.fromCache && (
            <div>
              <dt>Cache</dt>
              <dd>answered from the Nightshift response cache</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
