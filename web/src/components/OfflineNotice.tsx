import type { ViewMode } from "./Header";

interface Props {
  mode: ViewMode;
}

export function OfflineNotice({ mode }: Props) {
  if (mode === "live") return null;
  return (
    <p className="offline-notice" role="status">
      {mode === "replay"
        ? "These are saved answers from real Kilowhy runs (meter readings are sample data; prices and weather are real). Pick one below. Asking new questions needs the local stack: see the README."
        : "Zetaris is not running, so new questions cannot run here. The saved answers below are real runs; start the stack with scripts/start_stack.sh to ask your own."}
    </p>
  );
}
