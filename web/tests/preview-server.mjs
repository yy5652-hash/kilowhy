/** UI acceptance fixture only; never imported into the production app.
 * Usage: node tests/preview-server.mjs live|saved|replay [port]
 * API responses use bundled answers. Notes are held in memory only.
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "replay",
  port = Number(process.argv[3] ?? 5180);
if (!["live", "saved", "replay"].includes(mode))
  throw Error("Invalid fixture mode");
const slugs = [
  "why-did-our-electricity-cost-more-in-the-last-four",
  "why-did-brixton-use-more-electricity-s2",
  "what-should-we-change-to-save-money",
];
const answers = slugs.map((slug) => ({
  slug,
  result: JSON.parse(
    readFileSync(resolve(root, "src/fixtures", `${slug}.json`)),
  ),
}));
const notes = answers[1].result.memory.recalled.map((m) => ({
  ...m,
  confidence: null,
  layer: "recalled",
}));
const dist = resolve(root, mode === "replay" ? "dist-replay" : "dist");
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith("/api")) {
      console.log(`${mode} ${req.method} ${url.pathname}`);
      if (mode === "replay")
        return send({ error: "Replay must not request API" }, 500);
      if (url.pathname === "/api/status")
        return send({
          zetaris: { ok: mode === "live", views: 0 },
          meterless: { status: "online", baseUrl: null },
          fallback: { enabled: true },
        });
      if (url.pathname === "/api/answers")
        return send(
          answers.map((a) => ({
            slug: a.slug,
            question: a.result.question,
            headline: a.result.answer.headline,
            generatedAt: a.result.generatedAt,
          })),
        );
      if (url.pathname.startsWith("/api/answers/")) {
        const a = answers.find(
          (a) => a.slug === url.pathname.split("/").at(-1),
        );
        return send(a?.result ?? {}, a ? 200 : 404);
      }
      if (url.pathname === "/api/memory") return send(notes);
      if (url.pathname.endsWith("/audit")) return send([]);
      if (url.pathname === "/api/notes" && req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        const n = JSON.parse(body),
          id = `qa-note-${notes.length}`;
        notes.push({
          id,
          text: n.text,
          site: n.site,
          origin: "user",
          learnedAt: new Date().toISOString(),
          confidence: null,
          layer: "recalled",
        });
        return send({ id });
      }
      if (url.pathname === "/api/entities")
        return send({
          counts: {
            entities: { site: answers[0].result.scope.sites.length },
            relationships: 0,
            facts: answers[0].result.facts.length,
          },
        });
      if (url.pathname === "/api/ask" && req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        const q = JSON.parse(body);
        const a =
          q.site === "S2" || q.question.toLowerCase().includes("brixton")
            ? answers[1].result
            : answers[0].result;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        const event = (t, d) =>
          res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
        const events = [
          { type: "step", step: "intent", status: "started" },
          { type: "llm", call: a.llmCalls[0] },
          {
            type: "step",
            step: "intent",
            status: "finished",
            ms: a.timings.intent,
          },
          { type: "step", step: "data", status: "started" },
          { type: "evidence", evidence: a.evidence[0] },
          {
            type: "step",
            step: "data",
            status: "finished",
            ms: a.timings.data,
          },
        ];
        for (const e of events) {
          event("progress", e);
          await new Promise((r) => setTimeout(r, 600));
        }
        event("result", a);
        event("progress", { type: "done", totalMs: a.timings.total });
        return res.end();
      }
      return send({}, 404);
    }
    const path = resolve(
      dist,
      `.${decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`,
    );
    if (!path.startsWith(`${dist}/`) || !existsSync(path)) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
    });
    res.end(readFileSync(path));
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`UI fixture ${mode}: http://127.0.0.1:${port}`),
  );
