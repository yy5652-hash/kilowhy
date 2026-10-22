// Test helpers for H-MEM: a deterministic fake embedder (hashed bag of words, unit length) that records its calls. NOT a test file.
import type { EmbedFn } from "./memory.ts";

const words = (t: string): string[] => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
const h = (s: string): number => { let x = 2166136261; for (const c of s) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; } return x >>> 0; };

export function fakeVector(text: string, dim = 48): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const w of words(text)) v[h(w) % dim] += 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n ? v.map((x) => x / n) : v;
}

export function fakeEmbedder(opts: { model?: string; fail?: () => boolean } = {}) {
  const calls: { texts: string[]; inputType: "passage" | "query" }[] = [];
  const fn: EmbedFn = async (texts, o) => {
    calls.push({ texts, inputType: o.inputType });
    if (opts.fail?.()) throw new Error("embedding service down");
    const model = opts.model ?? "fake/embed-48";
    return { vectors: texts.map((t) => fakeVector(t)), route: { provider: "fake", requestedModel: model, routedModel: model, latencyMs: 1 } };
  };
  return Object.assign(fn, { calls });
}
export const NOTE = "Brixton moved its oven schedule 2 hours later from 7 Oct for the new sourdough line";
