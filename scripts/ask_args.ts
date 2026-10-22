// Argument parsing for scripts/ask.ts, kept separate so it can be tested.
import { slugify } from "../server/src/agent_sites.ts";

export interface AskArgs { question: string; site?: string }

/** `"question words" [--site S2]` or `--site=S2`; unquoted words are joined. */
export function parseArgs(argv: string[]): AskArgs {
  let site: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--site") site = argv[++i];
    else if (argv[i].startsWith("--site=")) site = argv[i].slice("--site=".length);
    else if (argv[i] === "--no-memory") continue;   // read by scripts/ask.ts
    else words.push(argv[i]);
  }
  return { question: words.join(" ").trim(), ...(site ? { site } : {}) };
}

/** Where the full InvestigationResult of a question is written, relative to the repository root. */
export const answerFile = (question: string, site?: string): string => `eval/answers/${slugify(question, site ?? "")}.json`;
