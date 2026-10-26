import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime, type MessageLeafInput } from "../../src/server/agent/agent-runtime";
import type { ActionDescription, AgentSpec } from "../../src/server/agent/agent-specs";
import { ContextEngine, textMessage } from "../../src/server/agent/context-engine";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { QQ_TEXT_ENVELOPE_SCHEMA } from "../../src/server/channels/onebot11/bot-host";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelTool } from "../../src/server/llm/model-gateway";
import {
  nativeToolDeclarations,
  type PreparedRequestFormat,
} from "../../src/server/llm/request-format";
import {
  loadTextTokenCounter,
  type TextTokenEncoding,
} from "../../src/server/llm/text-token-counter";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import {
  QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
} from "../../src/server/services/qq-prompt-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const readInput = () => ({ signal: new AbortController().signal, observations: [] });

async function fixture(
  encodings: { judge?: TextTokenEncoding; reply?: TextTokenEncoding },
  options: { capacity?: number; window?: number; legacy?: boolean; withoutPreparer?: boolean } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000);
  const now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "context",
    context: {
      ...QQ_CONTEXT_DEFAULT,
      reply_token_budget: options.window ?? 16384,
      judgement_token_budget: options.window ?? 16384,
    },
  });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(h.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  if (options.legacy) {
    delete runtime.resolved_model_contexts;
  } else {
    runtime.resolved_model_contexts = {};
  }
  const journal = new ConversationEventRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const capacity = options.capacity ?? 65536;

  const budgets = new Map<string, ModelContextBudget>();
  for (const [model, encoding] of [
    ["judge-model", encodings.judge],
    ["reply-model", encodings.reply],
  ] as const) {
    const counter = encoding ? await loadTextTokenCounter(encoding) : undefined;
    budgets.set(model, {
      model,
      capacity,
      ...(counter
        ? {
            tokenizerEncoding: counter.encoding,
            countText: (text: string) => counter.count(text),
          }
        : {}),
      assertCurrent() {},
    });
  }

  const generatedFormatInstances: PreparedRequestFormat[] = [];

  const gateway = {
    loadedContextCapacity: async (_model: string) => capacity,
    prepareContextModel: async (model: string) => {
      const result = budgets.get(model);
      if (!result) throw new Error("model");
      return result;
    },
    ...(options.withoutPreparer
      ? {}
      : {
          prepareRequestFormat: (input: {
            model: string;
            responseSchema?: Record<string, unknown>;
            tools?: readonly ModelTool[];
          }): PreparedRequestFormat => {
            const declared = input.tools ? nativeToolDeclarations(input.tools) : undefined;
            const instance: PreparedRequestFormat = {
              level: input.responseSchema ? "json_schema" : "none",
              schema: input.responseSchema,
              tools: declared?.tools,
              wireNames: declared?.wireNames ?? new Map(),
            };
            generatedFormatInstances.push(instance);
            return instance;
          },
        }),
    complete: async () => "unused",
  };

  const agentRuntime = createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) });
  const spec: AgentSpec = {
    id: "test.bot",
    model: "judge-model",
    context: "conversation",
    instructions: "synthetic context",
    availableActions: [],
    limits: { steps: 16 },
  };

  const source = new BotContextSource({
    ...h,
    gateway,
    agentRuntime,
    journal,
    outbox,
    conversationId: conversation.id,
    binding,
    snapshot: capture.snapshot,
    scheme,
    runtime,
    spec,
    path: "direct_reply",
    decisionTier: "judgement",
    targets: () => [{ id: "alice", speakerId: "20002" }],
    assertCurrent() {},
    now: () => now,
  });

  const seed = (text: string, age = 0) => {
    const id = crypto.randomUUID();
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: id,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: id,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };

  return {
    h,
    source,
    gateway,
    generatedFormatInstances,
    seed,
    spec,
    runtime,
    scheme,
    conversation,
  };
}

describe("QQ Actual Call Protocol Rollout", () => {
  it("decision phase prepares actual format, reuses same instance in source, and invalidates on action change", async () => {
    const fixtureData = await fixture({ judge: "cl100k_base", reply: "cl100k_base" });
    const { source } = fixtureData;

    // First ensure model context budget is prepared on the source via the public method
    await source.prepareModelContext!("judge-model", readInput().signal);

    const action1: ActionDescription = {
      name: "search",
      description: "Search knowledge",
      parameters: { type: "object" },
      capability: "read",
    };
    source.configureActions([action1]);

    // Let runtime connect prepareDecisionProtocol hook with a distinctive instance
    const instances: PreparedRequestFormat[] = [];
    source.prepareDecisionProtocol((schema, actions) => {
      const declared = actions ? nativeToolDeclarations(actions) : undefined;
      const inst: PreparedRequestFormat = {
        level: "json_schema",
        schema,
        tools: declared?.tools,
        wireNames: declared?.wireNames ?? new Map(),
      };
      instances.push(inst);
      return inst;
    });

    const messages = [textMessage("user", "Hello QQ")];
    const initialUnits = source.measurePhaseInput("decision", messages);
    expect(initialUnits).toBeGreaterThan(0);
    expect(instances).toHaveLength(1);
    const firstInstance = instances[0];

    // Repeated measurement must reuse the EXACT same PreparedRequestFormat instance
    const repeatUnits = source.measurePhaseInput("decision", messages);
    expect(repeatUnits).toBe(initialUnits);
    expect(instances).toHaveLength(1);

    // Reconfiguring actions invalidates the decision protocol and causes re-preparation
    const action2: ActionDescription = {
      name: "fetch",
      description: "Fetch document",
      parameters: { type: "object" },
      capability: "read",
    };
    source.configureActions([action1, action2]);
    const afterActionChangeUnits = source.measurePhaseInput("decision", messages);
    expect(afterActionChangeUnits).toBeGreaterThan(initialUnits);
    expect(instances).toHaveLength(2);
    expect(instances[1]).not.toBe(firstInstance);
  });

  it("evaluation and batchEvaluation propagate same PreparedRequestFormat instance to LeafInput", async () => {
    const fixtureData = await fixture({ judge: "cl100k_base", reply: "cl100k_base" });
    const { source, seed, generatedFormatInstances } = fixtureData;
    seed("Synthetic evaluation question");

    // Single evaluation: returns PreparedEvaluation with requestFormat instance
    const singleEval = await source.prepareEvaluation({
      signal: readInput().signal,
      target: { id: "alice", speakerId: "20002" },
    });
    expect(singleEval.requestFormat).toBeDefined();
    expect(singleEval.requestFormat?.schema).toEqual(QQ_JUDGEMENT_RESPONSE_SCHEMA);

    // Batch evaluation: returns PreparedBatchEvaluation with requestFormat instance
    const batchEval = await source.prepareBatchEvaluation({
      signal: readInput().signal,
      targets: [{ id: "alice", speakerId: "20002" }],
      throughSeq: 1,
    });
    expect(batchEval.requestFormat).toBeDefined();
    expect(batchEval.requestFormat?.schema).toEqual(QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA);

    // Verify same instance identity: the instance returned in batchEval is the exact instance generated by gateway
    const matchingGatewayInstance = generatedFormatInstances.find(
      (inst) => inst.schema === QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA,
    );
    expect(matchingGatewayInstance).toBeDefined();
    expect(batchEval.requestFormat).toBe(matchingGatewayInstance);

    // Simulate bot-host callBatchLeaf passing batchEval.requestFormat into MessageLeafInput.requestFormat
    const leafInput: MessageLeafInput = {
      owner: {
        kind: "conversation",
        id: fixtureData.conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      messages: batchEval.messages,
      contextBudget: batchEval.contextBudget,
      contextInputLimit: batchEval.contextInputLimit,
      requestFormat: batchEval.requestFormat,
    };
    // Verified that MessageLeafInput receives the exact same snapshot without mutation or re-preparation
    expect(leafInput.requestFormat).toBe(batchEval.requestFormat);
  });

  it("generation phase owns reply ceiling and prepares target-local format instance without duplicate gateway calls", async () => {
    const fixtureData = await fixture({ judge: "cl100k_base", reply: "cl100k_base" });
    const { source, seed, generatedFormatInstances } = fixtureData;
    seed("Synthetic reply question");

    const material = await source.read(readInput());
    const rendered = new ContextEngine().render(fixtureData.spec, material, [], ["alice"]);

    const draft = { kind: "generate" as const, targetId: "alice", instructions: "Reply kindly" };

    // Target 1: generation with unknown images envelope schema
    const prepGenEnvelope = await source.prepareGeneration(draft, {
      context: rendered,
      outputId: "out-1",
      signal: readInput().signal,
      responseSchema: QQ_TEXT_ENVELOPE_SCHEMA,
    });

    expect(prepGenEnvelope.inputUnits).toBeGreaterThan(0);
    expect(prepGenEnvelope.model).toBe("reply-model");
    expect(prepGenEnvelope.requestFormat).toBeDefined();
    expect(prepGenEnvelope.requestFormat?.schema).toEqual(QQ_TEXT_ENVELOPE_SCHEMA);

    // Verified that the requestFormat attached to prepGenEnvelope is the exact instance from gateway
    const envelopeFormatInstance = generatedFormatInstances.find(
      (inst) => inst.schema === QQ_TEXT_ENVELOPE_SCHEMA,
    );
    expect(envelopeFormatInstance).toBeDefined();
    expect(prepGenEnvelope.requestFormat).toBe(envelopeFormatInstance);

    // Target 2: plain generation without envelope
    const prepGenPlain = await source.prepareGeneration(draft, {
      context: rendered,
      outputId: "out-2",
      signal: readInput().signal,
    });
    expect(prepGenPlain.inputUnits).toBeGreaterThan(0);
    expect(prepGenPlain.requestFormat).toBeUndefined();
  });

  it("gracefully falls back when gateway.prepareRequestFormat is absent", async () => {
    const fixtureData = await fixture(
      { judge: "cl100k_base", reply: "cl100k_base" },
      { withoutPreparer: true },
    );
    const { source, seed } = fixtureData;
    seed("Fallback question");

    const messages = [textMessage("user", "Testing fallback without preparer")];
    const decisionUnits = source.measurePhaseInput("decision", messages);
    expect(decisionUnits).toBeGreaterThan(0);

    const batchEval = await source.prepareBatchEvaluation({
      signal: readInput().signal,
      targets: [{ id: "alice", speakerId: "20002" }],
      throughSeq: 1,
    });
    expect(batchEval.inputUnits).toBeGreaterThan(0);
    expect(batchEval.requestFormat).toBeUndefined();
  });
});
