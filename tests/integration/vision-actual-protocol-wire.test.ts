import { afterEach, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  readQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { type ChatMessage, createLmStudioClient } from "../../src/server/llm/model-gateway";
import {
  measurePreparedRequest,
  type PreparedRequestFormat,
} from "../../src/server/llm/request-format";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const h of handles.splice(0)) h.close();
});
const schema = {
  type: "object",
  properties: { text: { type: "string" }, optionalNote: { type: "string" } },
  required: ["text"],
};
const image = { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
const config = {
  baseUrl: "http://vision-protocol.invalid/v1",
  model: "synthetic",
  timeoutSeconds: 5,
};
const ok = () =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      usage: { prompt_tokens: 17 },
    }),
    { status: 200 },
  );
type Body = {
  messages: ChatMessage[];
  response_format?: { type: string; json_schema?: { schema: unknown } };
  tools?: unknown;
  max_tokens?: number;
};
const fetcher = (
  handler: (input: unknown, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect() {} });
async function budget(model: string): Promise<ModelContextBudget> {
  const counter = await loadTextTokenCounter("cl100k_base");
  return {
    model,
    capacity: 65536,
    tokenizerEncoding: counter.encoding,
    countText: counter.count,
    assertCurrent() {},
  };
}
function repository() {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  return new AgentRunRepository(h.db);
}

it("uses the original raw visual schema, not the external text strict schema, at an exact text ceiling", async () => {
  const model = "raw-visual-wire";
  const descriptor = await budget(model);
  const bodies: Body[] = [];
  const vision = createLmStudioVisionClient(
    config,
    fetcher(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      return ok();
    }),
    {
      externalModel: () => ({ baseUrl: config.baseUrl, apiKey: "synthetic" }),
    },
  );
  const format = vision.prepareRequestFormat!({ model, responseSchema: schema });
  expect(format.schema).toBe(schema);
  expect(format.tools).toBeUndefined();
  const text = createLmStudioClient(config, {
    externalModel: () => ({ baseUrl: config.baseUrl, apiKey: "synthetic", contextWindow: 65536 }),
  });
  const textFormat = text.prepareRequestFormat!({ model, responseSchema: schema });
  expect(textFormat.schema).not.toEqual(format.schema);
  const messages = [
    textMessage("system", "Keep complete evidence."),
    textMessage("user", "visual prompt"),
  ];
  const measured = measurePreparedRequest(messages, descriptor, format)!;
  const runtime = createAgentRuntime({
    repository: repository(),
    vision,
    gateway: {
      prepareRequestFormat() {
        throw new Error("text preparer must not run for vision");
      },
      async complete() {
        throw new Error("text complete must not run for vision");
      },
    },
  });
  await expect(
    runtime.completeVisionLeaf(
      {
        id: "test.vision.raw",
        instructions: "Keep complete evidence.",
        responseSchema: schema,
        maxTokens: 128,
      },
      {
        model,
        owner: { kind: "synthetic", id: model },
        prompt: "visual prompt",
        images: [image],
        contextBudget: descriptor,
        contextInputLimit: measured.textTokens,
      },
    ),
  ).resolves.toBe("ok");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.response_format?.json_schema?.schema).toEqual(schema);
  expect(bodies[0]?.tools).toBeUndefined();
  expect(bodies[0]?.max_tokens).toBe(128);
  expect(measurePreparedRequest(bodies[0]!.messages, descriptor, format)?.textTokens).toBe(
    measured.textTokens,
  );
  expect(measurePreparedRequest(bodies[0]!.messages, descriptor, format)?.mediaState).toBe(
    "unknown",
  );
});

it("keeps the caller's visual snapshot across another call's schema fallback and remeasures each actual attempt", async () => {
  const model = "visual-snapshot-cache-drift";
  const descriptor = await budget(model);
  const bodies: Body[] = [];
  const vision = createLmStudioVisionClient(
    config,
    fetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return body.response_format?.type === "json_schema"
        ? new Response("unsupported response_format", { status: 400 })
        : ok();
    }),
  );
  const format = vision.prepareRequestFormat!({ model, responseSchema: schema });
  expect(format.level).toBe("json_schema");
  await vision.annotate({
    model,
    prompt: "other logical call",
    images: [image],
    responseSchema: schema,
  });
  expect(vision.prepareRequestFormat!({ model, responseSchema: schema }).level).toBe("json_object");
  const start = bodies.length;
  const limit = measurePreparedRequest(
    [textMessage("user", "original complete prompt")],
    descriptor,
    format,
  )!.textTokens;
  const runtime = createAgentRuntime({ repository: repository(), vision });
  await expect(
    runtime.completeVisionLeaf(
      { id: "test.vision.snapshot", responseSchema: schema, maxTokens: 64 },
      {
        model,
        owner: { kind: "synthetic", id: model },
        prompt: "original complete prompt",
        images: [image],
        contextBudget: descriptor,
        contextInputLimit: limit,
        requestFormat: format,
      },
    ),
  ).resolves.toBe("ok");
  expect(bodies.slice(start).map((body) => body.response_format?.type)).toEqual([
    "json_schema",
    "json_object",
  ]);
  for (const body of bodies.slice(start)) {
    expect(body.tools).toBeUndefined();
    expect(
      measurePreparedRequest(body.messages, descriptor, {
        ...format,
        level: body.response_format?.type === "json_schema" ? "json_schema" : "json_object",
      })!.textTokens,
    ).toBeLessThanOrEqual(limit);
  }
});

it("retains the original capability epoch when schema fallback follows off then on", async () => {
  const h = createOneBotHarness();
  const binding = readQqBinding(h.orm, h.bindingId);
  if (!binding) throw new Error("synthetic binding missing");
  const guard = new QqGroupCapabilityGuard(h.orm);
  const model = "visual-prepared-epoch";
  let sends = 0;
  const vision = createLmStudioVisionClient(
    config,
    fetcher(async () => {
      sends++;
      writeQqGroupAgentConfigRow(h.orm, {
        bindingId: binding.id,
        agentId: binding.agentId,
        overrides: {},
        disabledCapabilities: ["media"],
        expectedRevision: 0,
      });
      writeQqGroupAgentConfigRow(h.orm, {
        bindingId: binding.id,
        agentId: binding.agentId,
        overrides: {},
        disabledCapabilities: [],
        expectedRevision: 1,
      });
      return new Response("unsupported response_format", { status: 400 });
    }),
  );
  const format = vision.prepareRequestFormat!({ model, responseSchema: schema });
  const runtime = createAgentRuntime({
    repository: new AgentRunRepository(h.db),
    vision,
    assertLeaf: (owner, spec) => guard.assertLeaf(owner, spec),
  });
  await expect(
    runtime.completeVisionLeaf(
      { id: "media.describe", responseSchema: schema, maxTokens: 128 },
      {
        model,
        prompt: "p",
        images: [image],
        requestFormat: format,
        owner: {
          kind: "qq_binding",
          id: binding.id,
          agentId: binding.agentId,
          userId: DEFAULT_USER_ID,
        },
      },
    ),
  ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
  expect(sends).toBe(1);
});

it("preserves source rechecks, cancellation and optional-field-free legacy visual calls", async () => {
  let sends = 0;
  let sourceCurrent = true;
  const revoked = new Error("synthetic source revoked");
  const model = "visual-legacy-source";
  const vision = createLmStudioVisionClient(
    config,
    fetcher(async () => {
      sends++;
      sourceCurrent = false;
      return sends === 1 ? new Response("unsupported response_format", { status: 400 }) : ok();
    }),
  );
  const runtime = createAgentRuntime({ repository: repository(), vision });
  await expect(
    runtime.completeVisionLeaf(
      { id: "test.vision.source", responseSchema: schema },
      {
        model,
        prompt: "p",
        images: [image],
        owner: { kind: "synthetic", id: model },
        requestFormat: vision.prepareRequestFormat!({ model, responseSchema: schema }),
        assertSources() {
          if (!sourceCurrent) throw revoked;
        },
      },
    ),
  ).rejects.toBe(revoked);
  expect(sends).toBe(1);
  const controller = new AbortController();
  const cancelled = new Error("cancelled");
  controller.abort(cancelled);
  await expect(
    vision.annotate({ model, prompt: "p", images: [image], signal: controller.signal }),
  ).rejects.toBe(cancelled);
  expect(sends).toBe(1);
  await expect(
    vision.annotate({ model: "visual-legacy-no-format", prompt: "p", images: [image] }),
  ).resolves.toBe("ok");
  expect(sends).toBe(2);
});

it("uses the generation owner's prepared snapshot rather than preparing again after its pregate", async () => {
  const model = "generation-caller-snapshot";
  const descriptor = await budget(model);
  const generationFormat: PreparedRequestFormat = Object.freeze({
    level: "json_object",
    schema,
    tools: undefined,
    wireNames: new Map<string, string>(),
  });
  let seen: PreparedRequestFormat | undefined;
  const runtime = createAgentRuntime({
    repository: repository(),
    gateway: {
      config: { ...config, model },
      async prepareContextModel() {
        return descriptor;
      },
      prepareRequestFormat(input) {
        if (input.responseSchema === schema)
          throw new Error("generation snapshot must not be replaced");
        return {
          level: "json_object",
          schema: input.responseSchema,
          tools: undefined,
          wireNames: new Map(),
        };
      },
      async complete(input) {
        if (input.responseSchema === schema) {
          seen = input.requestFormat;
          return JSON.stringify({ text: "complete answer" });
        }
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "reply", instructions: "answer", stickerIds: [] },
          ],
        });
      },
    },
  });
  const result = await runtime.run(
    {
      id: "test.generation.caller-format",
      context: "conversation",
      model,
      maxTokens: 128,
      availableActions: [],
      limits: { steps: 4, inputUnits: 64000 },
    },
    {
      owner: { kind: "synthetic", id: model },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      context: {
        async prepareModelContext() {
          return descriptor;
        },
        async read() {
          return { pending: [textMessage("user", "complete question")] };
        },
      },
      async prepareGeneration() {
        return {
          inputUnits: 64000,
          requestFormat: generationFormat,
          responseEnvelope: {
            responseSchema: schema,
            parse(raw) {
              return JSON.parse(raw) as { text: string };
            },
          },
        };
      },
    },
  );
  expect(result.status).toBe("completed");
  expect(seen).toBe(generationFormat);
});
