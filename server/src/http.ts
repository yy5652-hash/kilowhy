// Kilowhy HTTP server: the JSON/SSE API the web UI calls, plus the built UI (web/dist) on the same origin.
// node server/src/http.ts  → http://127.0.0.1:5174  (KILOWHY_HOST / KILOWHY_PORT to change; binds loopback by default)
// One investigation runs at a time (Zetaris and the LLM routes are shared, rate-limited resources). Meter kWh are SAMPLE data.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { zsql } from "../../scripts/zetaris_client.ts";
import { investigate } from "./agent.ts";
import { status as providerStatus } from "./provider.ts";
import { answerFile } from "../../scripts/ask_args.ts";
import { defaultMemory, WORLD_DIR } from "./memory_default.ts";
import { KilowhyWorld } from "./worldmodel.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const DIST = join(ROOT, "web/dist");
const ANSWERS = join(ROOT, "eval/answers");
const HOST = process.env.KILOWHY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.KILOWHY_PORT ?? 5174);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const memory = defaultMemory();
const world = KilowhyWorld.create({ storage: "local", directory: WORLD_DIR });
let busy = false;
let zCache: { at: number; ok: boolean; ms: number } | null = null;

const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
async function readBody(req: IncomingMessage): Promise<any> {
  let s = ""; for await (const c of req) { s += c; if (s.length > 64_000) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}

async function zetarisStatus() {
  if (zCache && Date.now() - zCache.at < 30_000) return zCache;
  const t = Date.now();
  try { const r = await zsql("SELECT 1 AS ok", 1); zCache = { at: Date.now(), ok: r.ok, ms: Date.now() - t }; }
  catch { zCache = { at: Date.now(), ok: false, ms: Date.now() - t }; }
  return zCache;
}

function listAnswers() {
  if (!existsSync(ANSWERS)) return [];
  return readdirSync(ANSWERS).filter((f) => f.endsWith(".json")).map((f) => {
    const d = JSON.parse(readFileSync(join(ANSWERS, f), "utf8"));
    return { slug: f.replace(/\.json$/, ""), question: d.question, generatedAt: d.generatedAt, headline: d.answer?.headline ?? null, site: d.scope?.sites ?? null };
  }).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}
const readAnswer = (slug: string) => { const f = join(ANSWERS, `${slug.replace(/[^a-z0-9-]/gi, "")}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };

async function ask(req: IncomingMessage, res: ServerResponse) {
  const { question, site } = await readBody(req);
  if (typeof question !== "string" || !question.trim() || question.length > 500) return json(res, 400, { error: "question required (≤500 chars)" });
  if (busy) return json(res, 429, { error: "another investigation is running; try again in a minute" });
  busy = true;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  try {
    const outcome = await investigate(question.trim(), {
      zsql, site: site || undefined, memory, world, engine: "markovian",
      markovian: { logPath: join(ROOT, "eval/markovian_tokens.json"), historyDir: join(ROOT, "data/cache/markovian") },
      onEvent: (e) => send("progress", e),
    });
    const file = answerFile(question.trim(), site || undefined);
    mkdirSync(ANSWERS, { recursive: true });
    writeFileSync(join(ROOT, file), JSON.stringify({ generatedAt: new Date().toISOString(), ...outcome }, null, 2) + "\n");
    send("result", { slug: file.replace(/^eval\/answers\/|\.json$/g, ""), ...outcome });
  } catch (err) {
    send("error", { error: String((err as Error)?.message ?? err).slice(0, 300) });
  } finally { clearInterval(ping); busy = false; res.end(); }
}

function serveStatic(path: string, res: ServerResponse) {
  if (!existsSync(DIST)) return json(res, 404, { error: "web/dist missing: run npm run build in web/" });
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/api/status") {
      const [m, z] = await Promise.all([providerStatus(), zetarisStatus()]);
      return json(res, 200, { zetaris: { ok: z.ok, ms: z.ms, views: 10 }, meterless: m.meterless, fallback: { enabled: !!m.fallback }, lastRoute: m.lastRoute ?? null, busy });
    }
    if (req.method === "POST" && p === "/api/ask") return await ask(req, res);
    if (req.method === "GET" && p === "/api/answers") return json(res, 200, listAnswers());
    let m = p.match(/^\/api\/answers\/([a-z0-9-]+)$/i);
    if (req.method === "GET" && m) { const a = readAnswer(m[1]); return a ? json(res, 200, a) : json(res, 404, { error: "not found" }); }
    m = p.match(/^\/api\/evidence\/([a-z0-9-]+)\/(E\d+)$/i);
    if (req.method === "GET" && m) { const e = readAnswer(m[1])?.evidence?.find((x: any) => x.id === m![2]); return e ? json(res, 200, e) : json(res, 404, { error: "not found" }); }
    if (req.method === "GET" && p === "/api/memory") return json(res, 200, memory.list({ site: url.searchParams.get("site") ?? undefined }));
    m = p.match(/^\/api\/memory\/([^/]+)\/audit$/);
    if (req.method === "GET" && m) return json(res, 200, memory.audit(decodeURIComponent(m[1])));
    if (req.method === "POST" && p === "/api/notes") {
      const { site, text } = await readBody(req);
      if (typeof text !== "string" || !text.trim() || text.length > 1000) return json(res, 400, { error: "text required (≤1000 chars)" });
      const rec = await memory.remember(text.trim(), { source: "user", site: site || undefined });
      return json(res, 201, { id: rec.id });
    }
    if (req.method === "GET" && p === "/api/entities") return json(res, 200, { sites: world.sites(), counts: world.counts() });
    if (p.startsWith("/api/")) return json(res, 404, { error: "unknown endpoint" });
    if (req.method === "GET") return serveStatic(p, res);
    json(res, 405, { error: "method not allowed" });
  } catch (err) { if (!res.headersSent) json(res, 500, { error: String((err as Error)?.message ?? err).slice(0, 300) }); else res.end(); }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => console.log(`Kilowhy on http://${HOST}:${PORT}  (UI + API; meter kWh are SAMPLE data)`));
}
