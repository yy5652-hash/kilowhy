# How Kilowhy was built

Kilowhy was built by two coding agents working to one plan, with the work split by area and every hand-off kept in the repository. This page says which agent built what, where the evidence is, and what the finished product runs on.

## Who built what

| Area | Built by | Where to look |
|---|---|---|
| Sample meter-data generator (D1): three bakery sites, half-hourly SAMPLE kWh, dated operational events | **Cursor CLI** (headless agent) | `scripts/generate_sample.ts`, `data/sample/`, transcript `docs/cursor-log/d1-sample-generator.jsonl` |
| Web UI scaffold and components (D4): React 18 + Vite + TypeScript, question box, live timeline, answer card with SVG waterfall, citation chips, evidence drawer, ruled-out chips, recommendation card, memory panel, "How it works" footer | **Cursor CLI** | `web/`, prompt `docs/cursor-prompts/d4-ui.md`, transcript `docs/cursor-log/d4-ui.jsonl` |
| First UI polish pass (D5): zoomed waterfall, recent answers, LLM receipts, "How this answer was made", memory panel work | **Cursor CLI** | prompt `docs/cursor-prompts/d5-ui-polish.md`, transcript `docs/cursor-log/d5-ui-polish.jsonl` |
| Zetaris DDL and data layer: views over real Octopus, NESO, Elexon and Open-Meteo data plus the sample meters, a read-only SQL guard, evidence records | **Claude** (Claude Code) | `scripts/zetaris_ddl.ts`, `server/src/data.ts`, `sqlguard.ts`, `evidence.ts` |
| Exact bill-change decomposition (volume, price, timing, standing; weather split) | **Claude** | `server/src/decompose.ts` |
| Hypotheses H1 to H11, load-shift recommendation, tariff counterfactual | **Claude** | `server/src/hypotheses/`, `recommend.ts`, `flat_tariff.ts` |
| Facts table, verifier (every figure in an answer is matched to a cited fact), agent loop | **Claude** | `server/src/facts*.ts`, `verifier.ts`, `agent*.ts` |
| Meterless Nightshift provider with compute receipts and the labelled NVIDIA-direct fallback | **Claude** | `server/src/provider*.ts` |
| Meterless engines integration: H-MEM, World Model, Markovian | **Claude** | `server/src/memory*.ts`, `worldmodel*.ts`, `investigate_markovian.ts`, `vendor/meterless/` |
| HTTP server: API plus the built UI on one origin | **Claude** | `server/src/http.ts` |
| Evaluation: 12 planted-cause scenarios on real market windows | **Claude** | `eval/`, `scripts/eval_run.ts` |
| UI polish, final pass (D5c) | **Claude** | `web/` (details below) |

How Claude worked: Claude Code in the main session, with Sonnet sub-agents for implementation, tests and long-output tasks, and Opus for design and review decisions. The two agents never edited the same area at once: Cursor worked inside `web/` (and the D1 generator), Claude owned `server/`, `scripts/`, `eval/` and `vendor/`.

## What it runs on

The language model at runtime is **Nemotron, served through Meterless Nightshift** (the local Meterless runtime). Each call returns a compute receipt (receipt id, requested and routed model, tier, race width, latency, token usage), and the UI shows it next to the step that made the call. If Nightshift has not answered in time, a labelled **NVIDIA-direct** call to Nemotron is used instead, and the UI marks every such step as a fallback. Embeddings for memory recall go through the same labelled route. The three Meterless engines (H-MEM, World Model, Markovian) are vendored unchanged and used as libraries in every investigation.

## The D5 hand-over

The D5 Cursor session reached its free-plan usage limit part-way through the polish list. It had produced the components and wiring for recent answers, receipts, "How this answer was made" and the memory panel, and the build passed. Claude took over from that commit and finished the list as **D5c**, working only in `web/` and the two docs files. The prompt that defined the list is kept as `docs/cursor-prompts/d5-ui-polish.md`.

### What Claude changed in D5c

- **Markovian chart** in "How this answer was made", redesigned as a compact horizontal bar chart. Each step has a readable name (Plan, Interpret 1/2, Interpret 2/2, Narrative, Verify) with its hypotheses as a sub-label; two clearly different series (solid: input sent to the step; hatched: naive full-history re-send) with a legend; values sit inside the card; "est." appears only on estimated values, and provider-reported (measured) input counts are listed separately under the steps that have them. A one-line summary comes from the engine's own totals, for example "Chain total ≈ 4,065 tokens vs ≈ 7,133 naive (43% less), estimated".
- **Styles for the D5 components.** The D5 session ended before the style sheet covered the recent-answers list, receipts, origin badges, audit list, recall list, entity counts and step timings; these are now styled in light and dark.
- **Memory panel.** Lists `GET /api/memory` grouped by site (the selected site first), each memory with an origin badge (your note or agent finding), date learned, valid-from date when present, confidence and, for agent findings, the source line. The audit-trail expander calls `GET /api/memory/:id/audit` and shows action, actor and time. The "Add a note" form posts to `POST /api/notes`, confirms, and refreshes the list. The list also refreshes when a new answer arrives, because the agent writes its findings after verification. `[M#]` chips (in the answer, in the recall line and in the recall list) open the panel, scroll to the memory, highlight it and move keyboard focus to it; memories the current answer recalled carry a "recalled in this answer" tag.
- **LLM receipts** in the timeline and in the how-made section: a compact line (route badge, model, latency, tokens, race width) that expands to receipt id, requested to routed model, label, tier, race width, latency and token usage. NVIDIA-direct fallbacks are labelled in the line and in the expanded view, with the fallback reason.
- **Headlines** in ALL CAPS are shown in sentence case on the client (site names and units such as kWh restored); long headlines wrap and balance.
- **Waterfall** drawn in real pixels at any width: on screens narrower than 560 px it lies on its side with one row per bar so labels and values stay readable; two-line labels, a colour legend and a note on the zoomed axis.
- **Status chips.** "Meterless Nightshift · offline" is amber, with a one-line hint that answers fall back to NVIDIA direct, labelled; the Nemotron chip says which route is in use.
- **Responsive and accessible.** No horizontal scroll at 375 px; the evidence drawer becomes a full-width bottom sheet on phones, takes focus when it opens and returns it when it closes, and is not focusable while closed; visible focus rings; text contrast of at least 4.5:1 and control borders of at least 3:1 in both themes (checked); motion is reduced when the system asks for it; the "How it works" diagram becomes a stacked list on phones.
- **Footer credit** updated to name both tools and point to this page.

Every money figure in the UI still comes from the server's fact strings, as in the Cursor version; the only number the UI derives is the start of the zoomed waterfall axis, which is labelled as such.

## Evidence trail

- Cursor transcripts: `docs/cursor-log/` (D1, D4, D5). Prompts: `docs/cursor-prompts/`. Usage summary: `docs/cursor-usage.md`.
- Git history: commits are prefixed by day of the plan (D1 to D5, D5c); the commit messages for the Cursor-built parts say so.
- Build check for the UI: `cd web && npm run build` (TypeScript strict plus Vite).
