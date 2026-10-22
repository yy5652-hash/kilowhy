// Minimal Zetaris REST SQL client (local platform). Key comes from the macOS keychain or ZETARIS_API_KEY.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const URL_ = process.env.ZETARIS_URL ?? "http://localhost:8888";

function apiKey(): string {
  if (process.env.ZETARIS_API_KEY) return process.env.ZETARIS_API_KEY;
  return execFileSync("security", ["find-generic-password", "-a", "kilowhy", "-s", "ZETARIS_API_KEY", "-w"]).toString().trim();
}

export interface ZRun { ok: boolean; status: number; body: any; runId: string }

export async function zsql(sql: string, limit = 100000): Promise<ZRun> {
  const runId = randomUUID();
  const res = await fetch(`${URL_}/api/v1.0/sql-editor/sqls/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "X-Org-ID": "1",
      "X-Request-ID": runId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ queryId: runId, sql, source: "SqlEditor", limit }),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, body, runId };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
