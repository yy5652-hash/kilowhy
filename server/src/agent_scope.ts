// Scope resolution (spec step 1): which sites the question is about. The deterministic part (ids, numbers, fuzzy names found in the question text) is
// available before the model answers, so data work can start speculatively; the model's intent can only confirm it, add a site name that is not
// in the data (a clarification) or widen it to ALL.
import { appearsIn, isAllRequest, mentionedSites, resolveSite, unknownNumberedSites, type SiteRef } from "./agent_sites.ts";
import { addDays } from "./bands.ts";
import type { DateWindow } from "./windows.ts";
import type { Intent } from "./agent_types.ts";

export type Scope = { ok: true; siteIds: string[]; label: string; notes: string[] } | { ok: false; clarification: string };

const listing = (known: SiteRef[]): string => known.map((s) => `${s.id} (${s.name})`).join(", ");
const labelOf = (siteIds: string[], known: SiteRef[]): string => (siteIds.length === known.length ? "ALL" : siteIds.join("+"));

/** What the question text alone says: the mentioned sites, or every site when none is mentioned. Used to start work before the intent arrives. */
export function guessSites(question: string, known: SiteRef[], onlySite?: string): string[] {
  const ids = onlySite ? (() => { const r = resolveSite(onlySite, known); return r.ok ? r.ids : []; })() : mentionedSites(question, known);
  return ids.length ? known.map((s) => s.id).filter((id) => ids.includes(id)) : known.map((s) => s.id);
}

export function resolveScope(question: string, intent: Pick<Intent, "requestedSites" | "dates">, known: SiteRef[], windowA: DateWindow, windowB: DateWindow, onlySite?: string): Scope {
  const notes: string[] = [];
  const requested = onlySite ? [onlySite] : intent.requestedSites;
  const ids = new Set<string>();
  for (const r of requested) {
    const res = resolveSite(r, known);
    if (res.ok) res.ids.forEach((id) => ids.add(id));
    else if (onlySite || appearsIn(r, question)) {
      const near = res.near?.map((id) => known.find((s) => s.id === id)).filter((s): s is SiteRef => !!s);
      return { ok: false, clarification: res.ambiguous.length > 1 ? `"${r}" matches several sites (${res.ambiguous.join(", ")}). Which one do you mean? Sites: ${listing(known)}.`
        : near?.length ? `"${r}" is close to ${near.map((s) => `${s.id} (${s.name})`).join(" and ")}, but not close enough for me to be sure. Which one do you mean? Sites: ${listing(known)}.`
        : `I could not find a site called "${r}". Which one do you mean? Sites: ${listing(known)}.` };
    } else notes.push(`ignored site "${r}" proposed by the model: it does not appear in the question`);
  }
  const unknownNumbered = onlySite ? [] : unknownNumberedSites(question, known);
  if (unknownNumbered.length) return { ok: false, clarification: `I could not find "${unknownNumbered[0]}". Which one do you mean? Sites: ${listing(known)}.` };
  if (!onlySite) mentionedSites(question, known).forEach((id) => ids.add(id));
  const every = ids.size === 0 || requested.some(isAllRequest);
  const siteIds = every ? known.map((s) => s.id) : known.map((s) => s.id).filter((id) => ids.has(id));
  const outside = intent.dates.filter((d) => d < windowA.from || d >= windowB.toExclusive);
  if (outside.length) return { ok: false, clarification: `I only have meter data from ${windowA.from} to ${addDays(windowB.toExclusive, -1)}, so I cannot look at ${outside.join(", ")}. Which day in that range do you mean?` };
  return { ok: true, siteIds, label: labelOf(siteIds, known), notes };
}
