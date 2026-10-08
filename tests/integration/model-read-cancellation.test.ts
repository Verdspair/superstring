import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { modelRoutes } from "../../src/server/api/models";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

async function parkedCatalog(check: (origin: string, reached: Promise<void>) => Promise<void>) {
  let received!: () => void;
  const reached = new Promise<void>((resolve) => {
    received = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((req) => {
    if (req.url === "/v1/models") received();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  try {
    await check(`http://127.0.0.1:${address.port}/v1`, reached);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("model metadata request cancellation", () => {
  for (const route of ["/local", "/capacity?model=fixture"]) {
    it(`settles ${route} when its caller cancels during the local catalog lookup`, async () => {
      const business = openBusinessDb();
      ensureDefaults(business.orm, "fixture");
      try {
        await parkedCatalog(async (origin, reached) => {
          const gateway = createLmStudioClient({
            baseUrl: origin,
            model: "fixture",
            timeoutSeconds: 1200,
          });
          const app = new Hono().route("/models", modelRoutes(business.orm, gateway));
          app.onError(() => new Response(null, { status: 499 }));
          const abort = new AbortController();
          const request = app.fetch(
            new Request(`http://localhost/models${route}`, { signal: abort.signal }),
          );
          const settled = Promise.resolve(request).then(
            () => true,
            () => true,
          );
          await reached;
          abort.abort(new Error("fixture caller cancelled"));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const promptly = await Promise.race([
            settled,
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), 500);
            }),
          ]);
          clearTimeout(timer);
          expect(promptly).toBe(true);
        });
      } finally {
        business.close();
      }
    });
  }
});
