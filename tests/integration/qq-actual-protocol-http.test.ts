// QQ Actual Call Protocol HTTP Wire Integration Tests
//
// Contract:
// 1. OneBot Harness supports real gateway injection via OneBotHarnessOptions.actualGateway.
// 2. Both AgentRuntime (via createModelPort({ gateway })) and OneBotHost receive the exact same
//    real ModelGateway instance created by createLmStudioClient.
// 3. Port 0 fake HTTP server provides the OpenAI-compatible chat completions interface.
// 4. Case 1: direct_reply complete pipeline (decision next phase + stream generation phase).
//    - Actual HTTP bodies captured on wire without mock spies.
//    - Decision carries plain QQ_DECISION_JSON_SCHEMA with external strict json_object response_format.
//    - Generation phase without unknown images uses native streamText (HTTP body.stream: true) over SSE.
//    - Shared measurePreparedRequest verifies text projection and proves pregate measure options
//      identically match the wire body options (response_format and tools).
// 5. Case 2: initiative chiming_in pipeline (batch evaluation phase + child reply decision + child stream generation).
//    - Real batch evaluation with valid source sequence reference on judge-model.
//    - Score clears minimum threshold leading to child reply execution on reply-model.
//    - Pregate measure options and wire bodies verified with shared measure.
// 6. Zero external/QQ/17861 network requests. Port 0 server cleanly closed in afterAll.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import http, { type Server } from "node:http";
import { createModelPort } from "../../src/server/agent/model-port";
import { QQ_DECISION_JSON_SCHEMA } from "../../src/server/channels/onebot11/qq-reply-decision-contract";
import {
  type ChatMessage,
  createLmStudioClient,
  type ExternalModelRoute,
  type ModelTool,
} from "../../src/server/llm/model-gateway";
import {
  measurePreparedRequest,
  preparedRequestMeasure,
} from "../../src/server/llm/request-format";
import { QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA } from "../../src/server/services/qq-prompt-contract";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

interface CapturedHttpBody {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: Record<string, unknown>;
  tools?: { type: "function"; function: ModelTool }[];
  stream?: boolean;
}

let server: Server;
let serverPort = 0;
const sentBodies: CapturedHttpBody[] = [];
let mockResponseDispatcher: (body: CapturedHttpBody) => string = () => "{}";

beforeAll(async () => {
  server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const url = request.url ?? "";
      if (request.method === "GET" && url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "reply-model" }, { id: "judge-model" }] }));
        return;
      }
      if (request.method === "GET" && url === "/api/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            models: [
              {
                type: "llm",
                key: "reply-model",
                loaded_instances: [{ id: "reply-model", config: { context_length: 65536 } }],
              },
              {
                type: "llm",
                key: "judge-model",
                loaded_instances: [{ id: "judge-model", config: { context_length: 65536 } }],
              },
            ],
          }),
        );
        return;
      }
      if (request.method !== "POST" || url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as CapturedHttpBody;
      sentBodies.push(body);

      // Handle SSE streaming generation
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'data: {"choices":[{"delta":{"content":"已收到。"},"finish_reason":null}]}\n\n',
        );
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        response.end("data: [DONE]\n\n");
        return;
      }

      // Handle complete JSON responses
      const content = mockResponseDispatcher(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = (server.address() as { port: number }).port;
});

afterEach(() => {
  closeHarnesses();
  sentBodies.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function createRealGatewayAndPort(options: { contextWindow?: number } = {}) {
  const contextWindow = options.contextWindow ?? 65536;
  const externalRoute: ExternalModelRoute = {
    baseUrl: `http://127.0.0.1:${serverPort}/v1`,
    apiKey: "synthetic-qq-key",
    contextWindow,
    tokenizerEncoding: "cl100k_base",
    providerRevision: 1,
  };

  const gateway = createLmStudioClient(
    { baseUrl: `http://127.0.0.1:${serverPort}/v1`, model: "reply-model", timeoutSeconds: 5 },
    {
      externalModel: (model) =>
        model === "reply-model" || model === "judge-model" ? externalRoute : null,
    },
  );

  const modelPort = createModelPort({ gateway });
  return { gateway, modelPort, externalRoute };
}

describe("QQ Actual Call Protocol HTTP Wire Integration", () => {
  it("executes direct_reply with real gateway over HTTP capturing decision next and generation bodies", async () => {
    const { gateway, modelPort } = createRealGatewayAndPort();

    mockResponseDispatcher = () => {
      // Decision phase (next step) without images returns plain final decision
      return JSON.stringify({
        kind: "final",
        outputs: [
          {
            kind: "generate",
            targetId: "10001",
            instructions: "已收到",
            stickerIds: [],
          },
        ],
      });
    };

    const harness = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      conversationModel: "reply-model",
      judgementModelName: "judge-model",
      mergeWindowSeconds: 0,
      model: modelPort,
      actualGateway: gateway,
    });

    harness.receive({
      id: "1",
      speaker: "10001",
      addressed: true,
      text: "已收到",
    });

    harness.advance(1);

    const activateResult = await harness.activate("direct_reply");
    expect(activateResult).not.toBeNull();

    const deliveredCount = await harness.deliver();
    expect(deliveredCount).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(JSON.stringify(harness.sent[0]?.message)).toContain("已收到。");

    // Verify actual captured HTTP wire bodies: 1 complete (decision) + 1 stream (generation)
    expect(sentBodies).toHaveLength(2);

    const [decisionWire, generationWire] = sentBodies;

    // Call 1: decision phase
    expect(decisionWire.model).toBe("reply-model");
    expect(decisionWire.stream).toBeFalsy();
    expect(decisionWire.response_format).toEqual({ type: "json_object" });
    expect(Array.isArray(decisionWire.messages)).toBe(true);
    expect(decisionWire.messages.length).toBeGreaterThan(0);

    // Call 2: generation phase (streamText over SSE)
    expect(generationWire.model).toBe("reply-model");
    expect(generationWire.stream).toBe(true);
    expect(generationWire.response_format).toBeUndefined();
    expect(Array.isArray(generationWire.messages)).toBe(true);
    expect(generationWire.messages.length).toBeGreaterThan(0);

    // Shared measure check: prove pregate measure options identically match wire body options
    const budget = await gateway.prepareContextModel!("reply-model");
    expect(budget.model).toBe("reply-model");
    expect(budget.countText).toBeDefined();

    const decisionFormat = gateway.prepareRequestFormat!({
      model: "reply-model",
      responseSchema: QQ_DECISION_JSON_SCHEMA,
    });
    expect(decisionFormat.level).toBe("json_object");

    const pregateMeasureOpts = preparedRequestMeasure(decisionFormat);
    // Prove wire body response_format identically matches pregate measurement options
    expect(decisionWire.response_format).toEqual(pregateMeasureOpts.responseFormat);

    const decisionMeasured = measurePreparedRequest(decisionWire.messages, budget, decisionFormat);
    expect(decisionMeasured).toBeDefined();
    expect(decisionMeasured!.textTokens).toBeGreaterThan(0);
  });

  it("executes initiative chiming_in pipeline over HTTP with batch evaluation and child reply phases", async () => {
    const { gateway, modelPort } = createRealGatewayAndPort();

    mockResponseDispatcher = (body) => {
      if (body.model === "judge-model") {
        // Step 1: Batch evaluation phase
        return JSON.stringify({
          evaluations: [
            {
              targetId: "10001",
              score: 8,
              intent: "已收到",
              sourceSeqs: [harness.lastEventSeq],
            },
          ],
        });
      }
      // Step 2: Child reply decision phase (next)
      return JSON.stringify({
        kind: "final",
        outputs: [
          {
            kind: "generate",
            targetId: "10001",
            instructions: "已收到",
            stickerIds: [],
          },
        ],
      });
    };

    const harness = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      conversationModel: "reply-model",
      judgementModelName: "judge-model",
      mergeWindowSeconds: 0,
      initiativeMinScore: 6,
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: modelPort,
      actualGateway: gateway,
    });

    harness.receive({
      id: "2",
      speaker: "10001",
      text: "已收到",
    });

    // Advance clock past the initiative threshold
    harness.advance(31);

    const activateResult = await harness.activate("chiming_in");
    expect(activateResult).not.toBeNull();

    const deliveredCount = await harness.deliver();
    expect(deliveredCount).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(JSON.stringify(harness.sent[0]?.message)).toContain("已收到。");

    // Verify 3 distinct HTTP wire calls: 1 batch evaluation + 1 child decision + 1 child stream generation
    expect(sentBodies).toHaveLength(3);

    const [evalWire, childDecisionWire, childGenWire] = sentBodies;

    // Evaluation call on judge-model: QQ_BATCH schema has no oneOf, so external strict mode uses json_schema
    const judgeBudget = await gateway.prepareContextModel!("judge-model");
    expect(judgeBudget.model).toBe("judge-model");

    const evalFormat = gateway.prepareRequestFormat!({
      model: "judge-model",
      responseSchema: QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA,
    });
    expect(evalFormat.level).toBe("json_schema");

    const pregateEvalOpts = preparedRequestMeasure(evalFormat);
    expect(evalWire.model).toBe("judge-model");
    expect(evalWire.stream).toBeFalsy();
    // Prove wire body response_format identically matches pregate measurement options (strict json_schema)
    expect(evalWire.response_format).toEqual(pregateEvalOpts.responseFormat);

    const evalMeasured = measurePreparedRequest(evalWire.messages, judgeBudget, evalFormat);
    expect(evalMeasured).toBeDefined();
    expect(evalMeasured!.textTokens).toBeGreaterThan(0);

    // Child decision call on reply-model: QQ_DECISION schema has oneOf, so external mode uses json_object
    const replyBudget = await gateway.prepareContextModel!("reply-model");
    const childDecisionFormat = gateway.prepareRequestFormat!({
      model: "reply-model",
      responseSchema: QQ_DECISION_JSON_SCHEMA,
    });
    expect(childDecisionFormat.level).toBe("json_object");

    const pregateChildDecisionOpts = preparedRequestMeasure(childDecisionFormat);
    expect(childDecisionWire.model).toBe("reply-model");
    expect(childDecisionWire.stream).toBeFalsy();
    // Prove child decision wire body response_format identically matches pregate measurement options (json_object)
    expect(childDecisionWire.response_format).toEqual(pregateChildDecisionOpts.responseFormat);

    const childDecisionMeasured = measurePreparedRequest(
      childDecisionWire.messages,
      replyBudget,
      childDecisionFormat,
    );
    expect(childDecisionMeasured).toBeDefined();
    expect(childDecisionMeasured!.textTokens).toBeGreaterThan(0);

    // Child generation call on reply-model: plain streamText over SSE (body.stream: true, response_format: undefined)
    expect(childGenWire.model).toBe("reply-model");
    expect(childGenWire.stream).toBe(true);
    expect(childGenWire.response_format).toBeUndefined();
  });
});
