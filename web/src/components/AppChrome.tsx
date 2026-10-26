import { Building2, ChevronRight, Menu, Moon, Sun, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetDescription,
} from "@/components/ui/sheet";
import { useState } from "react";
import type { AnswerListItem } from "../types";
import { shortSiteName, sentenceCaseHeadline } from "../format";
function Github({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.73 2.65 1.23 3.29.94.1-.73.4-1.23.72-1.51-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.09-1.15 3.09-1.15.62 1.55.23 2.7.12 2.98.72.79 1.15 1.79 1.15 3.02 0 4.33-2.63 5.28-5.14 5.56.41.35.77 1.04.77 2.1v3.08c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" />
    </svg>
  );
}
export const GITHUB = "https://github.com/yy5652-hash/kilowhy";
export const VIDEO = "https://youtu.be/_sTPlIU6pKM";
export function Brand() {
  return (
    <a href="#/" className="brand" aria-label="Kilowhy home">
      <span className="brand-icon">
        <Zap size={20} fill="currentColor" />
      </span>
      Kilowhy<span className="brand-period">.</span>
    </a>
  );
}
export function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: string;
  onToggle: () => void;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={onToggle}
      aria-label={
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      }
    >
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </Button>
  );
}
export function LandingHeader({
  theme,
  onToggle,
}: {
  theme: string;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const links = (
    <>
      {[
        ["Product", "product"],
        ["How it works", "how-it-works"],
        ["Proof", "proof"],
        ["FAQ", "faq"],
      ].map(([label, id]) => (
        <a key={id} href={`#/?section=${id}`} onClick={() => setOpen(false)}>
          {label}
        </a>
      ))}
    </>
  );
  return (
    <header className="landing-header">
      <div className="container nav-row">
        <Brand />
        <nav className="desktop-nav" aria-label="Main navigation">
          {links}
        </nav>
        <div className="nav-actions">
          <ThemeToggle theme={theme} onToggle={onToggle} />
          <a href={GITHUB} aria-label="GitHub repository" className="icon-link">
            <Github size={18} />
          </a>
          <Button asChild className="desktop-cta">
            <a href="#/demo">
              Try the live demo <ChevronRight />
            </a>
          </Button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mobile-menu"
                aria-label="Open menu"
              >
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Kilowhy</SheetTitle>
                <SheetDescription>Know why. Know what next.</SheetDescription>
              </SheetHeader>
              <nav className="mobile-nav">
                {links}
                <Button asChild>
                  <a href="#/demo" onClick={() => setOpen(false)}>
                    Try the live demo
                  </a>
                </Button>
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
export function Investigations({
  answers,
  activeSlug,
  busy,
  onOpen,
  sites,
}: {
  answers: AnswerListItem[];
  activeSlug: string | null;
  busy: boolean;
  onOpen: (slug: string) => void;
  sites: { id: string; name: string }[];
}) {
  return (
    <>
      <div className="workspace-label">
        <span className="workspace-avatar">C</span>
        <div>
          <strong>Crumb & Co</strong>
          <span>Energy workspace</span>
        </div>
      </div>
      <p className="sidebar-label">INVESTIGATIONS</p>
      <nav className="investigation-list" aria-label="Saved investigations">
        {answers.map((a) => (
          <button
            key={a.slug}
            className={a.slug === activeSlug ? "active" : ""}
            disabled={busy}
            onClick={() => onOpen(a.slug)}
            aria-current={a.slug === activeSlug ? "page" : undefined}
          >
            <span className="investigation-question">{a.question}</span>
            <span>
              {sentenceCaseHeadline(a.headline ?? a.question, [
                "Brixton",
                "Shoreditch",
                "Hampstead",
              ])}
            </span>
          </button>
        ))}
      </nav>
      <p className="sidebar-label">YOUR SITES</p>
      <ul className="site-list">
        {sites.map((s) => (
          <li key={s.id}>
            <Building2 size={16} />
            <span>{shortSiteName(s.name)}</span>
            <code>{s.id}</code>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        <span className="status-dot" />
        Octopus Agile<p>Meter readings: sample data</p>
      </div>
    </>
  );
}
export function DashboardHeader({
  mode,
  theme,
  onToggle,
  sidebar,
}: {
  mode: "live" | "saved" | "replay";
  theme: string;
  onToggle: () => void;
  sidebar: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <header className="dashboard-header">
      <div className="flex items-center gap-3">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="dashboard-menu"
              aria-label="Open investigations"
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-5">
            <SheetHeader className="sr-only">
              <SheetTitle>Investigations</SheetTitle>
              <SheetDescription>Saved answers and your sites</SheetDescription>
            </SheetHeader>
            <div
              onClick={(e) => {
                if (
                  (e.target as HTMLElement).closest(
                    ".investigation-list button",
                  )
                )
                  setOpen(false);
              }}
            >
              {sidebar}
            </div>
          </SheetContent>
        </Sheet>
        <Brand />
        <span className="header-divider" />
        <span className="workspace-name">Energy intelligence</span>
      </div>
      <div className="nav-actions">
        <Badge variant="secondary" className="mode-badge">
          <span className="status-dot" />
          {mode === "live"
            ? "Live · Zetaris + Nemotron via Nightshift"
            : mode === "saved"
              ? "Saved answers · Zetaris not running"
              : "Replay of saved real runs"}
        </Badge>
        <ThemeToggle theme={theme} onToggle={onToggle} />
        <a href={GITHUB} aria-label="GitHub repository" className="icon-link">
          <Github size={18} />
        </a>
      </div>
    </header>
  );
}
