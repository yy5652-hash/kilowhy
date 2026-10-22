import type { ApiStatus } from "../types";

interface Props {
  status: ApiStatus | null;
  offline: boolean;
}

export function Header({ status, offline }: Props) {
  const zetarisOk = status?.zetaris.ok ?? false;
  const meterless = status?.meterless.status ?? "offline";
  const meterlessLabel =
    meterless === "online" ? "online" : meterless === "unauthorized" ? "unauthorized" : "offline";

  return (
    <header className="site-header">
      <div className="brand">
        <h1 className="wordmark">Kilowhy</h1>
        <p className="tagline">
          Ask why your electricity bill changed. Every number is backed by a query.
        </p>
      </div>
      <div className="status-chips" aria-label="System status">
        <span className={`chip ${zetarisOk ? "ok" : "warn"}`}>
          Zetaris · {zetarisOk ? "local" : offline ? "demo" : "unreachable"}
        </span>
        <span className={`chip ${meterless === "online" ? "ok" : "warn"}`}>
          Meterless Nightshift · {meterlessLabel}
        </span>
        <span className="chip ok">Nemotron via Nightshift</span>
      </div>
    </header>
  );
}
