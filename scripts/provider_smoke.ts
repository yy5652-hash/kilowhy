// Live smoke test for the provider layer: detection, deep + fast chat, tool calling and embeddings through
// Meterless Nightshift (with the labelled NVIDIA fallback if it is down). Writes docs/provider-smoke.json:
// statuses, route summaries and dims only. Tiny test strings, no secrets. Exits 1 if a required check fails.
import { writeFileSync } from "node:fs";
import { chat, embed, extractJson, status, type Route } from "../server/src/provider.ts";

const OUT = new URL("../docs/provider-smoke.json", import.meta.url);

const routeSummary = (r: Route) => ({
  provider: r.provider, requestedModel: r.requestedModel, routedModel: r.routedModel, label: r.label, tier: r.tier,
  latencyMs: r.latencyMs, raceWidth: r.raceWidth, receiptId: r.receiptId,
  ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}),
});

async function step<T extends object>(fn: () => Promise<T>): Promise<(T & { ok: true }) | { ok: false; error: string }> {
  try { return { ok: true, ...(await fn()) }; } catch (e: any) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
}

const st = await status();

const deep = await step(async () => {
  const r = await chat({
    mode: "deep", max_tokens: 2000,
    messages: [{ role: "user", content: 'What is 2+2? Reply with only a JSON object like {"answer": <number>}.' }],
  });
  const parsed = (extractJson(r.content) ?? extractJson(r.rawContent)) as { answer?: unknown } | null;
  return { jsonParsed: parsed !== null, answerCorrect: parsed?.answer === 4, route: routeSummary(r.route) };
});

const fast = await step(async () => {
  const r = await chat({ mode: "fast", max_tokens: 1000, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
  return { replied: r.content.length > 0, route: routeSummary(r.route) };
});

const tools = await step(async () => {
  const r = await chat({
    mode: "auto", max_tokens: 1000, tool_choice: "auto",
    tools: [{
      type: "function",
      function: {
        name: "run_sql", description: "Run a read-only SQL query and return the rows.",
        parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
      },
    }],
    messages: [{ role: "user", content: "Use the run_sql tool to count the rows in the table readings." }],
  });
  const call = r.toolCalls[0];
  let argsOk = false;
  try { argsOk = typeof JSON.parse(call?.function.arguments ?? "").sql === "string"; } catch { /* not JSON */ }
  return {
    toolCallsReturned: r.toolCalls.length, toolName: call?.function.name ?? null, argumentsParsed: argsOk,
    workedViaNightshift: r.route.provider === "meterless" && r.toolCalls.length > 0 && argsOk, route: routeSummary(r.route),
  };
});

const emb = await step(async () => {
  const r = await embed(["kilowatt hours", "bill change"], { inputType: "passage" });
  return { count: r.vectors.length, dims: r.vectors[0]?.length ?? 0, route: routeSummary(r.route) };
});

const failed = [
  !deep.ok || !deep.answerCorrect ? "deep" : "",
  !fast.ok || !fast.replied ? "fast" : "",
  !tools.ok ? "tools" : "",
  !emb.ok || emb.dims === 0 ? "embed" : "",
].filter(Boolean);

const out = {
  checked_at: new Date().toISOString(),
  nightshift: st.meterless, fallback_enabled: st.fallback,
  deep, fast, tool_calling: tools, embed: emb,
  all_required_ok: failed.length === 0, failed,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

const line = (name: string, s: any) =>
  s.ok ? `${name.padEnd(6)} ok   ${s.route.provider} ${s.route.routedModel} "${s.route.label}" ${s.route.latencyMs} ms race ${s.route.raceWidth}${s.route.fallbackReason ? ` [fallback: ${s.route.fallbackReason}]` : ""}`
       : `${name.padEnd(6)} FAIL ${s.error}`;
console.log(`nightshift: ${st.meterless.status} ${st.meterless.baseUrl ?? "-"}  fallback: ${st.fallback ? "on" : "off"}`);
console.log(line("deep", deep), deep.ok ? `| json ${deep.jsonParsed} answer ${deep.answerCorrect}` : "");
console.log(line("fast", fast));
console.log(line("tools", tools), tools.ok ? `| calls ${tools.toolCallsReturned} via-nightshift ${tools.workedViaNightshift}` : "");
console.log(line("embed", emb), emb.ok ? `| ${emb.count} vectors x ${emb.dims} dims` : "");
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "all required checks passed -> docs/provider-smoke.json");
process.exit(failed.length ? 1 : 0);
