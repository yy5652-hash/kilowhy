// Placeholder narration (D2e): the narrative model never writes a number. It writes {F3} (or {F3:abs} for the magnitude of a negative figure)
// and this module substitutes the fact's display string, records the cited facts, and refuses or repairs digits that appear outside placeholders.
// The existing verifier then checks the rendered text as the final gate.
import { tokenize } from "./verifier.ts";
import { displayFor } from "./facts_format.ts";
import type { Fact } from "./facts.ts";

/** {F3}, [F3], <F3>, {{F3}}, {F3:abs} and a bare F3 all mean the same placeholder; M1 is the same for a remembered note. */
const PH = /(?:[{[<]{1,2}\s*)?\b([FM])(\d+)\b(?:\s*:\s*(abs|magnitude))?(?:\s*[}\]>]{1,2})?/gi;
/** Identifiers that may stay as written: hypothesis ids and site ids (E# evidence markers are dropped by the caller). */
const ALLOWED_ID = /\b[HSE]\d+\b|\b(?:kg|g)?CO2e?\b|CO\u2082e?/g;   // plus unit names that contain a digit (kgCO2e)

export interface Rendered {
  text: string;                 // placeholders replaced by display strings
  facts: string[];              // cited fact ids in order of first use
  errors: string[];             // unknown ids, digits outside placeholders
  repairs: string[];            // digits that were turned into the placeholder of the fact with exactly that display
}

const magnitude = (f: Fact): string => (typeof f.value === "number" ? displayFor(Math.abs(f.value), f.unit) : f.display);

/** Digit-bearing words left once placeholders and allowed ids are removed. */
export function strayDigits(raw: string): string[] {
  const bare = raw.replace(PH, " ").replace(ALLOWED_ID, " ");
  return [...new Set(bare.match(/[^\s]*\d[^\s]*/g) ?? [])].map((w) => w.replace(/^[("'“]+|[)"'.,;:”]+$/g, ""));
}

/** Turns digits that spell out exactly one fact's display ("£339.91", "17.0%", "2026-10-17") into that fact's placeholder. */
function repairDigits(raw: string, byId: Map<string, Fact>): { text: string; repairs: string[] } {
  const repairs: string[] = [];
  let text = raw;
  const masked = raw.replace(PH, (m) => " ".repeat(m.length));
  for (const t of tokenize(masked)) {
    const shown = t.raw.trim();
    const hits = [...byId.values()].filter((f) => f.display === shown);
    const ids = hits.length > 1 && hits.every((h) => h.display === hits[0].display) ? [hits.find((h) => !h.hypothesis) ?? hits[0]] : hits;
    if (ids.length !== 1 || !text.includes(shown)) continue;
    text = text.replace(shown, `{${ids[0].id}}`);
    repairs.push(`"${shown}" -> {${ids[0].id}}`);
  }
  return { text, repairs };
}

/** Display strings already carry their unit, so "124 kWh kWh" and "3.1 pp pp" are model slips; a full stop after a description that ends in one is doubled. */
const UNIT_TWICE = /(\b(?:kWh|kgCO2e|pp|sd|HDD|p\/kWh|days|slots)\b)(?:\s+(?:\1|kilowatt-hours?|percentage points?))\b/gi;
const UNIT_EXPLAINED = /(\bsd)\s+(?:standard deviations?)\b|(\bkWh\/HDD)\s+(?:kWh\s+)?per (?:heating degree day|HDD)\b|(\bHDD)\s+(?:heating degree days?)\b/gi;
export function tidy(text: string): string {
  return text.replace(UNIT_TWICE, "$1").replace(UNIT_EXPLAINED, (_m, a, b, c) => a ?? b ?? c).replace(/(%)\s*(?:percent|per cent|%)/gi, "$1").replace(/(?<!\.)\.\.(?!\.)/g, ".").replace(/\s+([,.;:])/g, "$1").replace(/\s+/g, " ").trim();
}

/** A time of day or a date written in digits that appears verbatim in exactly one fact's display ("04:00-07:00" inside "10:00-13:00, 04:00-07:00"): keep the words, cite that fact. */
function citeLiterals(raw: string, byId: Map<string, Fact>): { text: string; kept: string[]; cited: string[]; repairs: string[] } {
  const kept: string[] = [], cited: string[] = [], repairs: string[] = [];
  let text = raw;
  const masked = raw.replace(PH, (m) => " ".repeat(m.length));
  for (const t of tokenize(masked)) {
    if (t.type !== "time" && t.type !== "date") continue;
    const shown = t.raw.trim();
    const hits = [...byId.values()].filter((f) => f.display.includes(shown));
    if (hits.length !== 1 || !text.includes(shown) || kept.length >= 26) continue;
    text = text.replace(shown, `\uE000${String.fromCharCode(97 + kept.length)}\uE001`);
    kept.push(shown);
    if (!cited.includes(hits[0].id)) cited.push(hits[0].id);
    repairs.push(`"${shown}" kept, ${hits[0].id} cited`);
  }
  return { text, kept, cited, repairs };
}
const restore = (text: string, kept: string[]): string => text.replace(/\uE000([a-z])\uE001/g, (_m, c: string) => kept[c.charCodeAt(0) - 97] ?? "");

/** Renders one piece of model text. `where` prefixes the error messages ("sentences[2]"). */
export function renderPlaceholders(raw: string, byId: Map<string, Fact>, where: string): Rendered {
  const errors: string[] = [];
  let source = raw;
  let repairs: string[] = [];
  if (strayDigits(source).length) {
    const r = repairDigits(source, byId);
    source = r.text; repairs = r.repairs;
  }
  let kept: string[] = [], cited: string[] = [];
  if (strayDigits(source).length) {
    const c = citeLiterals(source, byId);
    source = c.text; kept = c.kept; cited = c.cited; repairs = [...repairs, ...c.repairs];
  }
  const stray = strayDigits(source).map((w) => restore(w, kept));
  if (stray.length) errors.push(`${where}: digits written outside placeholders (${stray.slice(0, 4).map((s) => `"${s}"`).join(", ")}); write the fact's placeholder such as {F3} instead, and spell out small counts in words`);
  const facts: string[] = [];
  const rendered = source.replace(PH, (_m, letter: string, n: string, abs?: string) => {
    const f = byId.get(`${letter.toUpperCase()}${n}`);
    if (!f) { errors.push(`${where}: placeholder {${letter.toUpperCase()}${n}} does not exist in the facts table`); return ""; }
    if (!facts.includes(f.id)) facts.push(f.id);
    return abs ? magnitude(f) : f.display;
  });
  for (const id of cited) if (!facts.includes(id)) facts.push(id);
  const text = tidy(restore(rendered, kept));
  if (facts.length === 0 && !errors.length) errors.push(`${where}: no placeholder; every sentence must use at least one {F#} placeholder`);
  return { text, facts, errors, repairs: repairs.map((r) => `${where}: ${r}`) };
}
