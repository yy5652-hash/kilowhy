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

/**
 * If the headline arrives in ALL CAPS, render sentence case.
 * Leaves mixed-case headlines untouched.
 */
export function sentenceCaseHeadline(headline: string): string {
  const t = headline.trim();
  if (!t) return headline;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return headline;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  if (upper / letters.length < 0.85) return headline;
  const lower = t.toLowerCase();
  return lower.replace(/(^\s*[a-z])|([.!?]\s+[a-z])/g, (m) => m.toUpperCase());
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
  return map[step] ?? step;
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
