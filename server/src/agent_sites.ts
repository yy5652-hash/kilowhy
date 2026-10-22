// Entity resolution for the agent (spec step 1): sites by id, number ("site 2") or fuzzy name; ALL; deterministic fallback intent; output slug.
// Unknown sites are never guessed: the caller turns an unresolved name into a clarification.
import type { IntentType } from "./agent_types.ts";

export interface SiteRef { id: string; name: string }
const STOP = new Set(["crumb", "the", "and", "site", "sites", "shop", "branch", "store", "bakery", "bakeries", "our", "my", "all", "every", "london"]);
const norm = (s: string): string => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const words = (s: string): string[] => norm(s).split(" ").filter(Boolean);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const wordsMatch = (x: string, y: string): boolean => x === y || (x.length >= 5 && y.length >= 5 && distance(x, y) <= 1);

export const ALL_RE = /^(all( (the|our|of the))?( sites| shops| bakeries| branches| stores)?|every ?(site|shop|bakery|branch|store)?|everything|the whole business|whole business|the business|our business|company|all)$/;

export const isAllRequest = (request: string): boolean => ALL_RE.test(norm(request));

export type Resolution = { ok: true; ids: string[] } | { ok: false; ambiguous: string[] };

/** One requested site string -> site ids. ALL -> every site; "S2" / "site 2" / "2" -> S2; "Brixton" (also misspelt) -> the site whose name has that word. */
export function resolveSite(request: string, known: SiteRef[]): Resolution {
  const n = norm(request);
  if (ALL_RE.test(n)) return { ok: true, ids: known.map((s) => s.id) };
  const byId = known.find((s) => norm(s.id) === n);
  if (byId) return { ok: true, ids: [byId.id] };
  const num = n.match(/^(?:site|shop|branch|bakery|store)?\s*(?:no |number |#)?(\d+)$/)?.[1];
  if (num) { const hit = known.find((s) => norm(s.id) === `s${num}`); if (hit) return { ok: true, ids: [hit.id] }; }
  const want = words(request).filter((w) => !STOP.has(w) && w.length >= 3);
  const hits = known.filter((s) => want.length > 0 && words(s.name).filter((w) => !STOP.has(w) && w.length >= 3).some((nw) => want.some((w) => wordsMatch(w, nw))));
  if (hits.length === 1) return { ok: true, ids: [hits[0].id] };
  return { ok: false, ambiguous: hits.map((s) => s.id) };
}

/** Sites the question text mentions by id ("S2", "site 2") or by a distinctive word of the name ("Brixton"). Used when the model forgot to list them. */
export function mentionedSites(question: string, known: SiteRef[]): string[] {
  const q = norm(question);
  const qWords = words(question);
  const found = new Set<string>();
  for (const s of known) {
    const num = s.id.match(/\d+/)?.[0];
    if (new RegExp(`(^| )${norm(s.id)}( |$)`).test(q) || (num && new RegExp(`(^| )(site|shop|branch|bakery|store) (no |number )?${num}( |$)`).test(q))) found.add(s.id);
    else if (words(s.name).filter((w) => !STOP.has(w) && w.length >= 3).some((nw) => qWords.some((w) => wordsMatch(w, nw)))) found.add(s.id);
  }
  return [...found];
}

/** "site 9" / "shop no. 9" in the question when no such site exists: a numbered mention is never silently widened to all sites. */
export function unknownNumberedSites(question: string, known: SiteRef[]): string[] {
  const out: string[] = [];
  for (const m of norm(question).matchAll(/(?:^| )(site|shop|branch|bakery|store) (?:no |number )?(\d+)(?= |$)/g)) if (!known.some((s) => norm(s.id) === `s${m[2]}`)) out.push(`${m[1]} ${m[2]}`);
  return [...new Set(out)];
}

/** Does the raw request text occur in the question? Used to ignore sites the model invented. */
export const appearsIn = (request: string, question: string): boolean => {
  const r = norm(request), q = norm(question);
  return r.length > 0 && new RegExp(`(^| )${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(q);
};

/** Deterministic classification used only when the model's intent output is unusable. */
export function fallbackIntentType(question: string): IntentType {
  const q = question.toLowerCase();
  if (/emission|carbon|co2|co₂|greenhouse/.test(q)) return "why_emissions";
  if (/\bshould\b|what can|how (can|do|could) (we|i)|save money|cut (my|our|the)? ?(bill|cost)|reduce|cheaper|what to change|recommend/.test(q)) return "what_to_change";
  if (/spike|spiked|jump|surge|unusual|odd|\d{4}-\d{2}-\d{2}|\bon (mon|tues|wednes|thurs|fri|satur|sun)day\b/.test(q)) return "why_spike_day";
  return "why_cost_change";
}
export const datesIn = (question: string): string[] => [...new Set(question.match(/\d{4}-\d{2}-\d{2}/g) ?? [])];

export const slugify = (question: string, suffix = ""): string => {
  const base = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 10).join("-").slice(0, 70).replace(/-+$/g, "");
  return `${base || "question"}${suffix ? `-${suffix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}`;
};
