import type { EvidenceSource, Fact, Route, SourceKind } from "./types";

/** Prefer the server's pre-formatted fact display; never recompute money in the UI. */
export function factDisplay(facts: Fact[], key: string): string | undefined {
  return facts.find((f) => f.key === key)?.display;
}

export function factById(facts: Fact[], id: string): Fact | undefined {
  return facts.find((f) => f.id === id);
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
  };
  return map[step] ?? step;
}
