# Vendored third-party components

These are pre-existing open-source components, declared in the hackathon submission (they were not written during the build window).

| Component | Path | Upstream | Licence |
|---|---|---|---|
| Meterless H-MEM engine | `vendor/meterless/hmem` | https://github.com/Meterless/Meterless/tree/main/engines/hmem | Apache-2.0 |
| Meterless World Model engine | `vendor/meterless/world-model` | https://github.com/Meterless/Meterless/tree/main/engines/world-model | Apache-2.0 |
| Meterless Markovian engine | `vendor/meterless/markovian` | https://github.com/Meterless/Meterless/tree/main/engines/markovian | Apache-2.0 |

- Upstream repository: https://github.com/Meterless/Meterless
- Commit fetched (`git ls-remote https://github.com/Meterless/Meterless HEAD`, 2026-10-22): `1742dec56a66e58eef9dda2d2b865823758ca8cd`
- Fetched with `npx degit meterless/meterless/engines/<name> vendor/meterless/<name>`.
- Each engine keeps its own `LICENSE` (Apache License 2.0), `AGENTS.md`, reference implementation (`reference/`), conformance suite and docs, unchanged.
- Only change to the copies: the `images/` folders (documentation screenshots, about 14 MB) were removed to keep the repository small. No source file was modified.
- `node_modules/` inside `vendor/` is git-ignored (`vendor/**/node_modules/`); `npm install` in an engine's `reference/` folder installs only its test tooling (vitest, tsx).

## How Kilowhy uses them

Kilowhy imports the engines' reference implementations as libraries (`vendor/meterless/<engine>/reference/src/index.ts`), it does not re-implement them. The reference sources use TypeScript parameter properties, which Node's type stripping rejects, so `server/src/engines.ts` registers a small in-process load hook (`node:module` `registerHooks` plus `stripTypeScriptTypes` in `transform` mode) for files under `vendor/meterless/` before importing them. No flag and no build step is needed.

`node scripts/engines_check.ts` runs each engine's own test suite (`npm install` and `npm test` in `reference/`) and prints the pass counts.
