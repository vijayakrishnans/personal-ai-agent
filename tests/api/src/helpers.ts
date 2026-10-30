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
function sqlStorage() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...bindings: (string | number | null)[]) {
      if (bindings.length === 0 && /;\s*\S/.test(query)) {
        db.exec(query);
        return { toArray: () => [], one: () => undefined, rowsWritten: 0 };
      }
      const stmt = db.prepare(query);
      const returnsRows = /^\s*select\b/i.test(query) || /\breturning\b/i.test(query);
      const rows = returnsRows ? (stmt.all(...bindings) as Record<string, unknown>[]) : [];
      const rowsWritten = returnsRows ? (/^\s*select\b/i.test(query) ? 0 : rows.length) : Number(stmt.run(...bindings).changes);
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

/** The MEMORY namespace with ONE real AgentMemory behind it, as the Worker's `owner` object. */
export function memoryNamespace() {
  const ctx = { storage: { sql: sqlStorage() }, blockConcurrencyWhile: (fn: () => unknown) => fn() };
  const object = new AgentMemory(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
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
 * a tool result is quoted, `remember: <fact>` becomes a `remember` call, and
 * anything else is echoed. Workers AI's binding and Hugging Face's router
 * both speak it; each records what it was asked.
 */
export function answer(messages: { role: string; content: unknown }[], tools: string[], model: string, asked: Asked[]) {
  asked.push({ model, tools, roles: messages.map((m) => m.role), system: text(messages.find((m) => m.role === "system")?.content) });
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (last?.role === "tool") return { message: { role: "assistant", content: `Tool said: ${text(last.content)}` }, finish_reason: "stop" };
  const fact = /^remember: (.+)$/.exec(text(lastUser?.content));
  if (fact && tools.includes("remember")) {
    return {
      message: { role: "assistant", content: "", tool_calls: [{ id: `call_${messages.length}`, type: "function", function: { name: "remember", arguments: JSON.stringify({ fact: fact[1] }) } }] },
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

/** An Env as a deployment has it; `over` sets what the owner stored. */
export function env(over: Partial<Env> = {}): Env & { asked: Asked[]; memory: AgentMemory } {
  const { AI, asked } = aiStandIn();
  const { MEMORY, object } = memoryNamespace();
  return { AI, MEMORY, ENVIRONMENT: "stage", asked, memory: object, ...over };
}

/** A response's JSON body, untyped, as a test reads it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (res: Response): Promise<any> => res.json();
