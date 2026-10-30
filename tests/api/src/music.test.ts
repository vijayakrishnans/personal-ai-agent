import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@/index";
import { fileFrom } from "@/music";
import { auth, env, HF_TOKEN, hfStandIn, json, KEY, memoryNamespace } from "./helpers";

let hf: Awaited<ReturnType<typeof hfStandIn>>;
beforeAll(async () => {
  hf = await hfStandIn();
});
afterAll(() => hf.close());

const owner = (over = {}) => env({ AGENT_ACCESS_KEY: KEY, HF_SPACES_URL: hf.spaces, ...over });
const ask = (x: ReturnType<typeof env>, content: string, mode?: string) =>
  app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content }], ...(mode ? { mode } : {}) }) }, x);
const told = (body: { text: string }) => JSON.parse(body.text.replace(/^Tool said: /, ""));
const started = (space: string) => hf.calls.filter((c) => c.method === "POST" && c.path.startsWith(`/spaces/${space}/gradio_api/call/`)).at(-1);

describe("composeMusic", () => {
  it("makes a track on ACE-Step by default, keeps it, and the page plays it", async () => {
    const x = owner();
    const body = await json(await ask(x, `call composeMusic {"style":"lo-fi, chill, piano, 80 BPM","seconds":30}`));
    expect(body.tools).toEqual(["composeMusic"]);
    expect(told(body)).toEqual({ trackId: 1, seconds: 30, shown: true });
    expect(body.tracks).toEqual([expect.objectContaining({ id: 1, style: "lo-fi, chill, piano, 80 BPM", lyrics: "", model: "ACE-Step/ACE-Step", type: "audio/mpeg", seconds: 30 })]);
    // Every input the Space takes, at its default but those the agent set.
    expect(started("ACE-Step/ACE-Step")?.path).toBe("/spaces/ACE-Step/ACE-Step/gradio_api/call/__call__");
    expect(started("ACE-Step/ACE-Step")?.body).toEqual({ data: [30, "lo-fi, chill, piano, 80 BPM", "[instrumental]", 27, 15, null] });
    const audio = await app.request("/api/music/1", { headers: auth() }, x);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe("ID3-fake-mp3-bytes");
    expect((await json(await app.request("/api/music", { headers: auth() }, x))).tracks).toHaveLength(1);
    expect((await app.request("/api/music/1", { method: "DELETE", headers: auth() }, x)).status).toBe(200);
    expect((await app.request("/api/music/1", { headers: auth() }, x)).status).toBe(404);
  });

  it("sends the owner's HF_TOKEN to the Space, and only there", async () => {
    const x = owner({ HF_TOKEN });
    await ask(x, `call composeMusic {"style":"ambient pads"}`);
    const music = hf.calls.filter((c) => c.path.startsWith("/spaces/ACE-Step/"));
    expect(music.slice(-4).map((c) => c.auth)).toEqual(Array(4).fill(`Bearer ${HF_TOKEN}`));
  });

  it("YuE2 when chosen, for a song with lyrics; ACE-Step when there are none to sing", async () => {
    const x = owner();
    expect((await app.request("/api/state", { method: "PUT", headers: auth(), body: JSON.stringify({ musicModel: "mrfakename/yue2-3b" }) }, x)).status).toBe(200);
    const song = await json(await ask(x, `call composeMusic {"style":"dreamy synth-pop","lyrics":"[verse]\\nCity lights"}`));
    expect(song.tracks[0].model).toBe("mrfakename/yue2-3b");
    expect(started("mrfakename/yue2-3b")?.body).toEqual({ data: ["dreamy synth-pop", "[verse]\nCity lights", 42] });
    const instrumental = await json(await ask(x, `call composeMusic {"style":"jazz trio"}`));
    expect(instrumental.tracks[0].model).toBe("ACE-Step/ACE-Step");
    expect((await app.request("/api/state", { method: "PUT", headers: auth(), body: JSON.stringify({ musicModel: "someone/else" }) }, x)).status).toBe(400);
    expect((await json(await app.request("/api/state", { headers: auth() }, x))).musicModel).toBe("mrfakename/yue2-3b");
  });

  it("says why a Space failed, refuses audio from anywhere but the Space, and keeps secrets out", async () => {
    const x = owner();
    expect(told(await json(await ask(x, `call composeMusic {"style":"explode"}`))).error).toBe('ACE-Step failed: "GPU quota exceeded"');
    expect(told(await json(await ask(x, `call composeMusic {"style":"elsewhere"}`))).error).toMatch(/pointed somewhere else/);
    await ask(x, `call composeMusic {"style":"song about ghp_abcdefghijklmnopqrstuvwxyz0123456789"}`);
    expect((await x.memory.listActivity())[0]).toMatchObject({ tool: "composeMusic", outcome: "blocked" });
    expect(await x.memory.listTracks()).toEqual([]);
  });

  it("the Tools menu's Make music tells the model to use it", async () => {
    const x = owner();
    await ask(x, "something calm for studying", "music");
    expect(x.asked.at(-1)?.system).toContain("Make the music they describe with `composeMusic`");
  });
});

describe("tracks in the store", () => {
  it("keep a big track whole, in parts, and the newest 40", async () => {
    const db = new DatabaseSync(":memory:");
    const { object } = memoryNamespace(db);
    const big = "A".repeat(3_400_000) + "Zz==";
    const t = await object.saveTrack({ style: "epic", lyrics: "", model: "ACE-Step/ACE-Step", type: "audio/mpeg", seconds: 180 }, big);
    expect(db.prepare("SELECT count(*) AS n FROM track_parts WHERE track_id = ?").get(t.id)).toEqual({ n: 3 });
    expect((await object.getTrack(t.id))?.base64).toBe(big);
    for (let i = 0; i < 40; i++) await object.saveTrack({ style: `t${i}`, lyrics: "", model: "m", type: "audio/mpeg", seconds: 10 }, "QUJD");
    expect(await object.getTrack(t.id)).toBeNull();
    expect((await object.listTracks()).length).toBe(40);
    expect(db.prepare("SELECT count(*) AS n FROM track_parts").get()).toEqual({ n: 40 });
  });

  it("reads a Gradio stream's file, or its error", () => {
    expect(fileFrom('event: complete\ndata: [{"url":"https://x.hf.space/gradio_api/file=/a.mp3","path":"/a.mp3"}]\n\n')).toMatchObject({ path: "/a.mp3" });
    expect(fileFrom("event: error\ndata: null\n\n")).toEqual({ error: expect.stringMatching(/busy or out of free GPU time/) });
    expect(fileFrom("event: heartbeat\ndata: null\n\n")).toEqual({ error: "the Space ended without a track" });
  });
});
