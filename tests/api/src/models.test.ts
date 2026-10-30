import { describe, expect, it } from "vitest";
import app from "@/index";
import { catalog, parseHfModels } from "@/models";
import { answerFrom, spaceBaseUrl } from "@/spaces";
import { auth, env, KEY, json } from "./helpers";

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
      "built-in:workers-ai:@cf/moonshotai/kimi-k2.6",
      "built-in:workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast",
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
    expect(body.models.map((m: { key: string }) => m.key)).toEqual(["workers-ai:@cf/moonshotai/kimi-k2.6", "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
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
      { provider: "workers-ai", id: "@cf/x/y" },
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
});
