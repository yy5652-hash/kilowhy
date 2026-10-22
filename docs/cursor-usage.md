# Cursor usage — Kilowhy web UI

**Session:** 2026-10-22 · agent built the React UI under `web/` only (server left untouched).

## What Cursor built

A single-page Kilowhy client: React 18 + Vite + TypeScript, no UI libraries.

- Scaffold: `web/package.json`, Vite proxy `/api` → `127.0.0.1:5174`, TypeScript strict build.
- Types mirrored from `server/src/agent_types.ts` / `agent_events.ts` (client-side copies only).
- Offline fixtures: three eval answers copied to `web/src/fixtures/` with a small matcher for suggested questions.
- API client: `GET /api/status`, SSE `POST /api/ask` via `fetch` ReadableStream, answers/memory/notes with graceful 404/offline fallback and a progress simulation for demos.
- UI: header + status chips, question box (sites from fixtures — Shoreditch / Brixton / Hampstead), live timeline (steps, evidence pills, Nightshift vs NVIDIA-direct routes), answer + SVG waterfall, ruled-out chips, tariff/load-shift recommendation, sliding evidence drawer, collapsible memory panel, “How it works” SVG footer.
- Light/dark via CSS variables; SAMPLE meter-data badge; displays use server fact strings (waterfall geometry only recomputes layout).

## Checks

```bash
cd web && npm install && npm run build
```

`tsc --noEmit` + `vite build` succeeded with no TypeScript errors.

## Honest limits

- Did not implement or modify the Node API on `:5174` (another agent owns `server/`).
- Memory panel expects endpoints that may still 404; UI degrades with a short message.
- Offline mode replays fixtures with simulated progress, not a live Zetaris/Nightshift run.
- Site names come from fixtures (`Crumb & Co Hampstead` for S3), not a separate sites API.

## D5c note (2026-10-22): the rest of the polish list was finished by Claude

The D5 Cursor session (`docs/cursor-prompts/d5-ui-polish.md`) stopped when the Cursor free plan's usage limit was reached. Cursor had built the recent-answers list, the LLM receipt component, the "How this answer was made" section, the zoomed waterfall and the first memory-panel work; the build passed. The remaining items (Markovian chart, memory-panel completion, receipt and fallback labelling, sentence-case headlines, responsive layout, focus states and contrast, offline status hint) were completed by Claude in commits prefixed `D5c:`. The list of changes is in `docs/how-it-was-built.md`.
