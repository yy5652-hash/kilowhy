# Latency of the agent loop (D2e)

Goal: cut a question from about 280-350 s to under about 60 s and keep the answers verified.
All numbers below are measurements from this machine (Meterless Nightshift on 127.0.0.1:8088, Zetaris on localhost:8888, NVIDIA hosted API), taken on 2026-10-22.
The raw data is in `eval/latency/` (`runs_d2e.json`, `reasoning_probe*.json`); meter kWh are SAMPLE data.

## Result

Each question was run twice, 60 s apart, on the final code (`scripts/ask.ts`). "Before" is the committed D2d run (`eval/answers/*.json` at commit d775782).

| question | before total | before narrative (attempts) | after run 1 | after run 2 | median | narrative attempts (run 1 / 2) | mode (run 1 / 2) |
|---|---|---|---|---|---|---|---|
| Why did our electricity cost more in the last four weeks than the four weeks before? | 278.3 s | 241.3 s (2) | 28.4 s | 39.3 s | 33.9 s | 1 / 1 | llm / llm |
| Why did Brixton use more electricity? | 282.2 s | 218.6 s (2) | 38.6 s | 18.4 s | 28.5 s | 2 / 1 | llm / llm |
| What should we change to save money? | 348.7 s | 297.3 s (2) | 31.7 s | 25.4 s | 28.5 s | 1 / 1 | llm / llm |

Routes of the last run of each question (full per-call detail, with wall time, in `runs_d2e.json`):

- Intent: Meterless for questions 1 and 2 (0.1 s, from the Nightshift cache, see the caveats); for question 3 the labelled NVIDIA direct route (Nemotron 3.5 Lightning 30B, 8.6-8.8 s wall, because Meterless had not answered within the 8 s hedge delay).
- Plan: Meterless (3.5 Super VL 120B, from the Nightshift cache, 0.1 s) for questions 1 and 2; NVIDIA direct (Nemotron 3 Ultra 550B, 9.1 s wall) for question 3 run 2, Meterless (15.9 s) in run 1, which arrived too late and was replaced by the default emphasis.
- Narrative: **NVIDIA direct, Nemotron 3 Ultra 550B, in all six runs.** Meterless was tried first, did not answer within 6 s, and the labelled direct call that starts alongside it won (`fallbackReason: meterless had not answered after 6s; the labelled fallback was started alongside`). In one run (question 1, run 2) both calls failed (Meterless timed out at 25 s, the direct call was rate limited), and the single direct retry answered in 5.8 s.

Step breakdown, question 3, run 2 (seconds; steps overlap): sites 0.3, plan 9.1 and intent 8.8 (concurrent with each other and with data), data 1.7 (all eleven hypotheses and both recommendations), facts 0.0, narrative 16.3, total 25.4.
Before (same question): intent 3.7, decomposition 4.5, plan 28.0, hypotheses 8.6, extra SQL 1.6, tariff 2.1, narrative 297.3, total 348.7, run one after the other.

Caveats, so the table is not over-read:

- In the Nightshift-cached rows (`plan` and `intent` at 0.1 s) the same question text had been asked several times in the session. A new question pays 1-10 s for those two calls, but they overlap the data work, so the total changes little.
- Run-to-run spread is large because the upstream models are shared and rate limited. Of 48 runs made while developing (8 batches of six) all 48 answers verified, 10 ended in template mode (all in batches run before the 429 back-off, the direct retry and the plan grace period existed; the last batch had none), and the totals ranged from 13 s to 87 s. None of the last 24 runs took longer than 43 s.
- The six runs in the table are the last batch, not the best of several.

## Where the 297 s went (question 3, before)

The narrative call took 297 s of 349 s: a Meterless attempt that ended in HTTP 502 (about 90 s), the labelled NVIDIA call (85 s), a verifier rejection, and a corrective call (122 s). The receipt of the first narrative call says 4,273 input and 4,399 output tokens: almost all of the output was the model's reasoning, written as text before the JSON, and the JSON itself asked for numbers that the model then had to copy exactly.

## What changed

1. **Placeholder narration** (`placeholders.ts`, `narration.ts`). The model writes `{F9}` (or `{F9:abs}` for the magnitude of a negative figure) instead of numbers; code substitutes the fact's display string and records the cited facts and their evidence, so the JSON is only `{headline, sentences:[{text}], ruledOut:[{hypothesis,text}], recommendation:{text}}`. Digits outside placeholders are repaired when they spell exactly one fact's display, kept and cited when they are a time or date inside one fact's display ("04:00-07:00"), and otherwise rejected. A sentence that cites a fact of a hypothesis that is not supported, or names one as a cause, is dropped instead of triggering a corrective call (if two sentences remain). The existing verifier still checks the rendered text and passed first time in 5 of the 6 final runs (one run needed one correction, for a digit the model had written for a threshold).
2. **Smaller prompts.** Only the facts of supported and ruled-out hypotheses are sent, a ruled-out hypothesis gets at most three of its facts, emissions facts are left out of cost questions and cost facts out of emissions questions, and each fact is one line. Question 3: 103 facts and 8,532 characters of table became 80 facts and 5,648 characters (before the question-type filter), and the narrative call went from 4,273 input / 4,399 output tokens to 3,020 input / 668 output tokens. The plan prompt now holds the question and the catalog titles only.
3. **Reasoning control**: measured below. `chat_template_kwargs.enable_thinking=false` is sent on every call; it only takes effect on the direct NVIDIA route.
4. **Concurrency** (`agent.ts`, `agent_run.ts`). The plan call starts at once (it sees only the question), the intent call and the data work start together, and all eleven hypotheses always run over queries that `data.prefetch` fired in parallel (seven Zetaris queries at once), so evidence ids E1.. do not depend on timing. The data stage dropped from 17-42 s (decomposition + hypotheses + tariff + extra SQL, one after the other) to 1.7-2.8 s in the final runs (3.7-6.6 s on a cold Zetaris cache). If the intent resolves to a different scope than the question text implied, the speculative work is discarded and redone (`reset` event, tested). The narrative waits for the plan for at most 4 s past the moment the data and the intent are ready (`planGraceMs`), because the plan only orders the tests.
5. **Deadlines, hedging, rate limits** (`provider.ts`). Each call has a deadline (intent 20 s, plan 30 s, narrative 25 s). A Meterless call that is still running after a hedge delay (intent and plan 8 s, narrative 6 s) is joined by the labelled NVIDIA call; the first answer wins and the other is cancelled, and `fallbackReason` says what happened. A NVIDIA 429 is retried twice (Retry-After, then twice that, at most 5 s). If the narrative call fails outright with a timeout, 429, 5xx or network error and under 40 s have passed, one more call goes straight to the labelled NVIDIA route (`narrative (direct retry)`). `LlmCall.wallMs` records the whole call as the agent saw it, because `route.latencyMs` only covers the answering attempt.
6. **Progress events** (`agent_events.ts`). `investigate(question, { onEvent })` emits step started/finished with milliseconds, each evidence record as it is created, each hypothesis result, each LLM call with its route, a `reset` when speculative work is discarded, and `done`. A listener that throws cannot break the run. `onProgress` still receives the step names.

## Measurement: can Nemotron be told not to think?

`scripts/reasoning_probe.ts` sends the real narrative request (7,598 characters) several times per variant and records wall time, output tokens and whether the reply is valid JSON.

Finding 1: the JSON answer itself is about 530 tokens, so a 500-token cap truncated every reply (0% valid JSON in every capped row). The caps in the agent are therefore generous (intent 800, plan 1,200, narrative 2,200); they only stop a runaway.

Finding 2: on the **direct NVIDIA route** (cap 3,000, 2 repeats):

| variant | median wall (s) | median output tokens | valid JSON |
|---|---|---|---|
| baseline | 27.3 | 1828 | 100% |
| `chat_template_kwargs: {enable_thinking: false}` | 7.1 | 528 | 100% |
| `thinking: {type: "disabled"}` | 11.0 | 529 | 100% |
| `chat_template_kwargs: {low_effort: true}` | 41.0 | 2000 | 100% |
| `reasoning: {effort: "low"}` | 66.6 | 2625 | 100% |

`enable_thinking=false` removes about 70% of the output tokens and 74% of the time. The system lines `/no_think` and `detailed thinking off` did not help (cap-500 rows, direct: 13.8 s and 9.8 s, both still 500 tokens of reasoning text), and `reasoning_budget` is rejected by the server ("thinking_token_budget is not yet supported").

Finding 3: through **Meterless** (cap 3,000, 3 repeats) the same request:

| variant | median wall (s) | valid JSON |
|---|---|---|
| baseline | 26.1 | 100% |
| `enable_thinking=false` | 13.8 | 100% |
| `enable_thinking=false` + "detailed thinking off" | 14.5 | 100% |
| `thinking: {type: "disabled"}` | 15.5 | 100% |

The wall time halves, but the reply still starts with the model's reasoning as plain text and reports about 1,270 output tokens, so the control is only partly honoured by the router. With a 900-token cap all four Meterless replies hit the cap and three had no complete JSON, because the reasoning had used the budget. In `fast` and `auto` mode the router still chose Nemotron 3 Ultra 550B (or 3.5 Super VL) and the controls made no visible difference at a 500-token cap. Meterless receipts report a constant token count for these rows, so wall time is the number to trust.

Kept: `enable_thinking=false` on every call (no system line). Not kept: the system lines, `low_effort`, `reasoning_effort`, `thinking.type`. Raw rows with the start of each reply: `eval/latency/reasoning_probe*.json`.

## Nightshift's response cache is keyed on the user message only

While measuring, the plan step sometimes came back in 0.1 s with the **intent** reply (`{"type": "why_cost_change", ...}`). Reproduced with a direct request: the cache (`meterless.from_cache: true`, status `exact` or `semantic_hard`) ignores the system prompt and matches on the user message. Two steps that sent the bare question as the user message therefore shared one cached answer. Fixes, with tests: each step's user message is unique to the step ("Classify this question: ...", "Order the tests for this question: ..."), and the narrative's user message ends with a fingerprint of the facts table it was written from, so a cached narrative can never be replayed against different facts (its placeholders would point at other facts). `Route.fromCache` and the CLI show when an answer came from the cache. No request header that bypasses the cache was found (`meterless-cache`, `meterless-no-cache`, `cache-control` were tried).

## Decision for the coordinator

Meterless is still tried first on every call, but with a 6 s hedge the direct NVIDIA route answers the narrative almost every time (Meterless needed 14-37 s in the probes). If Meterless must serve the narrative, set `HEDGE_AFTER_MS.narrative` in `server/src/agent.ts` to 25000: expect about 15-25 s more per question and more timeouts at the 25 s deadline. The `llmCalls` list shows the route of every step either way.

## Reproduce

```
node scripts/ask.ts "What should we change to save money?"           # prints routes, wall times, timings
node scripts/reasoning_probe.ts --repeats 3 --cap 3000 --only baseline,kwargs_enable_thinking          # Meterless
node scripts/reasoning_probe.ts --repeats 2 --direct --cap 3000 --out reasoning_probe_direct_cap3000    # NVIDIA direct
```
