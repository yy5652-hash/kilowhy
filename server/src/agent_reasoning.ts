// How the agent asks Nemotron not to think out loud. Chosen from the measurements in docs/latency.md (scripts/reasoning_probe.ts):
// chat_template_kwargs.enable_thinking=false cut the narrative call from a median 26 s to 14 s through Meterless and from 27 s to 7 s on NVIDIA direct.
// The system lines ("/no_think", "detailed thinking off") and reasoning_effort did not help, so they are not sent.
import type { ReasoningControl } from "./agent_llm.ts";

export const DEFAULT_REASONING: ReasoningControl | undefined = { extra: { chat_template_kwargs: { enable_thinking: false } } };
