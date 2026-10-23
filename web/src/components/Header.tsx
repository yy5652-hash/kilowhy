import type { ApiStatus } from "../types";

export type ViewMode = "live" | "saved" | "replay";

interface Props {
  status: ApiStatus | null;
  mode: ViewMode;
}

/** One status chip: what this page can do right now. */
function statusLine(status: ApiStatus | null, mode: ViewMode): { label: string; ok: boolean; title: string } {
  if (mode === "replay") return { label: "Replay of saved real runs", ok: true, title: "No server here: the answers are bundled real runs" };
  if (mode === "saved") return { label: "Saved answers · Zetaris not running", ok: false, title: "Start the stack (scripts/start_stack.sh) to ask new questions" };
  const nightshift = status?.meterless.status === "online";
  return nightshift
    ? { label: "Live · Zetaris + Nemotron via Nightshift", ok: true, title: "Every model call goes through Meterless Nightshift" }
    : { label: "Live · Nightshift offline, NVIDIA fallback", ok: false, title: "Open Nightshift to use the primary route; fallback calls are labelled" };
}

export function Header({ status, mode }: Props) {
  const s = statusLine(status, mode);
  return (
    <header className="site-header">
      <div className="brand">
        <h1 className="wordmark">Kilowhy</h1>
        <p className="tagline">
          Ask why your electricity bill changed. Every number is backed by a query.
        </p>
      </div>
      <div className="status-chips" role="status" aria-label="System status">
        <span className={`chip ${s.ok ? "ok" : "amber"}`} title={s.title}>
          <span className="chip-dot" aria-hidden />
          {s.label}
        </span>
      </div>
    </header>
  );
}
