import { defineConfig } from "vitest/config";

// Web-layer tests only, run under Vitest in a Node environment. Deliberately
// scoped to tests/web and uses NO jsdom: the store is pure state and the shared
// schema is plain Zod, so no DOM is required. bun:sqlite must never be pulled
// in here (that lives in tests/integration under `bun test`).
export default defineConfig({
  test: {
    include: ["tests/web/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    fileParallelism: false,
  },
});
