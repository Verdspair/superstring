import { defineConfig } from "vitest/config";

// Web component and store tests use jsdom. Tests importing bun:sqlite stay in
// tests/integration and run separately under Bun.
export default defineConfig({
  test: {
    include: ["tests/web/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    fileParallelism: false,
  },
});
