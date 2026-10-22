// Token accounting of the Markovian chain. Every figure carries its label: "estimated" is the reference engine's own estimator (ceil(chars / 4)) applied to the messages
// really sent and the replies really received; "measured" is the token usage the provider reported for the same calls (null when it reported none).
// The naive baseline is the reference's: one growing conversation that re-sends every earlier prompt and every earlier output at each step.
import type { ChatRequest, ChatResult, ChatMessage, Usage } from "./provider_shared.ts";
import type { ChatFn } from "./agent_llm.ts";
import { estimateTokens } from "./markovian_state.ts";

export interface TapeEntry { messages: ChatMessage[]; replyChars: number; usage: Usage | null; receiptId: string | null; model: string | null; provider: string | null; ms: number }
export type Tape = TapeEntry[];

/** A chat function that records the messages, the reply size and the usage of every call into `tape` (a failed call is recorded without a reply). */
export function tapChat(chat: ChatFn, tape: Tape): ChatFn {
  return async (req: ChatRequest): Promise<ChatResult> => {
    const entry: TapeEntry = { messages: req.messages, replyChars: 0, usage: null, receiptId: null, model: null, provider: null, ms: 0 };
    tape.push(entry);
    const t0 = performance.now();
    try {
      const res = await chat(req);
      entry.replyChars = res.content.length; entry.usage = res.route.usage; entry.receiptId = res.route.receiptId; entry.model = res.route.routedModel ?? res.route.requestedModel; entry.provider = res.route.provider;
      return res;
    } finally { entry.ms = Math.round(performance.now() - t0); }
  };
}

export const messageTokens = (m: ChatMessage[]): number => m.reduce((s, x) => s + estimateTokens(String(x.content ?? "")), 0);

export type ChunkKind = "plan" | "interpret" | "narrative" | "verify";
export interface ChunkLog {
  id: number; kind: ChunkKind; label: string; ms: number; llmCalls: number;
  inputTokens: { estimated: number; measured: number | null };      // everything sent in this chunk, carryover included
  outputTokens: { estimated: number; measured: number | null };
  carryoverIn: number; carryoverOut: number;                         // estimated tokens of the state handed in and handed on
  taskTokens: number;                                                // inputTokens.estimated minus the carryover block that is inside the prompt
  naiveInputTokens: number;                                          // estimated: this chunk's own prompt plus every earlier prompt and output, re-sent
  route: string | null; receiptIds: string[]; note?: string;
}

/** Fills the token fields of a chunk from the calls it made. `carryoverInPrompt`: tokens of the carryover text that is part of the prompts (0 when it is not sent). */
export function chunkTokens(tape: Tape, carryoverInPrompt: number): Pick<ChunkLog, "llmCalls" | "inputTokens" | "outputTokens" | "taskTokens" | "route" | "receiptIds"> {
  const input = tape.reduce((s, t) => s + messageTokens(t.messages), 0);
  const output = tape.reduce((s, t) => s + Math.ceil(t.replyChars / 4), 0);
  const allIn = tape.length > 0 && tape.every((t) => typeof t.usage?.inputTokens === "number");
  const allOut = tape.length > 0 && tape.every((t) => typeof t.usage?.outputTokens === "number");
  const last = [...tape].reverse().find((t) => t.model);
  return {
    llmCalls: tape.length,
    inputTokens: { estimated: input, measured: allIn ? tape.reduce((s, t) => s + (t.usage!.inputTokens as number), 0) : null },
    outputTokens: { estimated: output, measured: allOut ? tape.reduce((s, t) => s + (t.usage!.outputTokens as number), 0) : null },
    taskTokens: Math.max(0, input - carryoverInPrompt * tape.length),
    route: last ? `${last.provider}: ${last.model}` : null,
    receiptIds: [...new Set(tape.map((t) => t.receiptId).filter((x): x is string => !!x))],
  };
}

/** Adds the naive baseline: chunk i would have re-sent its own task prompt plus the task prompts and outputs of all chunks before it. */
export function withNaive(chunks: Omit<ChunkLog, "naiveInputTokens">[]): ChunkLog[] {
  let history = 0;
  return chunks.map((c) => {
    const naive = c.llmCalls ? c.taskTokens + history : 0;
    history += c.taskTokens + c.outputTokens.estimated;
    return { ...c, naiveInputTokens: naive };
  });
}

export interface ChainTotals {
  label: string;
  markovianInputEstimated: number; naiveInputEstimated: number; savedEstimated: number; savedPercentEstimated: number;
  markovianInputMeasured: number | null;               // sum of provider-reported input tokens when every call reported some
  plainLoopInputEstimated: number;                     // what the plain loop sends for the same question (plan + narrative prompt, no corrections), estimated
  referenceAccounting: { totalTokensUsed: number; tokensSaved: number; efficiencyPercent: number; label: string } | null;   // the engine's own run accounting (output tokens, configured carryover)
}

export function totalsOf(chunks: ChunkLog[], plainLoopInput: number, ref: ChainTotals["referenceAccounting"]): ChainTotals {
  const mk = chunks.reduce((s, c) => s + c.inputTokens.estimated, 0), naive = chunks.reduce((s, c) => s + c.naiveInputTokens, 0);
  const llm = chunks.filter((c) => c.llmCalls > 0);
  const measured = llm.length > 0 && llm.every((c) => c.inputTokens.measured !== null) ? llm.reduce((s, c) => s + (c.inputTokens.measured as number), 0) : null;
  return {
    label: "estimated = ceil(chars / 4) of the messages sent and replies received; measured = provider-reported usage (null when absent); naive = every earlier prompt and output re-sent",
    markovianInputEstimated: mk, naiveInputEstimated: naive, savedEstimated: naive - mk, savedPercentEstimated: naive > 0 ? Math.round(((naive - mk) / naive) * 1000) / 10 : 0,
    markovianInputMeasured: measured, plainLoopInputEstimated: plainLoopInput, referenceAccounting: ref,
  };
}
