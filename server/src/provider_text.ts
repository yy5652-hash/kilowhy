// Text helpers for model output: strip leaked reasoning, pull the last JSON value out of prose.
// Nightshift routes to reasoning models whose thinking sometimes lands in message.content
// (a <think>...</think> block, or a stray closing tag with the reasoning in front of it).

export function cleanContent(text: string): string {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const stray = s.toLowerCase().lastIndexOf("</think>");
  if (stray >= 0) s = s.slice(stray + "</think>".length);
  const open = s.toLowerCase().indexOf("<think>");
  if (open >= 0) s = s.slice(0, open); // unclosed block: the reply was cut off while still thinking
  return s.trim();
}

// End index (exclusive) of the balanced {...} or [...] starting at `start`, or -1 if it never balances.
function balancedEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

// Last top-level JSON object or array in the text that parses; null if there is none.
// Code fences need no special handling: the fence characters are skipped as plain text.
// A balanced span that does not parse is skipped whole (never mined for nested pieces),
// so a half-broken answer yields null rather than a silently wrong fragment.
export function extractJson(text: string): unknown | null {
  let last: unknown | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== "{" && c !== "[") { i++; continue; }
    const end = balancedEnd(text, i);
    if (end < 0) { i++; continue; } // stray opener: keep looking after it
    try { last = JSON.parse(text.slice(i, end)); } catch { /* balanced but not JSON: skip it */ }
    i = end;
  }
  return last;
}
