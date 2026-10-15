import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import { createModelPort } from "../../src/server/agent/model-port";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
async function fixture(rejectSchema = false) {
  const sent: Record<string, unknown>[] = [];
  const counted: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      sent.push(body);
      if (rejectSchema && (body.response_format as { type?: string })?.type === "json_schema") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "json_schema unsupported" } }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const gateway = createLmStudioClient(
    { baseUrl, model: "external", timeoutSeconds: 5 },
    {
      externalModel: () => ({
        baseUrl,
        apiKey: null,
        contextWindow: 8192,
        tokenizerEncoding: "cl100k_base",
        providerRevision: 1,
      }),
    },
  );
  const prepare = gateway.prepareContextModel;
  if (!prepare) throw new Error("Preparation unavailable");
  const prepared = await prepare("external");
  const countText = prepared.countText;
  if (!countText) throw new Error("Counter unavailable");
  const budget = {
    ...prepared,
    countText: (text: string) => {
      counted.push(text);
      return countText(text);
    },
  };
  return { gateway, budget, sent, counted };
}
const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

describe("optional final request token preflight", () => {
  test("rejects the final prepared text before HTTP and releases admission", async () => {
    const f = await fixture();
    const port = createModelPort({ gateway: f.gateway, modelCallConcurrency: 1 });
    await expect(
      port.complete({
        model: "external",
        messages: [{ role: "user", content: [{ kind: "text", text: "short" }] }],
        contextBudget: f.budget,
        contextInputLimit: 10,
        prepareWithResolved: async () => ({
          messages: [{ role: "user", content: [{ kind: "text", text: "large".repeat(1000) }] }],
        }),
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(f.sent).toHaveLength(0);
    expect(f.counted).toHaveLength(1);
    expect(JSON.parse(f.counted[0]).messages[0].content).toBe("large".repeat(1000));
    expect(port.admission?.available("external")).toBe(true);
  });
  test("counts the actual schema and tools in one complete shape", async () => {
    const f = await fixture();
    await f.gateway.complete({
      messages: [{ role: "user", content: "hi" }],
      contextBudget: f.budget,
      contextInputLimit: 8192,
      responseSchema: schema,
      tools: [
        { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } },
      ],
    });
    expect(f.sent).toHaveLength(1);
    expect(f.counted).toHaveLength(1);
    const counted = JSON.parse(f.counted[0]);
    expect(counted.messages).toEqual(f.sent[0].messages);
    expect(counted.response_format).toEqual(f.sent[0].response_format);
    expect(counted.tools).toEqual(f.sent[0].tools);
    expect(counted).not.toHaveProperty("max_tokens");
  });
  test("recounts controlled schema fallback with the actual changed format", async () => {
    const f = await fixture(true);
    await f.gateway.complete({
      messages: [{ role: "user", content: "hi" }],
      contextBudget: f.budget,
      contextInputLimit: 8192,
      responseSchema: schema,
    });
    expect(f.sent).toHaveLength(2);
    expect(f.counted).toHaveLength(2);
    expect(JSON.parse(f.counted[0]).response_format).toEqual(f.sent[0].response_format);
    expect(JSON.parse(f.counted[1]).response_format).toEqual({ type: "json_object" });
  });
  test("stream preflight refuses before HTTP", async () => {
    const f = await fixture();
    const consume = async () => {
      for await (const _text of f.gateway.streamChat({
        messages: [{ role: "user", content: "large".repeat(1000) }],
        contextBudget: f.budget,
        contextInputLimit: 10,
      })) {
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(f.sent).toHaveLength(0);
    expect(f.counted).toHaveLength(1);
  });
  test("omitting the ceiling adds no count to the existing send", async () => {
    const f = await fixture();
    expect(
      await f.gateway.complete({
        messages: [{ role: "user", content: "hi" }],
        contextBudget: f.budget,
      }),
    ).toBe("ok");
    expect(f.sent).toHaveLength(1);
    expect(f.counted).toHaveLength(0);
  });
  test("a ceiling without a matching counter refuses without HTTP", async () => {
    const f = await fixture();
    await expect(
      f.gateway.complete({ messages: [{ role: "user", content: "hi" }], contextInputLimit: 8192 }),
    ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(f.sent).toHaveLength(0);
  });
});
