// eval/markovian_tokens.json: the per-chunk token log of Markovian investigations (latest runs, newest last). All token figures are labelled estimated or measured (markovian_log.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MarkovianReport } from "./investigate_markovian.ts";

export interface TokenLogRun {
  at: string; question: string; scope: string; verificationMode: string; narrativeAttempts: number; totalMs: number; timings: Record<string, number>;
  report: MarkovianReport;
}
export const KEEP_RUNS = 12;
const NOTE = "Tokens per chunk of the Markovian investigation chain. 'estimated' = ceil(chars / 4) of the messages sent and replies received (the reference engine's estimator); 'measured' = token usage reported by the provider for the same calls (null when it reported none); " +
  "'naive' = the reference's full-history baseline: every earlier prompt and output re-sent at each chunk. 'plainLoopInputEstimated' = the single plan + narrative prompt of the plain loop for the same question. Meter kWh behind the answers are SAMPLE data.";

export function appendTokenLog(path: string, run: TokenLogRun): void {
  let runs: TokenLogRun[] = [];
  try { if (existsSync(path)) runs = (JSON.parse(readFileSync(path, "utf8")) as { runs?: TokenLogRun[] }).runs ?? []; } catch { runs = []; }
  runs = [...runs, run].slice(-KEEP_RUNS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 1, note: NOTE, runs }, null, 2) + "\n");
}
