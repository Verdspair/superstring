import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Web component and store tests use jsdom. Tests importing bun:sqlite stay in
// tests/integration and run separately under Bun.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  test: {
    include: ["tests/web/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./tests/web/setup.ts"],
    fileParallelism: false,
  },
});
