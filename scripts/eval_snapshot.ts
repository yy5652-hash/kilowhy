// Evaluation snapshot: reads ONCE from Zetaris the real per-slot Agile price (inc VAT), carbon intensity, wind/gas/import share and hourly
// temperature for windows A and B (same windows as the app) and writes eval/data/real_windows.json with the SQL and the Zetaris run ids.
// No meter data is read or written. Usage: node scripts/eval_snapshot.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { zsql } from "./zetaris_client.ts";
import { buildSnapshot, serializeSnapshot, validateSnapshot, SNAPSHOT_PATH, SNAPSHOT_SQL, type RawRun } from "../eval/real.ts";

async function run(sql: string): Promise<RawRun> {
  const z = await zsql(sql);
  return { sql, runId: z.runId, ok: z.ok, status: z.status, body: z.body };
}

const snap = buildSnapshot({ slots: await run(SNAPSHOT_SQL.slots), temps: await run(SNAPSHOT_SQL.temps), standing: await run(SNAPSHOT_SQL.standing) }, new Date().toISOString());
const bad = validateSnapshot(snap);
if (bad.length) { console.error("snapshot invalid: " + bad.join("; ")); process.exit(1); }
mkdirSync(new URL("./", SNAPSHOT_PATH), { recursive: true });
writeFileSync(SNAPSHOT_PATH, serializeSnapshot(snap));
console.log(`wrote eval/data/real_windows.json: ${snap.slots.length} priced slots, ${snap.temps.length} hourly temperatures, ${snap.standing.length} standing-charge rows; runs ${snap.queries.map((q) => `${q.id}=${q.zetarisRunId}`).join(" ")}`);
