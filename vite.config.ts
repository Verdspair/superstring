import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEV_DEFAULT_PORT, DEV_HOST } from "./src/server/dev-config";
import { API_PROXY_KEYS } from "./src/shared/api-routes";

// Share API prefixes with the static host so relative API calls never fall
// through to Vite's SPA response. Coverage: tests/integration/dev-proxy.test.ts.
const proxy = Object.fromEntries(
  API_PROXY_KEYS.map((key) => [
    key,
    { target: `http://${DEV_HOST}:${DEV_DEFAULT_PORT}`, changeOrigin: true },
  ]),
);

export default defineConfig({
  root: ".",
  plugins: [react()],
  build: {
    outDir: "dist/web",
  },
  server: {
    host: DEV_HOST,
    port: 5173,
    proxy,
  },
});
