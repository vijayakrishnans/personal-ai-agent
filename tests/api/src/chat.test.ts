import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@/index";
import { API_NAME } from "@/identity";
import { auth, env, hfStandIn, HF_TOKEN, KEY, json } from "./helpers";

const chat = (model: string | undefined, ...turns: string[]) => ({
  method: "POST",
  headers: auth(),
  body: JSON.stringify({ ...(model ? { model } : {}), messages: turns.map((content, i) => ({ role: i % 2 ? "assistant" : "user", content })) }),
});

let hf: Awaited<ReturnType<typeof hfStandIn>>;
beforeAll(async () => {
  hf = await hfStandIn();
});
afterAll(() => hf.close());

const hfEnv = (over = {}) => env({ AGENT_ACCESS_KEY: KEY, HF_TOKEN, HF_ROUTER_URL: hf.router, HF_SPACES_URL: hf.spaces, ...over });

describe("POST /api/chat — Workers AI", () => {
  it("answers with the default model, keeping the conversation and naming the agent", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    const res = await app.request("/api/chat", chat(undefined, "hi", "Echo: hi", "how are you"), x);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, text: "Echo: how are you", model: "workers-ai:@cf/moonshotai/kimi-k2.6", tools: [], redacted: 0 });
    expect(x.asked[0]).toMatchObject({ model: "@cf/moonshotai/kimi-k2.6", roles: ["system", "user", "assistant", "user"] });
    expect(x.asked[0]?.tools).toEqual(["remember", "recall", "forget", "currentTime", "news", "readPage"]);
    expect(x.asked[0]?.system).toContain(`You are ${API_NAME},`);
  });

  it("remembers through its tool, and tells every later conversation", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    const res = await app.request("/api/chat", chat(undefined, "remember: Prefers tea to coffee."), x);
    const body = await json(res);
    expect(body.tools).toEqual(["remember"]);
    expect(body.text).toMatch(/^Tool said: .*Prefers tea to coffee\./);
    expect((await x.memory.listMemories()).map((m) => m.text)).toEqual(["Prefers tea to coffee."]);
    await app.request("/api/chat", chat("workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast", "what do I drink?"), x);
    expect(x.asked.at(-1)?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(x.asked.at(-1)?.system).toContain("- [1] (General) Prefers tea to coffee.");
  });

  it("files what it remembers under the space the model names, and offers it again", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    await app.request("/api/chat", chat(undefined, "remember in Food: Prefers tea to coffee."), x);
    expect((await x.memory.listMemories()).map((m) => [m.text, m.space])).toEqual([["Prefers tea to coffee.", "Food"]]);
    await app.request("/api/chat", chat(undefined, "what do I drink?"), x);
    expect(x.asked.at(-1)?.system).toContain("- [1] (Food) Prefers tea to coffee.");
    expect(x.asked.at(-1)?.system).toContain("Reuse an existing space when one fits (Food)");
  });

  it("refuses a model it does not offer, and a conversation that does not end with the owner", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY });
    const unknown = await app.request("/api/chat", chat("workers-ai:@cf/some/other-model", "hi"), x);
    expect([unknown.status, (await json(unknown)).error]).toEqual([400, "unknown_model"]);
    const last = await app.request("/api/chat", chat(undefined, "hi", "hello"), x);
    expect([last.status, (await json(last)).error]).toEqual([400, "invalid_chat"]);
    const empty = await app.request("/api/chat", { method: "POST", headers: auth(), body: "{}" }, x);
    expect(empty.status).toBe(400);
    expect(x.asked).toEqual([]);
  });
});

describe("POST /api/chat — Hugging Face", () => {
  it("calls the router with the owner's token, the model's id and the agent's tools", async () => {
    const x = hfEnv({ HF_MODELS: "openai/gpt-oss-120b" });
    const n = hf.asked.length;
    const res = await app.request("/api/chat", chat("huggingface:openai/gpt-oss-120b", "remember: Lives in Kochi."), x);
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ model: "huggingface:openai/gpt-oss-120b", tools: ["remember"] });
    expect(hf.asked.slice(n).map((a) => a.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
    expect(hf.calls.filter((c) => c.path === "/v1/chat/completions").every((c) => c.auth === `Bearer ${HF_TOKEN}`)).toBe(true);
    expect((await x.memory.listMemories()).map((m) => m.text)).toEqual(["Lives in Kochi."]);
  });

  it("asks again without tools when a provider refuses them", async () => {
    const x = hfEnv({ HF_MODELS: "some/model:notools" });
    const n = hf.asked.length;
    const body = await json(await app.request("/api/chat", chat("huggingface:some/model:notools", "hello"), x));
    expect(body).toMatchObject({ ok: true, text: "Echo: hello", tools: [] });
    expect(hf.asked.slice(n).map((a) => a.tools.length)).toEqual([0]);
    expect(hf.asked.at(-1)?.system).toContain("You cannot save new memories");
  });

  it("says Hugging Face is not connected, before calling anything, when no token is stored", async () => {
    const x = hfEnv({ HF_TOKEN: undefined, HF_MODELS: "openai/gpt-oss-120b" });
    const n = hf.calls.length;
    const res = await app.request("/api/chat", chat("huggingface:openai/gpt-oss-120b", "hi"), x);
    expect([res.status, (await json(res)).error]).toEqual([409, "huggingface_not_connected"]);
    expect(hf.calls.length).toBe(n);
  });

  it("is a 502 naming the model when the provider fails, never the token", async () => {
    const x = hfEnv({ HF_TOKEN: "hf_wrong", HF_MODELS: "openai/gpt-oss-120b" });
    const res = await app.request("/api/chat", chat("huggingface:openai/gpt-oss-120b", "hi"), x);
    const raw = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(raw).error).toBe("model_failed");
    expect(raw).toContain("openai/gpt-oss-120b · Hugging Face failed");
    expect(raw).not.toContain("hf_wrong");
  });

  it("calls a Space added in the page with the owner's last message", async () => {
    const x = hfEnv();
    await app.request("/api/models", { method: "POST", headers: auth(), body: JSON.stringify({ provider: "space", id: "me/my-chat" }) }, x);
    const n = hf.calls.length;
    const body = await json(await app.request("/api/chat", chat("space:me/my-chat", "first", "ok", "hello space"), x));
    expect(body).toEqual({ ok: true, text: "me/my-chat says: hello space", model: "space:me/my-chat", tools: [], redacted: 0 });
    const calls = hf.calls.slice(n);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /spaces/me/my-chat/gradio_api/call/chat", "GET /spaces/me/my-chat/gradio_api/call/chat/" + calls[1]?.path.split("/").pop()]);
    expect(calls[0]?.body).toEqual({ data: ["hello space"] });
    expect(calls.every((c) => c.auth === `Bearer ${HF_TOKEN}`)).toBe(true);
  });

  it("says which Space failed, and why", async () => {
    const x = hfEnv({ HF_MODELS: "space:me/broken#nope, space:me/explodes" });
    const wrong = await json(await app.request("/api/chat", chat("space:me/broken", "hi"), x));
    expect(wrong).toMatchObject({ ok: false, error: "model_failed", message: 'Space me/broken refused the call (404): is its endpoint "nope"?' });
    const failed = await json(await app.request("/api/chat", chat("space:me/explodes", "explode"), x));
    expect(failed.message).toBe("Space me/explodes failed: no reason given");
  });
});
