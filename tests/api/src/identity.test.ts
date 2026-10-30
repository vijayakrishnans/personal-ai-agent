import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The agent's name is ONE literal line the Orun bootstrap rewrites to the
// product's name when it creates a product. Its shape is the contract, not
// its value, so a renamed product passes this as the baseline does.
describe("the name seam (apps/api/src/identity.ts)", () => {
  it("is one literal, double-quoted API_NAME line, and the exported value matches it", async () => {
    const src = readFileSync(resolve(__dirname, "../../../apps/api/src/identity.ts"), "utf8");
    const lines = src.split("\n").filter((l) => /API_NAME =/.test(l));
    expect(lines).toHaveLength(1);
    const m = /^export const API_NAME = (".*")$/.exec(lines[0] ?? "");
    expect(m).not.toBeNull();
    const literal = JSON.parse(m?.[1] ?? '""') as string;
    expect(literal.trim()).not.toBe("");
    const { API_NAME } = await import("@/identity");
    expect(API_NAME).toBe(literal);
  });
});
