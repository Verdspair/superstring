import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEV_DEFAULT_PORT, DEV_HOST } from "./src/server/dev-config";
import { API_PROXY_KEYS } from "./src/shared/api-routes";
import appearanceScale from "./tools/desktop/build/appearance-scale.mjs";

// Share API prefixes with the static host so relative API calls never fall
// through to Vite's SPA response. Coverage: tests/integration/dev-proxy.test.ts.
const proxy = Object.fromEntries(
  API_PROXY_KEYS.map((key) => [
    key,
    { target: `http://${DEV_HOST}:${DEV_DEFAULT_PORT}`, changeOrigin: true },
  ]),
);

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  root: ".",
  plugins: [react(), tailwindcss()],
  // Vite's own PostCSS pass runs after @tailwindcss/vite (enforce: "pre"), so the
  // plugin sees compiled utilities, not @theme/@apply source. Coverage:
  // tests/contracts/appearance-scale.test.ts.
  css: {
    postcss: { plugins: [appearanceScale()] },
  },
  build: {
    outDir: "dist/web",
  },
  server: {
    host: DEV_HOST,
    port: 5173,
    proxy,
  },
});
