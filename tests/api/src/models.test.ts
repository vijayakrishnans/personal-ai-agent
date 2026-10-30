import { describe, expect, it } from "vitest";
import app from "@/index";
import { catalog, parseHfModels, WORKERS_AI_MODELS } from "@/models";
import { answerFrom, spaceBaseUrl } from "@/spaces";
import { DatabaseSync } from "node:sqlite";
import { auth, env, KEY, json, memoryObject } from "./helpers";

describe("HF_MODELS", () => {
  it("reads models and Spaces, comma- or newline-separated, and drops what does not parse", () => {
    const got = parseHfModels(" openai/gpt-oss-120b ,Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest\nspace:me/my-chat\nspace:me/other#respond, not-a-model, space:bad, https://evil.example/x/y, a/b:Bad Suffix");
    expect(got.map((m) => [m.key, m.tools, m.apiName])).toEqual([
      ["huggingface:openai/gpt-oss-120b", true, undefined],
      ["huggingface:Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest", true, undefined],
      ["space:me/my-chat", false, "chat"],
      ["space:me/other", false, "respond"],
    ]);
    expect(parseHfModels(undefined)).toEqual([]);
  });

  it("is listed after the built-in models and before the page's, each key once", () => {
    const list = catalog({ HF_MODELS: "openai/gpt-oss-120b" } as never, [
      { provider: "huggingface", id: "openai/gpt-oss-120b", label: "dup", tools: false },
      { provider: "space", id: "me/s", label: "S", tools: true },
    ]);
    expect(list.map((m) => `${m.source}:${m.key}`)).toEqual([
      ...WORKERS_AI_MODELS.map((m) => `built-in:${m.key}`),
      "secret:huggingface:openai/gpt-oss-120b",
      "added:space:me/s",
    ]);
    expect(list.at(-1)).toMatchObject({ tools: false, apiName: "chat" });
  });
});

describe("a Space's address and answer", () => {
  it("is derived from its id, so the token only goes to hf.space", () => {
    expect(spaceBaseUrl({} as never, "My.Name/cool_space")).toBe("https://my-name-cool-space.hf.space");
    expect(spaceBaseUrl({ HF_SPACES_URL: "http://127.0.0.1:9/spaces/" } as never, "a/b")).toBe("http://127.0.0.1:9/spaces/a/b");
  });

  it("is the complete event's first output, whatever shape a Space gives it", () => {
    expect(answerFrom("a/b", 'event: generating\ndata: ["Hel"]\n\nevent: complete\ndata: ["Hello"]\n')).toBe("Hello");
    expect(answerFrom("a/b", 'event: complete\ndata: [{"role":"assistant","content":"Hi"}]\n')).toBe("Hi");
    expect(answerFrom("a/b", 'event: complete\ndata: [[{"role":"user","content":"q"},{"role":"assistant","content":"a"}]]\n')).toBe("a");
    expect(() => answerFrom("a/b", "event: error\ndata: null\n")).toThrow("Space a/b failed: no reason given");
    expect(() => answerFrom("a/b", "event: heartbeat\ndata: null\n")).toThrow("ended without an answer");
  });
});

describe("/api/models", () => {
  const e = () => env({ AGENT_ACCESS_KEY: KEY });
  const post = (b: unknown) => ({ method: "POST", headers: auth(), body: JSON.stringify(b) });

  it("lists the built-in models, the default first, and whether Hugging Face is connected", async () => {
    const body = await json(await app.request("/api/models", { headers: auth() }, e()));
    expect(body.default).toBe("workers-ai:@cf/moonshotai/kimi-k2.6");
    expect(body.huggingface).toBe(false);
    const keys = body.models.map((m: { key: string }) => m.key);
    expect(keys[0]).toBe("workers-ai:@cf/moonshotai/kimi-k2.6");
    expect(keys).toEqual(WORKERS_AI_MODELS.map((m) => m.key));
    // Newer Workers AI families, every one offered with the agent's tools.
    for (const id of ["@cf/deepseek-ai/deepseek-v4-pro-0813", "@cf/zai-org/glm-5.3", "@cf/qwen/qwen3.8-27b", "@cf/google/gemma-4-26b-a4b-it"]) expect(keys).toContain(`workers-ai:${id}`);
    expect(WORKERS_AI_MODELS.every((m) => m.tools)).toBe(true);
    expect(body.images.default).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(body.images.models.map((m: { id: string }) => m.id)).toContain("@cf/black-forest-labs/flux-2-dev");
  });

  it("adds any other Workers AI model by its @cf id, and removes it again", async () => {
    const x = e();
    const a = await app.request("/api/models", post({ provider: "workers-ai", id: "@cf/qwen/qwen3-30b-a3b-fp8" }), x);
    expect(a.status).toBe(201);
    expect((await json(a)).model).toEqual({
      key: "workers-ai:@cf/qwen/qwen3-30b-a3b-fp8",
      provider: "workers-ai",
      id: "@cf/qwen/qwen3-30b-a3b-fp8",
      label: "qwen/qwen3-30b-a3b-fp8 · Workers AI",
      tools: true,
      source: "added",
    });
    expect((await app.request(`/api/models/workers-ai/${encodeURIComponent("@cf")}/qwen/qwen3-30b-a3b-fp8`, { method: "DELETE", headers: auth() }, x)).status).toBe(200);
    expect(await x.memory.listModels()).toEqual([]);
  });

  it("adds a Hugging Face model and a Space, keeps them, and removes them again", async () => {
    const x = e();
    const a = await app.request("/api/models", post({ provider: "huggingface", id: "meta-llama/Llama-3.3-70B-Instruct:groq", tools: false }), x);
    expect(a.status).toBe(201);
    expect((await json(a)).model).toEqual({
      key: "huggingface:meta-llama/Llama-3.3-70B-Instruct:groq",
      provider: "huggingface",
      id: "meta-llama/Llama-3.3-70B-Instruct:groq",
      label: "meta-llama/Llama-3.3-70B-Instruct:groq · Hugging Face",
      tools: false,
      source: "added",
    });
    const s = await app.request("/api/models", post({ provider: "space", id: "me/my-chat", label: "My Space", apiName: "respond" }), x);
    expect((await json(s)).model).toMatchObject({ key: "space:me/my-chat", label: "My Space", tools: false, apiName: "respond" });
    expect(await x.memory.listModels()).toHaveLength(2);

    expect((await app.request("/api/models/space/me/my-chat", { method: "DELETE", headers: auth() }, x)).status).toBe(200);
    expect((await app.request("/api/models/space/me/my-chat", { method: "DELETE", headers: auth() }, x)).status).toBe(404);
    expect((await x.memory.listModels()).map((m) => m.id)).toEqual(["meta-llama/Llama-3.3-70B-Instruct:groq"]);
  });

  it("refuses what is not a model id, a Space id or an endpoint name", async () => {
    for (const b of [
      { provider: "huggingface", id: "https://evil.example/v1" },
      { provider: "huggingface", id: "no-slash" },
      { provider: "space", id: "a/b/c" },
      { provider: "space", id: "a/b", apiName: "../../x" },
      { provider: "workers-ai", id: "@hf/x/y" },
      { provider: "workers-ai", id: "@cf/../x" },
      { provider: "workers-ai", id: "https://evil.example/@cf/x/y" },
      { provider: "openai", id: "gpt-5" },
      "not json",
    ]) {
      const res = await app.request("/api/models", post(b), e());
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((await json(res)).error).toBe("invalid_model");
    }
  });

  it("cannot remove a built-in model or one from HF_MODELS", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY, HF_MODELS: "openai/gpt-oss-120b" });
    expect((await app.request("/api/models/huggingface/openai/gpt-oss-120b", { method: "DELETE", headers: auth() }, x)).status).toBe(404);
  });
});

describe("/api/memories", () => {
  it("keeps what the owner adds, lists the newest first, and forgets by number", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    for (const text of ["Lives in Kochi.", "Prefers tea to coffee."]) {
      expect((await app.request("/api/memories", { method: "POST", headers: auth(), body: JSON.stringify({ text }) }, x)).status).toBe(201);
    }
    const { memories } = await json(await app.request("/api/memories", { headers: auth() }, x));
    expect(memories.map((m: { id: number; text: string }) => [m.id, m.text])).toEqual([[2, "Prefers tea to coffee."], [1, "Lives in Kochi."]]);
    expect((await app.request("/api/memories/1", { method: "DELETE", headers: auth() }, x)).status).toBe(200);
    expect((await app.request("/api/memories/1", { method: "DELETE", headers: auth() }, x)).status).toBe(404);
    expect((await app.request("/api/memories/abc", { method: "DELETE", headers: auth() }, x)).status).toBe(404);
    expect((await app.request("/api/memories", { method: "POST", headers: auth(), body: JSON.stringify({ text: "x".repeat(501) }) }, x)).status).toBe(400);
    expect((await x.memory.recall("tea")).map((m) => m.text)).toEqual(["Prefers tea to coffee."]);
    expect(await x.memory.recall("100%_")).toEqual([]);
  });

  it("files a memory under a space, General by default, and moves it to another", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    const post = (body: unknown) => app.request("/api/memories", { method: "POST", headers: auth(), body: JSON.stringify(body) }, x);
    const patch = (id: number | string, body: unknown) => app.request(`/api/memories/${id}`, { method: "PATCH", headers: auth(), body: JSON.stringify(body) }, x);
    expect((await json(await post({ text: "Lives in Kochi." }))).memory.space).toBe("General");
    expect((await json(await post({ text: "Runs on Sundays.", space: "  Health " }))).memory.space).toBe("Health");
    for (const space of ["", "   ", "x".repeat(41), 7]) expect((await post({ text: "Bad space.", space })).status, JSON.stringify(space)).toBe(400);

    const moved = await patch(1, { space: "Home" });
    expect(moved.status).toBe(200);
    expect((await json(moved)).memory).toMatchObject({ id: 1, text: "Lives in Kochi.", space: "Home" });
    expect((await patch(99, { space: "Home" })).status).toBe(404);
    expect((await patch("abc", { space: "Home" })).status).toBe(404);
    expect((await patch(1, {})).status).toBe(400);
    expect((await x.memory.listMemories()).map((m) => [m.text, m.space])).toEqual([["Runs on Sundays.", "Health"], ["Lives in Kochi.", "Home"]]);
    // recall finds a memory by the name of its space, too
    expect((await x.memory.recall("health")).map((m) => m.text)).toEqual(["Runs on Sundays."]);
  });

  it("gives memories kept before spaces existed the default space", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO memories (text, created_at) VALUES (?, ?)").run("Lives in Kochi.", "2026-10-01T00:00:00.000Z");
    const upgraded = memoryObject(db);
    expect((await upgraded.listMemories()).map((m) => [m.text, m.space])).toEqual([["Lives in Kochi.", "General"]]);
    expect((await upgraded.remember("Runs on Sundays.", "Health")).space).toBe("Health");
  });
});
