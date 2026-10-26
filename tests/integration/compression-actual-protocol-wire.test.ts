import { describe, expect, it } from "bun:test";
import {
  createAgentRuntime,
  type LeafAgentRuntime,
  type LeafInput,
} from "../../src/server/agent/agent-runtime";
import type { LeafAgentSpec } from "../../src/server/agent/agent-specs";
import {
  type CompressionRecord,
  ConversationCompressor,
} from "../../src/server/agent/conversation-compression";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  modelRequestFormat,
  type PreparedRequestFormat,
} from "../../src/server/llm/request-format";
import type { StructuredOutputLevel } from "../../src/server/llm/strict-json-schema";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import type { RuntimeConfig } from "../../src/shared/contracts";

const COMPRESSION_MODEL = "compress-model";
const MAIN_MODEL = "main-model";

function createRuntimeConfig(contexts: Record<string, unknown> | undefined): RuntimeConfig {
  return {
    agent_id: "agent-1",
    name: "bot",
    system_prompt: "",
    additional_instructions: "",
    model_name: MAIN_MODEL,
    temperature: 0,
    memory_consolidation_model_name: "memory-model",
    memory_consolidation_prompt: "p",
    memory_consolidation_additional_instructions: "",
    memory_retrieval_model_name: "retrieval-model",
    memory_retrieval_prompt: "p",
    memory_retrieval_additional_instructions: "",
    context_compression_model_name: COMPRESSION_MODEL,
    p5_config: {
      auxiliary_timeout_seconds: 30,
      summary_max_tokens: 2048,
      summary_target_tokens: 512,
      safety_margin_ratio: 0.1,
      compression_enabled: true,
      recent_turns: 1,
      max_output_tokens: 256,
      context_window: 8192,
    },
    resolved_model_capacities: {},
    ...(contexts === undefined ? {} : { resolved_model_contexts: contexts }),
    mode: "chat",
    config_version: 1,
  } as unknown as RuntimeConfig;
}

function records(count: number, text: string): CompressionRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `event-${index + 1}`,
    seq: index + 1,
    speaker: "member:20002",
    text: `${text}${index}`,
    sources: [{ kind: "qq_observation", id: `obs-${index + 1}`, revision: "rev" }],
  }));
}

const OWNER = {
  kind: "qq_binding",
  id: "binding-1",
  userId: "user-1",
  agentId: "agent-1",
} as const;

async function knownDescriptor(capacity: number): Promise<ModelContextBudget> {
  const counter = await loadTextTokenCounter("cl100k_base");
  return {
    model: COMPRESSION_MODEL,
    capacity,
    tokenizerEncoding: counter.encoding,
    countText: counter.count,
    assertCurrent: () => {},
  };
}

describe("compression actual protocol wire integration", () => {
  it("prepares actual wire format for compression batch and passes identical format to leaf runtime", async () => {
    const capacity = 8192;
    const descriptor = await knownDescriptor(capacity);
    const leafInputs: LeafInput[] = [];
    const formatsPrepared: { model: string; schema: unknown }[] = [];

    const gateway: Pick<
      ModelGateway,
      "loadedContextCapacity" | "prepareContextModel" | "prepareRequestFormat"
    > = {
      loadedContextCapacity: async () => capacity,
      prepareContextModel: async () => descriptor,
      prepareRequestFormat: (input: { model: string; responseSchema?: unknown }) => {
        formatsPrepared.push({ model: input.model, schema: input.responseSchema });
        return {
          level: "json_schema" as StructuredOutputLevel,
          schema: input.responseSchema,
          tools: undefined,
          wireNames: new Map<string, string>(),
        } as PreparedRequestFormat;
      },
    };

    const agentRuntime: LeafAgentRuntime = {
      completeLeaf: async (spec: LeafAgentSpec, input: LeafInput) => {
        expect(spec.id).toBe("context.compress.events");
        expect(spec.model).toBe(COMPRESSION_MODEL);
        leafInputs.push(input);
        const payload = JSON.parse(
          (input.messages as { content: string }[])[1]?.content ?? "{}",
        ) as { events?: { id: string; speaker: string }[] };
        const raw = JSON.stringify({
          facts: (payload.events ?? []).map((event) => ({
            kind: "fact",
            speaker: event.speaker,
            text: "verified summary fact",
            source_ids: [event.id],
          })),
        });
        (input.validate as (text: string) => unknown)(raw);
        return raw;
      },
      completeVisionLeaf: async () => "",
    };

    const snapshot = createRuntimeConfig({
      [COMPRESSION_MODEL]: {
        model: COMPRESSION_MODEL,
        capacity,
        tokenizer_encoding: descriptor.tokenizerEncoding,
      },
    });

    const compressor = new ConversationCompressor({
      runtime: snapshot,
      agentRuntime,
      gateway,
      owner: OWNER,
      assertSources: () => {},
    });

    const evidence = await compressor.summarize({
      records: records(3, "test conversation item "),
      target: 2048,
      signal: new AbortController().signal,
    });

    expect(evidence).not.toBeNull();
    expect(formatsPrepared.length).toBeGreaterThan(0);
    expect(formatsPrepared[0].model).toBe(COMPRESSION_MODEL);
    expect(leafInputs).toHaveLength(1);

    const leafInput = leafInputs[0];
    expect(leafInput.contextBudget).toBe(descriptor);
    expect(leafInput.requestFormat).toBeDefined();
    const passedFormat = leafInput.requestFormat as PreparedRequestFormat;
    expect(passedFormat.level).toBe("json_schema");
    expect(passedFormat.schema).toBeDefined();

    // Verify wire format matches request format helper
    const wire = modelRequestFormat(passedFormat.schema, passedFormat.level);
    expect((wire.response_format as Record<string, unknown> | undefined)?.type).toBe("json_schema");
  });

  it("ContextBuilder auxiliary compression prepares actual request format and passes it to completeLeaf", async () => {
    const capacity = 8192;
    const descriptor = await knownDescriptor(capacity);
    const h = openBusinessDb({ path: ":memory:" });
    try {
      ensureDefaults(h.orm, MAIN_MODEL);
      h.db
        .prepare("UPDATE agents SET context_compression_model_name = ? WHERE id = ?")
        .run(COMPRESSION_MODEL, DEFAULT_AGENT_ID);
      const session = createSession(h.orm, "test-user", { modelName: MAIN_MODEL });

      // Create 3 substantial previous turns to ensure budget is exceeded and compression runs
      for (let i = 0; i < 3; i++) {
        const turn = prepareTurn(
          h.orm,
          session.id,
          `User message ${i}: ` + "Historical message content with substantial tokens. ".repeat(6),
          `req-${i}`,
        );
        saveCompletedAssistantMessage(
          h.orm,
          session.id,
          `Assistant response ${i}: ` +
            "Historical reply content with substantial tokens. ".repeat(6),
          `req-${i}`,
          turn.generationToken!,
        );
      }

      const leafCalls: { spec: LeafAgentSpec; input: LeafInput }[] = [];
      const runtimeRepo = new AgentRunRepository(h.db);

      const fakeGateway: Pick<
        ModelGateway,
        "loadedContextCapacity" | "prepareContextModel" | "prepareRequestFormat"
      > = {
        loadedContextCapacity: async () => capacity,
        prepareContextModel: async () => descriptor,
        prepareRequestFormat: (input: { model: string; responseSchema?: unknown }) => {
          return {
            level: "json_schema" as StructuredOutputLevel,
            schema: input.responseSchema,
            tools: undefined,
            wireNames: new Map<string, string>(),
          } as PreparedRequestFormat;
        },
      };

      const realAgentRuntime = createAgentRuntime({
        gateway: fakeGateway as unknown as ModelGateway,
        repository: runtimeRepo,
      });

      // Intercept completeLeaf to observe requestFormat and dynamically resolve turn ID
      const originalCompleteLeaf = realAgentRuntime.completeLeaf.bind(realAgentRuntime);
      realAgentRuntime.completeLeaf = async (spec: LeafAgentSpec, input: LeafInput) => {
        leafCalls.push({ spec, input });
        if (spec.id === "context.compress") {
          const payload = JSON.parse(
            (input.messages as { content: string }[])[1]?.content ?? "{}",
          ) as {
            turns?: { id: string }[];
            previous_overview?: { facts?: { source_ids?: string[] }[] };
          };
          const turnIds = (payload.turns ?? []).map((t) => t.id);
          const previousIds = (payload.previous_overview?.facts ?? []).flatMap(
            (f) => f.source_ids ?? [],
          );
          const validId = turnIds[0] ?? previousIds[0] ?? "unknown";
          return JSON.stringify({
            facts: [
              {
                kind: "fact",
                speaker: "user",
                text: "summary fact",
                source_ids: [validId],
              },
            ],
          });
        }
        return originalCompleteLeaf(spec, input);
      };

      const builder = new ContextBuilder({
        db: h.db,
        orm: h.orm,
        gateway: fakeGateway as unknown as ModelGateway,
        agentRuntime: realAgentRuntime,
      });

      const currentPrepared = prepareTurn(h.orm, session.id, "Current question", "req-current");
      const currentTurn = getTurnByRequest(h.orm, session.id, "req-current");
      if (!currentTurn) throw new Error("current turn missing");

      const runtimeCfg: RuntimeConfig = {
        ...currentPrepared.runtime,
        model_name: MAIN_MODEL,
        context_compression_model_name: COMPRESSION_MODEL,
        p5_config: {
          ...currentPrepared.runtime.p5_config,
          compression_enabled: true,
          recent_turns: 1,
          context_window: 400, // Small context window to trigger compression
          max_output_tokens: 50,
        },
        resolved_model_contexts: {
          [MAIN_MODEL]: {
            model: MAIN_MODEL,
            capacity,
            tokenizer_encoding: "cl100k_base" as const,
          },
          [COMPRESSION_MODEL]: {
            model: COMPRESSION_MODEL,
            capacity,
            tokenizer_encoding: descriptor.tokenizerEncoding,
          },
        },
      };

      const messages = await builder.build({
        sessionId: session.id,
        currentTurnId: currentTurn.id,
        runtime: runtimeCfg,
        generationToken: currentPrepared.generationToken,
      });

      expect(messages).toBeDefined();
      expect(leafCalls.length).toBeGreaterThan(0);
      const compressLeaf = leafCalls.find((c) => c.spec.id === "context.compress");
      expect(compressLeaf).toBeDefined();
      expect(compressLeaf!.input.requestFormat).toBeDefined();
      expect(compressLeaf!.input.requestFormat?.level).toBe("json_schema");
      expect(compressLeaf!.input.contextBudget).toBe(descriptor);
    } finally {
      h.close();
    }
  });

  it("preserves prepared descriptor and requestFormat even when route declares no tokenizer counter", async () => {
    const capacity = 8192;
    let stale = false;
    const noCounterDescriptor: ModelContextBudget = {
      model: COMPRESSION_MODEL,
      capacity,
      assertCurrent: () => {
        if (stale) throw new Error("route stale");
      },
    };
    const h = openBusinessDb({ path: ":memory:" });
    try {
      ensureDefaults(h.orm, MAIN_MODEL);
      h.db
        .prepare("UPDATE agents SET context_compression_model_name = ? WHERE id = ?")
        .run(COMPRESSION_MODEL, DEFAULT_AGENT_ID);
      const session = createSession(h.orm, "test-user-nocounter", { modelName: MAIN_MODEL });

      // Create 3 substantial history turns: 3 turns ~ 2112 bytes total, which exceeds
      // limit 1390 (context_window 1600 - output 50 - margin 160) to trigger compression,
      // while mandatory recent turn + compressed summary + question fits comfortably (~1051 bytes <= 1390).
      for (let i = 0; i < 3; i++) {
        const turn = prepareTurn(
          h.orm,
          session.id,
          `History item ${i}: ` + "Historical message content with substantial tokens. ".repeat(6),
          `req-nc-${i}`,
        );
        saveCompletedAssistantMessage(
          h.orm,
          session.id,
          `Answer ${i}: ` + "Historical reply content with substantial tokens. ".repeat(6),
          `req-nc-${i}`,
          turn.generationToken!,
        );
      }

      const leafCalls: { spec: LeafAgentSpec; input: LeafInput }[] = [];
      const runtimeRepo = new AgentRunRepository(h.db);

      const fakeGateway: Pick<
        ModelGateway,
        "loadedContextCapacity" | "prepareContextModel" | "prepareRequestFormat"
      > = {
        loadedContextCapacity: async () => capacity,
        prepareContextModel: async () => noCounterDescriptor,
        prepareRequestFormat: (input: { model: string; responseSchema?: unknown }) => {
          return {
            level: "json_schema" as StructuredOutputLevel,
            schema: input.responseSchema,
            tools: undefined,
            wireNames: new Map<string, string>(),
          } as PreparedRequestFormat;
        },
      };

      const realAgentRuntime = createAgentRuntime({
        gateway: fakeGateway as unknown as ModelGateway,
        repository: runtimeRepo,
      });

      realAgentRuntime.completeLeaf = async (spec: LeafAgentSpec, input: LeafInput) => {
        leafCalls.push({ spec, input });
        if (spec.id === "context.compress") {
          const payload = JSON.parse(
            (input.messages as { content: string }[])[1]?.content ?? "{}",
          ) as {
            turns?: { id: string }[];
            previous_overview?: { facts?: { source_ids?: string[] }[] };
          };
          const turnIds = (payload.turns ?? []).map((t) => t.id);
          const previousIds = (payload.previous_overview?.facts ?? []).flatMap(
            (f) => f.source_ids ?? [],
          );
          const validId = turnIds[0] ?? previousIds[0] ?? "unknown";
          return JSON.stringify({
            facts: [
              {
                kind: "fact",
                speaker: "user",
                text: "no-counter summary fact",
                source_ids: [validId],
              },
            ],
          });
        }
        return "{}";
      };

      const builder = new ContextBuilder({
        db: h.db,
        orm: h.orm,
        gateway: fakeGateway as unknown as ModelGateway,
        agentRuntime: realAgentRuntime,
      });

      const currentPrepared = prepareTurn(h.orm, session.id, "Question", "req-nc-current");
      const currentTurn = getTurnByRequest(h.orm, session.id, "req-nc-current");
      if (!currentTurn) throw new Error("current turn missing");

      // Byte path calibration: context_window 1600 provides limit 1390 bytes.
      // 3 history turns (~2112 bytes) exceed limit -> triggers compression.
      // After compressing turns 0 & 1, turn 2 + summary + prompt + question (~1051 bytes) fits limit.
      const runtimeCfg: RuntimeConfig = {
        ...currentPrepared.runtime,
        model_name: MAIN_MODEL,
        context_compression_model_name: COMPRESSION_MODEL,
        p5_config: {
          ...currentPrepared.runtime.p5_config,
          compression_enabled: true,
          recent_turns: 1,
          context_window: 1600,
          max_output_tokens: 50,
        },
        resolved_model_contexts: {
          [MAIN_MODEL]: {
            model: MAIN_MODEL,
            capacity,
          },
          [COMPRESSION_MODEL]: {
            model: COMPRESSION_MODEL,
            capacity,
          },
        },
      };

      const messages = await builder.build({
        sessionId: session.id,
        currentTurnId: currentTurn.id,
        runtime: runtimeCfg,
        generationToken: currentPrepared.generationToken,
      });

      expect(messages).toBeDefined();
      expect(leafCalls.length).toBeGreaterThan(0);
      const compressLeaf = leafCalls.find((c) => c.spec.id === "context.compress");
      expect(compressLeaf).toBeDefined();
      expect(compressLeaf!.input.contextBudget).toBe(noCounterDescriptor);
      expect(compressLeaf!.input.requestFormat).toBeDefined();
      expect(compressLeaf!.input.requestFormat?.level).toBe("json_schema");
      // Because there is no counter declared, contextInputLimit is not set
      expect(compressLeaf!.input.contextInputLimit).toBeUndefined();

      // Complete current turn using public repository helper to release active turn lease
      saveCompletedAssistantMessage(
        h.orm,
        session.id,
        "Completed assistant answer",
        "req-nc-current",
        currentPrepared.generationToken!,
      );

      // Now verify that stale route fails closed before sending
      const leafSendsBefore = leafCalls.length;
      stale = true;
      const turnNext = prepareTurn(h.orm, session.id, "Next question after stale", "req-nc-stale");
      const turnNextRow = getTurnByRequest(h.orm, session.id, "req-nc-stale");
      if (!turnNextRow) throw new Error("next turn missing");

      const staleRuntimeCfg: RuntimeConfig = {
        ...turnNext.runtime,
        model_name: MAIN_MODEL,
        context_compression_model_name: COMPRESSION_MODEL,
        p5_config: {
          ...turnNext.runtime.p5_config,
          compression_enabled: true,
          recent_turns: 1,
          context_window: 1600,
          max_output_tokens: 50,
        },
        resolved_model_contexts: {
          [MAIN_MODEL]: {
            model: MAIN_MODEL,
            capacity,
          },
          [COMPRESSION_MODEL]: {
            model: COMPRESSION_MODEL,
            capacity,
          },
        },
      };

      await expect(
        builder.build({
          sessionId: session.id,
          currentTurnId: turnNextRow.id,
          runtime: staleRuntimeCfg,
          generationToken: turnNext.generationToken,
        }),
      ).rejects.toThrow("route stale");

      // Verify 0 additional actual leaf send occurred when route was stale
      expect(leafCalls.length).toBe(leafSendsBefore);
    } finally {
      h.close();
    }
  });
});
