// The three vendored Meterless engines as libraries (see vendor/README.md): H-MEM (memory.ts), World Model (worldmodel.ts), Markovian (investigate_markovian.ts).
// Top-level await: the load hook must exist before the first vendored file is imported, so the imports below cannot be static.
import { registerVendorHooks } from "./engines_loader.ts";

registerVendorHooks();

export const hmemLib = await import("../../vendor/meterless/hmem/reference/src/index.ts");
export const worldLib = await import("../../vendor/meterless/world-model/reference/src/index.ts");
export const markovianLib = await import("../../vendor/meterless/markovian/reference/src/index.ts");
