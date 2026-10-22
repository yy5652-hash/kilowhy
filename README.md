# Kilowhy

An agent that explains *why* a small business's electricity cost changed, and what to do about it.
Built for the Open Agent Hackathon 2026, Track 02 "The Agent That Can Explain Why".

Status: build in progress (D1). Meter data in `data/sample/` is **sample data** (generated); prices, carbon intensity, weather and generation are real public data queried through Zetaris.

## Meterless engines

Kilowhy mounts all three Meterless agent engines as working parts of every investigation. They are pre-existing open-source components (Apache-2.0), vendored unchanged under `vendor/meterless/` (upstream commit and licence in `vendor/README.md`) and imported as libraries; the integration code is Kilowhy's own. Nightshift (Meterless) is the primary LLM provider; embeddings for memory recall come through the labelled `provider.embed` route (Nemotron embed 1B).

| Engine | What it does in Kilowhy | Code | See it work |
|---|---|---|---|
| **H-MEM** | Investigation memory. Notes the owner tells us and causes the agent confirmed are stored with provenance (source, evidence ids, Zetaris run ids, Nightshift receipt ids). Every investigation recalls what is relevant at the start (hybrid ranking with a retrieval trace), each recalled memory becomes an `M#` fact the answer may cite, and every write, read and feedback lands in the append-only trust ledger. | `server/src/memory.ts` (`remember`, `recall`, `audit`, `feedback`), `memory_confirm.ts` (`confirmCauses`), `agent.ts` + `agent_memory.ts` (recall at the start, `M#` facts, plan prompt) | `node scripts/note.ts --site S2 "..."`, `node scripts/note.ts --recall "..." --site S2`, `node scripts/note.ts --audit mem-6`, `eval/memory_demo.json` |
| **World Model** | Grounded entities read from Zetaris: sites (with aliases such as "Brixton"), meters, the contract, the Agile tariff and the flat comparison tariff, and the `ops_log` events as bitemporal edges and facts, each stamped `{view, zetarisRunId, at}`. The site a question names is resolved with the engine's 0.85 / 0.82 resolve bands (an unknown or near-miss name becomes a clarification), and the events in a window feed the H4, H5 and H11 evidence. Re-ingest is idempotent. | `server/src/worldmodel.ts` (`ingest`, `resolveSite`, `factsFor`), `worldmodel_ingest.ts`, `worldmodel_resolve.ts` | `node scripts/worldmodel_check.ts` (ingests twice: empty diff, 12 entities, 10 relationships, 3 facts) |
| **Markovian** | The LLM part of an investigation runs as bounded chunks on the engine's orchestrator: plan, interpret the hypothesis results in batches, narrative, verify. Only a compact JSON carryover (scope, hypothesis table, evidence ids, readings, open questions; at most 800 tokens) travels between chunks, and a rejected draft is corrected in a new chunk that carries the verifier's errors. Tokens per chunk are logged next to the reference's naive full-history estimate. | `server/src/investigate_markovian.ts` (`runMarkovianChain`), `markovian_state.ts`, `markovian_log.ts`; `investigate(q, { engine: "markovian" })` is the default | `node scripts/ask.ts "..."` prints the chain; `eval/markovian_tokens.json`; `node scripts/markovian_latency.ts` |

`node scripts/engines_check.ts` runs each engine's own test suite (10 + 10 + 10 tests pass).

### Memory demo (live, SAMPLE meter data)

```
node scripts/ask.ts "Why did Brixton use more electricity?"                      # empty memory; the supported causes are written (mem-1..5)
node scripts/note.ts --site S2 "Brixton moved its oven schedule 2 hours later from 7 Oct for the new sourdough line"
node scripts/ask.ts "Why did Brixton use more electricity?"                      # the note comes back as M1 and is cited next to the timing test
node scripts/note.ts --audit mem-6                                              # create, update, every recall, with actors and timestamps
```

The second answer carries the owner's note in the ruled-out timing item: "A timing shift moved the oven schedule two hours later on 7 Oct "Brixton moved its oven schedule ..." (your note, 2026-10-22), but the timing effect on the bill was only 1.0%, so it is not a cause." The verifier still checks every figure; the note is shown verbatim with its date and source and sits next to evidence-backed facts. The full before and after answers and the ledger are in `eval/memory_demo.json` and `eval/answers/`.

### Markovian token log

Each chunk records the input tokens really sent (estimated as characters / 4, the reference engine's estimator, and measured where the provider reports usage) beside the reference's naive full-history estimate (every earlier prompt and output re-sent). Over the logged Brixton runs the chain sent about 3,700 to 4,000 estimated input tokens against about 6,700 to 7,200 for the naive full-history version, 44% less, with the carryover held at 160 to 300 estimated tokens per chunk. Raw rows: `eval/markovian_tokens.json`; plain loop against chain, live: `eval/latency/markovian_d3.json`.
