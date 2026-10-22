// Entity helpers for the agent (spec step 1): numbered-site checks, deterministic fallback intent, output slug.
// Site resolution itself (ids, numbers, names, aliases, ALL) is the World Model's: see worldmodel_resolve.ts (re-exported here).
// Unknown sites are never guessed: the caller turns an unresolved name into a clarification.
import type { IntentType } from "./agent_types.ts";
import { norm, type SiteRef } from "./worldmodel_resolve.ts";

export { resolveSite, mentionedSites, isAllRequest, ALL_RE, type SiteRef, type Resolution } from "./worldmodel_resolve.ts";

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
