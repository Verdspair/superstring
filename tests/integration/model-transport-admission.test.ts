import { describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import { createModelPort } from "../../src/server/agent/model-port";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

const sockets = new Set<import("node:net").Socket>();
function listen(handler: http.RequestListener): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => resolve());
  });
}

const TEXT = {
  messages: [{ role: "user" as const, content: [{ kind: "text" as const, text: "hi" }] }],
};

describe("ModelPort actual-send admission", () => {
  it("charges resolved fallback provider, not requested model; preparation consumes no slot", async () => {
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const pending: Array<() => void> = [];
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local/available" }] }));
        return;
      }
      req.resume();
      req.on("end", () => {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        pending.push(() => {
          inFlight -= 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
          );
        });
      });
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/available",
        timeoutSeconds: 5,
      });
      const modelPort = createModelPort({
        gateway,
        providerConcurrency: 1,
        providerKey: (model) => model?.split("/")[0] ?? "missing",
      });
      const first = modelPort.complete({ ...TEXT, model: "local/available" });
      while (started < 1) await new Promise((resolve) => setTimeout(resolve, 1));
      let prepared = false;
      const second = modelPort.complete({
        ...TEXT,
        model: "unloaded/requested",
        prepareWithResolved: async ({ model }) => {
          expect(model).toBe("local/available");
          prepared = true;
          return {};
        },
      });
      while (!prepared) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toBe(1);
      expect(peak).toBe(1);
      pending.shift()?.();
      while (started < 2) await new Promise((resolve) => setTimeout(resolve, 1));
      pending.shift()?.();
      await Promise.all([first, second]);
      expect(peak).toBe(1);
    } finally {
      await close(server);
    }
  });
});
