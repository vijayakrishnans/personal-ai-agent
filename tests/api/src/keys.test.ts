import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "@/index";
import { seal, unseal } from "@/vault";
import { auth, env, hfStandIn, HF_TOKEN, KEY, json, webStandIn } from "./helpers";

let hf: Awaited<ReturnType<typeof hfStandIn>>;
let web: Awaited<ReturnType<typeof webStandIn>>;
beforeAll(async () => {
  hf = await hfStandIn();
  web = await webStandIn();
});
afterAll(() => {
  hf.close();
  web.close();
});

const owner = (over = {}) => env({ AGENT_ACCESS_KEY: KEY, HF_ROUTER_URL: hf.router, HF_SPACES_URL: hf.spaces, HF_MODELS: "openai/gpt-oss-120b", LOOKUP_URL: web.lookup, ...over });
const call = (x: ReturnType<typeof env>, path: string, method = "GET", body?: unknown) =>
  app.request(path, { method, headers: auth(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, x);
const ask = (x: ReturnType<typeof env>) =>
  call(x, "/api/chat", "POST", { model: "huggingface:openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });

describe("a Hugging Face token pasted in the page", () => {
  it("makes Hugging Face models work with no redeploy, and is never sent back", async () => {
    const x = owner();
    expect((await ask(x)).status).toBe(409);
    expect((await json(await call(x, "/api/models"))).hfToken).toBeNull();

    const put = await call(x, "/api/hf-token", "PUT", { token: HF_TOKEN });
    expect(put.status).toBe(200);
    const models = await call(x, "/api/models");
    const text = await models.text();
    expect(JSON.parse(text)).toMatchObject({ huggingface: true, hfToken: "app" });
    expect(text).not.toContain(HF_TOKEN);

    const n = hf.calls.length;
    const res = await ask(x);
    expect(res.status).toBe(200);
    expect(hf.calls.slice(n).every((c) => c.auth === `Bearer ${HF_TOKEN}`)).toBe(true);
  });

  it("is stored sealed, not as the token", async () => {
    const x = owner();
    await call(x, "/api/hf-token", "PUT", { token: HF_TOKEN });
    const stored = (await x.memory.getVault("hf-token")) ?? "";
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(HF_TOKEN.slice(3));
    expect(await unseal(KEY, stored)).toBe(HF_TOKEN);
  });

  it("can no longer be read once the access key changes, and says so", async () => {
    const x = owner();
    await call(x, "/api/hf-token", "PUT", { token: HF_TOKEN });
    x.AGENT_ACCESS_KEY = "a-new-access-key";
    const res = await app.request("/api/models", { headers: auth("a-new-access-key") }, x);
    expect(await json(res)).toMatchObject({ huggingface: false, hfToken: "unreadable" });
    expect(await unseal("a-new-access-key", await seal(KEY, HF_TOKEN))).toBeNull();
  });

  it("is removed", async () => {
    const x = owner();
    await call(x, "/api/hf-token", "PUT", { token: HF_TOKEN });
    expect((await call(x, "/api/hf-token", "DELETE")).status).toBe(200);
    expect((await json(await call(x, "/api/models"))).hfToken).toBeNull();
    expect((await ask(x)).status).toBe(409);
  });

  it("refuses what is not a token", async () => {
    const x = owner();
    for (const token of ["", "hello", "hf_short", `${HF_TOKEN} `.repeat(2), "sk-" + "a".repeat(40)]) {
      expect((await call(x, "/api/hf-token", "PUT", { token })).status).toBe(400);
    }
    expect(await x.memory.getVault("hf-token")).toBeNull();
  });

  it("leaves HF_TOKEN stored as a secret alone: it wins", async () => {
    const x = owner({ HF_TOKEN });
    expect((await json(await call(x, "/api/models"))).hfToken).toBe("secret");
    expect((await call(x, "/api/hf-token", "PUT", { token: "hf_" + "B".repeat(34) })).status).toBe(409);
    expect((await call(x, "/api/hf-token", "DELETE")).status).toBe(409);
  });
});

describe("an OpenAlex key pasted in the page", () => {
  const OPENALEX_KEY = "oa-StandInKey-0123456789abcdef";
  const papers = (x: ReturnType<typeof env>) =>
    app.request("/api/chat", { method: "POST", headers: auth(), body: JSON.stringify({ messages: [{ role: "user", content: `call papers {"query":"microenterprise kerala"}` }] }) }, x);
  const lastOpenAlex = () => decodeURIComponent(web.calls.filter((c) => c.path.startsWith("/lookup/openalex/works?")).at(-1)?.path ?? "");

  it("gives paper searches their own budget, with no redeploy, and is never sent back", async () => {
    const x = owner();
    await papers(x);
    expect(lastOpenAlex()).not.toContain("api_key=");

    expect((await call(x, "/api/keys/openalex", "PUT", { key: OPENALEX_KEY })).status).toBe(200);
    const text = await (await call(x, "/api/models")).text();
    expect(JSON.parse(text).keys).toEqual({ hf: null, openalex: "app" });
    expect(text).not.toContain(OPENALEX_KEY);

    await papers(x);
    expect(lastOpenAlex()).toContain(`api_key=${OPENALEX_KEY}`);
    expect(await x.memory.getVault("openalex-key")).not.toContain(OPENALEX_KEY);
  });

  it("is removed, refuses what is not a key, and leaves the secret alone", async () => {
    const x = owner();
    await call(x, "/api/keys/openalex", "PUT", { key: OPENALEX_KEY });
    expect((await call(x, "/api/keys/openalex", "DELETE")).status).toBe(200);
    expect((await json(await call(x, "/api/models"))).keys.openalex).toBeNull();
    for (const key of ["", "short", "has spaces in it, sixteen+", "<script>alert(1)</script>"]) {
      expect((await call(x, "/api/keys/openalex", "PUT", { key })).status).toBe(400);
    }
    expect((await call(x, "/api/keys/tavily", "PUT", { key: OPENALEX_KEY })).status).toBe(404);

    const s = owner({ OPENALEX_API_KEY: "from-the-secret-0000" });
    expect((await json(await call(s, "/api/models"))).keys.openalex).toBe("secret");
    expect((await call(s, "/api/keys/openalex", "PUT", { key: OPENALEX_KEY })).status).toBe(409);
  });

  it("keeps the Hugging Face token's first route working", async () => {
    const x = owner();
    expect((await call(x, "/api/keys/hf", "PUT", { key: HF_TOKEN })).status).toBe(200);
    expect((await json(await call(x, "/api/models"))).keys).toEqual({ hf: "app", openalex: null });
    expect((await call(x, "/api/hf-token", "DELETE")).status).toBe(200);
    expect((await json(await call(x, "/api/models"))).hfToken).toBeNull();
  });
});
