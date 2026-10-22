// LLM provider layer. Primary: Meterless Nightshift (provider contract v4, OpenAI-compatible, local).
// Fallback (labelled, never silent): NVIDIA's hosted API directly. Every call returns a `route` that says
// what actually answered, and one JSON line per call is appended to data/cache/llm-calls.jsonl
// (prompt hash only; no prompts, tokens or keys).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanContent, extractJson } from "./provider_text.ts";
import {
  normalizeBaseUrl, configFromEnv, ProviderError, UpstreamError,
  type ChatMessage, type ChatRequest, type ChatResult, type Detection, type EmbedResult, type Mode,
  type ProviderConfig, type ProviderStatus, type Route, type ToolCall, type Usage,
} from "./provider_shared.ts";

export * from "./provider_shared.ts";
export { cleanContent, extractJson };

const APP_ID = "kilowhy";
const DEFAULT_PORTS = [8088, 8090, 8787, 11434];
const DEFAULT_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
// Preferred direct-NVIDIA model first. Catalogue entries can be listed yet not invokable for an account
// (measured 2026-10-22: super-120b answers 404 "Function not found for account"), so deep walks down the chain.
const LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b";
const NVIDIA_CHAT_MODELS: Record<Mode, string[]> = {
  deep: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b", LIGHTNING],
  fast: [LIGHTNING],
  auto: [LIGHTNING],
};
const RATE_LIMIT_PAUSE_MS = 2_000;
const NVIDIA_EMBED_MODEL = "nvidia/nemotron-3-embed-1b";
const DEFAULT_TOKEN_PATH = `${homedir()}/Library/Application Support/ai.meterless.runtime/proxy-token`;
const DEFAULT_LOG_PATH = fileURLToPath(new URL("../../data/cache/llm-calls.jsonl", import.meta.url));

const sha256 = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

function usageOf(body: any): Usage {
  const u = body?.usage ?? {};
  const r = body?.meterless?.usage ?? {};
  return {
    inputTokens: num(r.input_tokens) ?? num(u.prompt_tokens),
    outputTokens: num(r.output_tokens) ?? num(u.completion_tokens),
    totalTokens: num(r.total_tokens) ?? num(u.total_tokens),
    outputTps: num(r.output_tps),
    routerLatencyMs: num(r.latency_ms),
  };
}

export function createProvider(cfg: ProviderConfig = {}) {
  const ports = cfg.ports ?? DEFAULT_PORTS;
  const hosts = cfg.hosts ?? DEFAULT_HOSTS;
  const timeoutMs = cfg.timeoutMs ?? 180_000;
  const detectTimeoutMs = cfg.detectTimeoutMs ?? 1_500;
  const detectTtlMs = cfg.detectTtlMs ?? 30_000;
  const nvidiaBase = (cfg.nvidiaBaseUrl ?? NVIDIA_BASE).replace(/\/+$/, "");
  const fallbackOn = cfg.fallback ?? true;
  const logPath = cfg.logPath === undefined ? DEFAULT_LOG_PATH : cfg.logPath;

  const unavailableModels = new Set<string>(); // NVIDIA models that answered 404 for this account
  let cachedKey: string | null | undefined;
  let detection: { at: number; value: Detection } | null = null;
  let inflight: Promise<Detection> | null = null;
  let lastRoute: Route | null = null;

  function meterlessToken(): string | null {
    if (cfg.token !== undefined) return cfg.token;
    try {
      const t = readFileSync(cfg.tokenPath ?? DEFAULT_TOKEN_PATH, "utf8").trim();
      return t && t !== "rt-local" ? t : null; // the contract rejects the rt-local placeholder
    } catch { return null; }
  }

  function nvidiaKey(): string | null {
    if (cfg.nvidiaKey !== undefined) return cfg.nvidiaKey;
    if (cachedKey !== undefined) return cachedKey;
    let key: string | null = process.env.NVIDIA_API_KEY?.trim() || null;
    if (!key) {
      try {
        key = execFileSync("security", ["find-generic-password", "-a", APP_ID, "-s", "NVIDIA_API_KEY", "-w"],
          { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).toString().trim() || null;
      } catch { key = null; }
    }
    cachedKey = key;
    return key;
  }

  function redact(text: string): string {
    let out = text;
    for (const secret of [meterlessToken(), cfg.nvidiaKey ?? cachedKey ?? process.env.NVIDIA_API_KEY]) {
      if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  const meterlessHeaders = (): Record<string, string> => {
    const token = meterlessToken();
    return {
      "Content-Type": "application/json", "meterless-app": APP_ID, "meterless-scope": "user",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown, limitMs: number = timeoutMs, cancel?: AbortSignal) {
    const timer = AbortSignal.timeout(limitMs);
    const signal = cancel ? AbortSignal.any([timer, cancel]) : timer;
    const limit = limitMs >= 1000 ? `${Math.round(limitMs / 100) / 10}s`.replace(".0s", "s") : `${limitMs}ms`;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e: any) {
      if (cancel?.aborted && !timer.aborted) throw new UpstreamError(`${label} request cancelled`, null, true);
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      const why = timedOut ? `timeout after ${limit}` : `network error (${e?.cause?.code ?? e?.message ?? "fetch failed"})`;
      throw new UpstreamError(`${label} ${why}`, null, true);
    }
    const text = await res.text().catch(() => "");
    if (cancel?.aborted && !timer.aborted) throw new UpstreamError(`${label} request cancelled`, null, true);
    if (signal.aborted) throw new UpstreamError(`${label} timeout after ${limit} (while reading the reply)`, null, true);
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const detail = redact(str(json?.error?.message) ?? text.slice(0, 200));
      const retryable = res.status >= 500 || [401, 403, 408, 429].includes(res.status);
      const err = new UpstreamError(`${label} HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryable);
      const wait = Number(res.headers.get("retry-after"));
      if (Number.isFinite(wait) && wait > 0) err.retryAfterMs = wait * 1000;
      throw err;
    }
    if (json === null) throw new UpstreamError(`${label} returned a non-JSON body`, res.status, true);
    return json;
  }

  // ---- detection -------------------------------------------------------------------------------------

  async function probe(base: string): Promise<Detection> {
    const offline: Detection = { status: "offline", baseUrl: null, modes: [] };
    try {
      const res = await fetch(`${base}/models`, { headers: meterlessHeaders(), signal: AbortSignal.timeout(detectTimeoutMs) });
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        return { status: "unauthorized", baseUrl: base, modes: [] };
      }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return offline; }
      const body: any = await res.json().catch(() => null);
      const ids: string[] = Array.isArray(body?.data) ? body.data.map((m: any) => m?.id).filter((id: unknown) => typeof id === "string") : [];
      const modes = ids.filter((id) => id.startsWith("meterless/"));
      return modes.length ? { status: "online", baseUrl: base, modes } : offline;
    } catch { return offline; }
  }

  async function scan(): Promise<Detection> {
    const candidates = new Set<string>();
    if (cfg.baseUrl) candidates.add(normalizeBaseUrl(cfg.baseUrl));
    for (const host of hosts) for (const port of ports) candidates.add(`http://${host}:${port}/v1`);
    for (const base of candidates) {
      const hit = await probe(base);
      if (hit.status !== "offline") return hit; // first online or unauthorized hit wins
    }
    return { status: "offline", baseUrl: null, modes: [] };
  }

  async function detectMeterless(opts: { force?: boolean } = {}): Promise<Detection> {
    if (!opts.force && detection && Date.now() - detection.at < detectTtlMs) return detection.value;
    inflight ??= scan().then((value) => { detection = { at: Date.now(), value }; return value; }).finally(() => { inflight = null; });
    return inflight;
  }

  // ---- call log --------------------------------------------------------------------------------------

  function record(kind: "chat" | "embed", mode: string, promptHash: string, t0: number, outcome: { route?: Route; error?: string }) {
    lastRoute = outcome.route ?? lastRoute;
    if (!logPath) return;
    const { usage, ...summary } = outcome.route ?? ({} as Route);
    const entry = {
      ts: new Date().toISOString(), kind, mode, ok: !outcome.error,
      route: outcome.route ? summary : null, usage: outcome.route ? usage : null,
      latencyMs: Date.now() - t0, promptSha256: promptHash,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${redact(JSON.stringify(entry))}\n`);
    } catch { /* logging must never break a call */ }
  }

  // ---- chat ------------------------------------------------------------------------------------------

  function chatBody(model: string, req: ChatRequest) {
    return {
      ...(req.extra ?? {}),
      model, messages: req.messages,
      ...(req.tools ? { tools: req.tools } : {}),
      ...(req.tool_choice !== undefined ? { tool_choice: req.tool_choice } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
  }

  function toResult(json: any, route: Omit<Route, "latencyMs">, t0: number): ChatResult {
    const message = json?.choices?.[0]?.message;
    if (!message) throw new UpstreamError(`${route.provider} returned no choices`, null, true);
    const rawContent = textOf(message.content);
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return { content: cleanContent(rawContent), rawContent, toolCalls, route: { ...route, latencyMs: Date.now() - t0 } };
  }

  async function chatViaMeterless(base: string, req: ChatRequest, mode: Mode, cancel?: AbortSignal): Promise<ChatResult> {
    const t0 = Date.now();
    const requestedModel = `meterless/${mode}`;
    const json = await postJson("meterless", `${base}/chat/completions`, meterlessHeaders(), chatBody(requestedModel, req), req.deadlineMs, cancel);
    const r = json.meterless ?? {};
    const win = r.winning_route ?? {};
    return toResult(json, {
      provider: "meterless", requestedModel,
      routedModel: str(r.routed_model) ?? str(win.model) ?? str(json.model),
      label: str(win.label), kind: str(win.kind), tier: str(win.tier),
      receiptId: str(r.receipt_id),
      raceWidth: num(r.receipt?.app_policy?.race_width) ?? num(r.app_policy?.race_width),
      usage: usageOf(json), ...(r.from_cache === true ? { fromCache: true } : {}),
    }, t0);
  }

  async function nvidiaPost(path: string, body: unknown, limitMs?: number, cancel?: AbortSignal) {
    const key = nvidiaKey();
    if (!key) throw new ProviderError("NVIDIA API key not found (set NVIDIA_API_KEY or keychain item kilowhy/NVIDIA_API_KEY)");
    return postJson("nvidia", `${nvidiaBase}${path}`, { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body, limitMs, cancel);
  }

  async function chatViaNvidia(req: ChatRequest, mode: Mode, fallbackReason: string, cancel?: AbortSignal): Promise<ChatResult> {
    const t0 = Date.now();
    const chain = NVIDIA_CHAT_MODELS[mode];
    const candidates = chain.filter((m) => !unavailableModels.has(m));
    const skipped = chain.filter((m) => unavailableModels.has(m));
    for (const [i, model] of (candidates.length ? candidates : chain).entries()) {
      try {
        let json: any;
        try { json = await nvidiaPost("/chat/completions", chatBody(model, req), req.deadlineMs, cancel); }
        catch (e: any) {
          if (!(e instanceof UpstreamError) || e.status !== 429 || cancel?.aborted) throw e;
          // a rate limit: wait as long as Retry-After says (default 2 s, at most 5 s), try again, and once more after twice that
          let waited = Math.min(e.retryAfterMs ?? RATE_LIMIT_PAUSE_MS, 5000);
          for (let n = 0; ; n++) {
            await new Promise((r) => setTimeout(r, waited));
            try { json = await nvidiaPost("/chat/completions", chatBody(model, req), req.deadlineMs, cancel); break; }
            catch (e2: any) { if (n >= 1 || !(e2 instanceof UpstreamError) || e2.status !== 429 || cancel?.aborted) throw e2; waited = Math.min(waited * 2, 5000); }
          }
        }
        const note = skipped.map((m) => `${m.split("/")[1]} not available on this NVIDIA account (404)`).join("; ");
        return toResult(json, {
          provider: "nvidia-direct", requestedModel: model, routedModel: str(json.model) ?? model,
          label: "NVIDIA direct (Meterless fallback)", kind: "cloud", tier: null, receiptId: null, raceWidth: 1,
          usage: usageOf(json), fallbackReason: note ? `${fallbackReason}; ${note}` : fallbackReason,
        }, t0);
      } catch (e: any) {
        const last = i === (candidates.length ? candidates : chain).length - 1;
        if (!(e instanceof UpstreamError) || e.status !== 404 || last) throw e;
        unavailableModels.add(model);
        skipped.push(model);
      }
    }
    throw new ProviderError("no NVIDIA chat model configured"); // unreachable: every chain is non-empty
  }

  /** Meterless first; if it is still running after `req.hedgeAfterMs`, the labelled NVIDIA call starts alongside it. First answer wins, the other call is cancelled. */
  function chatHedged(base: string, req: ChatRequest, mode: Mode, hedgeMs: number): Promise<ChatResult> {
    const ctlA = new AbortController(), ctlB = new AbortController();
    return new Promise<ChatResult>((resolve, reject) => {
      let done = false, bStarted = false, aDone = false, bDone = false, aErr: unknown, bErr: unknown;
      const win = (r: ChatResult) => { if (done) return; done = true; clearTimeout(timer); ctlA.abort(); ctlB.abort(); resolve(r); };
      const lose = () => { if (done || !aDone || (bStarted && !bDone)) return; done = true; clearTimeout(timer); reject(bStarted ? new ProviderError(`${(aErr as Error)?.message ?? aErr}; the alongside NVIDIA call failed too: ${(bErr as Error)?.message ?? bErr}`) : aErr); };
      chatViaMeterless(base, req, mode, ctlA.signal).then(win, (e) => { aErr = e; aDone = true; lose(); });
      const timer = setTimeout(() => {
        if (done || aDone) return;
        bStarted = true;
        const why = `meterless had not answered after ${hedgeMs >= 1000 ? `${Math.round(hedgeMs / 100) / 10}s`.replace(".0s", "s") : `${hedgeMs}ms`}; the labelled fallback was started alongside`;
        chatViaNvidia(req, mode, why, ctlB.signal).then(win, (e) => { bErr = e; bDone = true; lose(); });
      }, hedgeMs);
    });
  }

  function failure(e: any, reason: string): ProviderError {
    const message = redact(e?.message ?? String(e));
    return new ProviderError(reason && !message.includes(reason) ? `${message} (Meterless: ${reason})` : message);
  }

  function unavailable(reason: string): ProviderError {
    return new ProviderError(`Meterless Nightshift unavailable (${reason}) and the NVIDIA fallback is off (KILOWHY_FALLBACK=off)`);
  }

  async function chat(req: ChatRequest): Promise<ChatResult> {
    const mode: Mode = req.mode === "deep" || req.mode === "fast" ? req.mode : "auto";
    const t0 = Date.now();
    const hash = sha256(req.messages);
    let reason = "";
    try {
      if (req.direct && !fallbackOn) throw unavailable(`direct NVIDIA call requested: ${req.direct}`);
      const det = req.direct ? ({ status: "offline", baseUrl: null, modes: [] } as Detection) : await detectMeterless();
      if (req.direct) reason = req.direct;
      else if (det.status === "online" && det.baseUrl) {
        try {
          const result = req.hedgeAfterMs && fallbackOn ? await chatHedged(det.baseUrl, req, mode, req.hedgeAfterMs) : await chatViaMeterless(det.baseUrl, req, mode);
          record("chat", mode, hash, t0, { route: result.route });
          return result;
        } catch (e: any) {
          if (!(e instanceof UpstreamError) || !e.retryable) throw e;
          detection = null; // re-probe on the next call
          reason = e.message;
        }
      } else {
        reason = `meterless ${det.status}`;
      }
      if (!fallbackOn) throw unavailable(reason);
      const result = await chatViaNvidia(req, mode, reason);
      record("chat", mode, hash, t0, { route: result.route });
      return result;
    } catch (e: any) {
      const err = failure(e, reason);
      record("chat", mode, hash, t0, { error: err.message });
      throw err;
    }
  }

  // ---- embeddings ------------------------------------------------------------------------------------

  function parseVectors(json: any, count: number): number[][] | null {
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== count) return null;
    const rows = [...data].sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0)).map((d: any) => d?.embedding);
    return rows.every((v) => Array.isArray(v) && v.length > 0 && v.every((x: unknown) => typeof x === "number")) ? rows : null;
  }

  async function embed(texts: string[], opts: { inputType?: "passage" | "query" } = {}): Promise<EmbedResult> {
    const t0 = Date.now();
    const hash = sha256(texts);
    let reason = "";
    try {
      const det = await detectMeterless();
      if (det.status === "online" && det.baseUrl) {
        try {
          const json = await postJson("meterless", `${det.baseUrl}/embeddings`, meterlessHeaders(), { model: "meterless/embed", input: texts });
          const vectors = parseVectors(json, texts.length);
          if (!vectors) throw new UpstreamError("meterless did not return embeddings", 200, true);
          const r = json.meterless ?? {};
          const win = r.winning_route ?? {};
          const route: Route = {
            provider: "meterless", requestedModel: "meterless/embed", routedModel: str(r.routed_model) ?? str(win.model) ?? str(json.model),
            label: str(win.label), kind: str(win.kind), tier: str(win.tier), latencyMs: Date.now() - t0,
            receiptId: str(r.receipt_id), raceWidth: num(r.receipt?.app_policy?.race_width) ?? num(r.app_policy?.race_width), usage: usageOf(json),
          };
          record("embed", "embed", hash, t0, { route });
          return { vectors, route };
        } catch (e: any) {
          // Nightshift builds that cannot embed answer 4xx here, so any failure falls through to the labelled path.
          if (!(e instanceof UpstreamError)) throw e;
          reason = e.message;
        }
      } else {
        reason = `meterless ${det.status}`;
      }
      if (!fallbackOn) throw unavailable(reason);
      const t1 = Date.now();
      const json = await nvidiaPost("/embeddings", {
        model: NVIDIA_EMBED_MODEL, input: texts, input_type: opts.inputType ?? "passage", encoding_format: "float",
      });
      const vectors = parseVectors(json, texts.length);
      if (!vectors) throw new ProviderError("NVIDIA embeddings response had no usable vectors");
      const route: Route = {
        provider: "nvidia-direct", requestedModel: NVIDIA_EMBED_MODEL, routedModel: str(json.model) ?? NVIDIA_EMBED_MODEL,
        label: "NVIDIA direct (Meterless fallback)", kind: "cloud", tier: null, latencyMs: Date.now() - t1,
        receiptId: null, raceWidth: 1, usage: usageOf(json), fallbackReason: reason,
      };
      record("embed", "embed", hash, t0, { route });
      return { vectors, route };
    } catch (e: any) {
      const err = failure(e, reason);
      record("embed", "embed", hash, t0, { error: err.message });
      throw err;
    }
  }

  async function status(): Promise<ProviderStatus> {
    const det = await detectMeterless();
    return { meterless: { status: det.status, baseUrl: det.baseUrl }, fallback: fallbackOn, lastRoute };
  }

  return { detectMeterless, chat, embed, status, cleanContent, extractJson };
}

// App-wide provider, configured from env on first use.
let shared: ReturnType<typeof createProvider> | null = null;
const getProvider = () => (shared ??= createProvider(configFromEnv()));

export const detectMeterless = (opts?: { force?: boolean }) => getProvider().detectMeterless(opts);
export const chat = (req: ChatRequest) => getProvider().chat(req);
export const embed = (texts: string[], opts?: { inputType?: "passage" | "query" }) => getProvider().embed(texts, opts);
export const status = () => getProvider().status();
