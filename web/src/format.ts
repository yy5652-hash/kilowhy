import type {
  EvidenceSource,
  Fact,
  InvestigationResult,
  Route,
  SourceKind,
} from "./types";

/** Prefer the server's pre-formatted fact display; never recompute money in the UI. */
export function factDisplay(facts: Fact[], key: string): string | undefined {
  return facts.find((f) => f.key === key)?.display;
}

export function factById(facts: Fact[], id: string): Fact | undefined {
  return facts.find((f) => f.id === id);
}

/** Resolve an M# chip (or raw mem id) to the underlying H-MEM record id. */
export function memoryIdFromChip(facts: Fact[], chip: string): string | null {
  if (chip.startsWith("mem-") || (!chip.startsWith("M") && chip.includes("-"))) return chip;
  const fact = factById(facts, chip);
  return fact?.memory?.id ?? null;
}

/** Words that keep their own capitalisation when a shouted headline is lowered. */
const KEEP_CASE: [RegExp, string | ((m: string) => string)][] = [
  [/\bkwh\b/gi, "kWh"],
  [/\bmwh\b/gi, "MWh"],
  [/\bkgco2e\b/gi, "kgCO2e"],
  [/\bco2e?\b/gi, (m) => (m.toLowerCase() === "co2e" ? "CO2e" : "CO2")],
  [/\bgbp\b/gi, "GBP"],
  [/\bagile\b/gi, "Agile"],
  [/\bcrumb & co\b/gi, "Crumb & Co"],
];

/**
 * If the headline arrives in ALL CAPS, render sentence case (first letter of each
 * sentence capitalised, site names and units restored). Mixed-case headlines are
 * returned untouched. Client-side only.
 */
export function sentenceCaseHeadline(headline: string, properNames: string[] = []): string {
  const t = headline.trim();
  if (!t) return headline;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return headline;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  if (upper / letters.length < 0.85) return headline;
  let out = t.toLowerCase().replace(/(^\s*[a-z])|([.!?]\s+[a-z])/g, (m) => m.toUpperCase());
  for (const [re, rep] of KEEP_CASE) out = out.replace(re, rep as never);
  for (const name of properNames) {
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${esc}\\b`, "gi"), name);
  }
  return out;
}

/** "Crumb & Co Brixton" -> "Brixton"; used for short site labels. */
export function shortSiteName(name: string): string {
  return name.replace(/^Crumb & Co\s+/, "");
}

/** Chunk label from the Markovian report -> short name plus the parenthetical detail. */
export function chunkName(label: string): { name: string; detail: string } {
  const m = label.match(/^([^(]+?)\s*(?:\((.*)\))?\s*$/);
  const raw = (m?.[1] ?? label).trim();
  const name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : label;
  return { name, detail: (m?.[2] ?? "").trim() };
}

/** "nvidia-direct: nvidia/nemotron-3.5-lightning-30b-a3b" -> { fallback: true, model: "nemotron-3.5-lightning-30b-a3b" } */
export function parseChunkRoute(route: string | null): { fallback: boolean; model: string } | null {
  if (!route) return null;
  const [prov, ...rest] = route.split(":");
  const model = rest.join(":").trim().replace(/^nvidia\//, "");
  return { fallback: prov.trim() === "nvidia-direct", model };
}

export function shortSha(sha: string, n = 10): string {
  if (!sha) return "—";
  return sha.length <= n + 1 ? sha : `${sha.slice(0, n)}…`;
}

export function sourceBadgeLabel(kind: SourceKind | string): string {
  return kind.replace(": ", " · ");
}

export function sourceBadges(sources: EvidenceSource[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const label = sourceBadgeLabel(s.kind);
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

export function formatRoute(route: Route): string {
  const secs = (route.latencyMs / 1000).toFixed(1);
  if (route.provider === "nvidia-direct") {
    const label = route.label ?? "NVIDIA Nemotron";
    return `NVIDIA direct (fallback) · ${label} · ${secs} s`;
  }
  const name = route.label ?? route.routedModel ?? "Nemotron";
  const race =
    route.raceWidth && route.raceWidth > 1 ? ` · race of ${route.raceWidth}` : "";
  const cache = route.fromCache ? " · cached" : "";
  return `${name} via Nightshift · ${secs} s${race}${cache}`;
}

export function stepLabel(step: string): string {
  const map: Record<string, string> = {
    sites: "Find sites",
    intent: "Understand question",
    plan: "Plan checks",
    data: "Split the bill",
    hypotheses: "Test hypotheses",
    recommend: "Compare tariffs & load shift",
    extraSql: "Extra queries",
    facts: "Collect figures",
    narrative: "Write answer",
    template: "Template answer",
    memory: "H-MEM",
  };
  if (map[step]) return map[step];
  const { name, detail } = chunkName(step);
  return detail ? `${name} (${detail})` : name;
}

const SITE_NAMES: Record<string, string> = {
  S1: "Shoreditch",
  S2: "Brixton",
  S3: "Hampstead",
};

/** Short line like "Recalled 1 note about Brixton". */
export function recallSummaryLine(result: InvestigationResult): string | null {
  const recalled = result.memory?.recalled;
  if (!recalled || recalled.length === 0) return null;

  const bySite = new Map<string, { notes: number; findings: number }>();
  for (const m of recalled) {
    const key = m.site ?? "_all";
    const cur = bySite.get(key) ?? { notes: 0, findings: 0 };
    if (m.origin === "user") cur.notes += 1;
    else cur.findings += 1;
    bySite.set(key, cur);
  }

  const parts: string[] = [];
  for (const [site, c] of bySite) {
    const where =
      site === "_all"
        ? ""
        : ` about ${SITE_NAMES[site] ?? result.scope.sites.find((s) => s.id === site)?.name.replace(/^Crumb & Co\s+/, "") ?? site}`;
    const bits: string[] = [];
    if (c.notes) bits.push(`${c.notes} note${c.notes === 1 ? "" : "s"}`);
    if (c.findings) bits.push(`${c.findings} finding${c.findings === 1 ? "" : "s"}`);
    parts.push(`${bits.join(" and ")}${where}`);
  }
  return `Recalled ${parts.join("; ")}`;
}
