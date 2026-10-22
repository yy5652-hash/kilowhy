import type { ApiStatus } from "../types";

interface Props {
  status: ApiStatus | null;
  offline: boolean;
}

export function Header({ status, offline }: Props) {
  const zetarisOk = status?.zetaris.ok ?? false;
  const meterless = status?.meterless.status ?? "offline";
  const meterlessOk = meterless === "online";
  const meterlessLabel = meterlessOk ? "online" : meterless === "unauthorized" ? "unauthorized" : "offline";
  const hint = meterlessOk
    ? null
    : meterless === "unauthorized"
      ? "Nightshift did not accept the key; answers fall back to NVIDIA direct, labelled."
      : "Open Nightshift to use the primary route; answers fall back to NVIDIA direct, labelled.";

  return (
    <header className="site-header">
      <div className="brand">
        <h1 className="wordmark">Kilowhy</h1>
        <p className="tagline">
          Ask why your electricity bill changed. Every number is backed by a query.
        </p>
      </div>
      <div className="status-chips" role="group" aria-label="System status">
        <span className={`chip ${zetarisOk ? "ok" : "amber"}`}>
          <span className="chip-dot" aria-hidden />
          Zetaris · {zetarisOk ? "local" : offline ? "demo" : "unreachable"}
        </span>
        <span className={`chip ${meterlessOk ? "ok" : "amber"}`}>
          <span className="chip-dot" aria-hidden />
          Meterless Nightshift · {meterlessLabel}
        </span>
        <span className={`chip ${meterlessOk ? "ok" : "amber"}`}>
          <span className="chip-dot" aria-hidden />
          {meterlessOk
            ? "Nemotron via Nightshift"
            : offline
              ? "Nemotron · saved answers"
              : status?.fallback.enabled === false
                ? "Nemotron unavailable"
                : "Nemotron via NVIDIA direct (fallback)"}
        </span>
      </div>
      {hint && <p className="status-hint">{hint}</p>}
    </header>
  );
}
