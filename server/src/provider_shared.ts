// Shared types, URL normalisation, env config and error classes for the provider layer.
export type Mode = "deep" | "fast" | "auto";
export type MeterlessStatus = "online" | "unauthorized" | "offline";

export interface Detection { status: MeterlessStatus; baseUrl: string | null; modes: string[] }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; [key: string]: unknown }
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatRequest {
  mode?: Mode; messages: ChatMessage[]; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number; temperature?: number;
}
export interface Usage {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  outputTps: number | null; routerLatencyMs: number | null;
}
export interface Route {
  provider: "meterless" | "nvidia-direct";
  requestedModel: string; routedModel: string | null; label: string | null; kind: string | null; tier: string | null;
  latencyMs: number; receiptId: string | null; raceWidth: number | null; usage: Usage; fallbackReason?: string;
}
export interface ChatResult { content: string; rawContent: string; toolCalls: ToolCall[]; route: Route }
export interface EmbedResult { vectors: number[][]; route: Route }
export interface ProviderStatus {
  meterless: { status: MeterlessStatus; baseUrl: string | null }; fallback: boolean; lastRoute: Route | null;
}

export interface ProviderConfig {
  baseUrl?: string;                 // explicit Meterless URL (any pasted form); tried before auto-detect
  ports?: number[]; hosts?: string[];
  tokenPath?: string; token?: string | null;
  nvidiaBaseUrl?: string;
  nvidiaKey?: string | null;        // undefined: env NVIDIA_API_KEY, then macOS keychain; null: none
  fallback?: boolean;               // default true
  logPath?: string | null;          // null disables the call log
  timeoutMs?: number; detectTimeoutMs?: number; detectTtlMs?: number;
}

// Accept a pasted URL with or without scheme, /v1, /v1/chat/completions, /v1/models or /healthz -> <host>/v1.
export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  s = s.replace(/\/(v1\/(chat\/completions|models|embeddings)|healthz|v1)$/i, "");
  return `${s}/v1`;
}

// Settings for the app's default provider: env only; the injectable createProvider() never reads env.
export function configFromEnv(env: Record<string, string | undefined> = process.env): ProviderConfig {
  const ports = env.KILOWHY_METERLESS_PORTS?.split(",").map((p) => Number(p.trim())).filter((p) => p > 0);
  return {
    baseUrl: env.METERLESS_BASE_URL || undefined,
    ports: ports?.length ? ports : undefined,
    tokenPath: env.KILOWHY_METERLESS_TOKEN_PATH || undefined,
    nvidiaBaseUrl: env.KILOWHY_NVIDIA_BASE_URL || undefined,
    fallback: env.KILOWHY_FALLBACK?.trim().toLowerCase() !== "off",
    logPath: env.KILOWHY_LLM_LOG || undefined,
  };
}

export class UpstreamError extends Error {
  status: number | null;
  retryable: boolean; // true: the endpoint itself is unavailable, so the labelled fallback may answer
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderError"; }
}
