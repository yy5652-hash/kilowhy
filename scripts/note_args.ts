// Argument parsing for scripts/note.ts (kept apart so it can be tested).
export type NoteCommand =
  | { kind: "remember"; text: string; site?: string; from?: string }
  | { kind: "list"; site?: string }
  | { kind: "recall"; query: string; site?: string }
  | { kind: "audit"; id: string }
  | { kind: "feedback"; id: string; verdict: "helpful" | "not_helpful" | "wrong" }
  | { kind: "usage"; error?: string };

export const USAGE = `usage:
  node scripts/note.ts [--site S2] [--from 2026-10-07] "note text"   remember a note (the site is an id or a name such as Brixton)
  node scripts/note.ts --list [--site S2]                           list what is remembered
  node scripts/note.ts --recall "question" [--site S2]              what recall returns for a question, with scores
  node scripts/note.ts --audit mem-1                                the trust-ledger history of one memory
  node scripts/note.ts --feedback mem-1:helpful|not_helpful|wrong   feedback (+0.05 / -0.03 / -0.20 on the confidence)`;

export function parseNoteArgs(argv: string[]): NoteCommand {
  let site: string | undefined, from: string | undefined, list = false, recall: string | undefined, audit: string | undefined, feedback: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], eq = a.match(/^--(site|from|recall|audit|feedback)=(.*)$/);
    const take = (): string => (eq ? eq[2] : argv[++i] ?? "");
    const name = eq ? eq[1] : a.replace(/^--/, "");
    if (!a.startsWith("--")) words.push(a);
    else if (name === "site") site = take();
    else if (name === "from") from = take();
    else if (name === "list") list = true;
    else if (name === "recall") recall = take();
    else if (name === "audit") audit = take();
    else if (name === "feedback") feedback = take();
    else return { kind: "usage", error: `unknown option ${a}` };
  }
  if (from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return { kind: "usage", error: `--from needs a date like 2026-10-07, got "${from}"` };
  if (audit) return { kind: "audit", id: audit };
  if (feedback) {
    const [id, verdict] = feedback.split(":");
    return id && (verdict === "helpful" || verdict === "not_helpful" || verdict === "wrong") ? { kind: "feedback", id, verdict } : { kind: "usage", error: "--feedback needs mem-1:helpful, mem-1:not_helpful or mem-1:wrong" };
  }
  if (recall !== undefined) return recall.trim() ? { kind: "recall", query: recall.trim(), site } : { kind: "usage", error: "--recall needs a question" };
  if (list) return { kind: "list", site };
  const text = words.join(" ").trim();
  return text ? { kind: "remember", text, site, from } : { kind: "usage" };
}
