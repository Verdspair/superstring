import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import http, { type Server } from "node:http";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { textMessage } from "../../src/server/agent/context-engine";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  type ChatMessage,
  createLmStudioClient,
  type ModelTool,
} from "../../src/server/llm/model-gateway";
import {
  measureContextBytes,
  measureContextTokens,
  measurePreparedRequest,
  preparedRequestMeasure,
} from "../../src/server/llm/request-format";

interface Body {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  response_format?: Record<string, unknown>;
  tools?: { function: ModelTool }[];
  stream?: boolean;
}
let server: Server;
let port = 0;
const sent: Body[] = [];
const handles: ReturnType<typeof openBusinessDb>[] = [];
let generate = false;
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const path = request.url ?? "";
      if (request.method === "GET" && path === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "cloud/next" }, { id: "cloud/generate" }] }));
        return;
      }
      if (request.method === "GET" && path === "/api/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            models: ["cloud/next", "cloud/generate"].map((id) => ({
              type: "llm",
              key: id,
              loaded_instances: [
                { id, config: { context_length: id === "cloud/generate" ? 12000 : 8192 } },
              ],
            })),
          }),
        );
        return;
      }
      if (request.method === "GET" && path === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method !== "POST" || path !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as Body;
      sent.push(body);
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"choices":[{"delta":{"content":"complete answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
        return;
      }
      const content =
        generate && sent.length === 1
          ? JSON.stringify({
              kind: "final",
              outputs: [
                {
                  kind: "generate",
                  targetId: "reply",
                  instructions: "preserve the source",
                  stickerIds: [],
                },
              ],
            })
          : generate
            ? JSON.stringify({ text: "complete answer" })
            : JSON.stringify({ kind: "none" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  sent.length = 0;
  generate = false;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const union = {
  oneOf: [{ type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }],
};
const responseSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
function fixture() {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  const gateway = createLmStudioClient(
    { baseUrl: `http://127.0.0.1:${port}/v1`, model: "cloud/next", timeoutSeconds: 5 },
    {
      externalModel: (model) => ({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "synthetic-key",
        contextWindow: model === "cloud/generate" ? 12000 : 8192,
        tokenizerEncoding: "cl100k_base",
        providerRevision: 1,
      }),
    },
  );
  const runtime = createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) });
  return { h, gateway, runtime };
}

it("uses a caller's prepared protocol for text and message leaves without reinterpreting the schema", async () => {
  const f = fixture();
  const budget = await f.gateway.prepareContextModel!("cloud/next");
  const format = f.gateway.prepareRequestFormat!({ model: budget.model, responseSchema: union });
  expect(format.level).toBe("json_object");
  const messages = [{ role: "user" as const, content: "complete leaf input" }];
  const measured = measurePreparedRequest(messages, budget, format);
  if (!measured) throw new Error("declared counter missing");
  await expect(
    f.runtime.completeLeaf(
      { id: "test.leaf.actual", model: budget.model, responseSchema: union, maxTokens: 256 },
      {
        messages,
        owner: { kind: "synthetic", id: "leaf" },
        contextBudget: budget,
        contextInputLimit: measured.textTokens,
        requestFormat: format,
      },
    ),
  ).resolves.toBe('{"kind":"none"}');
  await expect(
    f.runtime.completeMessageLeaf(
      {
        id: "test.message-leaf.actual",
        model: budget.model,
        responseSchema: union,
        maxTokens: 256,
      },
      {
        messages: [textMessage("user", "complete leaf input")],
        owner: { kind: "synthetic", id: "message-leaf" },
        contextBudget: budget,
        contextInputLimit: measured.textTokens,
        requestFormat: format,
      },
    ),
  ).resolves.toBe('{"kind":"none"}');
  expect(sent).toHaveLength(2);
  for (const body of sent) {
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(256);
    expect(measurePreparedRequest(body.messages, budget, format)?.textTokens).toBe(
      measured.textTokens,
    );
  }
});

it("prepares an actual leaf format when the caller supplies only the model budget", async () => {
  const f = fixture();
  const budget = await f.gateway.prepareContextModel!("cloud/next");
  const format = f.gateway.prepareRequestFormat!({ model: budget.model, responseSchema: union });
  const messages = [{ role: "user" as const, content: "leaf without caller format" }];
  const measured = measurePreparedRequest(messages, budget, format);
  if (!measured) throw new Error("counter missing");
  await expect(
    f.runtime.completeLeaf(
      {
        id: "test.leaf.runtime-format",
        model: budget.model,
        responseSchema: union,
        maxTokens: 256,
      },
      {
        messages,
        owner: { kind: "synthetic", id: "runtime-format" },
        contextBudget: budget,
        contextInputLimit: measured.textTokens,
      },
    ),
  ).resolves.toBe('{"kind":"none"}');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.response_format).toEqual({ type: "json_object" });
});

it("gives structured generation its own model, output, ceiling and actual response format", async () => {
  generate = true;
  const f = fixture();
  const nextBudget = await f.gateway.prepareContextModel!("cloud/next");
  const generationBudget = await f.gateway.prepareContextModel!("cloud/generate");
  const generationCeiling = generationBudget.capacity! - 700;
  const result = await f.runtime.run(
    {
      id: "test.own-generation",
      context: "conversation",
      model: nextBudget.model,
      instructions: "Use authorized evidence",
      maxTokens: 300,
      availableActions: [],
      limits: { steps: 4, inputUnits: 8192 - 300 },
    },
    {
      owner: { kind: "synthetic", id: "generation" },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      context: {
        async prepareModelContext(model) {
          return model === generationBudget.model ? generationBudget : nextBudget;
        },
        async read() {
          return { pending: [textMessage("user", "current generation question")] };
        },
      },
      async prepareGeneration() {
        return {
          model: generationBudget.model,
          maxTokens: 700,
          inputUnits: generationCeiling,
          responseEnvelope: {
            responseSchema,
            parse(raw) {
              return JSON.parse(raw) as { text: string };
            },
          },
        };
      },
    },
  );
  expect(result.status).toBe("completed");
  expect(sent).toHaveLength(2);
  expect(sent[0]?.model).toBe(nextBudget.model);
  expect(sent[0]?.max_tokens).toBe(300);
  expect(sent[1]?.model).toBe(generationBudget.model);
  expect(sent[1]?.max_tokens).toBe(700);
  expect(sent[1]?.response_format?.type).toBe("json_schema");
  const format = f.gateway.prepareRequestFormat!({ model: generationBudget.model, responseSchema });
  expect(
    measurePreparedRequest(sent[1]!.messages, generationBudget, format)?.textTokens,
  ).toBeLessThanOrEqual(generationCeiling);
  expect(JSON.stringify(sent[1]?.messages)).toContain("current generation question");
});

it("does not add schema or tool protocol to an ordinary generation stream", async () => {
  generate = true;
  const f = fixture();
  const budget = await f.gateway.prepareContextModel!("cloud/next");
  const result = await f.runtime.run(
    {
      id: "test.stream.actual",
      context: "conversation",
      model: budget.model,
      maxTokens: 300,
      availableActions: [],
      limits: { steps: 4, inputUnits: 8192 - 300 },
    },
    {
      owner: { kind: "synthetic", id: "stream" },
      authorizedTargets: ["reply"],
      outputMode: "stream",
      context: {
        async prepareModelContext() {
          return budget;
        },
        async read() {
          return { pending: [textMessage("user", "stream question")] };
        },
      },
      async prepareGeneration() {
        return { maxTokens: 500, inputUnits: 8192 - 500 };
      },
    },
  );
  expect(result.status).toBe("completed");
  expect(sent).toHaveLength(2);
  expect(sent[1]?.stream).toBe(true);
  expect(sent[1]?.response_format).toBeUndefined();
  expect(sent[1]?.tools).toBeUndefined();
  expect(sent[1]?.max_tokens).toBe(500);
});

it("keeps an unchanged generation model and output on its existing request ceiling", async () => {
  generate = true;
  const f = fixture();
  const budget = await f.gateway.prepareContextModel!("cloud/next");
  const ceiling = 8192 - 300;
  const result = await f.runtime.run(
    {
      id: "test.unchanged-generation",
      context: "conversation",
      model: budget.model,
      maxTokens: 300,
      availableActions: [],
      limits: { steps: 4, inputUnits: ceiling },
      generation: { model: budget.model, maxTokens: 300 },
    },
    {
      owner: { kind: "synthetic", id: "unchanged-generation" },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      context: {
        async prepareModelContext() {
          return budget;
        },
        async read() {
          return { pending: [textMessage("user", "unchanged phase question")] };
        },
      },
      async prepareGeneration() {
        return {
          responseEnvelope: {
            responseSchema,
            parse(raw) {
              return JSON.parse(raw) as { text: string };
            },
          },
        };
      },
    },
  );
  expect(result.status).toBe("completed");
  expect(sent).toHaveLength(2);
  expect(sent[1]?.model).toBe(budget.model);
  expect(sent[1]?.max_tokens).toBe(300);
  const format = f.gateway.prepareRequestFormat!({ model: budget.model, responseSchema });
  expect(measurePreparedRequest(sent[1]!.messages, budget, format)?.textTokens).toBeLessThanOrEqual(
    ceiling,
  );
});

it("checks an independent full-protocol byte cap even when token capacity fits", async () => {
  const f = fixture();
  const budget = await f.gateway.prepareContextModel!("cloud/next");
  const format = f.gateway.prepareRequestFormat!({ model: budget.model, responseSchema: union });
  const messages = [{ role: "user" as const, content: "完整中文问题".repeat(60) }];
  const protocol = preparedRequestMeasure(format);
  const bytes = measureContextBytes(messages, protocol);
  const measured = measurePreparedRequest(messages, budget, format)!;
  expect(bytes).toBeGreaterThan(measured.textTokens);
  let serialized = "";
  measureContextTokens(
    messages,
    {
      encoding: "cl100k_base",
      count(value) {
        serialized = value;
        return 1;
      },
    },
    protocol,
  );
  expect(bytes).toBe(Buffer.byteLength(serialized, "utf8"));
  const input = {
    messages,
    owner: { kind: "synthetic", id: "byte-cap" },
    contextBudget: budget,
    contextInputLimit: 7900,
    requestFormat: format,
  };
  await expect(
    f.runtime.completeLeaf(
      {
        id: "test.byte.reject",
        model: budget.model,
        responseSchema: union,
        maxTokens: 256,
        limits: { inputBytes: bytes - 1 },
      },
      input,
    ),
  ).rejects.toMatchObject({ code: "AGENT_CONTEXT_LIMIT" });
  expect(sent).toHaveLength(0);
  await expect(
    f.runtime.completeLeaf(
      {
        id: "test.byte.boundary",
        model: budget.model,
        responseSchema: union,
        maxTokens: 256,
        limits: { inputBytes: bytes },
      },
      input,
    ),
  ).resolves.toBe('{"kind":"none"}');
  expect(sent).toHaveLength(1);
});

it("carries an explicit byte cap to the complete generation protocol without widening it", async () => {
  generate = true;
  const f = fixture();
  const budget = await f.gateway.prepareContextModel!("cloud/next");
  const largeSchema = { ...responseSchema, description: "retained protocol metadata ".repeat(400) };
  const spec = {
    id: "test.generation.byte",
    context: "conversation" as const,
    model: budget.model,
    maxTokens: 300,
    availableActions: [],
    limits: { steps: 4, inputUnits: 8192 - 300 },
  };
  const input = {
    owner: { kind: "synthetic", id: "generation-byte" },
    authorizedTargets: ["reply"],
    outputMode: "buffered" as const,
    context: {
      async prepareModelContext() {
        return budget;
      },
      async read() {
        return { pending: [textMessage("user", "complete current question")] };
      },
    },
    async prepareGeneration() {
      return {
        responseEnvelope: {
          responseSchema: largeSchema,
          parse(raw: string) {
            return JSON.parse(raw) as { text: string };
          },
        },
      };
    },
  };
  await expect(f.runtime.run(spec, input)).resolves.toMatchObject({ status: "completed" });
  expect(sent).toHaveLength(2);
  const nextBytes = measureContextBytes(sent[0]!.messages, {
    responseFormat: sent[0]!.response_format,
  });
  const generationBytes = measureContextBytes(sent[1]!.messages, {
    responseFormat: sent[1]!.response_format,
  });
  expect(generationBytes).toBeGreaterThan(nextBytes);
  const nextFormatType = sent[0]?.response_format?.type;
  sent.length = 0;
  await expect(
    f.runtime.run({ ...spec, limits: { ...spec.limits, inputBytes: generationBytes - 1 } }, input),
  ).rejects.toMatchObject({
    code: "AGENT_OUTPUT_FAILED",
    message: "No output could be prepared",
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.response_format?.type).toBe(nextFormatType);
});
