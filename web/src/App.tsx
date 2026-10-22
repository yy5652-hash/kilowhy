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
import { Header } from "./components/Header";
import { HowAnswerMade } from "./components/HowAnswerMade";
import { HowItWorks } from "./components/HowItWorks";
import { MemoryPanel } from "./components/MemoryPanel";
import { OfflineNotice } from "./components/OfflineNotice";
import { QuestionBox } from "./components/QuestionBox";
import { RecentAnswers } from "./components/RecentAnswers";
import { RecommendationCard } from "./components/RecommendationCard";
import { RuledOut } from "./components/RuledOut";
import {
  emptyTimeline,
  reduceTimeline,
  Timeline,
  type TimelineState,
} from "./components/Timeline";
import { FIXTURES, matchFixture, sitesFromFixtures, SUGGESTED_QUESTIONS } from "./fixtures";
import { recallSummaryLine } from "./format";
import type {
  AnswerListItem,
  ApiStatus,
  Evidence,
  InvestigateOutcome,
  InvestigationResult,
} from "./types";
import { isClarification } from "./types";

type Theme = "light" | "dark";

function preferTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(preferTheme);
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [apiOnline, setApiOnline] = useState(false);
  const [offlineDemo, setOfflineDemo] = useState(false);

  const [question, setQuestion] = useState(SUGGESTED_QUESTIONS[0]);
  const [site, setSite] = useState("ALL");
  const sites = useMemo(() => sitesFromFixtures(), []);

  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineState>(emptyTimeline());
  const [result, setResult] = useState<InvestigationResult | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<AnswerListItem[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [memoryFocus, setMemoryFocus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const refreshRecent = useCallback(async () => {
    try {
      const list = await fetchAnswers();
      setRecent(list);
    } catch {
      setRecent(
        FIXTURES.map((f) => ({
          slug: f.slug,
          question: f.question,
          headline: f.result.answer.headline,
          generatedAt: f.result.generatedAt,
        })),
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchStatus();
        if (cancelled) return;
        setStatus(s);
        setApiOnline(true);
        setOfflineDemo(false);
        await refreshRecent();
      } catch {
        if (cancelled) return;
        setApiOnline(false);
        setOfflineDemo(true);
        setStatus({
          zetaris: { ok: false, views: 0 },
          meterless: { status: "offline", baseUrl: null },
          fallback: { enabled: true },
        });
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

  const applyOutcome = useCallback((outcome: InvestigateOutcome, slug?: string | null) => {
    if (isClarification(outcome)) {
      setClarification(outcome.clarification);
      setResult(null);
      setActiveSlug(null);
    } else {
      setClarification(null);
      setResult(outcome);
      if (slug !== undefined) setActiveSlug(slug);
    }
  }, []);

  const runOffline = useCallback(
    async (q: string, siteId: string) => {
      const fixture = matchFixture(q, siteId);
      if (!fixture) {
        setError("No offline fixture matches this question.");
        return;
      }
      setOfflineDemo(true);
      setTimeline(emptyTimeline());
      await simulateProgress(fixture, (ev) => setTimeline((t) => reduceTimeline(t, ev)));
      const entry = FIXTURES.find((f) => f.result === fixture || f.question === fixture.question);
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
  }, [apiOnline, applyOutcome, busy, question, refreshRecent, runOffline, site]);

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

  const drawerEvidence = drawerId ? evidenceMap.get(drawerId) ?? null : null;
  const recallLine = result ? recallSummaryLine(result) : null;

  return (
    <div className="app">
      <div className="top-bar">
        <Header status={status} offline={offlineDemo} />
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          aria-label="Toggle light and dark"
        >
          {theme === "light" ? "Dark" : "Light"}
        </button>
      </div>

      <main className="main">
        <OfflineNotice show={offlineDemo} />
        <QuestionBox
          question={question}
          site={site}
          sites={sites}
          busy={busy}
          onQuestion={setQuestion}
          onSite={setSite}
          onAsk={() => void onAsk()}
        />

        <RecentAnswers
          answers={recent}
          busy={busy}
          activeSlug={activeSlug}
          onOpen={(slug) => void onOpenRecent(slug)}
        />

        <Timeline
          state={timeline}
          visible={busy || timeline.evidence.length > 0 || timeline.llmCalls.length > 0}
          onOpenEvidence={openEvidence}
        />

        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}

        {clarification && (
          <section className="clarify">
            <h2>Need a bit more detail</h2>
            <p>{clarification}</p>
          </section>
        )}

        {result && (
          <>
            <AnswerCard result={result} onEvidence={openEvidence} onMemory={setMemoryFocus} />
            <RuledOut items={result.answer.ruledOut} onEvidence={openEvidence} />
            <RecommendationCard result={result} onEvidence={openEvidence} />
            <HowAnswerMade result={result} apiOnline={apiOnline} />
          </>
        )}

        <MemoryPanel
          site={site}
          sites={sites}
          apiOnline={apiOnline}
          focusId={memoryFocus}
          recallLine={recallLine}
        />
      </main>

      <HowItWorks />

      <EvidenceDrawer
        evidence={drawerEvidence}
        open={!!drawerEvidence}
        onClose={() => setDrawerId(null)}
      />
    </div>
  );
}
