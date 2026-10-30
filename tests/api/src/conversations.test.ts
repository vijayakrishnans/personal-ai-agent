import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@/index";
import { systemPrompt } from "@/agent";
import { thin } from "@/maps";
import { page } from "@/ui";
import { auth, env, json, KEY, memoryNamespace, webStandIn } from "./helpers";

let web: Awaited<ReturnType<typeof webStandIn>>;
beforeAll(async () => {
  web = await webStandIn();
});
afterAll(() => web.close());

const owner = () => env({ AGENT_ACCESS_KEY: KEY, NEWS_URL: web.news, LOOKUP_URL: web.lookup });
const call = (x: ReturnType<typeof env>, path: string, method = "GET", body?: unknown) =>
  app.request(path, { method, headers: auth(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, x);
const DAY = 86_400_000;

describe("conversations", () => {
  const talk = (q: string, a: string) => [
    { role: "user", content: q },
    { role: "assistant", content: a, meta: "Kimi K2.6 · used weather" },
  ];

  it("are saved, listed newest first, opened and deleted", async () => {
    const x = owner();
    expect((await call(x, "/api/conversations/conv-aaaa-1111", "PUT", { messages: talk("What should I eat in the heat?", "Watermelon and curd rice.") })).status).toBe(200);
    await call(x, "/api/conversations/conv-bbbb-2222", "PUT", { messages: talk("Plan a trip to Munnar", "Day 1: tea gardens.") });
    const { conversations } = await json(await call(x, "/api/conversations"));
    expect(conversations.map((c: { id: string; title: string }) => [c.id, c.title])).toEqual([
      ["conv-bbbb-2222", "Plan a trip to Munnar"],
      ["conv-aaaa-1111", "What should I eat in the heat?"],
    ]);
    const { conversation } = await json(await call(x, "/api/conversations/conv-aaaa-1111"));
    expect(conversation.messages[1]).toEqual({ role: "assistant", content: "Watermelon and curd rice.", meta: "Kimi K2.6 · used weather" });
    expect((await call(x, "/api/conversations/conv-aaaa-1111", "DELETE")).status).toBe(200);
    expect((await call(x, "/api/conversations/conv-aaaa-1111")).status).toBe(404);
  });

  it("are searched by every word, in titles and in what was said, with where it matched", async () => {
    const x = owner();
    await call(x, "/api/conversations/conv-aaaa-1111", "PUT", { messages: talk("What should I eat in the heat?", "Watermelon and curd rice keep you cool.") });
    await call(x, "/api/conversations/conv-bbbb-2222", "PUT", { messages: talk("Plan a trip to Munnar", "Day 1: tea gardens.") });
    const found = async (q: string) => (await json(await call(x, `/api/conversations?q=${encodeURIComponent(q)}`))).conversations;
    expect((await found("curd rice")).map((c: { id: string }) => c.id)).toEqual(["conv-aaaa-1111"]);
    expect((await found("curd rice"))[0].snippet).toContain("Watermelon and curd rice");
    expect(await found("munnar curd")).toEqual([]);
    expect((await found("TEA")).map((c: { id: string }) => c.id)).toEqual(["conv-bbbb-2222"]);
    expect((await found("100%_"))).toEqual([]);
  });

  it("keep no secret, whatever the page sends", async () => {
    const x = owner();
    await call(x, "/api/conversations/conv-cccc-3333", "PUT", { messages: talk("my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok?", "Fine.") });
    const { conversation } = await json(await call(x, "/api/conversations/conv-cccc-3333"));
    expect(JSON.stringify(conversation)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(conversation.title).not.toContain("ghp_");
  });

  it("refuse a bad id or body, and stay behind the key", async () => {
    const x = owner();
    expect((await call(x, "/api/conversations/x", "PUT", { messages: talk("a", "b") })).status).toBe(404);
    expect((await call(x, "/api/conversations/conv-dddd-4444", "PUT", { messages: [] })).status).toBe(400);
    expect((await call(x, "/api/conversations/conv-dddd-4444", "PUT", { messages: [{ role: "system", content: "x" }] })).status).toBe(400);
    expect((await app.request("/api/conversations", {}, x)).status).toBe(401);
  });

  it("keep only the newest messages of one too big to store", async () => {
    const x = owner();
    const big = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${"y".repeat(19_000)}` }));
    expect((await call(x, "/api/conversations/conv-eeee-5555", "PUT", { messages: big })).status).toBe(200);
    const { conversation } = await json(await call(x, "/api/conversations/conv-eeee-5555"));
    expect(conversation.messages.length).toBeLessThan(200);
    expect(conversation.messages.at(-1).content.startsWith("199 ")).toBe(true);
    expect(conversation.title.startsWith("0 yyy")).toBe(true);
  });
});

describe("notes expire", () => {
  it("in 2 days by default; 7 days or for good when asked, and the owner can change it", async () => {
    const x = owner();
    const soon = (await json(await call(x, "/api/notes", "POST", { text: "Buy curd" }))).note;
    expect(new Date(soon.expiresAt).getTime() - Date.now()).toBeGreaterThan(2 * DAY - 60_000);
    expect(new Date(soon.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * DAY);
    const week = (await json(await call(x, "/api/notes", "POST", { text: "Book train", keepDays: 7 }))).note;
    expect(new Date(week.expiresAt).getTime() - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    const good = (await json(await call(x, "/api/notes", "POST", { text: "Passport renewal: March", keepDays: null }))).note;
    expect(good.expiresAt).toBeNull();
    const kept = (await json(await call(x, `/api/notes/${soon.id}`, "PATCH", { keepDays: null }))).note;
    expect(kept.expiresAt).toBeNull();
    expect((await call(x, "/api/notes", "POST", { text: "x", keepDays: 3 })).status).toBe(400);
    expect((await call(x, `/api/notes/${week.id}`, "PATCH", { keepDays: "forever" })).status).toBe(400);
  });

  it("an expired note is gone, and the object's alarm deletes it on time", async () => {
    const db = new DatabaseSync(":memory:");
    const { object } = memoryNamespace(db);
    const gone = await object.addNote("Old idea");
    await object.addNote("Fresh idea");
    await object.addNote("For good", undefined, null);
    db.prepare("UPDATE notes SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), gone.id);
    expect((await object.listNotes()).map((n) => n.text)).toEqual(["Fresh idea", "For good"]);
    db.prepare("UPDATE notes SET expires_at = ? WHERE text = ?").run(new Date(Date.now() - 1000).toISOString(), "Fresh idea");
    await object.alarm();
    expect(db.prepare("SELECT text FROM notes").all().map((r) => (r as { text: string }).text)).toEqual(["For good"]);
  });

  it("the agent's notes expire too, unless it is told to keep one", async () => {
    const x = owner();
    await app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content: `call addNote {"text":"Milk"} ; call addNote {"text":"Visa docs","keep":"for good"}` }] }) }, x);
    const notes = await x.memory.listNotes();
    expect(notes.find((n) => n.text === "Milk")?.expiresAt).not.toBeNull();
    expect(notes.find((n) => n.text === "Visa docs")?.expiresAt).toBeNull();
  });

  it("an old store's notes are kept for good", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, list TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO notes (list, text, created_at) VALUES ('Notes', 'Kept from before', '2026-10-01T00:00:00Z')").run();
    const { object } = memoryNamespace(db);
    expect(await object.listNotes()).toEqual([expect.objectContaining({ text: "Kept from before", expiresAt: null })]);
  });
});

describe("knowledge kept as a conversation", () => {
  const answer = "Eat hydrating food: watermelon, cucumber, curd rice. ".repeat(20).trim();

  it("keeps what was asked with what it answered, an answer longer than a fact", async () => {
    const x = owner();
    const res = await call(x, "/api/memories", "POST", { question: "What's the best food to eat in heat?", text: answer, space: "Food" });
    expect(res.status).toBe(201);
    const { memory } = await json(res);
    expect(memory).toMatchObject({ question: "What's the best food to eat in heat?", text: answer, space: "Food" });
    // Every "s" kept: the page once dropped them.
    expect(memory.text).toContain("watermelon, cucumber");
    expect((await call(x, "/api/memories", "POST", { text: answer })).status).toBe(400);
    expect((await call(x, "/api/memories", "POST", { question: "q", text: "x".repeat(4001) })).status).toBe(400);
    expect((await call(x, "/api/memories", "POST", { question: "my pin is 4321, ok?", text: "Sure" })).status).toBe(400);
  });

  it("the prompt carries the question and the answer's start; recall finds it by the question", async () => {
    const x = owner();
    await call(x, "/api/memories", "POST", { question: "What's the best food to eat in heat?", text: answer, space: "Food" });
    const memories = await x.memory.listMemories();
    const prompt = systemPrompt(memories, "2026-10-30", true);
    expect(prompt).toContain('Your owner asked "What\'s the best food to eat in heat?" and kept the answer: Eat hydrating food');
    expect(prompt).toContain("(recall for all of it)");
    expect(prompt).not.toContain(answer);
    expect((await x.memory.recall("heat")).map((m) => m.question)).toEqual(["What's the best food to eat in heat?"]);
  });
});

describe("maps and travel", () => {
  const ask = (x: ReturnType<typeof env>, content: string, mode?: string) =>
    app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content }], ...(mode ? { mode } : {}) }) }, x);

  it("showMap: the places it found, on a map for the page; the model gets names and links", async () => {
    const x = owner();
    const body = await json(await ask(x, `call showMap {"places":["Fort Kochi, Kerala","Munnar, Kerala","Nowhere at all"]}`));
    expect(body.tools).toEqual(["showMap"]);
    expect(body.maps).toHaveLength(1);
    expect(body.maps[0].places.map((p: { name: string }) => p.name)).toEqual(["Fort Kochi, Ernakulam, Kerala", "Munnar, Ernakulam, Kerala"]);
    expect(body.maps[0].places[0]).toMatchObject({ lat: 9.9658, lon: 76.2421, url: expect.stringContaining("openstreetmap.org") });
    const told = JSON.parse(body.text.replace(/^Tool said: /, ""));
    expect(told).toMatchObject({ shown: true, notFound: ["Nowhere at all"] });
  });

  it("route: distance, time, the way for the page only, and a link to directions", async () => {
    const x = owner();
    const body = await json(await ask(x, `call route {"from":"Fort Kochi","to":"Munnar","mode":"car"}`));
    const map = body.maps[0];
    expect(map.route).toMatchObject({ km: 128.4, minutes: 225, mode: "car" });
    expect(map.route.line).toEqual([[9.9658, 76.2421], [10, 76.6], [10.0889, 77.0595]]);
    expect(map.route.directions).toContain("engine=fossgis_osrm_car");
    const told = JSON.parse(body.text.replace(/^Tool said: /, ""));
    expect(told.map.route.line).toBeUndefined();
    expect(told.map.route.km).toBe(128.4);
    expect(web.calls.some((c) => c.path.startsWith("/lookup/osrm/routed-car/route/v1/driving/76.2421,9.9658;77.0595,10.0889"))).toBe(true);
  });

  it("places: what is near, with names, kinds, hours and links; unnamed ones left out", async () => {
    const x = owner();
    const body = await json(await ask(x, `call places {"kind":"restaurant","near":"Fort Kochi"}`));
    expect(body.maps[0].places).toEqual([
      expect.objectContaining({ name: "Kashi Art Cafe", kind: "restaurant · cafe, regional", address: "Burgher Street", hours: "08:30-19:30", url: "https://www.openstreetmap.org/node/1" }),
      expect.objectContaining({ name: "Fort House", lat: 9.967, url: "https://www.openstreetmap.org/way/2" }),
    ]);
    const empty = await json(await ask(x, `call places {"kind":"museum","near":"Fort Kochi"}`));
    expect(JSON.parse(empty.text.replace(/^Tool said: /, "")).error).toMatch(/no museum with a name within 2 km/);
  });

  it("a map reads from the web, so it closes the notes for the turn", async () => {
    const x = owner();
    await ask(x, `call showMap {"places":["Fort Kochi"]} ; call addNote {"text":"Visit Fort Kochi"}`);
    expect((await x.memory.listActivity()).map((a) => [a.tool, a.outcome])).toEqual([["addNote", "blocked"], ["showMap", "ok"]]);
  });

  it("a long way is thinned for the page, keeping its ends", () => {
    const line = Array.from({ length: 1000 }, (_, i) => [i, i] as [number, number]);
    const kept = thin(line);
    expect(kept.length).toBeLessThanOrEqual(301);
    expect(kept[0]).toEqual([0, 0]);
    expect(kept.at(-1)).toEqual([999, 999]);
  });
});

describe("the tools menu", () => {
  it("tells the model which tool the owner chose", async () => {
    const x = owner();
    const send = (mode: string) => app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content: "Kochi to Munnar this weekend" }], mode }) }, x);
    expect((await send("travel")).status).toBe(200);
    expect(x.asked.at(-1)?.system).toContain('your owner chose a tool from the menu: Call `useSkill` with "trip-planner"');
    await send("web");
    expect(x.asked.at(-1)?.system).toContain("web search is not connected");
    expect((await send("hack")).status).toBe(400);
  });
});

describe("stacking tools", () => {
  const send = (x: ReturnType<typeof env>, content: string, modes: string[]) =>
    app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content }], modes }) }, x);

  it("tells the model to use every tool picked and combine them, and makes its first step call one", async () => {
    const x = owner();
    expect((await send(x, "where should I go this weekend?", ["map", "knowledge", "weather", "web"])).status).toBe(200);
    const asked = x.asked[0];
    expect(asked?.system).toContain("your owner stacked 4 tools from the menu. Use every one of them before you answer");
    expect(asked?.system).toMatch(/- Use what you know about your owner[\s\S]*- Look this up before answering[\s\S]*- Use `weather`[\s\S]*- Show it on a map/);
    expect(asked?.system).toContain("use the first one's results for the next");
    expect(asked?.toolChoice).toBe("required");
    // The stand-in answered in words though made to call a tool, as a model
    // might: the agent asked again, letting it choose.
    expect(x.asked.map((a) => a.toolChoice)).toEqual(["required", "auto"]);
  });

  it("only the first step is made to call a tool; the rest choose", async () => {
    const x = owner();
    await send(x, `call weather {"place":"Munnar","country":"IN"}`, ["weather"]);
    expect(x.asked.slice(-2).map((a) => a.toolChoice)).toEqual(["required", "auto"]);
    expect(x.asked).toHaveLength(2);
  });

  it("knowledge alone forces nothing: what it remembers is already in the prompt", async () => {
    const x = owner();
    await send(x, "what should I eat?", ["knowledge"]);
    expect(x.asked.map((a) => a.toolChoice)).toEqual(["auto"]);
    expect(x.asked.at(-1)?.system).toContain("your owner chose a tool from the menu: Use what you know about your owner");
  });

  it("a model that refuses to be made to call a tool is asked as it would be", async () => {
    const x = owner();
    const res = await send(x, "noforce: where should I go?", ["web", "weather"]);
    expect(res.status).toBe(200);
    expect((await json(res)).text).toBe("Echo: noforce: where should I go?");
  });

  it("tells every model to trust today's tools over its training, and to answer rather than ask", async () => {
    const x = owner();
    await send(x, "tell me the best place to visit", []);
    expect(x.asked.at(-1)?.system).toContain("trust what your tools return today over what you remember");
    expect(x.asked.at(-1)?.system).toContain("do not answer with questions");
    expect((await send(x, "x", ["teleport"])).status).toBe(400);
  });
});

describe("the page's script", () => {
  const script = () => {
    const html = page("Personal Ai Agent");
    return html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
  };

  it("parses, and keeps its regular expressions' backslashes", () => {
    expect(() => new Function(script())).not.toThrow();
    // `\s` lost its backslash once and "Add to knowledge" dropped every "s".
    expect(script()).toContain("replace(/\\s+/g, ' ')");
    expect(script()).not.toMatch(/replace\(\/s\+\/g/);
  });

  it("draws maps from OpenStreetMap's tiles with its credit, and nothing else from outside", () => {
    expect(script()).toContain("https://tile.openstreetmap.org/");
    expect(script()).toContain("https://www.openstreetmap.org/copyright");
    expect(page("x")).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
  });

  it("maps drag, pinch and go back to the start, and a drag is not a click on a pin", () => {
    expect(script()).toContain("box.addEventListener('pointermove'");
    expect(script()).toContain("title: 'Back to the start'");
    expect(page("x")).toContain(".map{position:relative;width:600px;max-width:100%;height:320px;overflow:hidden;cursor:grab;touch-action:none");
    expect(script()).toMatch(/addEventListener\('click', \(e\) => \{ if \(moved\)/);
  });

  it("fits a phone: the sidebar is a drawer opened from the header", () => {
    expect(page("x")).toContain('interactive-widget=resizes-content');
    expect(page("x")).toMatch(/<button id="chats-open"[^>]*aria-controls="side"/);
    expect(page("x")).toContain("body.drawer aside{transform:none}");
    expect(script()).toContain("function drawer(on)");
  });

  it("downloads an answer, or the whole chat, as Markdown", () => {
    expect(page("x")).toContain('id="download-chat"');
    expect(script()).toContain("textContent: 'Download', title: 'Download the question and this answer");
    expect(script()).toContain("type: 'text/markdown;charset=utf-8'");
  });
});

describe("the activity log", () => {
  it("keeps why a tool failed", async () => {
    const x = owner();
    await app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content: `call places {"kind":"museum","near":"Fort Kochi"}` }] }) }, x);
    expect((await x.memory.listActivity())[0]).toMatchObject({ tool: "places", outcome: "error", detail: expect.stringMatching(/^museum near Fort Kochi — no museum with a name within 2 km/) });
  });

  it("newest papers are only those out by today", async () => {
    const x = owner();
    await app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content: `call papers {"query":"rag","sort":"newest"}` }] }) }, x);
    const asked = web.calls.filter((c) => c.path.startsWith("/lookup/openalex/works?")).at(-1)?.path ?? "";
    expect(decodeURIComponent(asked)).toContain(`to_publication_date:${new Date().toISOString().slice(0, 10)}`);
  });
});
