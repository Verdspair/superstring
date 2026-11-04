import { expect, it } from "bun:test";
import http, { type Server, type ServerResponse } from "node:http";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

const model = "cloud/synthetic";
const messages = [{ role: "user" as const, content: "hello" }];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function fixture() {
  let releaseGate!: () => void;
  let localSeen!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const localRequest = new Promise<void>((resolve) => {
    localSeen = resolve;
  });
  let localModels = 0;
  let externalModels = 0;
  const externalChats: Array<{ model: string; stream?: boolean }> = [];
  const pending = new Set<ServerResponse>();
  const local = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      localModels += 1;
      pending.add(response);
      response.on("close", () => pending.delete(response));
      localSeen();
      void gate.then(() => {
        if (!response.destroyed) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "local/synthetic" }] }));
        }
      });
      return;
    }
    response.writeHead(404).end();
  });
  const external = http.createServer((request, response) => {
    if (request.url === "/v1/models") {
      externalModels += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as { model: string; stream?: boolean };
      externalChats.push(body);
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{"content":"stream answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "complete answer" } }],
          }),
        );
      }
    });
  });
  const localUrl = await listen(local);
  const externalUrl = await listen(external);
  const gateway = createLmStudioClient(
    { baseUrl: localUrl, model: "local/synthetic", timeoutSeconds: 120 },
    {
      externalModel: (name) =>
        name === model ? { baseUrl: externalUrl, apiKey: "synthetic", contextWindow: 8192 } : null,
    },
  );
  return {
    gateway,
    localRequest,
    get localModels() {
      return localModels;
    },
    get externalModels() {
      return externalModels;
    },
    externalChats,
    releaseGate,
    async close() {
      releaseGate();
      for (const response of pending) response.destroy();
      await Promise.all([close(local), close(external)]);
    },
  };
}

it("external preparation and chat do not wait for or query the local catalog", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    const work = (async () => {
      const budget = await f.gateway.prepareContextModel!(model, { signal: abort.signal });
      expect(budget.model).toBe(model);
      expect(budget.capacity).toBe(8192);
      expect(await f.gateway.complete({ model, messages, signal: abort.signal })).toBe(
        "complete answer",
      );
      let text = "";
      for await (const chunk of f.gateway.streamChat({ model, messages, signal: abort.signal }))
        text += chunk;
      expect(text).toBe("stream answer");
      return "completed";
    })();
    const outcome = await Promise.race([work, f.localRequest.then(() => "local request")]);
    expect(outcome).toBe("completed");
    expect(f.localModels).toBe(0);
    expect(f.externalModels).toBe(0);
    expect(
      f.externalChats.map(({ model: sent, stream }) => ({ model: sent, stream: stream === true })),
    ).toEqual([
      { model, stream: false },
      { model, stream: true },
    ]);
  } finally {
    abort.abort();
    await f.close();
  }
});

it("local catalog is held until the test explicitly releases it", async () => {
  const f = await fixture();
  const abort = new AbortController();
  try {
    let settled = false;
    const work = f.gateway.complete({ model: "local/synthetic", messages, signal: abort.signal });
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await f.localRequest;
    expect(f.localModels).toBe(1);
    expect(settled).toBe(false);
    f.releaseGate();
    // The local chat endpoint is intentionally absent; its failure proves the gate was released.
    await expect(work).rejects.toBeDefined();
    expect(settled).toBe(true);
  } finally {
    abort.abort();
    await f.close();
  }
});

it("preserves the exact pre-entry abort reason for all external paths", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const reason = new Error("synthetic cancellation");
    controller.abort(reason);
    await expect(f.gateway.prepareContextModel!(model, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    await expect(f.gateway.complete({ model, messages, signal: controller.signal })).rejects.toBe(
      reason,
    );
    const stream = f.gateway.streamChat({ model, messages, signal: controller.signal });
    await expect(stream.next()).rejects.toBe(reason);
    expect(f.localModels).toBe(0);
    expect(f.externalModels).toBe(0);
    expect(f.externalChats).toHaveLength(0);
  } finally {
    await f.close();
  }
});
