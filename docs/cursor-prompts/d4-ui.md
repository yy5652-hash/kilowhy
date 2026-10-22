Build the Kilowhy web UI in `web/` (React 18 + Vite + TypeScript). ONLY create or modify files under `web/` (and you may create `docs/cursor-usage.md`). Do NOT touch `server/`, `scripts/`, `vendor/` or anything else — another agent is editing the server right now.

What Kilowhy is: an agent that explains why a small business's half-hourly electricity bill changed. It splits the change into price, weather-driven volume, operational volume, timing and standing charge, tests 11 hypotheses against data federated through Zetaris (real Octopus Agile prices, NESO carbon intensity, Elexon generation, Open-Meteo temperature; meter readings are SAMPLE data for a 3-site London bakery), and writes a short answer in which every figure is checked against its source. LLM calls go through Meterless Nightshift (local runtime) to NVIDIA Nemotron.

Read these first to learn the exact data shapes:
- `server/src/agent_types.ts` (InvestigationResult and friends)
- `server/src/agent_events.ts` (ProgressEvent — the live stream)
- `eval/answers/*.json` (three real results; copy them into `web/src/fixtures/` for offline development)
- `docs/` for context if needed.

API (served later by a Node server on 127.0.0.1:5174; configure the Vite dev proxy `/api` → `http://127.0.0.1:5174`):
- `GET /api/status` → `{zetaris:{ok, views:number}, meterless:{status:"online"|"unauthorized"|"offline", baseUrl}, fallback:{enabled:boolean}, lastRoute?}`
- `POST /api/ask` body `{question, site?}` → Server-Sent Events: `event: progress` with a ProgressEvent JSON, then `event: result` with the InvestigationResult JSON (or `event: error`). Parse SSE from a `fetch` ReadableStream (POST), not EventSource.
- `GET /api/answers`, `GET /api/answers/:slug` → saved results.
- `GET /api/memory?site=`, `POST /api/notes {site, text}`, `GET /api/memory/:id/audit` (memory panel; may 404 for now — handle gracefully).
If the API is unreachable, fall back to the fixtures and show a small "offline demo data" notice.

Page (one calm, professional page; light and dark via CSS variables; no UI libraries; good typography; readable by a non-technical bakery owner; responsive down to 375 px):
1. Header: wordmark "Kilowhy", tagline "Ask why your electricity bill changed. Every number is backed by a query." Status chips from /api/status: "Zetaris · local", "Meterless Nightshift · online/offline", "Nemotron via Nightshift".
2. Question box with 3 suggested questions ("Why did our electricity cost more in the last four weeks?", "Why did Brixton use more electricity?", "What should we change to save money?") and a site selector (All sites, Shoreditch S1, Brixton S2, Peckham S3 — read real names from the fixtures/sites if present). A small "meter data: SAMPLE" badge.
3. Live investigation timeline while a question runs: steps from progress events (understand question → split the bill → test hypotheses → write answer → verify every figure), evidence cards appearing as they are created (E# · title · source badges such as "REST · Octopus", "REST · NESO", "FILE · sample"), and the model route per LLM step, e.g. "Nemotron 3 Ultra via Nightshift · 9.8 s · race of 6" (and clearly labelled "NVIDIA direct (fallback)" when that route was used).
4. Answer card: headline; a hand-written SVG waterfall (window A cost → standing → weather volume → operational volume → price → timing → window B cost) using the decomposition values in the result; sentences rendered with clickable chips for [E#] (opens evidence), [F#] (tooltip with the fact label/value) and [M#] (memory); a badge "Verified: every figure matches its source" when verification.passed and mode is llm, or "Template answer" when mode is template.
5. Ruled-out causes: grey chips with one-line reason, clickable evidence.
6. Recommendation card (tariff counterfactual: Agile vs flat business tariff in both windows; load-shift £ and kgCO2e).
7. Evidence drawer (right side, slides in): title, source badges, SQL as sent to Zetaris (monospace, copy button), Zetaris run id, row count, sha256 (shortened, full on hover), sample-rows table, metrics.
8. Memory panel (collapsible): notes with date/source and an "Add a note" form posting to /api/notes; show an audit trail link.
9. Footer "How it works": a small SVG diagram — Sources (Octopus, NESO, Elexon, Open-Meteo, sample meter files) → Zetaris (one SQL endpoint) → Kilowhy agent (decompose, 11 hypotheses, verifier; Meterless engines H-MEM, World Model, Markovian) → Meterless Nightshift → Nemotron; a line "Built with Cursor — see docs/cursor-log".

Engineering: `web/package.json` with scripts dev/build/preview; dependencies only react, react-dom, vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom. Keep components small (web/src/components/*). Format money exactly as the server's fact displays (never recompute numbers in the UI except the waterfall geometry). Run `npm install` and `npm run build` in `web/` and fix until the build succeeds with no TypeScript errors. Finally write `docs/cursor-usage.md` with a short honest summary of what you (Cursor) built in this session.
