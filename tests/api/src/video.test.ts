import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@/index";
import { DEFAULT_VIDEO_MODEL, VIDEO_MODELS } from "@/video";
import { auth, env, HF_TOKEN, hfStandIn, json, KEY } from "./helpers";

let hf: Awaited<ReturnType<typeof hfStandIn>>;
beforeAll(async () => {
  hf = await hfStandIn();
});
afterAll(() => hf.close());

const owner = (over = {}) => env({ AGENT_ACCESS_KEY: KEY, HF_TOKEN, HF_ROUTER_URL: hf.router, HF_HUB_URL: hf.hub, VIDEO_POLL_MS: "5", ...over });
const ask = (x: ReturnType<typeof env>, content: string) =>
  app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content }] }) }, x);
const told = (body: { text: string }) => JSON.parse(body.text.replace(/^Tool said: /, ""));
const post = (path: string, b: unknown) => ({ method: "POST", headers: auth(), body: JSON.stringify(b) });

describe("makeVideo", () => {
  it("makes a clip on fal-ai through the router, keeps it, and the page plays it", async () => {
    const x = owner();
    const n = hf.calls.length;
    const body = await json(await ask(x, `call makeVideo {"prompt":"an old man fishing on a misty lake at dawn"}`));
    expect(body.tools).toEqual(["makeVideo"]);
    expect(told(body)).toEqual({ videoId: 1, shown: true });
    expect(body.videos).toEqual([expect.objectContaining({ id: 1, prompt: "an old man fishing on a misty lake at dawn", model: DEFAULT_VIDEO_MODEL, type: "video/mp4" })]);

    const calls = hf.calls.slice(n);
    const submit = calls.find((c) => c.method === "POST" && c.path.startsWith("/fal-ai/"));
    expect(submit).toMatchObject({ path: "/fal-ai/fal-ai/wan/v2.2-5b/text-to-video?_subdomain=queue", auth: `Bearer ${HF_TOKEN}`, body: { prompt: "an old man fishing on a misty lake at dawn" } });
    expect(calls.filter((c) => c.path.endsWith("/status?_subdomain=queue"))).toHaveLength(2);
    // The clip comes from the provider's CDN without the owner's token.
    expect(calls.find((c) => c.path === "/cdn/clip.mp4")?.auth).toBe("");

    const clip = await app.request("/api/videos/1", { headers: auth() }, x);
    expect(clip.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await clip.arrayBuffer()).toString()).toBe("fake-mp4-bytes");
    expect((await json(await app.request("/api/videos", { headers: auth() }, x))).videos).toHaveLength(1);
    expect((await app.request("/api/videos/1", { method: "DELETE", headers: auth() }, x)).status).toBe(200);
    expect((await app.request("/api/videos/1", { headers: auth() }, x)).status).toBe(404);
  });

  it("says why it cannot: no token, credits used up, the provider failed", async () => {
    const cases: [ReturnType<typeof env>, string, string][] = [
      [owner({ HF_TOKEN: undefined }), "a cat", "needs a Hugging Face token"],
      [owner(), "broke cat", "no Inference Providers credits left for this month"],
      [owner(), "melt cat", "could not make it: GPU out of memory"],
      [owner({ HF_TOKEN: "hf_expired" }), "a cat", "Hugging Face refused your token"],
    ];
    for (const [x, prompt, says] of cases) {
      const body = await json(await ask(x, `call makeVideo {"prompt":"${prompt}"}`));
      expect(told(body).error, prompt).toContain(says);
      expect(body.videos).toBeUndefined();
    }
  });
});

describe("video models", () => {
  it("offers the built-in ones, the first by default, and switches between them", async () => {
    const x = owner();
    const models = await json(await app.request("/api/models", { headers: auth() }, x));
    expect(models.video.default).toBe(DEFAULT_VIDEO_MODEL);
    expect(models.video.models.map((m: { id: string }) => m.id)).toEqual(VIDEO_MODELS.map((m) => m.id));
    expect((await json(await app.request("/api/state", { headers: auth() }, x))).videoModel).toBe(DEFAULT_VIDEO_MODEL);
    const put = await app.request("/api/state", { method: "PUT", headers: auth(), body: JSON.stringify({ videoModel: "nobody/else" }) }, x);
    expect(put.status).toBe(400);
  });

  it("adds a pasted text-to-video model after checking the Hub, uses it, and removes it", async () => {
    const x = owner();
    const res = await app.request("/api/video-models", post("", { id: "Wan-AI/Wan2.1-T2V-14B" }), x);
    expect(res.status).toBe(201);
    expect((await json(await app.request("/api/state", { headers: auth() }, x))).videoModel).toBe("Wan-AI/Wan2.1-T2V-14B");
    const n = hf.calls.length;
    await ask(x, `call makeVideo {"prompt":"waves"}`);
    expect(hf.calls.slice(n).find((c) => c.method === "POST")?.path).toBe("/fal-ai/fal-ai/wan-t2v?_subdomain=queue");
    expect((await app.request("/api/video-models", post("", { id: "Wan-AI/Wan2.1-T2V-14B" }), x)).status).toBe(409);

    expect((await app.request("/api/video-models/Wan-AI/Wan2.1-T2V-14B", { method: "DELETE", headers: auth() }, x)).status).toBe(200);
    expect((await json(await app.request("/api/state", { headers: auth() }, x))).videoModel).toBe(DEFAULT_VIDEO_MODEL);
  });

  it("refuses, with the reason, what it cannot make video with", async () => {
    const cases: [string, string][] = [
      ["Wan-AI/Wan2.2-I2V-A14B", "needs a picture to start from"],
      ["Qwen/Qwen3.8-27B", "is not a video model"],
      ["only/wavespeed", "only on wavespeed"],
      ["nobody/nothing", "There is no model nobody/nothing"],
    ];
    for (const [id, says] of cases) {
      const res = await app.request("/api/video-models", post("", { id }), owner());
      const body = await json(res);
      expect([res.status, body.error], id).toEqual([422, "not_a_video_model"]);
      expect(body.message).toContain(says);
    }
    expect((await app.request("/api/video-models", post("", { id: "https://evil.example/x" }), owner())).status).toBe(400);
  });
});
