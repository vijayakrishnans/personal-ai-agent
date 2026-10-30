import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { AgentMemory } from "@/memory";
import type { Env } from "@/env";

export const KEY = "test-access-key";
export const HF_TOKEN = "hf_test_token";
export const auth = (key = KEY) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

/**
 * A Durable Object's SQL storage over Node's SQLite: `exec` returns the
 * cursor shape the runtime's does (`one`, `toArray`, `rowsWritten`).
 */
export function sqlStorage(db = new DatabaseSync(":memory:")) {
  return {
    exec(query: string, ...bindings: (string | number | null)[]) {
      if (bindings.length === 0 && /;\s*\S/.test(query)) {
        db.exec(query);
        return { toArray: () => [], one: () => undefined, rowsWritten: 0 };
      }
      const stmt = db.prepare(query);
      const reads = /^\s*(select|pragma)\b/i.test(query);
      const returnsRows = reads || /\breturning\b/i.test(query);
      const rows = returnsRows ? (stmt.all(...bindings) as Record<string, unknown>[]) : [];
      const rowsWritten = returnsRows ? (reads ? 0 : rows.length) : Number(stmt.run(...bindings).changes);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        rowsWritten,
      };
    },
  };
}

/** One AgentMemory over an in-process SQLite database — a fresh one, or `db` as it already is. */
export function memoryObject(db?: DatabaseSync) {
  const ctx = { storage: { sql: sqlStorage(db) }, blockConcurrencyWhile: (fn: () => unknown) => fn() };
  return new AgentMemory(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
}

/** The MEMORY namespace with ONE real AgentMemory behind it, as the Worker's `owner` object. */
export function memoryNamespace(db?: DatabaseSync) {
  const object = memoryObject(db);
  const names: string[] = [];
  const ns = {
    idFromName: (name: string) => (names.push(name), { name }),
    get: () => object,
  };
  return { MEMORY: ns as unknown as Env["MEMORY"], object, names };
}

const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string })?.text ?? "").join("") : "");

export type Asked = { model: string; tools: string[]; roles: string[]; system: string };

/**
 * A model that answers in the OpenAI chat-completions shape, deterministically:
 * a tool result is quoted, `remember: <fact>` (or `remember in <Space>: <fact>`)
 * becomes a `remember` call, `call <tool> <json>` a call of any tool, and
 * anything else is echoed. Workers AI's binding and Hugging Face's router
 * both speak it; each records what it was asked.
 */
export function answer(messages: { role: string; content: unknown }[], tools: string[], model: string, asked: Asked[]) {
  asked.push({ model, tools, roles: messages.map((m) => m.role), system: text(messages.find((m) => m.role === "system")?.content) });
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (last?.role === "tool") return { message: { role: "assistant", content: `Tool said: ${text(last.content)}` }, finish_reason: "stop" };
  const call = /^call (\w+) (\{.*\})$/.exec(text(lastUser?.content));
  if (call && tools.includes(call[1] ?? "")) {
    return {
      message: { role: "assistant", content: "", tool_calls: [{ id: `call_${messages.length}`, type: "function", function: { name: call[1], arguments: call[2] } }] },
      finish_reason: "tool_calls",
    };
  }
  const fact = /^remember(?: in (\w+))?: (.+)$/.exec(text(lastUser?.content));
  if (fact && tools.includes("remember")) {
    const args = { fact: fact[2], ...(fact[1] ? { space: fact[1] } : {}) };
    return {
      message: { role: "assistant", content: "", tool_calls: [{ id: `call_${messages.length}`, type: "function", function: { name: "remember", arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls",
    };
  }
  return { message: { role: "assistant", content: `Echo: ${text(lastUser?.content)}` }, finish_reason: "stop" };
}

/** The Worker's AI binding, in process: workers-ai-provider calls `AI.run(model, inputs)`. */
export function aiStandIn() {
  const asked: Asked[] = [];
  const AI = {
    async run(model: string, inputs: { messages?: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] }) {
      const tools = (inputs.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean);
      return { choices: [answer(inputs.messages ?? [], tools, model, asked)], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } };
    },
  };
  return { AI: AI as unknown as Ai, asked };
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });

export type HfCall = { method: string; path: string; auth: string; body: unknown };

/**
 * Hugging Face, in process: the router's /v1/chat/completions (a model whose
 * id ends `:notools` refuses tools with a 400, as such providers do), and
 * Gradio Spaces under /spaces/<owner>/<name>/gradio_api/call/<endpoint>.
 */
export async function hfStandIn() {
  const calls: HfCall[] = [];
  const asked: Asked[] = [];
  const jobs = new Map<string, string>();
  const server: Server = createServer(async (req, res) => {
    const raw = await body(req);
    const path = req.url ?? "";
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* not JSON */
    }
    calls.push({ method: req.method ?? "", path, auth: String(req.headers.authorization ?? ""), body: parsed });
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (path === "/v1/chat/completions") {
      if (req.headers.authorization !== `Bearer ${HF_TOKEN}`) return json(401, { error: "Invalid credentials in Authorization header" });
      const b = parsed as { model: string; messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
      if (b.model.endsWith(":notools") && b.tools?.length) return json(400, { error: { message: "This model does not support tools" } });
      const choice = answer(b.messages, (b.tools ?? []).map((t) => t.function.name), b.model, asked);
      return json(200, { id: "chatcmpl-1", object: "chat.completion", created: 1, model: b.model, choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } });
    }
    const start = /^\/spaces\/([^/]+\/[^/]+)\/gradio_api\/call\/([\w-]+)$/.exec(path);
    if (start && req.method === "POST") {
      const [, space, endpoint] = start;
      if (endpoint !== "chat") return json(404, { detail: "Not Found" });
      const id = `ev${jobs.size + 1}`;
      jobs.set(id, `${space} says: ${(parsed as { data: string[] }).data[0]}`);
      return json(200, { event_id: id });
    }
    const result = /^\/spaces\/[^/]+\/[^/]+\/gradio_api\/call\/[\w-]+\/(\w+)$/.exec(path);
    if (result) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const answerText = jobs.get(result[1] ?? "") ?? "";
      if (answerText.includes("explode")) return res.end("event: error\ndata: null\n\n");
      return res.end(`event: generating\ndata: ["${answerText.slice(0, 3)}"]\n\nevent: complete\ndata: ${JSON.stringify([answerText])}\n\n`);
    }
    json(404, { error: "no such route" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return { router: `${url}/v1`, spaces: `${url}/spaces`, calls, asked, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const TAVILY_KEY = "tvly-test-key";

const RSS = (items: [string, string, string][]) =>
  `<?xml version="1.0"?><rss><channel><title>News</title>${items
    .map(([title, source, link]) => `<item><title>${title} - ${source}</title><link>${link}</link><pubDate>Fri, 30 Oct 2026 06:00:00 GMT</pubDate><source url="https://x">${source}</source></item>`)
    .join("")}</channel></rss>`;

/**
 * The web, in process: Google News' RSS (top stories per edition, and a
 * search), pages to read, and Tavily's search API.
 */
export async function webStandIn() {
  const calls: HfCall[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = await body(req);
    const url = new URL(req.url ?? "/", "http://x");
    calls.push({ method: req.method ?? "", path: url.pathname + url.search, auth: String(req.headers.authorization ?? ""), body: raw ? JSON.parse(raw) : undefined });
    const send = (status: number, type: string, b: string) => {
      res.writeHead(status, { "content-type": type });
      res.end(b);
    };
    if (url.pathname === "/rss") return send(200, "application/rss+xml", RSS([[`Top story for ${url.searchParams.get("gl")}`, "The Hindu", "https://news.example/1"], ["Markets &amp; more", "Mint", "https://news.example/2"]]));
    if (url.pathname === "/rss/search") return send(200, "application/rss+xml", RSS([[`News on ${url.searchParams.get("q")}`, "Reuters", "https://news.example/3"]]));
    if (url.pathname === "/article")
      return send(200, "text/html; charset=utf-8", `<!doctype html><html><head><title>Kochi &amp; rain</title><script>alert("x")</script></head><body><nav>Home | World</nav><article><h1>Rain in Kochi</h1><p>Heavy rain is expected on Friday. ${"More detail. ".repeat(20)}</p><ul><li>Schools closed</li><li>Roads flooded</li></ul></article><footer>© News</footer></body></html>`);
    if (url.pathname === "/big") return send(200, "text/plain", "x".repeat(50_000));
    if (url.pathname === "/file.pdf") return send(200, "application/pdf", "%PDF-1.4");
    if (url.pathname === "/search") {
      if (req.headers.authorization !== `Bearer ${TAVILY_KEY}`) return send(401, "application/json", JSON.stringify({ detail: "Unauthorized" }));
      const q = JSON.parse(raw) as { query: string; topic: string };
      return send(200, "application/json", JSON.stringify({ results: [{ title: `Result for ${q.query} (${q.topic})`, url: "https://result.example/1", content: "A snippet." }] }));
    }
    send(404, "text/plain", "no such page");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return { url, news: `${url}/rss`, search: `${url}/search`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An Env as a deployment has it; `over` sets what the owner stored. */
export function env(over: Partial<Env> = {}): Env & { asked: Asked[]; memory: AgentMemory } {
  const { AI, asked } = aiStandIn();
  const { MEMORY, object } = memoryNamespace();
  return { AI, MEMORY, ENVIRONMENT: "stage", asked, memory: object, ...over };
}

/** A response's JSON body, untyped, as a test reads it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (res: Response): Promise<any> => res.json();
