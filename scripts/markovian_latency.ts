// Latency and token comparison of the plain loop and the Markovian chain with different interpret batch sizes, on the live stack (Zetaris, Nightshift).
// Usage: node scripts/markovian_latency.ts [--repeat 2] [--configs plain,mk3,mk5,mk9] [--questions 1,2]   Writes eval/latency/markovian_d3.json. Meter kWh are SAMPLE data.
// Configs: plain = single plan + narrative loop; mkN = Markovian chain with N hypotheses per interpret chunk. Runs go one after the other, configs interleaved, no memory (so the
// answers do not depend on earlier runs). Token figures: estimated = chars / 4, measured = provider-reported usage.
import { writeFileSync, mkdirSync } from "node:fs";
import { zsql } from "./zetaris_client.ts";
import { investigate } from "../server/src/agent.ts";
import { isClarification } from "../server/src/agent_types.ts";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const repeat = Number(arg("repeat", "2"));
const QUESTIONS = ["Why did Brixton use more electricity?", "Why did our electricity cost more in the last four weeks than the four weeks before?"];
const questions = arg("questions", "1,2").split(",").map((i) => QUESTIONS[Number(i) - 1]).filter(Boolean);
const configs = arg("configs", "plain,mk3,mk5,mk9").split(",");
const rows: unknown[] = [];

for (let r = 1; r <= repeat; r++) for (const q of questions) for (const cfg of configs) {
  const engine = cfg === "plain" ? "plain" : "markovian", batchSize = cfg.startsWith("mk") ? Number(cfg.slice(2)) : undefined;
  const t0 = performance.now();
  const o = await investigate(q, { zsql, engine, markovian: { batchSize } });
  if (isClarification(o)) { console.log(`${cfg} r${r}: clarification`); continue; }
  const chunks = o.markovian?.chunks ?? [];
  const row = {
    config: cfg, repeat: r, question: q, totalMs: Math.round(performance.now() - t0), narrativeStepMs: o.timings.narrative, planMs: o.timings.plan,
    interpretMs: chunks.filter((c) => c.kind === "interpret").reduce((s, c) => s + c.ms, 0), interpretChunks: chunks.filter((c) => c.kind === "interpret").length,
    narrativeChunkMs: chunks.filter((c) => c.kind === "narrative").reduce((s, c) => s + c.ms, 0), chunks: chunks.length,
    mode: o.verification.mode, attempts: o.verification.attempts, inputEstimated: chunks.length ? o.markovian!.totals.markovianInputEstimated : null, naiveEstimated: chunks.length ? o.markovian!.totals.naiveInputEstimated : null,
    plainLoopEstimated: chunks.length ? o.markovian!.totals.plainLoopInputEstimated : null, inputMeasured: chunks.length ? o.markovian!.totals.markovianInputMeasured : null,
    readings: chunks.length ? Object.keys(o.markovian!.finalState?.read ?? {}).length : null, routes: o.llmCalls.map((c) => `${c.step}: ${c.route?.provider ?? "FAILED"}`),
  };
  rows.push(row);
  console.log(`${cfg.padEnd(5)} r${r} ${(row.totalMs / 1000).toFixed(1).padStart(6)} s total, narrative step ${((row.narrativeStepMs ?? 0) / 1000).toFixed(1)} s, interpret ${(row.interpretMs / 1000).toFixed(1)} s in ${row.interpretChunks} chunk(s), mode ${row.mode}/${row.attempts}, readings ${row.readings}  ${q.slice(0, 30)}`);
}
mkdirSync(new URL("../eval/latency/", import.meta.url), { recursive: true });
writeFileSync(new URL("../eval/latency/markovian_d3.json", import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), note: "Live Zetaris + Nightshift; SAMPLE meter data; tokens estimated = chars/4, measured = provider-reported", repeat, rows }, null, 2) + "\n");
