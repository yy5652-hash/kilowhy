// Site resolution on top of the World Model engine's entity-resolution bands (vendor/meterless/world-model, resolve.ts):
// similarity = 1 - Levenshtein / max length on normalised names; >= 0.85 resolves, [0.82, 0.85) is the review band (ask, never guess), below is unknown.
// The names compared are the aliases the World Model holds for each site entity (full name, the distinctive part such as "Brixton", the id and "site 2").
// Pure: no I/O. ids ("S2"), numbers ("site 2") and ALL phrases are exact forms and are not fuzzy.
import { worldLib } from "./engines.ts";

export interface SiteRef { id: string; name: string; aliases?: string[] }
export type Resolution = { ok: true; ids: string[] } | { ok: false; ambiguous: string[]; near?: string[] };

const STOP = new Set(["crumb", "the", "and", "site", "sites", "shop", "branch", "store", "bakery", "bakeries", "our", "my", "all", "every", "london"]);
export const norm = (s: string): string => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string): string[] => norm(s).split(" ").filter(Boolean);
const MAX_SPAN = 4;
const EXACT_ONLY = /^(s\d+|site \d+)$/;   // ids and numbers are matched exactly (resolveSite / mentionedSites), never by similarity: "site 10" must not become S1

export const ALL_RE = /^(all( (the|our|of the))?( sites| shops| bakeries| branches| stores)?|every ?(site|shop|bakery|branch|store)?|everything|the whole business|whole business|the business|our business|company|all)$/;
export const isAllRequest = (request: string): boolean => ALL_RE.test(norm(request));

/** The names a site answers to: full name, the part that tells it apart from the other sites, its distinctive words, its id and "site N". */
export function siteAliases(site: SiteRef, all: SiteRef[]): string[] {
  const own = tokens(site.name);
  const others = all.map((s) => tokens(s.name));
  let k = 0;
  if (all.length >= 2) while (k < own.length - 1 && others.every((n) => n[k] === own[k])) k++;   // the shared leading words ("Crumb & Co")
  const tail = own.slice(k);
  const distinctive = own.filter((w) => w.length >= 3 && !STOP.has(w));   // "brixton", "hill": a word shared by two sites then makes a request ambiguous
  const out = new Set<string>([norm(site.name), tail.join(" "), distinctive.join(" "), ...distinctive, norm(site.id)]);
  const num = site.id.match(/^S(\d+)$/i)?.[1];
  if (num) out.add(`site ${num}`);
  for (const a of site.aliases ?? []) out.add(norm(a));
  out.delete("");
  return [...out];
}

interface Hit { id: string; decision: "auto-merge" | "review"; span: number; similarity: number }
/** For each site, the best match of any span of 1..4 words of `text` against any alias, using the engine's bands. */
function scan(text: string, sites: SiteRef[]): Hit[] {
  const w = tokens(text);
  const hits: Hit[] = [];
  for (const site of sites) {
    let best: Hit | null = null;
    for (const alias of siteAliases(site, sites)) if (!EXACT_ONLY.test(alias)) for (let i = 0; i < w.length; i++) for (let len = 1; len <= MAX_SPAN && i + len <= w.length; len++) {
      const span = w.slice(i, i + len);
      if (span.every((x) => STOP.has(x))) continue;
      const shown = span.join(" ");
      if (shown.length < 3) continue;
      const similarity = worldLib.nameSimilarity(shown, alias);
      const decision = worldLib.decide(similarity);
      if (decision === "new") continue;
      const hit: Hit = { id: site.id, decision, span: len, similarity };
      const rank = (h: Hit) => (h.decision === "auto-merge" ? 1e6 : 0) + h.span * 1e3 + h.similarity;
      if (!best || rank(hit) > rank(best)) best = hit;
    }
    if (best) hits.push(best);
  }
  return hits;
}

/** One requested site string -> site ids. ALL -> every site; "S2" / "site 2" / "2" -> S2; "Brixton" (also misspelt) -> the site that answers to it. */
export function resolveSite(request: string, known: SiteRef[]): Resolution {
  const n = norm(request);
  if (ALL_RE.test(n)) return { ok: true, ids: known.map((s) => s.id) };
  const byId = known.find((s) => norm(s.id) === n);
  if (byId) return { ok: true, ids: [byId.id] };
  const num = n.match(/^(?:site|shop|branch|bakery|store)?\s*(?:no |number )?(\d+)$/)?.[1];
  if (num) { const hit = known.find((s) => norm(s.id) === `s${num}`); if (hit) return { ok: true, ids: [hit.id] }; }
  const hits = scan(request, known);
  const auto = hits.filter((h) => h.decision === "auto-merge");
  const widest = Math.max(0, ...auto.map((h) => h.span));
  const top = auto.filter((h) => h.span === widest);     // "Brixton Hill" beats the single word "Brixton"
  if (top.length === 1) return { ok: true, ids: [top[0].id] };
  if (top.length > 1) return { ok: false, ambiguous: top.map((h) => h.id) };
  return { ok: false, ambiguous: [], ...(hits.length ? { near: hits.map((h) => h.id) } : {}) };
}

/** Sites the question text mentions by id ("S2", "site 2") or by a name the engine resolves ("Brixton"). Used when the model forgot to list them. */
export function mentionedSites(question: string, known: SiteRef[]): string[] {
  const q = norm(question);
  const found = new Set<string>();
  for (const s of known) {
    const num = s.id.match(/\d+/)?.[0];
    if (new RegExp(`(^| )${norm(s.id)}( |$)`).test(q) || (num && new RegExp(`(^| )(site|shop|branch|bakery|store) (no |number )?${num}( |$)`).test(q))) found.add(s.id);
  }
  for (const h of scan(question, known)) if (h.decision === "auto-merge") found.add(h.id);
  return known.map((s) => s.id).filter((id) => found.has(id));
}
