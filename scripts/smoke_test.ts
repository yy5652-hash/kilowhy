// Smoke test: one tiny chat request through Meterless Nightshift (provider contract v4) on meterless/auto.
// Records status, answering model and latency to docs/nightshift-smoke.json. Never writes the token.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE = process.env.METERLESS_BASE_URL ?? "http://127.0.0.1:8088/v1";
const token = readFileSync(`${homedir()}/Library/Application Support/ai.meterless.runtime/proxy-token`, "utf8").trim();
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "meterless-app": "kilowhy", "meterless-scope": "user" };

const t0 = Date.now();
const res = await fetch(`${BASE}/chat/completions`, {
  method: "POST", headers, signal: AbortSignal.timeout(180000),
  body: JSON.stringify({ model: "meterless/auto", max_tokens: 20, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
});
const latencyMs = Date.now() - t0;
const body: any = await res.json().catch(() => ({}));
const out = {
  checked_at: new Date().toISOString(), base_url: BASE, requested_model: "meterless/auto",
  http_status: res.status, answering_model: body.model ?? null, latency_ms: latencyMs,
  reply: body.choices?.[0]?.message?.content ?? null, error: res.ok ? null : JSON.stringify(body).slice(0, 300),
  route_headers: Object.fromEntries([...res.headers].filter(([k]) => k.startsWith("meterless") || k.startsWith("x-"))),
};
writeFileSync(new URL("../docs/nightshift-smoke.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
