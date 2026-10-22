// Test helpers for the agent: a synthetic scenario (colder, dearer window B with one logged event), a scriptable fake LLM and a facts-table parser.
// NOT a test file (imported by the *.test.ts files). No network: the data layer is the synthetic one, the chat function is a closure.
import type { ChatRequest, ChatResult, Route } from "./provider_shared.ts";
import { synth, type Synth } from "./hypotheses/testkit.ts";
import type { ChatFn } from "./agent_llm.ts";

export const SITE_NAMES = { S1: "Crumb & Co Shoreditch", S2: "Crumb & Co Brixton", S3: "Crumb & Co Hampstead" };

/** Window B is colder (more heating) and dearer in the evening peak, with less wind and more gas; S2 has one logged event. */
export function scenario(over: Parameters<typeof synth>[0] = {}): Synth {
  return synth({
    sites: ["S1", "S2", "S3"], siteNames: SITE_NAMES,
    temp: (w, day) => (w === "A" ? 16 : 9) + 2 * Math.sin(day),
    kwh: (_s, w, day, slot) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (w === "B" ? (0.15 * Math.max(0, 15.5 - (9 + 2 * Math.sin(day)))) / 6 : 0),
    price: (w, day, slot) => (slot >= 32 && slot < 38 ? (w === "B" ? 45 : 35) : slot < 14 ? 12 : 22) + (day % 5),
    wind: (w, _d, slot) => (w === "A" ? 33 : 28) - (slot >= 32 && slot < 38 ? 8 : 0), gas: (w) => (w === "A" ? 10 : 15),
    ops: [{ eventId: "E1", siteId: "S2", eventDate: "2026-10-07", description: "SAMPLE: Oven schedule moved 2h later from this date (new sourdough line)." }],
    ...over,
  });
}

export const route = (model = "mock/model-x", mode = "deep", latencyMs = 5): Route => ({
  provider: "meterless", requestedModel: `meterless/${mode}`, routedModel: model, label: "Mock model", kind: "test", tier: null, latencyMs, receiptId: "rcpt_test", raceWidth: 6,
  usage: { inputTokens: null, outputTokens: null, totalTokens: null, outputTps: null, routerLatencyMs: null },
});
export const reply = (content: string, mode = "deep"): ChatResult => ({ content, rawContent: content, toolCalls: [], route: route("mock/model-x", mode) });

export type Step = "intent" | "plan" | "narrative";
export const stepOf = (req: ChatRequest): Step => {
  const sys = String(req.messages[0]?.content ?? "");
  return sys.startsWith("You classify") ? "intent" : sys.startsWith("You plan") ? "plan" : "narrative";
};

export interface FactLine { id: string; hyp: string; label: string; display: string }
/** Reads the facts table back out of a narrative prompt (the model sees exactly this): "F9 [H1] label = display". */
export function factLines(req: ChatRequest): FactLine[] {
  const sys = String(req.messages[0].content);
  return sys.split("\n").filter((l) => /^F\d+ /.test(l)).map((l) => {
    const m = l.match(/^(F\d+)(?: \[(\w+)\])? (.*) = ([^=]*)$/)!;
    return { id: m[1], hyp: m[2] ?? "-", label: m[3], display: m[4] };
  });
}
export const lineBy = (lines: FactLine[], labelStart: string): FactLine => {
  const f = lines.find((l) => l.label.startsWith(labelStart));
  if (!f) throw new Error(`no fact starting with "${labelStart}"`);
  return f;
};
/** The placeholder of the fact whose label starts with `labelStart`, e.g. "{F9}". */
export const ph = (lines: FactLine[], labelStart: string, abs = false): string => `{${lineBy(lines, labelStart).id}${abs ? ":abs" : ""}}`;

export const INTENT_OK = (over: object = {}) => JSON.stringify({ type: "why_cost_change", sites: [], dates: [], ...over });
export const PLAN_OK = (over: object = {}) => JSON.stringify({ hypotheses: ["H1", "H2", "H3", "H4", "H5", "H6", "H11"], extraSql: [], ...over });

/** A placeholder narrative (no digits) that is valid for the scenario above, where H3 is supported and H5 is ruled out. */
export function goodNarrative(req: ChatRequest): string {
  const L = factLines(req);
  const p = (s: string, abs = false) => ph(L, s, abs);
  return JSON.stringify({
    headline: `Your bill rose by ${p("Change in the bill, window")}`,
    sentences: [
      { text: `Your bill rose by ${p("Change in the bill, window")} (${p("Change in the bill as a share")}), from ${p("Electricity bill in window A")} to ${p("Electricity bill in window B")}.` },
      { text: `Colder weather added ${p("Weather part of the volume effect")} (${p("Weather part as a share")} of the change).` },
    ],
    ruledOut: [{ hypothesis: "H5", text: `Timing is ruled out: it moved the bill by only ${p("Timing effect T:")} (${p("Timing effect T as a share")}).` }],
    recommendation: { text: `On window B prices, load shifting would have saved ${p("Load shift: money saved")}; as a historical counterfactual, the flat tariff would have cost ${p("Flat tariff minus Agile in window B")} more.` },
  });
}

/** goodNarrative with one figure written as digits that no fact has: the placeholder check rejects it. */
export function badNarrative(req: ChatRequest): string {
  const n = JSON.parse(goodNarrative(req));
  n.sentences[1].text = `Colder weather added £999.99 (${ph(factLines(req), "Weather part as a share")} of the change).`;
  return JSON.stringify(n);
}

/** Scripted fake LLM: `script` maps a step to the list of replies for its successive calls (the last one repeats). Records every request with its start and end time. */
export function fakeChat(script: Partial<Record<Step, (string | ((req: ChatRequest) => string) | Error)[]>>, delaysMs: Partial<Record<Step, number>> = {}) {
  const used: Record<string, number> = {};
  const requests: { step: Step; req: ChatRequest; startedAt: number; endedAt: number }[] = [];
  const fn = async (req: ChatRequest): Promise<ChatResult> => {
    const step = stepOf(req);
    const rec = { step, req, startedAt: performance.now(), endedAt: 0 };
    requests.push(rec);
    const list = script[step] ?? [];
    const n = used[step] ?? 0;
    used[step] = n + 1;
    const item = list[Math.min(n, list.length - 1)];
    if (delaysMs[step]) await new Promise((r) => setTimeout(r, delaysMs[step]));
    rec.endedAt = performance.now();
    if (item === undefined) throw new Error(`no scripted reply for ${step}`);
    if (item instanceof Error) throw item;
    return reply(typeof item === "function" ? item(req) : item, step === "intent" ? "auto" : "deep");
  };
  return Object.assign(fn as ChatFn, { requests });
}
