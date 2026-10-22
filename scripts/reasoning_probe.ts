// Measures whether a request-level control makes the Nemotron routes skip reasoning on the real narrative prompt (see docs/latency.md).
// For each variant it sends the same narrative request N times through the app provider (Meterless "deep", labelled fallback allowed) and records wall time,
// output tokens, whether reasoning leaked into the reply and whether the reply is valid JSON. Writes eval/latency/<out>.json.
//   node scripts/reasoning_probe.ts [--repeats 3] [--mode deep|fast|auto] [--direct] [--cap N] [--out name] [--from eval/answers/....json] [--only id,id]
// --direct skips Meterless and calls NVIDIA directly (the labelled fallback route).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chat as appChat, createProvider } from "../server/src/provider.ts";
import { extractJson } from "../server/src/provider_text.ts";
import { narrativeMessages, relevantFacts } from "../server/src/agent_prompts.ts";
import { CATALOG } from "../server/src/hypotheses/index.ts";
import { VARIANTS, requestFor, summarize, type ProbeRow } from "../server/src/reasoning_variants.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const repeats = Number(arg("repeats", "3"));
const from = arg("from", "eval/answers/what-should-we-change-to-save-money.json");
const only = arg("only", "").split(",").filter(Boolean);
const mode = arg("mode", "deep") as "deep" | "fast" | "auto";
const direct = process.argv.includes("--direct");
const cap = process.argv.includes("--cap") ? Number(arg("cap", "500")) : undefined;   // overrides the variants' max_tokens (0 = no cap)
const outName = arg("out", "reasoning_probe");
const chat = direct ? createProvider({ ports: [9], hosts: ["127.0.0.1"], detectTimeoutMs: 300, logPath: null }).chat : appChat;
const saved = JSON.parse(readFileSync(new URL(`../${from}`, import.meta.url), "utf8"));
const hyps = saved.results.map((r: any) => ({ id: r.id, name: r.name, status: r.status }));
const titles = Object.fromEntries(CATALOG.map((c) => [c.id as string, c.title]));
const messages = narrativeMessages({
  question: saved.question, type: saved.intent.type, scopeText: saved.scope.sites.map((s: any) => `${s.id} ${s.name}`).join("; "),
  facts: relevantFacts(saved.facts, hyps), hypotheses: hyps, titles, focusDates: [], hasRecommendation: true,
});
console.error(`prompt: ${messages[0].content!.length} characters; ${repeats} repeat(s) per variant; mode ${mode}${direct ? "; NVIDIA direct" : ""}`);

const rows: ProbeRow[] = [];
for (const v of VARIANTS.filter((x) => !only.length || only.includes(x.id))) {
  const one = async (): Promise<ProbeRow> => {
    const t0 = performance.now();
    try {
      const r = await chat(requestFor(v, messages, mode, cap));
      const j = extractJson(r.content) as any;
      return { variant: v.id, ok: true, wallMs: Math.round(performance.now() - t0), outputTokens: r.route.usage.outputTokens, routedModel: r.route.routedModel, leaked: r.rawContent.trim() !== r.content.trim() || /<\/?think>/i.test(r.rawContent), jsonOk: !!j && Array.isArray(j.sentences), provider: r.route.provider, preview: r.rawContent.replace(/\s+/g, " ").slice(0, 100) };
    } catch (e) {
      return { variant: v.id, ok: false, wallMs: Math.round(performance.now() - t0), outputTokens: null, routedModel: null, leaked: false, jsonOk: false, error: String((e as Error).message).slice(0, 160) };
    }
  };
  const got = await Promise.all(Array.from({ length: repeats }, one));
  rows.push(...got);
  console.error(`${v.id}: ${got.map((g) => `${(g.wallMs / 1000).toFixed(1)}s/${g.outputTokens ?? "-"}tok${g.ok ? "" : " ERR"}`).join("  ")}`);
}
const summary = summarize(rows);
console.table(summary.map((s) => ({ variant: s.variant, n: s.n, ok: s.okRate.toFixed(2), json: s.jsonRate.toFixed(2), leak: s.leakRate.toFixed(2), medianSec: s.medianWallMs === null ? null : s.medianWallMs / 1000, medianOutTokens: s.medianOutputTokens, models: s.models.join(" | "), via: (s.providers ?? []).join(" | ") })));
mkdirSync(new URL("../eval/latency/", import.meta.url), { recursive: true });
writeFileSync(new URL(`../eval/latency/${outName}.json`, import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), mode, direct, promptChars: messages[0].content!.length, repeats, summary, rows }, null, 2) + "\n");
