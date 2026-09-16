import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { DEV_DEFAULT_PORT, DEV_HOST } from "./src/server/dev-config";
import { API_PROXY_KEYS } from "./src/shared/api-routes";

// R1 web build. Output goes to dist/web so the optional server-side static
// host (src/server/index.ts, off by default) can serve it.
//
// The dev server binds loopback and forwards the WHOLE API surface to the Bun
// process, not just `/__dev`. `src/web/api.ts` calls the API with relative
// paths, so without these entries a dev request lands on :5173, where Vite
// answers with the SPA HTML instead of the API's JSON envelope. The key list
// comes from `src/shared/api-routes.ts` — the same module the static host uses
// to keep the SPA fallback off API paths — so the two cannot drift, and
// `tests/integration/dev-proxy.test.ts` fails if the client starts calling a
// path that is not covered here.
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
