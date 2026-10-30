import { describe, expect, it } from "vitest";
import app from "@/index";
import { API_NAME } from "@/identity";
import { page } from "@/ui";
import { auth, env, HF_TOKEN, KEY, json } from "./helpers";

describe("GET /health", () => {
  it("names the agent and its environment, and says what is configured by name only", async () => {
    const res = await app.request("/health", {}, env());
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      status: "ok",
      name: API_NAME,
      environment: "stage",
      access: "not configured",
      killSwitch: "off",
      huggingface: "not connected",
      models: { default: "workers-ai:@cf/moonshotai/kimi-k2.6", "workers-ai": 2, configured: 0 },
      webSearch: "not connected",
      tools: ["remember", "recall", "forget", "addNote", "listNotes", "updateNote", "deleteNote", "currentTime", "calculate", "exchangeRate", "weather", "news", "wikipedia", "dictionary", "hackerNews", "arxiv", "books", "readPage", "generateImage"],
      endpoints: { chat: "/api/chat", models: "/api/models", memories: "/api/memories", notes: "/api/notes", images: "/api/images/<id>", state: "/api/state", activity: "/api/activity", health: "/health" },
    });
  });

  it("reports the stored keys as configured, never their values", async () => {
    const res = await app.request("/health", {}, env({ AGENT_ACCESS_KEY: KEY, HF_TOKEN, HF_MODELS: "openai/gpt-oss-120b, space:me/my-space" }));
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(HF_TOKEN);
    const h = JSON.parse(raw);
    expect([h.access, h.huggingface, h.models.configured]).toEqual(["configured", "connected", 2]);
  });
});

describe("GET /", () => {
  it("serves the agent's page, its name escaped", async () => {
    const res = await app.request("/", {}, env());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await res.text();
    // The name is the owner's and may hold any of & < > " ' — the page escapes it.
    const escaped = API_NAME.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(html).toContain('Built with <a href="https://orunbase.com"');
    expect(page('<b>"x"</b>')).toContain("<title>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</title>");
    // Every element id is unique: the page's script finds them by id.
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("answers an unknown path with a 404", async () => {
    expect((await app.request("/no-such-route", {}, env())).status).toBe(404);
  });
});

describe("the owner's door (/api/*)", () => {
  const routes: [string, string][] = [
    ["POST", "/api/chat"],
    ["GET", "/api/models"],
    ["POST", "/api/models"],
    ["GET", "/api/memories"],
    ["DELETE", "/api/memories/1"],
    ["PATCH", "/api/memories/1"],
    ["GET", "/api/state"],
    ["PUT", "/api/state"],
    ["GET", "/api/activity"],
  ];

  it("is a 503 that says so, before an access key is stored", async () => {
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, headers: auth() }, env());
      expect(res.status, `${method} ${path}`).toBe(503);
      expect((await json(res)).error).toBe("access_not_configured");
    }
  });

  it("is a 401 for a missing, wrong or malformed key, and touches no memory", async () => {
    const e = env({ AGENT_ACCESS_KEY: KEY });
    for (const headers of [{}, auth("wrong"), auth(`${KEY}x`), { authorization: KEY }, { authorization: "Basic " + btoa(`x:${KEY}`) }] as Record<string, string>[]) {
      for (const [method, path] of routes) {
        const res = await app.request(path, { method, headers }, e);
        expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="agent"');
      }
    }
    expect(await e.memory.listMemories()).toEqual([]);
  });

  it("opens with the right key", async () => {
    const res = await app.request("/api/memories", { headers: auth() }, env({ AGENT_ACCESS_KEY: KEY }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ memories: [] });
  });
});

describe("the kill switch", () => {
  const chatBody = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });

  it("hard: AGENT_KILL_SWITCH on refuses every /api route, even to the right key, and /health says so", async () => {
    for (const value of ["on", "ON", "true", "1", "yes"]) {
      const x = env({ AGENT_ACCESS_KEY: KEY, AGENT_KILL_SWITCH: value });
      for (const [method, path] of [["POST", "/api/chat"], ["GET", "/api/memories"], ["PUT", "/api/state"]] as const) {
        const res = await app.request(path, { method, headers: auth(), body: method === "GET" ? undefined : chatBody }, x);
        expect(res.status, `${value} ${method} ${path}`).toBe(503);
        expect((await json(res)).error).toBe("agent_disabled");
      }
      expect(x.asked).toEqual([]);
      expect((await json(await app.request("/health", {}, x))).killSwitch).toBe("on");
    }
    for (const value of ["off", "", "0", "no"]) {
      const res = await app.request("/api/state", { headers: auth() }, env({ AGENT_ACCESS_KEY: KEY, AGENT_KILL_SWITCH: value }));
      expect(res.status, JSON.stringify(value)).toBe(200);
    }
  });

  it("pause: the owner pauses in the page, chat calls no model, memories stay readable, and resume undoes it", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    const state = (body?: unknown) =>
      app.request("/api/state", body === undefined ? { headers: auth() } : { method: "PUT", headers: auth(), body: JSON.stringify(body) }, x);
    const chat = () => app.request("/api/chat", { method: "POST", headers: auth(), body: chatBody }, x);

    expect(await json(await state())).toEqual({ ok: true, paused: false });
    expect(await json(await state({ paused: true }))).toEqual({ ok: true, paused: true });
    const refused = await chat();
    expect(refused.status).toBe(503);
    expect((await json(refused)).error).toBe("agent_paused");
    expect(x.asked).toEqual([]);
    expect((await app.request("/api/memories", { headers: auth() }, x)).status).toBe(200);

    for (const bad of [{}, { paused: "yes" }, { paused: 1 }]) expect((await state(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await json(await state())).toEqual({ ok: true, paused: true });

    expect(await json(await state({ paused: false }))).toEqual({ ok: true, paused: false });
    expect((await chat()).status).toBe(200);
    expect(x.asked).toHaveLength(1);
  });
});
