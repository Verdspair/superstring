import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import { createLmStudioClient, type ModelTool } from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";

interface CapturedRequest {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

describe("model request shape golden wire baseline", () => {
  let server: Server;
  let port = 0;
  const captured: CapturedRequest[] = [];
  let customChatHandler: ((body: Record<string, unknown>, res: ServerResponse) => boolean) | null =
    null;

  beforeAll(async () => {
    server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const path = req.url ?? "";
        const parsedBody =
          raw.trim().length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
        captured.push({
          path,
          method: req.method ?? "GET",
          body: parsedBody,
        });

        if (path.startsWith("/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
          return;
        }

        if (path.startsWith("/v1/chat/completions")) {
          if (customChatHandler && customChatHandler(parsedBody, res)) {
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: '{"status":"ok"}' },
                },
              ],
            }),
          );
          return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("preserves frozen schema byte-for-byte and omits tools on local model calls", async () => {
    captured.length = 0;
    customChatHandler = null;

    const gateway = createLmStudioClient(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local-model",
        timeoutSeconds: 5,
        apiKey: "local-token",
      },
      {
        externalModel: () => null,
      },
    );

    const localSchema = {
      type: "object",
      properties: {
        command: { type: "string" },
        optionalNote: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    };

    const reply = await gateway.complete({
      model: "local-model",
      messages: [{ role: "user", content: "execute local" }],
      responseSchema: localSchema,
      maxTokens: 512,
    });

    expect(reply).toBe('{"status":"ok"}');
    const chatCall = captured.find((c) => c.path.startsWith("/v1/chat/completions"));
    expect(chatCall).toBeDefined();
    const body = chatCall!.body;

    expect(body.model).toBe("local-model");
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([{ role: "user", content: "execute local" }]);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "superstring_result",
        strict: true,
        schema: localSchema,
      },
    });
    // Absences
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(body.include_usage).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
  });

  it("rewrites optional properties to required nullable, and degrades oneOf directly to json_object on external calls", async () => {
    captured.length = 0;
    customChatHandler = null;

    const gateway = createLmStudioClient(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local-model",
        timeoutSeconds: 5,
        apiKey: "base-token",
      },
      {
        externalModel: (model) =>
          model === "cloud-model"
            ? {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: "cloud-key",
                contextWindow: 8192,
              }
            : null,
      },
    );

    // Part A: strict required + nullable conversion for external models
    const externalStrictSchema = {
      type: "object",
      properties: {
        requiredField: { type: "string" },
        optionalField: { type: "string" },
        optionalCount: { type: "integer" },
      },
      required: ["requiredField"],
      additionalProperties: false,
    };

    await gateway.complete({
      model: "cloud-model",
      messages: [{ role: "user", content: "strict external" }],
      responseSchema: externalStrictSchema,
    });

    const callA = captured[captured.length - 1];
    expect(callA.path).toBe("/v1/chat/completions");
    const bodyA = callA.body;
    expect(bodyA.model).toBe("cloud-model");
    expect(bodyA.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "superstring_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            requiredField: { type: "string" },
            optionalField: { type: ["string", "null"] },
            optionalCount: { type: ["integer", "null"] },
          },
          required: ["requiredField", "optionalField", "optionalCount"],
          additionalProperties: false,
        },
      },
    });
    expect(bodyA.tools).toBeUndefined();
    expect(bodyA.stream).toBeUndefined();

    // Part B: schema with oneOf starts directly at json_object with zero 400 attempts
    captured.length = 0;
    const unionSchema = {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["tool"] },
            target: { type: "string" },
          },
          required: ["kind", "target"],
        },
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["message"] } },
          required: ["kind"],
        },
      ],
    };

    await gateway.complete({
      model: "cloud-model",
      messages: [{ role: "user", content: "union external" }],
      responseSchema: unionSchema,
    });

    expect(captured).toHaveLength(1);
    const callB = captured[0];
    expect(callB.path).toBe("/v1/chat/completions");
    expect(callB.body.model).toBe("cloud-model");
    expect(callB.body.response_format).toEqual({ type: "json_object" });
    expect(callB.body.tools).toBeUndefined();
    expect(callB.body.stream).toBeUndefined();
  });

  it("aliases dotted native tool names, documents host actions, and parses reverse output", async () => {
    captured.length = 0;
    customChatHandler = (_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "ss_action_0",
                      arguments: JSON.stringify({ query: "superstring docs" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      return true;
    };

    const gateway = createLmStudioClient(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local-model",
        timeoutSeconds: 5,
        apiKey: "base-token",
      },
      {
        externalModel: (model) =>
          model === "cloud-tools"
            ? {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: "tools-key",
                contextWindow: 16384,
              }
            : null,
      },
    );

    const tools: ModelTool[] = [
      {
        name: "web.search",
        description: "Search web for facts",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "math_calc",
        description: "Evaluate math expression",
        parameters: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
      },
    ];

    const decision = await gateway.complete({
      model: "cloud-tools",
      messages: [{ role: "user", content: "search web" }],
      tools,
    });

    const chatCall = captured[captured.length - 1];
    expect(chatCall.path).toBe("/v1/chat/completions");
    const body = chatCall.body;

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "ss_action_0",
          description:
            "Search web for facts\nHost action: web.search. Use ss_action_0 for native function calls; keep the host name in JSON decisions.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "math_calc",
          description: "Evaluate math expression",
          parameters: {
            type: "object",
            properties: { expression: { type: "string" } },
            required: ["expression"],
          },
        },
      },
    ]);

    // Reverse parse verification
    expect(decision).toBe(
      '{"kind":"invoke","calls":[{"name":"web.search","arguments":{"query":"superstring docs"}}]}',
    );
  });

  it("omits tools and response schema from streamChat request bodies", async () => {
    captured.length = 0;
    customChatHandler = (_body, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write('data: {"choices":[{"delta":{"content":"streaming "},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"output"},"finish_reason":"stop"}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return true;
    };

    const gateway = createLmStudioClient(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local-model",
        timeoutSeconds: 5,
        apiKey: "base-token",
      },
      {
        externalModel: (model) =>
          model === "cloud-stream"
            ? {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: "stream-key",
                contextWindow: 8192,
              }
            : null,
      },
    );

    const chunks: string[] = [];
    for await (const delta of gateway.streamChat({
      model: "cloud-stream",
      messages: [{ role: "user", content: "stream hello" }],
      maxTokens: 64,
      temperature: 0.5,
    })) {
      chunks.push(delta);
    }

    expect(chunks).toEqual(["streaming ", "output"]);

    const chatCall = captured[captured.length - 1];
    expect(chatCall.path).toBe("/v1/chat/completions");
    const body = chatCall.body;

    expect(body.model).toBe("cloud-stream");
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([{ role: "user", content: "stream hello" }]);
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(body.include_usage).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
  });

  it("preserves system prompt and raw response schema without strict rewriting on vision calls", async () => {
    captured.length = 0;
    customChatHandler = null;

    const visionClient = createLmStudioVisionClient(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local-vision",
        timeoutSeconds: 5,
        apiKey: "local-vision-key",
      },
      undefined,
      {
        externalModel: (model) =>
          model === "cloud-vision"
            ? {
                baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: "cloud-vision-key",
              }
            : null,
      },
    );

    const visionSchema = {
      type: "object",
      properties: {
        caption: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["caption"],
      additionalProperties: false,
    };

    const reply = await visionClient.annotate({
      model: "cloud-vision",
      systemPrompt: "Follow vision instructions carefully.",
      prompt: "Describe this sample frame",
      images: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) }],
      responseSchema: visionSchema,
      maxTokens: 120,
    });

    expect(reply).toBe('{"status":"ok"}');
    const chatCall = captured[captured.length - 1];
    expect(chatCall.path).toBe("/v1/chat/completions");
    const body = chatCall.body;

    expect(body.model).toBe("cloud-vision");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(120);
    expect(body.messages).toEqual([
      { role: "system", content: "Follow vision instructions carefully." },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this sample frame" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AQIDBA==" },
          },
        ],
      },
    ]);

    // Crucial golden assertion: vision-client sends request.responseSchema directly,
    // without converting optional properties (like tags) to required/nullable.
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "superstring_result",
        strict: true,
        schema: visionSchema,
      },
    });

    expect(body.tools).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(body.include_usage).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
  });
});
