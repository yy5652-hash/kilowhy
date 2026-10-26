import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  ChevronRight,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DashboardHeader, Investigations } from "./components/AppChrome";
import { LandingPage } from "./components/LandingPage";
import { KpiCards } from "./components/KpiCards";
import { sentenceCaseHeadline, shortSiteName } from "./format";
import type { DateWindow } from "./types";
function windowLabel(w: DateWindow) {
  const date = (v: string | number) =>
    new Date(v).toLocaleDateString("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  return `${date(w.from)} – ${date(new Date(w.toExclusive).getTime() - 86400000)} (${w.days} days)`;
}
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  askQuestion,
  fetchAnswer,
  fetchAnswers,
  fetchStatus,
  simulateProgress,
} from "./api/client";
import { AnswerCard } from "./components/AnswerCard";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import type { ViewMode } from "./components/Header";
import { HowAnswerMade } from "./components/HowAnswerMade";
import { MemoryPanel, type MemoryFocus } from "./components/MemoryPanel";
import { QuestionBox } from "./components/QuestionBox";
import { RecommendationCard } from "./components/RecommendationCard";
import { RuledOut } from "./components/RuledOut";
import {
  emptyTimeline,
  reduceTimeline,
  Timeline,
  type TimelineState,
} from "./components/Timeline";
import {
  FIXTURES,
  matchFixture,
  sitesFromFixtures,
  SUGGESTED_QUESTIONS,
} from "./fixtures";
import type {
  AnswerListItem,
  ApiStatus,
  Evidence,
  InvestigateOutcome,
  InvestigationResult,
  MemoryRecord,
} from "./types";
import { isClarification } from "./types";

const MAIN_SLUG = "why-did-our-electricity-cost-more-in-the-last-four";
/** The static replay build (GitHub Pages, scripts/build_replay.sh) has no server: it opens straight on the bundled saved answers. */
const REPLAY = import.meta.env.VITE_REPLAY === "1";
const OFFLINE_STATUS: ApiStatus = {
  zetaris: { ok: false, views: 0 },
  meterless: { status: "offline", baseUrl: null },
  fallback: { enabled: true },
};
const fixtureAnswers = (): AnswerListItem[] =>
  FIXTURES.map((f) => ({
    slug: f.slug,
    question: f.question,
    headline: f.result.answer.headline,
    generatedAt: f.result.generatedAt,
  }));

type Theme = "light" | "dark";

function preferTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const saved = localStorage.getItem("kilowhy-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* Storage may be blocked. */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export default function App() {
  const [route, setRoute] = useState(
    () => window.location.hash.slice(1) || "/",
  );
  const [tab, setTab] = useState("answer");
  const [theme, setTheme] = useState<Theme>(preferTheme);
  const [status, setStatus] = useState<ApiStatus | null>(
    REPLAY ? OFFLINE_STATUS : null,
  );
  const [apiOnline, setApiOnline] = useState(false);
  const [offlineDemo, setOfflineDemo] = useState(REPLAY);

  const [question, setQuestion] = useState(SUGGESTED_QUESTIONS[0]);
  const [site, setSite] = useState("ALL");
  const sites = useMemo(() => sitesFromFixtures(), []);

  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineState>(emptyTimeline());
  const [result, setResult] = useState<InvestigationResult | null>(
    REPLAY ? FIXTURES[0].result : null,
  );
  const [clarification, setClarification] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<AnswerListItem[]>(
    REPLAY ? fixtureAnswers() : [],
  );
  const [activeSlug, setActiveSlug] = useState<string | null>(
    REPLAY ? FIXTURES[0].slug : null,
  );

  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [memoryFocus, setMemoryFocus] = useState<MemoryFocus | null>(null);
  const focusMemory = useCallback((id: string) => {
    setTab("memory");
    setMemoryFocus({ id, n: Date.now() });
  }, []);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#101817" : "#f7f9f8");
    try {
      localStorage.setItem("kilowhy-theme", theme);
    } catch {
      /* Storage may be blocked. */
    }
  }, [theme]);

  const refreshRecent = useCallback(async () => {
    try {
      const list = await fetchAnswers();
      setRecent(list);
    } catch {
      setRecent(fixtureAnswers());
    }
  }, []);

  useEffect(() => {
    if (REPLAY) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchStatus();
        if (cancelled) return;
        setStatus(s);
        setApiOnline(true);
        setOfflineDemo(false);
        await refreshRecent();
        if (!s.zetaris.ok) {
          const a = await fetchAnswer(MAIN_SLUG).catch(() => null);
          if (a && !cancelled) {
            setResult(a);
            setActiveSlug(MAIN_SLUG);
          }
        }
      } catch {
        if (cancelled) return;
        setApiOnline(false);
        setOfflineDemo(true);
        setStatus(OFFLINE_STATUS);
        setResult(FIXTURES[0].result);
        setActiveSlug(FIXTURES[0].slug);
        await refreshRecent();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshRecent]);

  const evidenceMap = useMemo(() => {
    const m = new Map<string, Evidence>();
    if (result) for (const e of result.evidence) m.set(e.id, e);
    return m;
  }, [result]);

  const openEvidence = useCallback((id: string) => setDrawerId(id), []);

  const applyOutcome = useCallback(
    (outcome: InvestigateOutcome, slug?: string | null) => {
      if (isClarification(outcome)) {
        setClarification(outcome.clarification);
        setResult(null);
        setActiveSlug(null);
      } else {
        setClarification(null);
        setResult(outcome);
        if (slug !== undefined) setActiveSlug(slug);
      }
    },
    [],
  );

  const runOffline = useCallback(
    async (q: string, siteId: string) => {
      const fixture = matchFixture(q, siteId);
      if (!fixture) {
        setError("No offline fixture matches this question.");
        return;
      }
      setOfflineDemo(true);
      setTimeline(emptyTimeline());
      await simulateProgress(fixture, (ev) =>
        setTimeline((t) => reduceTimeline(t, ev)),
      );
      const entry = FIXTURES.find(
        (f) => f.result === fixture || f.question === fixture.question,
      );
      applyOutcome(fixture, entry?.slug ?? null);
    },
    [applyOutcome],
  );

  const onAsk = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setBusy(true);
    setError(null);
    setClarification(null);
    setTimeline(emptyTimeline());
    setDrawerId(null);
    setActiveSlug(null);

    try {
      if (!apiOnline) {
        await runOffline(q, site);
        return;
      }
      let gotResult = false;
      await askQuestion(
        { question: q, site: site === "ALL" ? undefined : site },
        {
          onProgress: (ev) => setTimeline((t) => reduceTimeline(t, ev)),
          onResult: (outcome) => {
            gotResult = true;
            applyOutcome(outcome, null);
          },
          onError: (msg) => setError(msg),
        },
        ac.signal,
      );
      if (!gotResult && !ac.signal.aborted) {
        await runOffline(q, site);
      } else {
        void refreshRecent();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setApiOnline(false);
      await runOffline(q, site);
    } finally {
      setBusy(false);
    }
  }, [
    apiOnline,
    applyOutcome,
    busy,
    question,
    refreshRecent,
    runOffline,
    site,
  ]);

  const onOpenRecent = useCallback(
    async (slug: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setClarification(null);
      setTimeline(emptyTimeline());
      setDrawerId(null);
      try {
        if (apiOnline) {
          const a = await fetchAnswer(slug);
          applyOutcome(a, slug);
          setQuestion(a.question);
        } else {
          const fixture = FIXTURES.find((f) => f.slug === slug);
          if (!fixture) throw new Error("not found");
          applyOutcome(fixture.result, slug);
          setQuestion(fixture.question);
        }
      } catch {
        setError(`Could not load answer “${slug}”.`);
      } finally {
        setBusy(false);
      }
    },
    [apiOnline, applyOutcome, busy],
  );

  const drawerEvidence = drawerId ? (evidenceMap.get(drawerId) ?? null) : null;
  const mode: ViewMode =
    offlineDemo || !apiOnline
      ? "replay"
      : status?.zetaris.ok
        ? "live"
        : "saved";
  const timelineShown =
    busy || timeline.evidence.length > 0 || timeline.llmCalls.length > 0;
  const offlineNotes = useMemo<MemoryRecord[]>(
    () =>
      (result?.memory?.recalled ?? []).map((m) => ({
        id: m.id,
        text: m.text,
        relevance: m.relevance,
        origin: m.origin,
        site: m.site,
        learnedAt: m.learnedAt,
        confidence: Number.NaN,
        layer: "recalled",
      })),
    [result],
  );

  useEffect(() => {
    const change = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const landing = REPLAY && route.split("?")[0] === "/";
  useEffect(() => {
    setDrawerId(null);
    const section = new URLSearchParams(route.split("?")[1]).get("section");
    if (landing && section)
      requestAnimationFrame(() =>
        document.getElementById(section)?.scrollIntoView(),
      );
    else window.scrollTo({ top: 0, behavior: "instant" });
    const slug = route
      .split("?")[0]
      .split("/")
      .filter(Boolean)
      .slice(1)
      .join("/");
    if (REPLAY && !landing && slug) {
      const entry = FIXTURES.find((f) => f.slug === slug);
      if (entry) {
        applyOutcome(entry.result, slug);
        setQuestion(entry.question);
        setError(null);
      } else
        setError(
          "This saved investigation could not be found. Choose one from the sidebar.",
        );
      if (new URLSearchParams(route.split("?")[1]).get("tab") === "memory") {
        setTab("memory");
        const note = entry?.result.memory?.recalled[0];
        if (note) setMemoryFocus({ id: note.id, n: Date.now() });
      } else setTab("answer");
    }
  }, [route, landing, applyOutcome]);
  useEffect(() => {
    document.title = landing
      ? "Kilowhy — Know exactly why your electricity bill changed"
      : `${result ? result.question : "Energy workspace"} · Kilowhy`;
  }, [landing, result]);
  const navigateAnswer = (slug: string) => {
    setTab("answer");
    if (REPLAY) window.location.hash = `/demo/${slug}`;
    else {
      void onOpenRecent(slug);
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  };
  const sidebar = (
    <Investigations
      answers={recent}
      activeSlug={activeSlug}
      busy={busy}
      onOpen={navigateAnswer}
      sites={sites}
    />
  );
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  if (landing) return <LandingPage theme={theme} onToggle={toggleTheme} />;
  return (
    <div className="app-shell">
      <DashboardHeader
        mode={mode}
        theme={theme}
        onToggle={toggleTheme}
        sidebar={sidebar}
      />
      <div className="dashboard-layout">
        <aside className="dashboard-sidebar">{sidebar}</aside>
        <main className="dashboard-main" id="main-content" tabIndex={-1}>
          <div className="breadcrumb">
            <span>Crumb & Co</span>
            <ChevronRight size={13} />
            <span>Investigations</span>
          </div>
          {mode === "live" && (
            <QuestionBox
              question={question}
              site={site}
              sites={sites}
              busy={busy}
              onQuestion={setQuestion}
              onSite={setSite}
              onAsk={() => void onAsk()}
            />
          )}
          {timelineShown && (
            <Timeline state={timeline} visible onOpenEvidence={openEvidence} />
          )}
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {clarification && (
            <Card>
              <CardContent className="pt-6">
                <h2>One more detail</h2>
                <p>{clarification}</p>
              </CardContent>
            </Card>
          )}
          {busy && (
            <div
              className="loading-state"
              aria-label="Loading investigation"
              aria-busy="true"
            >
              <Skeleton className="h-7 w-2/3" />
              <div className="kpi-grid">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-28" />
                ))}
              </div>
            </div>
          )}
          {result && (
            <>
              <section className="answer-header">
                <div className="eyebrow">
                  <span className="status-dot" />
                  BILL INVESTIGATION
                </div>
                <p className="answer-question">{result.question}</p>
                <h1>
                  {sentenceCaseHeadline(
                    result.answer.headline,
                    result.scope.sites.map((s) => shortSiteName(s.name)),
                  )}
                </h1>
                <div className="answer-meta">
                  <Badge
                    variant="secondary"
                    className={
                      result.verification.passed ? "verified-badge" : ""
                    }
                  >
                    <BadgeCheck size={14} />
                    {result.verification.passed
                      ? "Verified"
                      : "Verification incomplete"}
                  </Badge>
                  <span>
                    {result.generatedAt
                      ? new Date(result.generatedAt).toLocaleDateString(
                          "en-GB",
                          { day: "numeric", month: "short", year: "numeric" },
                        )
                      : "Saved investigation"}
                  </span>
                  <span>
                    {result.scope.sites
                      .map((s) => shortSiteName(s.name))
                      .join(" · ")}
                  </span>
                </div>
                <div className="scope-windows">
                  <CalendarDays size={14} />
                  <span>Window A: {windowLabel(result.scope.windowA)}</span>
                  <ArrowRight size={14} />
                  <span>Window B: {windowLabel(result.scope.windowB)}</span>
                </div>
              </section>
              <KpiCards result={result} />
              <Tabs value={tab} onValueChange={setTab} className="answer-tabs">
                <TabsList>
                  <TabsTrigger value="answer">Answer</TabsTrigger>
                  <TabsTrigger value="process">
                    How this answer was made
                  </TabsTrigger>
                  <TabsTrigger value="memory">Memory</TabsTrigger>
                </TabsList>
                <TabsContent value="answer">
                  <div className="answer-layout">
                    <AnswerCard
                      result={result}
                      onEvidence={openEvidence}
                      onMemory={focusMemory}
                    />
                    <div className="answer-aside">
                      <RecommendationCard
                        result={result}
                        onEvidence={openEvidence}
                      />
                      <RuledOut
                        items={result.answer.ruledOut}
                        onEvidence={openEvidence}
                      />
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="process">
                  <Card>
                    <CardContent className="pt-6">
                      <HowAnswerMade
                        result={result}
                        apiOnline={apiOnline}
                        onMemory={focusMemory}
                      />
                    </CardContent>
                  </Card>
                </TabsContent>
                <TabsContent value="memory">
                  <Card>
                    <CardContent className="pt-6">
                      <MemoryPanel
                        site={site}
                        sites={sites}
                        apiOnline={apiOnline}
                        focus={memoryFocus}
                        recalledIds={
                          result.memory?.recalled.map((m) => m.id) ?? []
                        }
                        refreshKey={result.generatedAt}
                        offlineNotes={offlineNotes}
                      />
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </>
          )}
          {!result && !busy && !clarification && (
            <Card>
              <CardContent className="empty-state">
                <Sparkles size={28} />
                <h1>Start with your energy question.</h1>
                <p>
                  Ask Kilowhy or open a saved investigation from the sidebar.
                </p>
                {!status && <Skeleton className="h-5 w-52" />}
              </CardContent>
            </Card>
          )}
          <footer className="dashboard-footer">
            <ShieldCheck size={14} />
            Evidence-backed energy decisions{" "}
            <span>Meter readings: sample data</span>
          </footer>
        </main>
      </div>
      <EvidenceDrawer
        evidence={drawerEvidence}
        open={!!drawerEvidence}
        onClose={() => setDrawerId(null)}
      />
    </div>
  );
}
