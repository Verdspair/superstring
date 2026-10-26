import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import http, { type Server } from "node:http";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { ContextEngine } from "../../src/server/agent/context-engine";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  type ChatMessage,
  createLmStudioClient,
  type ExternalModelRoute,
  type ModelTool,
} from "../../src/server/llm/model-gateway";
import { measureContextTokens } from "../../src/server/llm/request-format";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import { AGENT_DECISION_JSON_SCHEMA } from "../../src/shared/contracts/agent-output";

const MODEL = "cloud/protocol-fixture";
const OUTPUT = 512;
interface WireBody {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  response_format?: Record<string, unknown>;
  tools?: { function: ModelTool }[];
}
let server: Server;
let port = 0;
let route: ExternalModelRoute;
const sent: WireBody[] = [];
let rejectStrict = false;
let twoDecisions = false;
const handles: ReturnType<typeof openBusinessDb>[] = [];
beforeAll(async () => {
  server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as WireBody;
      sent.push(body);
      if (rejectStrict && body.response_format?.type === "json_schema") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unsupported response_format" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      const content =
        twoDecisions && sent.length === 1
          ? JSON.stringify({ kind: "invoke", calls: [{ name: "fixture.read", arguments: {} }] })
          : '{"kind":"none"}';
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  sent.length = 0;
  rejectStrict = false;
  twoDecisions = false;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function gateway(capacity: number) {
  route = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "synthetic-key",
    contextWindow: capacity,
    tokenizerEncoding: "cl100k_base",
    providerRevision: 1,
  };
  return createLmStudioClient(
    { baseUrl: `http://127.0.0.1:${port}/v1`, model: MODEL, timeoutSeconds: 5 },
    { externalModel: (model) => (model === MODEL ? route : null) },
  );
}
class CountingBuilder extends ContextBuilder {
  builds = 0;
  override build(input: Parameters<ContextBuilder["build"]>[0]) {
    this.builds++;
    return super.build(input);
  }
}
function fixture(capacity: number, withRead = false) {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  ensureDefaults(h.orm, MODEL);
  const session = createSession(h.orm, "synthetic", { modelName: MODEL });
  for (let index = 0; index < 3; index++) {
    const key = `history-${index}`;
    const turn = prepareTurn(
      h.orm,
      session.id,
      `archive-${index}: ` + "Prior verified context sentence. ".repeat(100),
      key,
    );
    if (!turn.generationToken) throw new Error("synthetic history token missing");
    saveCompletedAssistantMessage(
      h.orm,
      session.id,
      `history-answer-${index}`,
      key,
      turn.generationToken,
    );
  }
  const prepared = prepareTurn(
    h.orm,
    session.id,
    "current question must remain complete",
    "current",
  );
  const current = getTurnByRequest(h.orm, session.id, "current");
  if (!prepared.generationToken || !current) throw new Error("synthetic current turn missing");
  const runtime = {
    ...prepared.runtime,
    p5_config: {
      ...prepared.runtime.p5_config,
      context_window: capacity,
      max_output_tokens: OUTPUT,
      safety_margin_ratio: 0,
      compression_enabled: false,
      retrieval_mode: "off" as const,
      allocation: { mode: "auto" as const },
    },
    resolved_model_contexts: {
      [MODEL]: {
        model: MODEL,
        capacity,
        tokenizer_encoding: "cl100k_base" as const,
        route_revision: 1,
      },
    },
  };
  const client = gateway(capacity);
  const repository = new AgentRunRepository(h.db);
  const agentRuntime = createAgentRuntime({ gateway: client, repository });
  const builder = new CountingBuilder({ ...h, gateway: client });
  const source = new WebContextSource({
    ...h,
    gateway: client,
    agentRuntime,
    builder,
    runtime,
    extraActions: withRead
      ? [
          {
            description: {
              name: "fixture.read",
              capability: "fixture.read",
              effect: "read",
              description: "Read a synthetic source",
              parameters: { type: "object", properties: {} },
            },
            async execute() {
              return {
                value: { status: "ok", text: "accepted-observation-must-remain" },
                sources: [],
              };
            },
          },
        ]
      : [],
    sessionId: session.id,
    turnId: current.id,
    generationToken: prepared.generationToken,
    maxSteps: 4,
  });
  const run = () =>
    agentRuntime.run(source.spec, {
      owner: {
        kind: "web_turn",
        id: current.id,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
      },
      context: source,
      actions: source.actions,
      authorizedTargets: ["reply"],
      outputMode: "buffered",
    });
  return { h, client, source, builder, run };
}
async function cost(body: WireBody) {
  const counter = await loadTextTokenCounter("cl100k_base");
  return measureContextTokens(body.messages, counter, {
    responseFormat: body.response_format,
    tools: body.tools?.map((tool) => tool.function),
  }).textTokens;
}

it("keeps all fitting history when the actual decision format is json_object rather than a full schema envelope", async () => {
  const generous = fixture(65536);
  const baselineBudget = await generous.source.prepareModelContext(
    MODEL,
    new AbortController().signal,
  );
  if (!baselineBudget?.countText) throw new Error("real gateway tokenizer descriptor missing");
  expect(baselineBudget.model).toBe(MODEL);
  expect(baselineBudget.tokenizerEncoding).toBe("cl100k_base");
  expect(baselineBudget.routeRevision).toBe(1);
  const material = await generous.source.read({
    signal: new AbortController().signal,
    observations: [],
  });
  const rendered = new ContextEngine().render(
    generous.source.spec,
    material,
    [],
    ["reply"],
    "buffered",
  );
  const usage = generous.source.contextUsage(rendered);
  expect(usage?.model_tokens?.encoding).toBe("cl100k_base");
  expect(usage?.model_tokens?.method).toBe("serialized_chat_token_estimate");
  expect(usage?.model_tokens?.input_limit).toBe(65536 - OUTPUT);
  expect(usage?.model_tokens?.input_tokens).toBeGreaterThan(0);
  await expect(generous.run()).resolves.toMatchObject({ status: "no_output" });
  const actual = sent.at(-1);
  if (!actual) throw new Error("baseline HTTP request missing");
  expect(actual.response_format).toEqual({ type: "json_object" });
  const counter = await loadTextTokenCounter("cl100k_base");
  const actualCost = await cost(actual);
  const originalHostCost = measureContextTokens(rendered.messages, counter, {
    responseSchema: AGENT_DECISION_JSON_SCHEMA,
    tools: generous.source.spec.availableActions,
  }).textTokens;
  expect(originalHostCost).toBeGreaterThan(actualCost);
  const inputCeiling = actualCost + Math.floor((originalHostCost - actualCost) / 2);
  expect(inputCeiling).toBeGreaterThan(actualCost);
  expect(inputCeiling).toBeLessThan(originalHostCost);
  sent.length = 0;
  const near = fixture(inputCeiling + OUTPUT);
  const nearBudget = await near.source.prepareModelContext(MODEL, new AbortController().signal);
  if (!nearBudget?.countText) throw new Error("near request has no declared token counter");
  expect(nearBudget.capacity).toBe(inputCeiling + OUTPUT);
  expect(nearBudget.tokenizerEncoding).toBe("cl100k_base");
  expect(nearBudget.routeRevision).toBe(1);
  expect(nearBudget.countText("完整上下文")).toBe(counter.count("完整上下文"));
  const outcome = await near.run().then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!outcome.ok) expect(sent).toHaveLength(0);
  expect(outcome).toMatchObject({ ok: true, result: { status: "no_output" } });
  expect(sent).toHaveLength(1);
  const body = sent[0]!;
  expect(await cost(body)).toBeLessThanOrEqual(inputCeiling);
  expect(body.max_tokens).toBe(OUTPUT);
  for (let index = 0; index < 3; index++)
    expect(JSON.stringify(body.messages)).toContain(`history-answer-${index}`);
  expect(JSON.stringify(body.messages)).toContain("current question must remain complete");
});

it("refuses a real final request one measured token above its explicit input ceiling before HTTP", async () => {
  const client = gateway(65536);
  const messages: ChatMessage[] = [{ role: "user", content: "preserve this complete question" }];
  await client.complete({
    model: MODEL,
    messages,
    maxTokens: OUTPUT,
    responseSchema: AGENT_DECISION_JSON_SCHEMA,
  });
  const body = sent[0];
  if (!body) throw new Error("boundary baseline missing");
  const measured = await cost(body);
  const descriptor = await client.prepareContextModel!(MODEL);
  sent.length = 0;
  await expect(
    client.complete({
      model: MODEL,
      messages,
      maxTokens: OUTPUT,
      responseSchema: AGENT_DECISION_JSON_SCHEMA,
      contextBudget: descriptor,
      contextInputLimit: measured - 1,
    }),
  ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
  expect(sent).toHaveLength(0);
});

it("preserves frozen route authority and explicit phase output on actual protocol calls", async () => {
  const client = gateway(65536);
  const descriptor = await client.prepareContextModel!(MODEL);
  route = { ...route, providerRevision: 2 };
  await expect(
    client.complete({
      model: MODEL,
      messages: [{ role: "user", content: "p" }],
      maxTokens: OUTPUT,
      responseSchema: AGENT_DECISION_JSON_SCHEMA,
      contextBudget: descriptor,
      contextInputLimit: 4096,
    }),
  ).rejects.toThrow("上下文预算已过期");
  expect(sent).toHaveLength(0);
});

it("keeps a prepared first-attempt format across an intervening negative-cache update and still follows real fallback", async () => {
  const model = "cloud/snapshot-fixture";
  const client = createLmStudioClient(
    { baseUrl: `http://127.0.0.1:${port}/v1`, model, timeoutSeconds: 5 },
    {
      externalModel: (requested) =>
        requested === model
          ? {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              apiKey: "synthetic-key",
              contextWindow: 65536,
              tokenizerEncoding: "cl100k_base",
              providerRevision: 1,
            }
          : null,
    },
  );
  const schema = {
    type: "object",
    properties: { kind: { type: "string" } },
    required: ["kind"],
    additionalProperties: false,
  };
  if (!client.prepareRequestFormat) throw new Error("gateway format preparation missing");
  const prepared = client.prepareRequestFormat({ model, responseSchema: schema });
  expect(prepared.level).toBe("json_schema");
  await Promise.resolve();
  rejectStrict = true;
  await client.complete({
    model,
    messages: [{ role: "user", content: "intervening call" }],
    responseSchema: schema,
  });
  expect(sent.map((body) => body.response_format?.type)).toEqual(["json_schema", "json_object"]);
  sent.length = 0;
  let guards = 0;
  await client.complete({
    model,
    messages: [{ role: "user", content: "prepared call" }],
    responseSchema: schema,
    requestFormat: prepared,
    assertPreparedCurrent() {
      guards++;
    },
  });
  expect(sent.map((body) => body.response_format?.type)).toEqual(["json_schema", "json_object"]);
  expect(guards).toBe(2);
  sent.length = 0;
  await client.complete({
    model,
    messages: [{ role: "user", content: "ordinary call" }],
    responseSchema: schema,
  });
  expect(sent.map((body) => body.response_format?.type)).toEqual(["json_object"]);
});

it("uses the same actual format for a second next step without rebuilding the stored material", async () => {
  twoDecisions = true;
  const baseline = fixture(65536, true);
  await expect(baseline.run()).resolves.toMatchObject({ status: "no_output" });
  expect(sent).toHaveLength(2);
  expect(baseline.builder.builds).toBe(1);
  const second = sent[1]!;
  expect(second.response_format).toEqual({ type: "json_object" });
  expect(JSON.stringify(second.messages)).toContain("accepted-observation-must-remain");
  const counter = await loadTextTokenCounter("cl100k_base");
  const secondActual = await cost(second);
  const secondOriginal = measureContextTokens(second.messages, counter, {
    responseSchema: AGENT_DECISION_JSON_SCHEMA,
    tools: baseline.source.spec.availableActions,
  }).textTokens;
  expect(secondOriginal).toBeGreaterThan(secondActual);
  const ceiling = secondActual + Math.floor((secondOriginal - secondActual) / 2);
  expect(await cost(sent[0]!)).toBeLessThan(ceiling);
  expect(secondActual).toBeLessThan(ceiling);
  expect(secondOriginal).toBeGreaterThan(ceiling);
  sent.length = 0;
  const near = fixture(ceiling + OUTPUT, true);
  const budget = await near.source.prepareModelContext(MODEL, new AbortController().signal);
  expect(budget?.tokenizerEncoding).toBe("cl100k_base");
  expect(budget?.capacity).toBe(ceiling + OUTPUT);
  const outcome = await near.run().then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(near.builder.builds).toBe(1);
  expect(outcome).toMatchObject({ ok: true, result: { status: "no_output" } });
  expect(sent).toHaveLength(2);
  for (const body of sent) {
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(OUTPUT);
    expect(await cost(body)).toBeLessThanOrEqual(ceiling);
  }
  expect(JSON.stringify(sent[1]!.messages)).toContain("accepted-observation-must-remain");
  expect(JSON.stringify(sent[1]!.messages)).toContain("current question must remain complete");
});
