import { useState } from "react";
import type { LlmCall } from "../types";
import { formatRoute, stepLabel } from "../format";

interface Props {
  call: LlmCall;
  /** Compact one-line summary always visible; expand for Nightshift receipt fields. */
  defaultOpen?: boolean;
}

export function LlmReceipt({ call, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const route = call.route;
  const isFallback = route?.provider === "nvidia-direct";
  const canExpand = !!route;

  return (
    <div className={`llm-receipt ${isFallback ? "fallback" : ""}`}>
      <button
        type="button"
        className="llm-receipt-toggle"
        aria-expanded={open}
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((v) => !v)}
      >
        <span className="llm-step">{stepLabel(call.step)}</span>
        {route ? (
          <span className="llm-route">
            {formatRoute(route)}
            {isFallback && <span className="fallback-tag"> NVIDIA-direct fallback</span>}
          </span>
        ) : (
          <span className="llm-route error">{call.error ?? "no route"}</span>
        )}
        {canExpand && <span className="llm-chevron" aria-hidden>{open ? "▾" : "▸"}</span>}
      </button>

      {open && route && (
        <dl className="receipt-fields">
          <div>
            <dt>Receipt id</dt>
            <dd>
              {route.receiptId ?? (
                <span className="muted">
                  none{isFallback ? " (NVIDIA-direct fallback — no Nightshift receipt)" : ""}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Requested → routed</dt>
            <dd>
              <code>{route.requestedModel}</code>
              {" → "}
              <code>{route.routedModel ?? "—"}</code>
            </dd>
          </div>
          <div>
            <dt>Label</dt>
            <dd>
              {route.label ?? "—"}
              {isFallback && (
                <span className="fallback-tag"> · NVIDIA-direct fallback</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Tier</dt>
            <dd>{route.tier ?? "—"}</dd>
          </div>
          <div>
            <dt>Race width</dt>
            <dd>{route.raceWidth ?? "—"}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>
              {(route.latencyMs / 1000).toFixed(2)} s
              {call.wallMs != null && call.wallMs !== route.latencyMs && (
                <span className="muted"> (wall {(call.wallMs / 1000).toFixed(2)} s)</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Token usage</dt>
            <dd>
              {route.usage.inputTokens != null || route.usage.outputTokens != null ? (
                <>
                  in {route.usage.inputTokens ?? "—"} · out {route.usage.outputTokens ?? "—"}
                  {route.usage.totalTokens != null && <> · total {route.usage.totalTokens}</>}
                  {route.usage.outputTps != null && (
                    <> · {route.usage.outputTps.toFixed(1)} tok/s</>
                  )}
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
              <dd>answered from Nightshift response cache</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
