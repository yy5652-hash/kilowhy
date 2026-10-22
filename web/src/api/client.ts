import type {
  AnswerListItem,
  ApiStatus,
  AskHandlers,
  EntitiesResponse,
  InvestigateOutcome,
  InvestigationResult,
  LedgerEntry,
  MemoryRecord,
  ProgressEvent,
  StepName,
} from "../types";

const API = "/api";

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchStatus(): Promise<ApiStatus> {
  const res = await fetch(`${API}/status`);
  return jsonOrThrow<ApiStatus>(res);
}

export async function fetchAnswers(): Promise<AnswerListItem[]> {
  const res = await fetch(`${API}/answers`);
  return jsonOrThrow(res);
}

export async function fetchAnswer(slug: string): Promise<InvestigationResult> {
  const res = await fetch(`${API}/answers/${encodeURIComponent(slug)}`);
  return jsonOrThrow<InvestigationResult>(res);
}

export async function fetchMemory(site?: string): Promise<MemoryRecord[]> {
  const q = site ? `?site=${encodeURIComponent(site)}` : "";
  const res = await fetch(`${API}/memory${q}`);
  if (res.status === 404) return [];
  return jsonOrThrow<MemoryRecord[]>(res);
}

export async function postNote(site: string, text: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site, text }),
  });
  return jsonOrThrow<{ id: string }>(res);
}

export async function fetchAudit(id: string): Promise<LedgerEntry[]> {
  const res = await fetch(`${API}/memory/${encodeURIComponent(id)}/audit`);
  if (res.status === 404) throw new Error("Audit not available yet");
  return jsonOrThrow<LedgerEntry[]>(res);
}

export async function fetchEntities(): Promise<EntitiesResponse> {
  const res = await fetch(`${API}/entities`);
  return jsonOrThrow<EntitiesResponse>(res);
}

/** Parse SSE from a POST ReadableStream (not EventSource). */
export async function askQuestion(
  body: { question: string; site?: string },
  handlers: AskHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const name = eventName;
    eventName = "message";
    try {
      const payload = JSON.parse(raw) as unknown;
      if (name === "progress") handlers.onProgress(payload as ProgressEvent);
      else if (name === "result") handlers.onResult(payload as InvestigateOutcome);
      else if (name === "error") {
        const msg =
          typeof payload === "string"
            ? payload
            : (payload as { message?: string }).message ?? "Investigation failed";
        handlers.onError(msg);
      }
    } catch {
      handlers.onError(`Could not parse SSE ${name} payload`);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (line === "") {
        flush();
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  flush();
}

/** Simulate progress events when serving a fixture offline. */
export function simulateProgress(
  result: InvestigationResult,
  onProgress: (e: ProgressEvent) => void,
): Promise<void> {
  const steps: StepName[] = [
    "intent",
    "plan",
    "data",
    "hypotheses",
    "recommend",
    "facts",
    "narrative",
  ];
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      if (i < steps.length) {
        const step = steps[i];
        onProgress({ type: "step", step, status: "started" });
        if (step === "data" || step === "hypotheses") {
          const chunk = result.evidence.slice(
            step === "data" ? 0 : Math.min(3, result.evidence.length),
            step === "data" ? Math.min(3, result.evidence.length) : result.evidence.length,
          );
          for (const e of chunk) {
            onProgress({
              type: "evidence",
              evidence: {
                id: e.id,
                hypothesisId: e.hypothesisId,
                title: e.title,
                rowCount: e.rowCount,
                zetarisRunId: e.zetarisRunId,
                sources: e.sources,
              },
            });
          }
        }
        if (step === "hypotheses") {
          for (const h of result.results) {
            onProgress({ type: "hypothesis", id: h.id, name: h.name, status: h.status });
          }
        }
        if (step === "intent" || step === "plan" || step === "narrative") {
          const call = result.llmCalls.find((c) => c.step === step) ?? result.llmCalls[0];
          if (call) onProgress({ type: "llm", call });
        }
        onProgress({ type: "step", step, status: "finished", ms: result.timings[step] ?? 120 });
        i += 1;
        setTimeout(tick, 180);
        return;
      }
      onProgress({ type: "done", totalMs: result.timings.total ?? 0 });
      resolve();
    };
    tick();
  });
}
