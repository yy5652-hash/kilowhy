// CLI for the Kilowhy agent: node scripts/ask.ts "Why did our electricity cost more in the last four weeks?" [--site S2]
// Prints the answer with [E#] evidence markers, the ruled-out list, the recommendation, the verification mode and the LLM route of every step,
// and writes the full InvestigationResult to eval/answers/<slug>.json. Meter kWh are SAMPLE data.
import { mkdirSync, writeFileSync } from "node:fs";
import { zsql } from "./zetaris_client.ts";
import { investigate } from "../server/src/agent.ts";
import { renderOutcome } from "../server/src/agent_render.ts";
import { answerFile, parseArgs } from "./ask_args.ts";
import { defaultMemory, WORLD_DIR } from "../server/src/memory_default.ts";
import { KilowhyWorld } from "../server/src/worldmodel.ts";

const { question, site } = parseArgs(process.argv.slice(2));
if (!question) { console.error('usage: node scripts/ask.ts "question" [--site S2]'); process.exit(2); }

// H-MEM (data/cache/hmem) and the World Model (data/cache/worldmodel) persist between questions; --no-memory asks without H-MEM.
const memory = process.argv.includes("--no-memory") ? undefined : defaultMemory();
const world = KilowhyWorld.create({ storage: "local", directory: WORLD_DIR });
const outcome = await investigate(question, { zsql, site, memory, world, onProgress: (m) => process.stderr.write(`  ... ${m}\n`) });
console.log(renderOutcome(outcome));

const file = answerFile(question, site);
const target = new URL(`../${file}`, import.meta.url);
mkdirSync(new URL("../eval/answers/", import.meta.url), { recursive: true });
writeFileSync(target, JSON.stringify({ generatedAt: new Date().toISOString(), ...outcome }, null, 2) + "\n");
console.log(`\nWrote ${file}`);
const ok = "clarification" in outcome || outcome.verification.passed;
process.exit(ok ? 0 : 1);
