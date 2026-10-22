import type { InvestigationResult } from "../types";
import costMore from "./why-did-our-electricity-cost-more-in-the-last-four.json";
import brixton from "./why-did-brixton-use-more-electricity.json";
import saveMoney from "./what-should-we-change-to-save-money.json";

export interface FixtureEntry {
  slug: string;
  question: string;
  result: InvestigationResult;
}

export const FIXTURES: FixtureEntry[] = [
  {
    slug: "why-did-our-electricity-cost-more-in-the-last-four",
    question: "Why did our electricity cost more in the last four weeks?",
    result: costMore as unknown as InvestigationResult,
  },
  {
    slug: "why-did-brixton-use-more-electricity",
    question: "Why did Brixton use more electricity?",
    result: brixton as unknown as InvestigationResult,
  },
  {
    slug: "what-should-we-change-to-save-money",
    question: "What should we change to save money?",
    result: saveMoney as unknown as InvestigationResult,
  },
];

/** Site list from the first ALL-sites fixture (real names from sample data). */
export function sitesFromFixtures(): { id: string; name: string }[] {
  const all = FIXTURES.find((f) => f.result.scope.label === "ALL") ?? FIXTURES[0];
  return all.result.scope.sites;
}

export function matchFixture(question: string, site?: string): InvestigationResult | null {
  const q = question.trim().toLowerCase();
  const bySlug = FIXTURES.find(
    (f) =>
      f.question.toLowerCase() === q ||
      f.result.question.toLowerCase().startsWith(q.slice(0, 40)) ||
      q.includes(f.slug.replace(/-/g, " ").slice(0, 24)),
  );
  if (bySlug) {
    if (site && site !== "ALL" && bySlug.result.scope.label !== site) {
      const siteMatch = FIXTURES.find((f) => f.result.scope.label === site);
      if (siteMatch) return siteMatch.result;
    }
    return bySlug.result;
  }
  if (site && site !== "ALL") {
    const siteMatch = FIXTURES.find((f) => f.result.scope.label === site);
    if (siteMatch) return siteMatch.result;
  }
  return FIXTURES[0]?.result ?? null;
}

export function fixtureBySlug(slug: string): InvestigationResult | null {
  return FIXTURES.find((f) => f.slug === slug)?.result ?? null;
}

export const SUGGESTED_QUESTIONS = FIXTURES.map((f) => f.question);
