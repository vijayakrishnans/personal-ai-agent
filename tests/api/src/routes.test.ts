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
      huggingface: "not connected",
      models: { default: "workers-ai:@cf/moonshotai/kimi-k2.6", "workers-ai": 2, configured: 0 },
      tools: ["remember", "recall", "forget", "currentTime"],
      endpoints: { chat: "/api/chat", models: "/api/models", memories: "/api/memories", health: "/health" },
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
