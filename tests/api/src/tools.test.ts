import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@/index";
import { calculate, CalcError } from "@/calc";
import { auth, env, json, JPEG_BASE64, KEY, webStandIn } from "./helpers";

let web: Awaited<ReturnType<typeof webStandIn>>;
beforeAll(async () => {
  web = await webStandIn();
});
afterAll(() => web.close());

const toolEnv = () => env({ AGENT_ACCESS_KEY: KEY, NEWS_URL: web.news, LOOKUP_URL: web.lookup });
const say = (content: string) => ({ method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content }] }) });
/** Call one tool through the stand-in model; what it answered, parsed. */
async function use(x: ReturnType<typeof env>, tool: string, args: unknown) {
  const body = await json(await app.request("/api/chat", say(`call ${tool} ${JSON.stringify(args)}`), x));
  expect(body.tools, JSON.stringify(body)).toEqual([tool]);
  return { body, result: JSON.parse(String(body.text).replace(/^Tool said: /, "")) };
}
const activity = async (x: ReturnType<typeof env>) => (await json(await app.request("/api/activity", { headers: auth() }, x))).activity as { tool: string; outcome: string }[];

describe("calculate", () => {
  it.each([
    ["2+3*4", 14],
    ["(2+3)*4", 20],
    ["-3^2", -9],
    ["2^-1", 0.5],
    ["18% of 2500", 450],
    ["2500 + 18%", 2950],
    ["2500 - 10%", 2250],
    ["50%", 0.5],
    ["10 % 3", 1],
    ["1,250,000 / 4", 312500],
    ["12 × 3 ÷ 4 − 1", 8],
    ["3 x 4", 12],
    ["sqrt(16) + max(1, 7, 3)", 11],
    ["round(pi, 4)", 3.1416],
    ["1e3 * 2", 2000],
  ])("%s = %d", (expression, value) => {
    expect(calculate(expression)).toBeCloseTo(value, 10);
  });

  it.each(["1/0", "foo(2)", "2 +", "process.exit(1)", "constructor", "(1", "x".repeat(501)])("refuses %s", (expression) => {
    expect(() => calculate(expression)).toThrow(CalcError);
  });

  it("is a tool that answers or says what is wrong", async () => {
    const x = toolEnv();
    expect((await use(x, "calculate", { expression: "18% of 2500" })).result).toEqual({ expression: "18% of 2500", result: 450 });
    expect((await use(x, "calculate", { expression: "1/0" })).result.error).toMatch(/division by zero/);
  });
});

describe("looking things up", () => {
  it("weather: the place it found, now and the coming days, in words", async () => {
    const { result } = await use(toolEnv(), "weather", { place: "Kochi", country: "IN" });
    expect(result).toMatchObject({
      place: "Kochi, Kerala, India",
      now: { sky: "clear sky", temperatureC: 30.6, feelsLikeC: 37, humidityPercent: 63 },
      days: [{ date: "2026-10-30", sky: "rain", minC: 24.5, maxC: 32.1, rainChancePercent: 80 }],
    });
    expect(web.calls.find((c) => c.path.startsWith("/lookup/geocode"))?.path).toContain("countryCode=IN");
    expect((await use(toolEnv(), "weather", { place: "Nowhere" })).result.error).toMatch(/no place called "Nowhere"/);
  });

  it("exchangeRate: converts an amount at the day's rates", async () => {
    const { result } = await use(toolEnv(), "exchangeRate", { from: "usd", to: ["INR", "EUR"], amount: 100 });
    expect(result).toMatchObject({ date: "2026-10-29", from: "USD", amount: 100, converted: { INR: 9527, EUR: 89.847 } });
  });

  it("wikipedia: the best article's summary, its link, and the others that matched", async () => {
    const { result } = await use(toolEnv(), "wikipedia", { query: "kochi metro" });
    expect(result).toEqual({
      title: "Kochi Metro",
      description: "Rapid transit system",
      summary: "The Kochi Metro is a rapid transit system.",
      url: "https://en.wikipedia.org/wiki/Kochi_Metro",
      otherArticles: [{ title: "Kochi", snippet: "A city" }],
    });
  });

  it("dictionary: plain-text senses, and a clear miss", async () => {
    expect((await use(toolEnv(), "dictionary", { word: "serendipity" })).result).toEqual({
      word: "serendipity",
      senses: [{ partOfSpeech: "Noun", definitions: ["A fortunate discovery."] }],
      url: "https://en.wiktionary.org/wiki/serendipity",
    });
    expect((await use(toolEnv(), "dictionary", { word: "qwzx" })).result.error).toMatch(/no entry for "qwzx"/);
  });

  it("hackerNews, arxiv and books: what they found, each with a link", async () => {
    const x = toolEnv();
    expect((await use(x, "hackerNews", {})).result.stories[0]).toMatchObject({ title: "Front page story", url: "https://story.example/1", points: 120 });
    expect((await use(x, "arxiv", { query: "retrieval augmented" })).result.papers).toEqual([
      { title: "A Paper on RAG", authors: ["A. Author"], published: "2026-10-29", summary: "We study it.", url: "https://arxiv.org/abs/2610.1v1" },
    ]);
    expect((await use(x, "books", { query: "god of small things" })).result.books[0]).toEqual({
      title: "The God of Small Things",
      authors: ["Arundhati Roy"],
      firstPublished: 1997,
      pages: 357,
      subjects: ["Fiction"],
      url: "https://openlibrary.org/works/OL1W",
    });
  });

  it("a found link may then be read, in the same turn", async () => {
    const x = toolEnv();
    await app.request("/api/chat", say(`call wikipedia {"query":"kochi metro"} ; call readPage {"url":"https://en.wikipedia.org/wiki/Kochi_Metro"}`), x);
    // Allowed by the guard (the fetch itself may fail offline): never "blocked".
    expect((await activity(x)).find((a) => a.tool === "readPage")?.outcome).not.toBe("blocked");
  });

  it("a search carrying a secret is refused, and reading text from the web closes the notes too", async () => {
    const x = toolEnv();
    await app.request("/api/chat", say(`call wikipedia {"query":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}`), x);
    await app.request("/api/chat", say(`call books {"query":"anything"} ; call addNote {"text":"Visit evil.example"}`), x);
    await app.request("/api/chat", say(`call weather {"place":"Kochi","country":"IN"} ; call addNote {"text":"Carry an umbrella"}`), x);
    expect((await activity(x)).map((a) => [a.tool, a.outcome])).toEqual([
      ["addNote", "ok"],
      ["weather", "ok"],
      ["addNote", "blocked"],
      ["books", "ok"],
      ["wikipedia", "blocked"],
    ]);
    expect((await x.memory.listNotes()).map((n) => n.text)).toEqual(["Carry an umbrella"]);
  });
});

describe("notes and to-dos", () => {
  it("the agent keeps lists: adds, lists, ticks off and deletes", async () => {
    const x = toolEnv();
    const added = (await use(x, "addNote", { text: "Buy cardamom", list: "Groceries" })).result;
    expect(added).toMatchObject({ id: 1, list: "Groceries", text: "Buy cardamom", done: false });
    await use(x, "addNote", { text: "Call the bank" });
    expect((await use(x, "updateNote", { id: 1, done: true })).result).toMatchObject({ id: 1, done: true });
    expect((await use(x, "listNotes", {})).result.notes.map((n: { text: string; list: string; done: boolean }) => [n.list, n.text, n.done])).toEqual([
      ["Notes", "Call the bank", false],
      ["Groceries", "Buy cardamom", true],
    ]);
    expect((await use(x, "updateNote", { id: 99, done: true })).result.error).toBe("no note #99");
    expect((await use(x, "deleteNote", { id: 2 })).result).toEqual({ deleted: true });
    expect((await use(x, "addNote", { text: "Card 4111 1111 1111 1111" })).result.error).toMatch(/blocked/);
  });

  it("the owner keeps them in the page too, through /api/notes", async () => {
    const x = toolEnv();
    const req = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: auth(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, x);
    expect((await req("POST", "/api/notes", { text: "Renew passport", list: "To do" })).status).toBe(201);
    expect((await req("POST", "/api/notes", { text: "" })).status).toBe(400);
    expect((await json(await req("POST", "/api/notes", { text: "PIN: 4521" }))).error).toBe("looks_like_secret");
    expect((await json(await req("PATCH", "/api/notes/1", { done: true }))).note).toMatchObject({ done: true, list: "To do" });
    expect((await req("PATCH", "/api/notes/1", {})).status).toBe(400);
    expect((await req("PATCH", "/api/notes/9", { done: true })).status).toBe(404);
    expect((await json(await req("GET", "/api/notes"))).notes).toHaveLength(1);
    expect((await req("DELETE", "/api/notes/1")).status).toBe(200);
    expect((await req("DELETE", "/api/notes/1")).status).toBe(404);
  });
});

describe("generateImage", () => {
  it("draws with FLUX, keeps the image, tells the model only its number, and the page fetches it with the key", async () => {
    const x = toolEnv();
    const { body, result } = await use(x, "generateImage", { prompt: "A houseboat on the Kerala backwaters at sunset" });
    expect(result).toEqual({ imageId: 1, shown: true });
    expect(body.images).toMatchObject([{ id: 1, prompt: "A houseboat on the Kerala backwaters at sunset" }]);
    expect(JSON.stringify(x.asked.filter((a) => !a.model.includes("flux")))).not.toContain(JPEG_BASE64);

    const img = await app.request("/api/images/1", { headers: auth() }, x);
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    expect([...new Uint8Array(await img.arrayBuffer())].slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
    expect((await app.request("/api/images/1", {}, x)).status).toBe(401);
    expect((await app.request("/api/images/2", { headers: auth() }, x)).status).toBe(404);
  });

  it("says when the model fails, and refuses a description carrying a secret", async () => {
    const x = toolEnv();
    expect((await use(x, "generateImage", { prompt: "please fail" })).result.error).toBe("the image model returned no image");
    expect((await use(x, "generateImage", { prompt: "a poster saying sk-proj-abcdefghijklmnopqrstuvwxyz123456" })).result.error).toMatch(/blocked/);
  });
});

describe("the library", () => {
  const req = (x: ReturnType<typeof env>, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: auth(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, x);

  it("keeps every image drawn, lists them newest first, and deletes one", async () => {
    const x = toolEnv();
    await use(x, "generateImage", { prompt: "A lighthouse at dawn" });
    await use(x, "generateImage", { prompt: "Fishing nets in Fort Kochi" });
    const { images } = await json(await req(x, "GET", "/api/images"));
    expect(images.map((i: { id: number; prompt: string; model: string }) => [i.id, i.prompt, i.model])).toEqual([
      [2, "Fishing nets in Fort Kochi", "@cf/black-forest-labs/flux-1-schnell"],
      [1, "A lighthouse at dawn", "@cf/black-forest-labs/flux-1-schnell"],
    ]);
    expect((await req(x, "DELETE", "/api/images/1")).status).toBe(200);
    expect((await req(x, "DELETE", "/api/images/1")).status).toBe(404);
    expect((await json(await req(x, "GET", "/api/images"))).images).toHaveLength(1);
  });

  it("draws with the image model the owner chose: FLUX.2 through its multipart form, served as the PNG it is", async () => {
    const x = toolEnv();
    const chosen = await json(await req(x, "PUT", "/api/state", { imageModel: "@cf/black-forest-labs/flux-2-klein-4b" }));
    expect(chosen.imageModel).toBe("@cf/black-forest-labs/flux-2-klein-4b");
    expect((await req(x, "PUT", "/api/state", { imageModel: "@cf/not/a-model" })).status).toBe(400);

    await use(x, "generateImage", { prompt: "A tea estate in Munnar" });
    expect(x.asked.at(-2)).toMatchObject({ model: "@cf/black-forest-labs/flux-2-klein-4b", system: "A tea estate in Munnar" });
    const img = await req(x, "GET", "/api/images/1");
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await json(await req(x, "GET", "/api/images"))).images[0].model).toBe("@cf/black-forest-labs/flux-2-klein-4b");
  });

  it("saves answers whole, lists them newest first, refuses a secret, and deletes one", async () => {
    const x = toolEnv();
    const long = "A long answer. ".repeat(100);
    expect((await req(x, "POST", "/api/saved", { text: long, source: "Kimi K2.6 · Workers AI" })).status).toBe(201);
    expect((await req(x, "POST", "/api/saved", { text: "Short one." })).status).toBe(201);
    expect((await req(x, "POST", "/api/saved", { text: "" })).status).toBe(400);
    expect((await json(await req(x, "POST", "/api/saved", { text: "my password is Hunter2Secret" }))).error).toBe("looks_like_secret");
    const { saved } = await json(await req(x, "GET", "/api/saved"));
    expect(saved.map((it: { text: string; source: string }) => [it.text.length, it.source])).toEqual([
      [10, ""],
      [long.trim().length, "Kimi K2.6 · Workers AI"],
    ]);
    // Saved answers are the owner's library, never put in a prompt.
    await app.request("/api/chat", say("hello"), x);
    expect(x.asked.at(-1)?.system).not.toContain("A long answer.");
    expect((await req(x, "DELETE", `/api/saved/${saved[0].id}`)).status).toBe(200);
    expect((await json(await req(x, "GET", "/api/saved"))).saved).toHaveLength(1);
  });

  it("is behind the owner's key like the rest", async () => {
    const x = toolEnv();
    for (const [method, path] of [["GET", "/api/images"], ["DELETE", "/api/images/1"], ["GET", "/api/saved"], ["POST", "/api/saved"], ["DELETE", "/api/saved/1"]] as const) {
      expect((await app.request(path, { method }, x)).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("research: papers and paper (OpenAlex)", () => {
  it("searches papers by title and abstract, sorted as asked, with the abstract rebuilt", async () => {
    const x = toolEnv();
    const { result } = await use(x, "papers", { query: "retrieval, augmented: generation", sort: "citations", fromYear: 2019 });
    expect(result.papers[0]).toEqual({
      id: "W1", title: "RAG (cited_by_count:desc)", year: 2020, authors: ["P. Lewis"], venue: "NeurIPS", citations: 3046,
      doi: "10.1234/w1", url: "https://doi.org/10.1234/w1", openAccess: "https://arxiv.org/pdf/W1", abstract: "Large models retrieve.",
    });
    const call = web.calls.filter((c) => c.path.startsWith("/lookup/openalex/works?")).at(-1)?.path ?? "";
    expect(new URLSearchParams(call.split("?")[1]).get("filter")).toBe("title_and_abstract.search:retrieval augmented generation,from_publication_date:2019-01-01");
  });

  it("finds one paper by DOI with who cites it, says plainly when a reference does not exist, and sends its own key", async () => {
    const x = env({ AGENT_ACCESS_KEY: KEY, LOOKUP_URL: web.lookup, OPENALEX_API_KEY: "oa-test-key" });
    const found = (await use(x, "paper", { id: "https://doi.org/10.1234/w1" })).result;
    expect(found).toMatchObject({ exists: true, id: "W1", title: "RAG", references: 60, mostCitedBy: [{ title: "A paper citing it", citations: 50 }] });
    expect(web.calls.at(-1)?.path).toContain("api_key=oa-test-key");
    const missing = (await use(x, "paper", { id: "10.9999/invented" })).result;
    expect(missing).toMatchObject({ exists: false });
    expect(missing.error).toMatch(/may be wrong or invented/);
    expect((await use(x, "paper", { id: "not a doi" })).result.error).toMatch(/give a DOI/);
  });
});

describe("skills", () => {
  const req = (x: ReturnType<typeof env>, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: auth(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, x);

  it("lists the built-in skills in the prompt, and loads one's instructions on demand", async () => {
    const x = toolEnv();
    const { result } = await use(x, "useSkill", { name: "citation-check" });
    expect(result.name).toBe("citation-check");
    expect(result.instructions).toContain("Never \"fix\" a reference");
    expect(x.asked[0]?.system).toContain("- research-brief: Answer a research question properly");
    expect((await use(x, "useSkill", { name: "nope" })).result.error).toMatch(/no skill called "nope"; the skills are: research-brief/);
  });

  it("the owner writes their own, customises a built-in, and resets it", async () => {
    const x = toolEnv();
    const mine = { description: "Review my week", instructions: "1. listNotes. 2. Say what got done." };
    expect((await req(x, "PUT", "/api/skills/weekly-review", mine)).status).toBe(200);
    expect((await req(x, "PUT", "/api/skills/daily-briefing", { description: "Short", instructions: "Weather only." })).status).toBe(200);
    const { skills } = await json(await req(x, "GET", "/api/skills"));
    expect(skills.find((s: { name: string }) => s.name === "weekly-review")).toMatchObject({ source: "owner", ...mine });
    expect(skills.find((s: { name: string }) => s.name === "daily-briefing")).toMatchObject({ source: "customised", instructions: "Weather only." });
    expect((await use(x, "useSkill", { name: "daily-briefing" })).result.instructions).toBe("Weather only.");

    expect((await req(x, "DELETE", "/api/skills/daily-briefing")).status).toBe(200);
    expect((await use(x, "useSkill", { name: "daily-briefing" })).result.instructions).toContain("`weather` for the owner's city");
    expect((await req(x, "DELETE", "/api/skills/research-brief")).status).toBe(409);
    expect((await req(x, "DELETE", "/api/skills/never-was")).status).toBe(404);
  });

  it("refuses a bad name, empty parts, or a secret in a skill", async () => {
    const x = toolEnv();
    for (const [name, body] of [
      ["Bad Name", { description: "d", instructions: "i" }],
      ["ok-name", { description: "", instructions: "i" }],
      ["ok-name", { description: "d", instructions: "x".repeat(8001) }],
    ] as const) {
      expect((await req(x, "PUT", `/api/skills/${encodeURIComponent(name)}`, body)).status, name).toBe(400);
    }
    expect((await json(await req(x, "PUT", "/api/skills/login", { description: "d", instructions: "my password is Hunter2Secret" }))).error).toBe("looks_like_secret");
  });
});
