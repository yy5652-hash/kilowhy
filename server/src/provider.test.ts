// Tests for the LLM provider layer. Everything runs against local mock servers (node:http) with fake
// credentials: no test touches the real Nightshift, NVIDIA, the keychain or data/cache.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProvider, cleanContent, extractJson, normalizeBaseUrl, configFromEnv, type ProviderConfig,
} from "./provider.ts";

const TOKEN = "mock-token-7f3a9c41";
const NV_KEY = "mock-nvkey-5d2e81b7";
const PROMPT = "PROMPT-MARKER-should-never-be-logged";

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: any }
interface Mock { server: Server; port: number; url: string; seen: Seen[] }

async function startMock(handler: (req: Seen, res: ServerResponse) => void): Promise<Mock> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port, url: `http://127.0.0.1:${port}/v1`, seen };
}

const stop = (m: Mock) => new Promise<void>((r) => { m.server.closeAllConnections(); m.server.close(() => r()); });
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
async function closedPort(): Promise<number> {
  const m = await startMock(() => {});
  await stop(m);
  return m.port;
}

// A trimmed copy of the real Nightshift receipt shape.
const receipt = (over: Record<string, unknown> = {}) => ({
  schema: "meterless.compute_receipt.v1", receipt_id: "rcpt_req_test1", requested_model: "meterless/deep",
  routed_model: "nvidia/nemotron-3-ultra-550b-a55b",
  winning_route: { model: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B A55B", provider: "nvidia", kind: "cloud", tier: "C" },
  usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30, output_tps: 12.5, latency_ms: 1900 },
  receipt: { app_policy: { app: "kilowhy", race_width: 6 }, prompt_preview: PROMPT },
  ...over,
});

const NV_CHAT = (model: string) => ({
  model, choices: [{ message: { role: "assistant", content: "<think>hmm</think>nvidia says hi" } }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

type MlMode = "ok" | "500" | "400" | "slow" | "echo-token" | "tools";
const nvDead = new Set<string>();
const state = { ml: "ok" as MlMode, embed: "404" as "404" | "ok" | "garbage", models: "ok" as "ok" | "401" | "no-meterless" };

let ml: Mock;
let nv: Mock;
let dir: string;
let logN = 0;

function mlHandler(req: Seen, res: ServerResponse) {
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  if (req.method === "GET" && req.url === "/v1/models") {
    if (state.models === "401" || !authed) return json(res, 401, { error: { message: "unauthorized" } });
    const data = state.models === "no-meterless" ? [{ id: "llama3" }] : [{ id: "meterless/auto" }, { id: "meterless/deep" }, { id: "meterless/embed" }, { id: "nvidia/x" }];
    return json(res, 200, { object: "list", data });
  }
  if (req.url === "/v1/chat/completions") {
    if (!authed) return json(res, 401, { error: { message: "unauthorized" } });
    switch (state.ml) {
      case "500": return json(res, 500, { error: { message: "upstream exploded" } });
      case "echo-token": return json(res, 500, { error: { message: `bad auth ${TOKEN}` } });
      case "400": return json(res, 400, { error: { message: "bad request body" } });
      case "slow": return void setTimeout(() => { try { json(res, 200, {}); } catch { /* closed */ } }, 1500);
      case "tools": return json(res, 200, {
        model: "nvidia/nemotron-3.5-lightning-30b-a3b", usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "run_sql", arguments: "{\"sql\":\"SELECT 1\"}" } }] } }],
        meterless: receipt({ requested_model: "meterless/auto" }),
      });
      default: return json(res, 200, {
        model: "nvidia/nemotron-3-ultra-550b-a55b", usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
        choices: [{ message: { role: "assistant", content: "I should answer in JSON.</think>{\"answer\": 4}" } }],
        meterless: receipt(),
      });
    }
  }
  if (req.url === "/v1/embeddings") {
    if (state.embed === "404") return json(res, 404, { error: { message: "not_found" } });
    if (state.embed === "garbage") return json(res, 200, { object: "list", note: "no data" });
    return json(res, 200, { data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [4, 5, 6] }], meterless: receipt({ requested_model: "meterless/embed", receipt_id: "rcpt_embed1" }) });
  }
  json(res, 404, { error: { message: "not_found" } });
}

function nvHandler(req: Seen, res: ServerResponse) {
  if (req.headers.authorization !== `Bearer ${NV_KEY}`) return json(res, 401, { error: { message: "bad key" } });
  if (req.url === "/v1/chat/completions") {
    if (nvDead.has(req.body.model)) return json(res, 404, { title: "Not Found", detail: "Function not found for account" });
    return json(res, 200, NV_CHAT(req.body.model));
  }
  if (req.url === "/v1/embeddings") {
    return json(res, 200, { model: req.body.model, data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 4, total_tokens: 4 } });
  }
  json(res, 404, {});
}

function make(over: ProviderConfig = {}) {
  const logPath = join(dir, `calls-${++logN}.jsonl`);
  const provider = createProvider({
    hosts: ["127.0.0.1"], ports: [ml.port], token: TOKEN, nvidiaBaseUrl: nv.url, nvidiaKey: NV_KEY,
    logPath, timeoutMs: 3000, detectTimeoutMs: 800, ...over,
  });
  return { provider, logPath };
}
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ask = (content = PROMPT) => ({ mode: "deep" as const, messages: [{ role: "user" as const, content }] });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kilowhy-provider-"));
  ml = await startMock(mlHandler);
  nv = await startMock(nvHandler);
});
after(async () => { await stop(ml); await stop(nv); });
beforeEach(() => { nvDead.clear(); state.ml = "ok"; state.embed = "404"; state.models = "ok"; ml.seen.length = 0; nv.seen.length = 0; });

describe("detectMeterless", () => {
  it("is online with a valid token and lists the meterless modes", async () => {
    const { provider } = make();
    const d = await provider.detectMeterless();
    assert.equal(d.status, "online");
    assert.equal(d.baseUrl, `http://127.0.0.1:${ml.port}/v1`);
    assert.deepEqual(d.modes, ["meterless/auto", "meterless/deep", "meterless/embed"]);
  });

  it("reports unauthorized for a wrong token (401), not offline", async () => {
    const { provider } = make({ token: "wrong-token-000000" });
    const d = await provider.detectMeterless();
    assert.equal(d.status, "unauthorized");
    assert.equal(d.baseUrl, `http://127.0.0.1:${ml.port}/v1`);
  });

  it("reports offline when nothing listens, and when a server has no meterless ids", async () => {
    const dead = make({ ports: [await closedPort()] });
    assert.deepEqual(await dead.provider.detectMeterless(), { status: "offline", baseUrl: null, modes: [] });
    state.models = "no-meterless";
    assert.equal((await make().provider.detectMeterless()).status, "offline");
  });

  it("skips dead ports and finds the runtime on a later port", async () => {
    const { provider } = make({ ports: [await closedPort(), ml.port] });
    assert.equal((await provider.detectMeterless()).status, "online");
  });

  it("caches for the TTL and re-probes on force or after expiry", async () => {
    const { provider } = make();
    await provider.detectMeterless();
    await provider.detectMeterless();
    assert.equal(ml.seen.filter((s) => s.url === "/v1/models").length, 1);
    await provider.detectMeterless({ force: true });
    assert.equal(ml.seen.filter((s) => s.url === "/v1/models").length, 2);
    const short = make({ detectTtlMs: 0 });
    await short.provider.detectMeterless();
    await short.provider.detectMeterless();
    assert.equal(ml.seen.filter((s) => s.url === "/v1/models").length, 4);
  });

  it("reads the token from a file and treats the rt-local placeholder as no token", async () => {
    const file = join(dir, "proxy-token");
    writeFileSync(file, `${TOKEN}\n`);
    assert.equal((await make({ token: undefined, tokenPath: file }).provider.detectMeterless()).status, "online");
    writeFileSync(file, "rt-local\n");
    assert.equal((await make({ token: undefined, tokenPath: file }).provider.detectMeterless()).status, "unauthorized");
    assert.equal((await make({ token: undefined, tokenPath: join(dir, "missing") }).provider.detectMeterless()).status, "unauthorized");
  });

  it("tries an explicit pasted base URL first", async () => {
    const { provider } = make({ ports: [await closedPort()], baseUrl: `127.0.0.1:${ml.port}/v1/chat/completions` });
    assert.equal((await provider.detectMeterless()).baseUrl, `http://127.0.0.1:${ml.port}/v1`);
  });
});

describe("normalizeBaseUrl / configFromEnv", () => {
  it("normalises every accepted paste form to <host>/v1 without /v1/v1", () => {
    for (const input of ["127.0.0.1:8088", "http://127.0.0.1:8088/", "http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1/",
      "http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1/models", "127.0.0.1:8088/healthz"]) {
      assert.equal(normalizeBaseUrl(input), "http://127.0.0.1:8088/v1", input);
    }
    assert.equal(normalizeBaseUrl("https://nightshift.example/v1"), "https://nightshift.example/v1");
  });

  it("KILOWHY_FALLBACK=off disables the fallback; anything else leaves it on", () => {
    assert.equal(configFromEnv({ KILOWHY_FALLBACK: "off" }).fallback, false);
    assert.equal(configFromEnv({ KILOWHY_FALLBACK: " OFF " }).fallback, false);
    assert.equal(configFromEnv({}).fallback, true);
    assert.deepEqual(configFromEnv({ KILOWHY_METERLESS_PORTS: "9001, 9002" }).ports, [9001, 9002]);
  });
});

describe("chat through Meterless", () => {
  it("parses the compute receipt into the route and cleans leaked reasoning", async () => {
    const { provider } = make();
    const r = await provider.chat(ask());
    assert.equal(r.rawContent, "I should answer in JSON.</think>{\"answer\": 4}");
    assert.equal(r.content, "{\"answer\": 4}");
    assert.deepEqual(extractJson(r.rawContent), { answer: 4 });
    assert.deepEqual(r.toolCalls, []);
    const { latencyMs, ...route } = r.route;
    assert.ok(latencyMs >= 0);
    assert.deepEqual(route, {
      provider: "meterless", requestedModel: "meterless/deep", routedModel: "nvidia/nemotron-3-ultra-550b-a55b",
      label: "Nemotron 3 Ultra 550B A55B", kind: "cloud", tier: "C", receiptId: "rcpt_req_test1", raceWidth: 6,
      usage: { inputTokens: 21, outputTokens: 9, totalTokens: 30, outputTps: 12.5, routerLatencyMs: 1900 },
    });
    assert.equal("fallbackReason" in r.route, false);
  });

  it("sends the contract headers and the routing mode as the model", async () => {
    const { provider } = make();
    await provider.chat({ mode: "fast", messages: [{ role: "user", content: "hi" }], max_tokens: 50, temperature: 0.2 });
    const call = ml.seen.find((s) => s.url === "/v1/chat/completions")!;
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers["meterless-app"], "kilowhy");
    assert.equal(call.headers["meterless-scope"], "user");
    assert.equal(call.body.model, "meterless/fast");
    assert.equal(call.body.max_tokens, 50);
    assert.equal(call.body.temperature, 0.2);
    assert.equal("tools" in call.body, false);
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(ml.seen.filter((s) => s.url === "/v1/chat/completions").at(-1)!.body.model, "meterless/auto");
  });

  it("returns tool calls untouched and tolerates null content", async () => {
    state.ml = "tools";
    const tools = [{ type: "function", function: { name: "run_sql", parameters: { type: "object", properties: { sql: { type: "string" } } } } }];
    const r = await make().provider.chat({ mode: "auto", messages: [{ role: "user", content: "count" }], tools, tool_choice: "auto" });
    assert.equal(r.content, "");
    assert.equal(r.toolCalls[0].function.name, "run_sql");
    assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { sql: "SELECT 1" });
    const sent = ml.seen.find((s) => s.url === "/v1/chat/completions")!.body;
    assert.deepEqual(sent.tools, tools);
    assert.equal(sent.tool_choice, "auto");
  });

  it("does not fall back on a client error (4xx): it throws", async () => {
    state.ml = "400";
    await assert.rejects(make().provider.chat(ask()), /HTTP 400.*bad request body/);
    assert.equal(nv.seen.length, 0);
  });
});

describe("labelled NVIDIA fallback", () => {
  it("falls back on a Meterless 500 with a fallbackReason, and maps deep/fast/auto to Nemotron models", async () => {
    state.ml = "500";
    const { provider } = make();
    const deep = await provider.chat({ ...ask(), mode: "deep" });
    assert.equal(deep.route.provider, "nvidia-direct");
    assert.equal(deep.route.requestedModel, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(deep.route.routedModel, "nvidia/nemotron-3-super-120b-a12b");
    assert.match(deep.route.fallbackReason ?? "", /meterless HTTP 500.*upstream exploded/);
    assert.equal(deep.route.receiptId, null);
    assert.equal(deep.content, "nvidia says hi");
    assert.deepEqual(deep.route.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8, outputTps: null, routerLatencyMs: null });
    const fast = await provider.chat({ ...ask(), mode: "fast" });
    const auto = await provider.chat({ ...ask(), mode: "auto" });
    assert.equal(fast.route.routedModel, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.equal(auto.route.routedModel, "nvidia/nemotron-3.5-lightning-30b-a3b");
    assert.equal(nv.seen[0].headers.authorization, `Bearer ${NV_KEY}`);
  });

  it("skips a model this NVIDIA account cannot invoke (404), says so, and does not retry it", async () => {
    nvDead.add("nvidia/nemotron-3-super-120b-a12b");
    const { provider } = make({ ports: [await closedPort()] });
    const first = await provider.chat({ ...ask(), mode: "deep" });
    assert.equal(first.route.routedModel, "nvidia/nemotron-3-ultra-550b-a55b");
    assert.equal(first.route.requestedModel, "nvidia/nemotron-3-ultra-550b-a55b");
    assert.equal(first.route.fallbackReason, "meterless offline; nemotron-3-super-120b-a12b not available on this NVIDIA account (404)");
    const second = await provider.chat({ ...ask(), mode: "deep" });
    assert.equal(second.route.routedModel, "nvidia/nemotron-3-ultra-550b-a55b");
    assert.deepEqual(nv.seen.map((s) => s.body.model), [
      "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });

  it("does not hide a 404 on the last candidate", async () => {
    nvDead.add("nvidia/nemotron-3.5-lightning-30b-a3b");
    await assert.rejects(make({ ports: [await closedPort()] }).provider.chat({ ...ask(), mode: "fast" }), /nvidia HTTP 404/);
  });

  it("falls back when Meterless is offline and says so", async () => {
    const r = await make({ ports: [await closedPort()] }).provider.chat(ask());
    assert.equal(r.route.provider, "nvidia-direct");
    assert.equal(r.route.fallbackReason, "meterless offline");
  });

  it("falls back when Meterless is unauthorized", async () => {
    const r = await make({ token: "wrong-token-000000" }).provider.chat(ask());
    assert.equal(r.route.fallbackReason, "meterless unauthorized");
  });

  it("falls back on a timeout", async () => {
    state.ml = "slow";
    const r = await make({ timeoutMs: 250 }).provider.chat(ask());
    assert.equal(r.route.provider, "nvidia-direct");
    assert.match(r.route.fallbackReason ?? "", /timeout/);
  });

  it("re-probes Meterless after a failure so it recovers on the next call", async () => {
    const { provider } = make();
    state.ml = "500";
    assert.equal((await provider.chat(ask())).route.provider, "nvidia-direct");
    state.ml = "ok";
    assert.equal((await provider.chat(ask())).route.provider, "meterless");
  });

  it("with fallback off it throws a clear error and never calls NVIDIA", async () => {
    state.ml = "500";
    await assert.rejects(make({ fallback: false }).provider.chat(ask()), /Meterless Nightshift unavailable.*500.*KILOWHY_FALLBACK=off/);
    await assert.rejects(make({ fallback: false, ports: [await closedPort()] }).provider.chat(ask()), /meterless offline.*KILOWHY_FALLBACK=off/);
    assert.equal(nv.seen.length, 0);
  });

  it("says so when there is no NVIDIA key, and when NVIDIA fails too", async () => {
    state.ml = "500";
    await assert.rejects(make({ nvidiaKey: null }).provider.chat(ask()), /NVIDIA API key not found/);
    await assert.rejects(make({ nvidiaKey: "wrong-key-0000000" }).provider.chat(ask()), /nvidia HTTP 401.*Meterless: .*500/);
  });
});

describe("embed", () => {
  it("uses Nightshift when it returns embeddings", async () => {
    state.embed = "ok";
    const r = await make().provider.embed(["a", "b"]);
    assert.deepEqual(r.vectors, [[1, 2, 3], [4, 5, 6]]);
    assert.equal(r.route.provider, "meterless");
    assert.equal(r.route.receiptId, "rcpt_embed1");
    assert.equal(ml.seen.find((s) => s.url === "/v1/embeddings")!.body.model, "meterless/embed");
    assert.equal(nv.seen.length, 0);
  });

  it("falls back to NVIDIA nemotron-3-embed-1b, ordered by index, with input_type and a label", async () => {
    state.embed = "404";
    const r = await make().provider.embed(["a", "b"], { inputType: "query" });
    assert.deepEqual(r.vectors, [[0.1, 0.2], [0.3, 0.4]]);
    assert.equal(r.route.provider, "nvidia-direct");
    assert.equal(r.route.routedModel, "nvidia/nemotron-3-embed-1b");
    assert.match(r.route.fallbackReason ?? "", /HTTP 404/);
    assert.equal(nv.seen[0].body.input_type, "query");
    state.embed = "garbage";
    const g = await make().provider.embed(["a", "b"]);
    assert.match(g.route.fallbackReason ?? "", /did not return embeddings/);
    assert.equal(nv.seen[1].body.input_type, "passage");
  });

  it("throws with the fallback off when Nightshift cannot embed", async () => {
    await assert.rejects(make({ fallback: false }).provider.embed(["a"]), /KILOWHY_FALLBACK=off/);
    assert.equal(nv.seen.length, 0);
  });
});

describe("status and call log", () => {
  it("status() summarises Meterless, the fallback switch and the last route", async () => {
    const { provider } = make();
    const before = await provider.status();
    assert.deepEqual(before, { meterless: { status: "online", baseUrl: ml.url }, fallback: true, lastRoute: null });
    const r = await provider.chat(ask());
    assert.deepEqual((await provider.status()).lastRoute, r.route);
    assert.equal((await make({ fallback: false }).provider.status()).fallback, false);
  });

  it("appends one JSON line per call and never writes the token, the key or the prompt", async () => {
    const { provider, logPath } = make();
    await provider.chat(ask());                                  // meterless ok
    state.ml = "echo-token";
    await provider.chat(ask());                                  // error echoing the token -> fallback
    state.embed = "404";
    await provider.embed(["alpha", "beta"]);                     // embed fallback
    const bad = make({ logPath, fallback: false });
    await assert.rejects(bad.provider.chat(ask()));              // failed call is logged too
    const text = readFileSync(logPath, "utf8");
    for (const secret of [TOKEN, NV_KEY, PROMPT, "alpha", "Bearer"]) assert.equal(text.includes(secret), false, secret);
    const rows = lines(logPath);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => [r.kind, r.ok]), [["chat", true], ["chat", true], ["embed", true], ["chat", false]]);
    const expected = createHash("sha256").update(JSON.stringify(ask().messages)).digest("hex");
    assert.equal(rows[0].promptSha256, expected);
    assert.equal(rows[0].route.provider, "meterless");
    assert.equal(rows[0].route.receiptId, "rcpt_req_test1");
    assert.equal(rows[0].usage.totalTokens, 30);
    assert.equal(rows[0].mode, "deep");
    assert.match(rows[1].route.fallbackReason, /\[redacted\]/);
    assert.equal(rows[1].route.provider, "nvidia-direct");
    assert.match(rows[3].error, /unavailable/);
    assert.equal(typeof rows[0].ts, "string");
    assert.ok(rows[0].latencyMs >= 0);
  });

  it("a null logPath disables logging and an unwritable path never breaks a call", async () => {
    await make({ logPath: null }).provider.chat(ask());
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const blocked = join(file, "nested", "x.jsonl"); // a path whose parent is a regular file cannot be created
    const r = await make({ logPath: blocked }).provider.chat(ask());
    assert.equal(r.route.provider, "meterless");
  });
});

describe("cleanContent", () => {
  it("strips think blocks, stray closing tags and unclosed blocks", () => {
    assert.equal(cleanContent("<think>plan it</think>\n\nHello"), "Hello");
    assert.equal(cleanContent("a<think>x</think>b<think>y\nz</think>c"), "abc");
    assert.equal(cleanContent("The user wants me to say ok.</think>ok"), "ok");
    assert.equal(cleanContent("r1</think>mid<think>r2</think>end"), "midend");
    assert.equal(cleanContent("answer <think>cut off while thinking"), "answer");
    assert.equal(cleanContent("<THINK>x</THINK> Done "), "Done");
    assert.equal(cleanContent("  plain text  "), "plain text");
    assert.equal(cleanContent(""), "");
    assert.equal(cleanContent("<think>only thinking</think>"), "");
  });
});

describe("extractJson", () => {
  it("returns the last balanced object or array that parses", () => {
    assert.deepEqual(extractJson('{"a":1} then {"b":2}'), { b: 2 });
    assert.deepEqual(extractJson('first [1,2] last {"k":[3]}'), { k: [3] });
    assert.deepEqual(extractJson("scores: [1, 2, 3]"), [1, 2, 3]);
    assert.deepEqual(extractJson('{"outer":{"inner":[1,{"x":2}]}}'), { outer: { inner: [1, { x: 2 }] } });
  });

  it("handles code fences, preambles and reasoning that leaked into the text", () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"answer": 4}\n```\nDone.'), { answer: 4 });
    assert.deepEqual(extractJson('The user wants {"answer": 5} maybe.</think>{"answer": 4}'), { answer: 4 });
    assert.deepEqual(extractJson('```json\n[{"a":1},{"a":2}]\n```'), [{ a: 1 }, { a: 2 }]);
  });

  it("is string-aware: braces and quotes inside strings do not break balancing", () => {
    assert.deepEqual(extractJson('{"t":"a } b { c \\" ]","n":1}'), { t: 'a } b { c " ]', n: 1 });
  });

  it("skips stray openers, and does not mine pieces out of a broken span", () => {
    assert.deepEqual(extractJson('Use { to open, then {"answer": 4}'), { answer: 4 });
    assert.deepEqual(extractJson('{oops} {"answer": 4} {also bad}'), { answer: 4 });
    assert.equal(extractJson('{"a": [1,2], bad}'), null);
    assert.equal(extractJson('{"a": 1,}'), null);
    assert.equal(extractJson('{"unterminated": 1'), null);
  });

  it("returns null when there is no object or array", () => {
    assert.equal(extractJson(""), null);
    assert.equal(extractJson("just words"), null);
    assert.equal(extractJson("42"), null);
    assert.equal(extractJson('"a string"'), null);
  });
});
