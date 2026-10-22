// CLI for the investigation memory (H-MEM): node scripts/note.ts --site S2 "Brixton moved its oven schedule 2 hours later from 7 Oct for the new sourdough line"
// Also --list, --recall "question", --audit mem-1 and --feedback mem-1:wrong; see --help. The store is data/cache/hmem/ (git-ignored).
import { defaultMemory, WORLD_DIR } from "../server/src/memory_default.ts";
import { KilowhyWorld } from "../server/src/worldmodel.ts";
import { renderAudit, renderMemory, renderRecall } from "../server/src/memory_render.ts";
import { parseNoteArgs, USAGE } from "./note_args.ts";

const cmd = parseNoteArgs(process.argv.slice(2));
if (cmd.kind === "usage") { console.error(`${cmd.error ? `${cmd.error}\n` : ""}${USAGE}`); process.exit(2); }
const memory = defaultMemory();

/** A site id (S2) stays as it is; a name (Brixton) is resolved with the World Model kept on disk by the last investigation (node scripts/ask.ts or worldmodel_check.ts --local). */
function siteId(site: string | undefined): string | undefined {
  if (!site) return undefined;
  if (/^S\d+$/i.test(site)) return site.toUpperCase();
  const r = KilowhyWorld.create({ storage: "local", directory: WORLD_DIR }).resolveSite(site);
  if (r.ok && r.ids.length === 1) return r.ids[0];
  console.error(`I could not resolve the site "${site}" (${r.ok ? "several sites" : "unknown or ambiguous"}). Use an id such as S2, or run one investigation first so the World Model knows the sites.`);
  process.exit(2);
}

if (cmd.kind === "remember") {
  const site = siteId(cmd.site);
  const rec = await memory.remember(cmd.text, { source: "user", site, validFrom: cmd.from });
  console.log(`Remembered ${rec.id}${site ? ` for ${site}` : " (all sites)"}: ${JSON.stringify(rec.content)}`);
  console.log(`  ${rec.layer} memory, confidence ${rec.confidence}, source ${rec.source}, provenance ${rec.provenance.origin}${cmd.from ? `, valid from ${cmd.from}` : ""}`);
  console.log(`  audit: node scripts/note.ts --audit ${rec.id}`);
} else if (cmd.kind === "list") {
  const all = memory.list({ site: siteId(cmd.site) });
  console.log(all.length ? all.map(renderMemory).join("\n") : "Nothing remembered yet.");
} else if (cmd.kind === "recall") {
  console.log(renderRecall(await memory.recall(cmd.query, { site: siteId(cmd.site) })));
} else if (cmd.kind === "audit") {
  console.log(renderAudit(cmd.id, memory.audit(cmd.id)));
} else if (cmd.kind === "feedback") {
  memory.feedback(cmd.id, cmd.verdict);
  console.log(`Feedback ${cmd.verdict} recorded for ${cmd.id}; confidence is now ${memory.get(cmd.id)?.confidence}.`);
}
