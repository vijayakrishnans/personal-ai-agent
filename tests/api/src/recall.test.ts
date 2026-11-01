import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { byWords, cosine, decodeVector, encodeVector, fuse } from "@/recall";
import { aiStandIn, memoryObject } from "./helpers";

const facts = ["I'm from Kochi", "Allergic to peanuts", "WiFi code K7-PX-22", "Sister's birthday is 14 March", "Meeting with Rahul on Friday"];

async function keep(m: ReturnType<typeof memoryObject>) {
  for (const f of facts) await m.remember(f);
  return m;
}
const texts = (list: { text: string }[]) => list.map((x) => x.text);

describe("hybrid recall", () => {
  it("finds a memory by its meaning when no word is shared", async () => {
    const m = await keep(memoryObject(undefined, aiStandIn().AI));
    expect(texts(await m.recall("where do I live?"))[0]).toBe("I'm from Kochi");
    expect(texts(await m.recall("what food should I avoid?"))[0]).toBe("Allergic to peanuts");
    expect(texts(await m.recall("family dates"))[0]).toBe("Sister's birthday is 14 March");
  });

  it("still finds exact codes and names by their words, first", async () => {
    const m = await keep(memoryObject(undefined, aiStandIn().AI));
    expect(texts(await m.recall("K7-PX-22"))[0]).toBe("WiFi code K7-PX-22");
    expect(texts(await m.recall("Rahul"))[0]).toBe("Meeting with Rahul on Friday");
  });

  it("without Workers AI, is by words alone — and misses what is worded differently", async () => {
    const m = await keep(memoryObject());
    expect(await m.recall("where do I live?")).toEqual([]);
    expect(texts(await m.recall("peanuts"))).toEqual(["Allergic to peanuts"]);
  });

  it("is by words alone when embedding fails, and never fails itself", async () => {
    const m = await keep(memoryObject(undefined, aiStandIn().AI));
    expect(texts(await m.recall("embedfail peanuts"))).toEqual(["Allergic to peanuts"]);
  });

  it("embeds the memories kept before it existed, on the next recall", async () => {
    const db = new DatabaseSync(":memory:");
    await keep(memoryObject(db));
    const vectors = () => (db.prepare("SELECT count(*) AS n FROM memory_vectors").get() as { n: number }).n;
    expect(vectors()).toBe(0);
    const ai = aiStandIn();
    const later = memoryObject(db, ai.AI);
    expect(texts(await later.recall("where do I live?"))[0]).toBe("I'm from Kochi");
    expect(vectors()).toBe(facts.length);
    // Once embedded, only the query is embedded on the next recall.
    const n = ai.embedded.length;
    await later.recall("what food should I avoid?");
    expect(ai.embedded.slice(n)).toEqual(["what food should I avoid?"]);
  });

  it("embeds a kept answer with its question, and forgets the vector with the memory", async () => {
    const db = new DatabaseSync(":memory:");
    const ai = aiStandIn();
    const m = memoryObject(db, ai.AI);
    const kept = await m.remember("Take the 8:10 train from Ernakulam.", undefined, "How do I get to the office?");
    expect(ai.embedded.at(-1)).toBe("How do I get to the office?\nTake the 8:10 train from Ernakulam.");
    expect(texts(await m.recall("commute to work"))[0]).toBe("Take the 8:10 train from Ernakulam.");
    await m.forget(kept.id);
    expect((db.prepare("SELECT count(*) AS n FROM memory_vectors").get() as { n: number }).n).toBe(0);
  });
});

describe("the parts", () => {
  it("fuses rankings so agreement wins and either alone still counts", () => {
    // 3 is in both; 1 is first in one; 2 and 4 tie (second in one each) — the newer first.
    expect(fuse([1, 2, 3], [3, 4])).toEqual([3, 1, 4, 2]);
    expect(fuse([], [5, 6])).toEqual([5, 6]);
  });

  it("ranks by words by how many of them a memory holds", () => {
    expect(byWords(["kochi", "rain"], [{ id: 1, haystack: "kochi" }, { id: 2, haystack: "rain in kochi" }, { id: 3, haystack: "x" }])).toEqual([2, 1]);
  });

  it("keeps a vector as float32 bytes and measures nearness by cosine", () => {
    const v = [0.25, -1, 3.5];
    expect([...decodeVector(encodeVector(v))]).toEqual(v);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});
