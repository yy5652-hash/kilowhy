import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Brain,
  Check,
  ChevronRight,
  Code2,
  Database,
  GitBranch,
  Link2,
  LockKeyhole,
  MessageSquare,
  Play,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FIXTURES } from "../fixtures";
import { factDisplay } from "../format";
import type { Evidence } from "../types";
import { LandingHeader, Brand, GITHUB, VIDEO } from "./AppChrome";
import { Waterfall } from "./Waterfall";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { SentenceWithCites } from "./CitedText";
import { RuledOut } from "./RuledOut";
import { RecommendationCard } from "./RecommendationCard";
import { AgileChart } from "./AgileChart";
const main = FIXTURES[0].result,
  brixton = FIXTURES[1].result;
const f = (key: string) => factDisplay(main.facts, key) ?? "—";
const sources = [
  "Octopus Agile prices",
  "NESO carbon intensity",
  "Elexon generation",
  "Open-Meteo weather",
  "your half-hourly meters",
];
function Feature({
  eyebrow,
  title,
  copy,
  children,
  reverse = false,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  children: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className={`feature-row ${reverse ? "reverse" : ""}`}>
      <div className="feature-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{copy}</p>
        <a className="text-link" href="#/demo">
          Explore the answer <ArrowRight size={16} />
        </a>
      </div>
      <div className="feature-visual">{children}</div>
    </section>
  );
}
export function LandingPage({
  theme,
  onToggle,
}: {
  theme: string;
  onToggle: () => void;
}) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const show = (id: string) =>
    setEvidence(main.evidence.find((e) => e.id === id) ?? null);
  const note = brixton.memory?.recalled[0];
  const faqs = [
    [
      "Is the demo real?",
      "Yes. These are saved answers from real investigation runs, with the SQL, results and compute receipts attached. Meter readings are sample data; prices, weather, carbon intensity and generation are real public data.",
    ],
    [
      "What data does it need?",
      "Half-hourly meter readings, your tariff and standing charges, site information and weather. Owner notes add context, such as a change to opening hours. Sources are federated through Zetaris.",
    ],
    [
      "Which tariffs does it support?",
      "Octopus Agile half-hourly tariffs now, with a flat business tariff as the comparison. Recommendations are priced against the observed tariff windows.",
    ],
    [
      "How accurate is it?",
      "On 12 planted-cause scenarios: 100% precision, 93.8% recall and 12/12 exact bill splits. Each displayed figure is filled from query results and checked before the answer is shown.",
    ],
    [
      "Can I run it on my own data?",
      "Yes. Self-host Kilowhy with your own Zetaris endpoint and Meterless Nightshift. The README includes local setup instructions.",
    ],
  ];
  return (
    <div className="landing">
      <LandingHeader theme={theme} onToggle={onToggle} />
      <main id="main-content" tabIndex={-1}>
        <section className="hero container">
          <div className="hero-copy">
            <Badge variant="outline" className="hero-badge">
              <span className="status-dot" />
              ENERGY INTELLIGENCE, WITH EVIDENCE
            </Badge>
            <h1>
              Know exactly why your electricity bill <span>changed.</span>
            </h1>
            <p>
              Kilowhy splits every change in a half-hourly bill into price,
              weather, operations and timing, and shows the query behind every
              number.
            </p>
            <div className="hero-actions">
              <Button size="lg" asChild>
                <a href="#/demo">
                  Try the live demo <ArrowRight />
                </a>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <a href={VIDEO}>
                  <Play size={16} />
                  Watch the 3-min demo
                </a>
              </Button>
            </div>
            <p className="hero-footnote">
              <Check size={14} />
              Explore a saved real run. No sign-up needed.
            </p>
          </div>
          <div className="hero-product">
            <div className="product-topline">
              <span>
                <span className="status-dot" />
                CRUMB & CO
              </span>
              <span>
                Bill investigation <ArrowUpRight size={13} />
              </span>
            </div>
            <div className="preview-heading">
              <span className="muted small">
                The last four weeks, explained
              </span>
              <h2>
                +{f("delta_bill")} <span>across three sites</span>
              </h2>
              <p>
                <BadgeCheck size={15} />
                Verified: every figure matches its source
              </p>
            </div>
            <Waterfall
              decomposition={main.decomposition}
              facts={main.facts}
              preview
            />
            <div className="preview-footer">
              <ShieldCheck size={15} />
              Real queries. Traceable answers.
              <a href="#/demo">
                Open investigation <ArrowRight size={14} />
              </a>
            </div>
          </div>
        </section>
        <section className="container question-section">
          <p className="eyebrow">START WITH A QUESTION</p>
          <div className="question-chips">
            {FIXTURES.map((a) => (
              <a href={`#/demo/${a.slug}`} key={a.slug}>
                <MessageSquare size={16} />
                <span>{a.question}</span>
                <ArrowUpRight size={15} />
              </a>
            ))}
          </div>
        </section>
        <section id="proof" className="proof-section">
          <div className="container">
            <div className="proof-grid">
              <div>
                <strong>+{f("delta_bill")}</strong>
                <span>split exactly</span>
              </div>
              <div>
                <strong>{f("flat_minus_agile_B")}</strong>
                <span>saved by staying on Agile vs a flat tariff</span>
              </div>
              <div>
                <strong>
                  100% <span>/ 93.8%</span>
                </strong>
                <span>precision / recall on 12 planted-cause scenarios</span>
              </div>
              <div>
                <strong>12/12</strong>
                <span>exact splits</span>
              </div>
            </div>
            <div className="source-pills">
              <span>CONNECTED TO THE FACTS</span>
              {sources.map((s) => (
                <Badge variant="outline" key={s}>
                  {s}
                </Badge>
              ))}
            </div>
            <div className="source-pills built-on">
              <span>BUILT ON</span>
              {["Zetaris", "Meterless Nightshift", "NVIDIA Nemotron"].map(
                (s) => (
                  <Badge variant="secondary" key={s}>
                    {s}
                  </Badge>
                ),
              )}
            </div>
          </div>
        </section>
        <section id="how-it-works" className="container section-space">
          <div className="section-heading">
            <p className="eyebrow">FROM DATA TO A DECISION</p>
            <h2>One question. A complete explanation.</h2>
            <p>The hard work happens behind the answer.</p>
          </div>
          <div className="steps-grid">
            {[
              {
                icon: Link2,
                title: "Connect",
                text: "Connect your meters and tariff, read-only. Every source is federated through one Zetaris SQL endpoint. Nothing copied.",
              },
              {
                icon: MessageSquare,
                title: "Ask",
                text: "Ask in plain English. Kilowhy investigates prices, weather, operations and when you use energy.",
              },
              {
                icon: BadgeCheck,
                title: "Get a verified answer",
                text: "See the exact split, inspect the evidence, review ruled-out causes and act on a priced recommendation.",
              },
            ].map((s, i) => (
              <div className="step" key={s.title}>
                <div className="step-top">
                  <span className="step-icon">
                    <s.icon size={23} />
                  </span>
                  <span className="step-number">0{i + 1}</span>
                </div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </section>
        <div id="product" className="container features">
          <Feature
            eyebrow="01 / UNDERSTAND THE CHANGE"
            title="Every pound has a reason."
            copy="Separate the price you paid from the energy you used. Weather, operations and timing each get their share, down to the penny."
          >
            <Card>
              <CardContent className="pt-6">
                <div className="crop-title">
                  <GitBranch size={17} />
                  An exact bridge between two bills
                </div>
                <Waterfall
                  decomposition={main.decomposition}
                  facts={main.facts}
                  onEvidence={show}
                />
                <div className="four-drivers">
                  {[
                    ["L", "Price"],
                    ["v_weather", "Weather"],
                    ["v_operational", "Operations"],
                    ["T", "Timing"],
                  ].map(([k, l]) => (
                    <div key={k}>
                      <span>{l}</span>
                      <strong>{f(k)}</strong>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </Feature>
          <Feature
            reverse
            eyebrow="02 / FOLLOW THE EVIDENCE"
            title="An answer you can open up."
            copy="No black boxes. Click an evidence chip to see the exact SQL Zetaris ran, the sources it used and the returned results."
          >
            <Card className="evidence-crop">
              <CardContent className="pt-6">
                <div className="crop-title">
                  <Database size={17} />
                  The query behind the claim
                </div>
                <SentenceWithCites
                  text={main.answer.sentences[0].text}
                  evidenceIds={main.answer.sentences[0].evidence}
                  factIds={main.answer.sentences[0].facts}
                  facts={main.facts}
                  onEvidence={show}
                />
                <div className="evidence-hint">
                  <span className="cite cite-e">E#</span>
                  <span>Click a chip above to inspect the evidence</span>
                  <ChevronRight size={16} />
                </div>
                <div className="code-preview">
                  <code>
                    {main.evidence
                      .find(
                        (e) => e.id === main.answer.sentences[0].evidence[0],
                      )
                      ?.sql.slice(0, 220)}
                  </code>
                </div>
                <p className="muted small">
                  <LockKeyhole size={13} className="inline" /> Read-only SQL ·
                  run id · result hash
                </p>
              </CardContent>
            </Card>
          </Feature>
          <Feature
            eyebrow="03 / CLOSE THE LOOP"
            title="See what it ruled out, too."
            copy="A good explanation tests the alternatives. Kilowhy shows which hypotheses the evidence ruled out, so you can focus on what actually changed."
          >
            <RuledOut items={main.answer.ruledOut} onEvidence={show} />
          </Feature>
          <Feature
            reverse
            eyebrow="04 / MAKE THE NEXT MOVE"
            title="Advice with a price attached."
            copy="Compare Agile with a flat business tariff on the same usage. See whether shifting flexible load is worth it, using actual half-hourly prices."
          >
            <RecommendationCard result={main} onEvidence={show} compact />
          </Feature>
          <Feature
            eyebrow="05 / KEEP THE CONTEXT"
            title="Your business has a memory. So does Kilowhy."
            copy="Tell it what changed on site. The next investigation can recall that note, connect it to the evidence and show exactly where it came from."
          >
            <Card className="memory-crop">
              <CardContent className="pt-6">
                <div className="crop-title">
                  <Brain size={18} />
                  Remembered in the Brixton investigation
                </div>
                {note && (
                  <>
                    <div className="note-meta">
                      <Badge variant="secondary">Your note</Badge>
                      <Badge variant="outline">Brixton · {note.site}</Badge>
                      <span>
                        Learned{" "}
                        {new Date(note.learnedAt).toLocaleDateString("en-GB", {
                          timeZone: "UTC",
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </div>
                    <blockquote>“{note.text}”</blockquote>
                    <a
                      className="memory-recall-link"
                      href={`#/demo/${FIXTURES[1].slug}?tab=memory`}
                    >
                      <span className="cite cite-m">{note.factId}</span>Recalled
                      in this answer
                      <ArrowRight size={16} />
                    </a>
                  </>
                )}
              </CardContent>
            </Card>
          </Feature>
        </div>
        <section className="price-band">
          <div className="container">
            <div className="section-heading">
              <p className="eyebrow">THE COST OF TIMING</p>
              <h2>Prices change every half hour.</h2>
              <p>Your answer should account for that.</p>
            </div>
            <Card>
              <CardContent className="pt-6">
                <div className="card-heading">
                  <h3>Octopus Agile · London</h3>
                  <Badge variant="outline">17 Oct 2026</Badge>
                </div>
                <AgileChart />
              </CardContent>
            </Card>
          </div>
        </section>
        <section className="container section-space trust-section">
          <div>
            <p className="eyebrow">DESIGNED TO BE CHECKED</p>
            <h2>
              Trust the evidence.
              <br />
              Verify the answer.
            </h2>
            <p className="muted">
              Clear boundaries, from the first query to the final sentence.
            </p>
          </div>
          <div className="trust-grid">
            {[
              {
                icon: LockKeyhole,
                title: "Read-only by design",
                text: "A read-only SQL guard protects the queries sent to your data sources.",
              },
              {
                icon: ShieldCheck,
                title: "Numbers come from code",
                text: "The language model writes placeholders, never numbers. Code fills every figure from query results; a verifier checks the answer before it is shown.",
              },
              {
                icon: Sparkles,
                title: "Traceable model calls",
                text: "Models run through Meterless Nightshift. Inspect compute receipts and clearly labelled fallbacks in each saved run.",
              },
              {
                icon: Database,
                title: "Transparent demo data",
                text: "Meter readings: sample data. Prices, weather, carbon intensity and generation come from real public sources.",
              },
            ].map((s) => (
              <div key={s.title}>
                <s.icon size={21} />
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="plans-section container">
          <div className="section-heading">
            <p className="eyebrow">MAKE IT YOURS</p>
            <h2>Your data. Your next step.</h2>
          </div>
          <div className="plans-grid">
            <Card>
              <CardContent className="pt-7">
                <Code2 size={25} />
                <h3>Self-host</h3>
                <p>
                  Run Kilowhy on your own Zetaris and Nightshift. Connect your
                  data, inspect the code and own the workflow.
                </p>
                <Button variant="outline" asChild>
                  <a href={`${GITHUB}#run-it-locally-macos-apple-silicon`}>
                    Run it locally <ArrowUpRight />
                  </a>
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-7">
                <div className="flex justify-between">
                  <Database size={25} />
                  <Badge variant="secondary">Coming soon</Badge>
                </div>
                <h3>Hosted for multi-site businesses</h3>
                <p>
                  A hosted home for your energy investigations. Follow the
                  project for updates as it develops.
                </p>
                <Button variant="outline" asChild>
                  <a href={GITHUB}>
                    Follow on GitHub <ArrowUpRight />
                  </a>
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
        <section id="faq" className="container faq-section">
          <div>
            <p className="eyebrow">A FEW MORE ANSWERS</p>
            <h2>Good questions.</h2>
          </div>
          <Accordion type="single" collapsible>
            {faqs.map(([q, a], i) => (
              <AccordionItem value={String(i)} key={q}>
                <AccordionTrigger>{q}</AccordionTrigger>
                <AccordionContent>
                  {a}
                  {i === 4 && (
                    <>
                      {" "}
                      <a
                        className="text-link"
                        href={`${GITHUB}#run-it-locally-macos-apple-silicon`}
                      >
                        Read the setup guide <ArrowUpRight size={14} />
                      </a>
                    </>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
        <section className="closing-cta container">
          <div>
            <p className="eyebrow">LESS GUESSWORK. MORE CLARITY.</p>
            <h2>
              Your bill changed.
              <br />
              Find out exactly why.
            </h2>
          </div>
          <Button size="lg" asChild>
            <a href="#/demo">
              Try the live demo <ArrowRight />
            </a>
          </Button>
        </section>
      </main>
      <footer className="container landing-footer">
        <div className="footer-top">
          <Brand />
          <nav aria-label="Footer">
            {[
              ["Live demo", "#/demo"],
              ["GitHub", GITHUB],
              ["Demo video", VIDEO],
              ["Slides PDF", `${GITHUB}/blob/main/docs/Kilowhy-slides.pdf`],
            ].map(([l, u]) => (
              <a key={l} href={u}>
                {l}
              </a>
            ))}
          </nav>
        </div>
        <div className="footer-bottom">
          <span>Built for the Open Agent Hackathon 2026, Track 02</span>
          <span>Data: Octopus Energy · NESO · Elexon · Open-Meteo</span>
        </div>
        <p className="sample-note">
          Demo business: Crumb & Co. Meter readings: sample data.
        </p>
      </footer>
      <EvidenceDrawer
        evidence={evidence}
        open={!!evidence}
        onClose={() => setEvidence(null)}
      />
    </div>
  );
}
