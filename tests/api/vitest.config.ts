import { defineConfig } from "vitest/config";
import * as path from "node:path";

// The Worker's Durable Object extends `cloudflare:workers`' DurableObject,
// which only the Workers runtime provides. Under Node that import is a
// stand-in base class (src/stubs/cloudflare-workers.ts), and the tests hand
// the real AgentMemory a storage whose SQL is Node's own SQLite — so the
// queries the Worker ships are the queries that run here.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../apps/api/src"),
      "cloudflare:workers": path.resolve(__dirname, "src/stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
