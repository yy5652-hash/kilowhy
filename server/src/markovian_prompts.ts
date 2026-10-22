// Prompts of the Markovian chain that the plain loop does not have: the interpret chunk (reads a batch of hypothesis results) and the narrative chunk that sees the
// carryover instead of every fact. The model never sees SQL, tokens or keys; it writes {F#} placeholders, never digits (placeholders.ts, as in the plain loop).
import { createHash } from "node:crypto";
import type { ChatMessage } from "./provider_shared.ts";
import type { Checked } from "./agent_llm.ts";
import type { Fact } from "./facts.ts";
import type { HypInfo } from "./verifier.ts";
import { narrativeMessages, relevantFacts, factsTable, type NarrativeInput } from "./agent_prompts.ts";
import { strayDigits } from "./placeholders.ts";
import { citedFacts, clean, type ChainState } from "./markovian_state.ts";

export const INTERPRET_MAX_TOKENS = 900;       // the reply is about 60 tokens per test; the rest is room for the reasoning that Meterless routes write out before the JSON
const MAX_FACTS_PER_TEST = 9;

export interface InterpretInput { question: string; scopeText: string; state: string; ids: string[]; label: string; hyps: HypInfo[]; titles: Record<string, string>; facts: Fact[] }

/** The facts shown for one test: up to nine for a supported one, a few for a ruled-out one. */
export function factsOfTest(facts: Fact[], id: string, status: string): Fact[] {
  const own = facts.filter((f) => f.hypothesis === id);
  return status === "supported" ? own.slice(0, MAX_FACTS_PER_TEST) : own.slice(0, 4);
}

export function interpretMessages(i: InterpretInput): ChatMessage[] {
  const blocks = i.ids.map((id) => {
    const h = i.hyps.find((x) => x.id === id)!;
    return `${id} ${i.titles[id] ?? h.name}: ${h.status}\n${factsTable(factsOfTest(i.facts, id, h.status)) || "(no facts)"}`;
  }).join("\n\n");
  const system =
`You read the results of a few tests that explain a change in a small business's electricity bill. For each test below write ONE plain-English reading of at most 20 words.
Rules: never write a digit, a year or a time; every reading must contain the placeholder of its key fact, copied from the list under that test, for example {F9}, in the place where the figure belongs; use only the facts listed under that test; say what the test found (supported = it is a cause, ruled_out = it is not a cause, inconclusive = unclear) and nothing else.
Reply with ONE JSON object and nothing else, for example: {"readings": [{"id": "H3", "reading": "Colder weather added {F9} to the bill, so it is a cause."}, {"id": "H5", "reading": "Moving use between times of day changed the bill by only {F14}, so it is not a cause."}]}
Earlier chunks of this investigation (JSON carryover): ${i.state}`;
  const fp = createHash("sha256").update(blocks).digest("hex").slice(0, 10);
  return [{ role: "system", content: system }, { role: "user", content: `Question: ${i.question}\nScope: ${i.scopeText}\nChunk ${i.label}. Read these tests (${fp}):\n\n${blocks}` }];
}

export interface Reading { id: string; reading: string }
/** {"readings": [{id, reading}]} (a map {"H3": "..."} is accepted too). Only ids of the batch survive, a reading with a digit outside a placeholder is dropped. */
export function checkReadings(ids: string[]): (v: unknown) => Checked<{ readings: Reading[]; dropped: string[] }> {
  return (v) => {
    const o = v as { readings?: unknown } | null;
    const raw = o && typeof o === "object" ? o.readings : undefined;
    const list: { id?: unknown; reading?: unknown }[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([id, reading]) => ({ id, reading })) : [];
    if (!list.length) return { ok: false, error: 'the object needs a "readings" array of {"id": "H3", "reading": "..."}' };
    const readings: Reading[] = [], dropped: string[] = [];
    for (const x of list) {
      const id = typeof x.id === "string" ? x.id.toUpperCase().replace(/^(H)0+(\d)/, "$1$2").trim() : "";
      if (!ids.includes(id) || typeof x.reading !== "string" || readings.some((r) => r.id === id)) continue;
      const reading = clean(x.reading);
      if (!reading) continue;
      const stray = strayDigits(reading);
      if (stray.length) { dropped.push(`${id}: digits outside placeholders (${stray.slice(0, 3).join(", ")})`); continue; }
      readings.push({ id, reading });
    }
    return { ok: true, value: { readings, dropped } };
  };
}

/**
 * The facts the narrative chunk is shown: the plain loop's relevant facts, minus the details of a test that an interpret chunk has already read
 * (only the facts its reading cites stay). Neutral, recommendation and remembered-note facts always stay.
 */
export function chunkFacts(facts: Fact[], hyps: HypInfo[], emphasis: string[], type: NarrativeInput["type"], state: ChainState): Fact[] {
  const cited = new Map<string, Set<string>>();       // test -> the facts its reading cites (a reading that cites none leaves the test's facts untouched)
  for (const [h, reading] of Object.entries(state.read)) { const ids = citedFacts(reading); if (ids.length && state.hyp[h] !== undefined) cited.set(h, new Set(ids)); }
  const bearing = new Set(facts.flatMap((f) => f.memory?.bearsOn ?? []));
  return relevantFacts(facts, hyps, emphasis, type).filter((f) => !f.hypothesis || !cited.has(f.hypothesis) || cited.get(f.hypothesis)!.has(f.id) || bearing.has(f.id));
}

/** The plain narrative prompt over the reduced facts, plus the carryover (the readings) and a fingerprint that includes it. */
export function narrativeChunkMessages(i: NarrativeInput, state: string): ChatMessage[] {
  const [system, user] = narrativeMessages(i);
  const fp = createHash("sha256").update(state).digest("hex").slice(0, 8);
  return [
    { ...system, content: `${system.content}\nEarlier chunks of this investigation (JSON carryover). "read" holds a plain reading per test, written with the same placeholders: reuse them, and use only the facts listed above.\n${state}` },
    { ...user, content: `${user.content} Carryover ${fp}.` },
  ];
}
