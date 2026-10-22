// Loads the vendored Meterless reference engines (vendor/meterless/*/reference/src) from plain `node file.ts` with no flag and no build step.
// Node's type stripping rejects TypeScript parameter properties (`constructor(private x: T)`), which the reference sources use, so for files under
// vendor/meterless/ a load hook runs `stripTypeScriptTypes` in "transform" mode. Our own files keep Node's default strip-only handling.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VENDOR = "/vendor/meterless/";
let registered = false;

/** Idempotent. Must run before the first import of a vendored file (so engines.ts calls it and then imports dynamically). */
export function registerVendorHooks(): void {
  if (registered) return;
  registered = true;
  const emit = process.emitWarning;
  registerHooks({
    load(url, context, nextLoad) {
      if (!(url.startsWith("file:") && url.endsWith(".ts") && url.includes(VENDOR))) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url), "utf8");
      // The first call prints an ExperimentalWarning for stripTypeScriptTypes; it is expected here, so it is muted for this one call.
      process.emitWarning = () => {};
      try { return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform" }), shortCircuit: true }; } finally { process.emitWarning = emit; }
    },
  });
}
