// Read-only SQL guard for any SQL an LLM proposes (spec section 12):
//   one statement, SELECT / WITH only; no ';'; no DDL/DML/admin keywords outside string literals and backticked identifiers;
//   every table reference is kilowhy.<allow-listed view> (or a CTE defined in the same statement); LIMIT appended or clamped to <= 5000.
// A small lexer separates words, quoted identifiers, string literals and comments first, so literals and comments cannot fool the checks.
export const MAX_LIMIT = 5000;
export const ALLOWED_VIEWS: readonly string[] = ["agile_rates", "ci_london", "fuel_hh", "temp_hourly", "meter_hh", "sites", "ops_log", "contract", "agile_standing"];
export const SCHEMA = "kilowhy";
const FORBIDDEN_KEYWORDS = new Set(["create", "drop", "insert", "update", "delete", "alter", "cache", "uncache", "grant", "revoke", "refresh", "set", "truncate", "merge", "use", "add", "load"]);
// Extra hardening beyond the spec list: Spark functions that can run arbitrary JVM methods.
const FORBIDDEN_FUNCTIONS = new Set(["reflect", "java_method", "try_reflect"]);
// FROM inside these calls is part of their own syntax, not a table reference: extract(hour FROM ts), trim(BOTH ' ' FROM x), ...
const FROM_FUNCTIONS = new Set(["extract", "substring", "substr", "trim", "overlay", "position"]);
// A top-level keyword that ends a FROM list (a following comma is not a table separator).
const FROM_LIST_END = new Set(["select", "where", "group", "having", "order", "limit", "union", "intersect", "except", "window", "qualify", "lateral", "cluster", "distribute", "sort", "offset"]);

export type GuardResult = { ok: true; sql: string; tables: string[] } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

type Kind = "ws" | "comment" | "word" | "qident" | "string" | "number" | "punct";
interface Tok { kind: Kind; text: string }

/** Splits SQL into tokens. Returns a string reason on malformed input (unterminated literal/comment, ambiguous escapes). */
function lex(sql: string): Tok[] | string {
  const toks: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "\0") return "NUL character in SQL";
    if (/\s/.test(c)) { let j = i + 1; while (j < n && /\s/.test(sql[j])) j++; toks.push({ kind: "ws", text: sql.slice(i, j) }); i = j; continue; }
    if (c === "-" && sql[i + 1] === "-") { let j = i + 2; while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++; toks.push({ kind: "comment", text: sql.slice(i, j) }); i = j; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return "unterminated block comment";
      if (sql.slice(i + 2, end).includes("/*")) return "nested block comment (ambiguous between SQL engines)";
      toks.push({ kind: "comment", text: sql.slice(i, end + 2) }); i = end + 2; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return "unterminated string literal";
        const d = sql[j];
        if (d === "\\") {
          if (sql[j + 1] === c) return "backslash-escaped quote in a string literal (ambiguous); double the quote instead";
          j += 2; continue;
        }
        if (d === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      toks.push({ kind: "string", text: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= n) return "unterminated backtick identifier";
        if (sql[j] === "`") { if (sql[j + 1] === "`") { j += 2; continue; } break; }
        j++;
      }
      toks.push({ kind: "qident", text: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_]/.test(sql[j])) j++;
      if (sql[j] === "." && /[0-9]/.test(sql[j + 1] ?? "")) { j++; while (j < n && /[0-9A-Za-z_]/.test(sql[j])) j++; }
      toks.push({ kind: "number", text: sql.slice(i, j) }); i = j; continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$]/u.test(sql[j])) j++;
      toks.push({ kind: "word", text: sql.slice(i, j) }); i = j; continue;
    }
    toks.push({ kind: "punct", text: c }); i++;
  }
  return toks;
}

const isIdent = (t?: Tok): t is Tok => !!t && (t.kind === "word" || t.kind === "qident");
const isWord = (t: Tok | undefined, w: string): boolean => !!t && t.kind === "word" && t.text.toLowerCase() === w;
const isPunct = (t: Tok | undefined, p: string): boolean => !!t && t.kind === "punct" && t.text === p;
const identName = (t: Tok): string => (t.kind === "qident" ? t.text.slice(1, -1).replace(/``/g, "`") : t.text).toLowerCase();

/** Names introduced by `WITH a AS (...), b(c1, c2) AS (...)`. */
function cteNames(sig: Tok[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < sig.length; i++) {
    if (!isIdent(sig[i])) continue;
    const prev = sig[i - 1];
    if (!(isWord(prev, "with") || isWord(prev, "recursive") || isPunct(prev, ","))) continue;
    let j = i + 1;
    if (isPunct(sig[j], "(")) { // optional column list
      let d = 0;
      for (; j < sig.length; j++) { if (isPunct(sig[j], "(")) d++; else if (isPunct(sig[j], ")")) { d--; if (d === 0) { j++; break; } } }
    }
    if (isWord(sig[j], "as") && isPunct(sig[j + 1], "(")) names.add(identName(sig[i]));
  }
  return names;
}

export function guardSql(input: string): GuardResult {
  if (typeof input !== "string" || input.trim() === "") return fail("empty SQL");
  const all = lex(input);
  if (typeof all === "string") return fail(all);
  const sig = all.filter((t) => t.kind !== "ws" && t.kind !== "comment");
  if (sig.length === 0) return fail("empty SQL");
  if (sig.some((t) => t.kind === "punct" && t.text === ";")) return fail("';' is not allowed (one statement only)");
  const first = sig[0];
  if (!(isWord(first, "select") || isWord(first, "with"))) return fail("only SELECT or WITH statements are allowed");

  const ctes = cteNames(sig);
  const tables = new Set<string>();
  const stack: { kind: "func" | "sub" | "group"; name?: string }[] = [];
  const fromActive: boolean[] = [false];
  const depthAt: number[] = [];
  let bad: string | null = null;

  const tableRef = (j: number): void => {
    const t = sig[j];
    if (!t) { bad = "FROM / JOIN without a table"; return; }
    if (isPunct(t, "(")) return; // subquery or parenthesised join: its contents are checked as the scan continues
    if (!isIdent(t)) { bad = `table reference must be an allow-listed view, found ${t.text}`; return; }
    const parts = [identName(t)];
    let k = j;
    while (isPunct(sig[k + 1], ".") && isIdent(sig[k + 2])) { parts.push(identName(sig[k + 2])); k += 2; }
    if (isPunct(sig[k + 1], "(")) { bad = `table-valued function ${parts.join(".")}() is not allowed`; return; }
    if (parts.length === 1 && ctes.has(parts[0])) return;
    if (parts.length === 2 && parts[0] === SCHEMA && ALLOWED_VIEWS.includes(parts[1])) { tables.add(`${SCHEMA}.${parts[1]}`); return; }
    bad = `table not allowed: ${parts.join(".")} (allowed: ${SCHEMA}.{${ALLOWED_VIEWS.join(", ")}})`;
  };

  for (let i = 0; i < sig.length && !bad; i++) {
    const t = sig[i];
    depthAt[i] = stack.length;
    if (t.kind === "punct") {
      if (t.text === "(") {
        const prev = sig[i - 1], next = sig[i + 1];
        const sub = isWord(next, "select") || isWord(next, "with");
        stack.push(sub ? { kind: "sub" } : prev && prev.kind === "word" && !["in", "as", "on", "from", "join", "and", "or", "not", "where", "when", "then", "else", "using", "by", "over", "between", "exists"].includes(prev.text.toLowerCase()) ? { kind: "func", name: prev.text.toLowerCase() } : { kind: "group" });
        fromActive[stack.length] = false;
      } else if (t.text === ")") {
        if (stack.length === 0) return fail("unbalanced ')'");
        stack.pop();
      } else if (t.text === "," && fromActive[stack.length]) tableRef(i + 1);
      continue;
    }
    if (t.kind !== "word") continue;
    const w = t.text.toLowerCase();
    if (FORBIDDEN_KEYWORDS.has(w)) return fail(`forbidden keyword: ${w.toUpperCase()}`);
    if (FORBIDDEN_FUNCTIONS.has(w) && isPunct(sig[i + 1], "(")) return fail(`forbidden function: ${w}()`);
    if (w === "from") {
      const top = stack[stack.length - 1];
      if (isWord(sig[i - 1], "distinct") || (top?.kind === "func" && FROM_FUNCTIONS.has(top.name ?? ""))) continue;
      tableRef(i + 1);
      fromActive[stack.length] = true;
    } else if (w === "join") tableRef(i + 1);
    else if (FROM_LIST_END.has(w)) fromActive[stack.length] = false;
  }
  if (bad) return fail(bad);
  if (stack.length !== 0) return fail("unbalanced '('");

  // LIMIT: look at the last top-level LIMIT; it must be the final clause (optionally followed by OFFSET n).
  let limIdx = -1;
  for (let i = 0; i < sig.length; i++) if (depthAt[i] === 0 && isWord(sig[i], "limit")) limIdx = i;
  let numTok: Tok | null = null;
  if (limIdx >= 0) {
    const rest = sig.slice(limIdx + 1);
    const okShape = (rest.length === 1 && rest[0].kind === "number") || (rest.length === 3 && rest[0].kind === "number" && isWord(rest[1], "offset") && rest[2].kind === "number");
    if (!okShape || !/^\d+$/.test(rest[0].text)) return fail("LIMIT must be the last clause and take a plain integer");
    numTok = rest[0];
  } else if (sig.some((t, i) => depthAt[i] === 0 && isWord(t, "offset"))) return fail("OFFSET without LIMIT");

  let out = "";
  for (const t of all) {
    if (t === numTok) out += String(Math.min(MAX_LIMIT, Number(t.text)));
    else out += t.kind === "comment" ? " " : t.text;
  }
  out = out.trim();
  if (!numTok) out += ` LIMIT ${MAX_LIMIT}`;
  return { ok: true, sql: out, tables: [...tables].sort() };
}
