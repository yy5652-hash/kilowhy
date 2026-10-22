// The memory the CLIs and the app use: data/cache/hmem/ (git-ignored), embeddings from provider.embed (Nemotron embed 1B via the labelled NVIDIA route while Nightshift has no /v1/embeddings).
import { KilowhyMemory, type EmbedFn } from "./memory.ts";
import { embed } from "./provider.ts";

export const MEMORY_DIR = new URL("../../data/cache/hmem", import.meta.url).pathname;
export const WORLD_DIR = new URL("../../data/cache/worldmodel", import.meta.url).pathname;
const providerEmbed: EmbedFn = (texts, o) => embed(texts, o);

export const defaultMemory = (dir: string = MEMORY_DIR): KilowhyMemory => KilowhyMemory.create({ dir, embed: providerEmbed });
