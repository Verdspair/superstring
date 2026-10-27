import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { type ContextMessage, history } from "../../src/server/db/context-repository";
import { contextDumps } from "../../src/server/db/json-text";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { estimateMessages } from "../../src/server/modules/memory-query";
import { estimateTokens } from "../../src/server/services/token-estimate";
import { runtimeFixtureBusiness } from "../harness/business-db";

describe("Web summary source metadata", () => {
  it("splits short-turn batches using the complete summary request", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), "synthetic");
    try {
      ensureDefaults(business.orm, "synthetic");
      const session = createSession(business.orm, "session", { modelName: "synthetic" });
      for (let i = 0; i < 16; i++) {
        const key = `history-${i}`;
        const turn = prepareTurn(business.orm, session.id, `u${i} ${"x".repeat(55)}`, key);
        if (!turn.generationToken) throw new Error("missing history token");
        saveCompletedAssistantMessage(business.orm, session.id, `a${i}`, key, turn.generationToken);
      }
      const active = prepareTurn(business.orm, session.id, "current", "current");
      const current = getTurnByRequest(business.orm, session.id, "current");
      if (!current || !active.generationToken) throw new Error("missing current turn");
      Object.assign(active.runtime.p5_config, {
        context_window: 8192,
        max_output_tokens: 512,
        compression_trigger_ratio: 0.1,
        recent_turns: 8,
        summary_target_tokens: 512,
        summary_max_tokens: 2048,
      });
      const calls: Array<Parameters<ModelGateway["complete"]>[0]> = [];
      const textMessages = (call: Parameters<ModelGateway["complete"]>[0]): ContextMessage[] =>
        call.messages.map((message): ContextMessage => {
          if (
            (message.role !== "system" &&
              message.role !== "user" &&
              message.role !== "assistant") ||
            typeof message.content !== "string"
          )
            throw new Error("summary wire must contain text messages");
          return { role: message.role, content: message.content };
        });
      const gateway: ModelGateway = {
        config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 30 },
        async listModels() {
          return ["synthetic"];
        },
        async loadedContextCapacity() {
          return 32768;
        },
        async probeModelLoaded() {
          return true;
        },
        async complete(call) {
          calls.push(call);
          return JSON.stringify({ facts: [] });
        },
        async *streamChat() {
          yield "unused";
        },
      };
      await new ContextBuilder({ db: business.db, orm: business.orm, gateway }).build({
        sessionId: session.id,
        currentTurnId: current.id,
        runtime: active.runtime,
        generationToken: active.generationToken,
      });
      const historical = history(
        business.orm,
        DEFAULT_AGENT_ID,
        session.id,
        Number.MAX_SAFE_INTEGER,
      ).slice(0, 8);
      expect(historical).toHaveLength(8);
      const firstCall = calls[0];
      if (!firstCall?.responseSchema) throw new Error("missing first response schema");
      const rawHistory = historical.flatMap((turn) => [
        { role: "user" as const, content: turn.user },
        { role: "assistant" as const, content: turn.assistant },
      ]);
      const rawCost = estimateMessages(rawHistory);
      const firstMessages = textMessages(firstCall);
      const firstData = JSON.parse(firstMessages[1].content) as Record<string, unknown>;
      const fullData = {
        ...firstData,
        turns: historical.map((turn) => ({
          id: turn.id,
          user: turn.user,
          assistant: turn.assistant,
          user_source: turn.userSource,
          assistant_source: turn.assistantSource,
        })),
      };
      const fullSchema = structuredClone(firstCall.responseSchema) as {
        $defs: { SummaryFact: { properties: { source_ids: Record<string, unknown> } } };
      };
      fullSchema.$defs.SummaryFact.properties.source_ids.items = {
        type: "string",
        enum: historical.map((turn) => turn.id).sort(),
      };
      fullSchema.$defs.SummaryFact.properties.source_ids.maxItems = historical.length;
      const fullCost8 =
        estimateMessages([firstMessages[0], { role: "user", content: contextDumps(fullData) }]) +
        estimateTokens(contextDumps(fullSchema));
      const mainLimit = 8192 - 512 - Math.ceil(8192 * active.runtime.p5_config.safety_margin_ratio);
      const auxiliaryLimit =
        32768 - 512 - Math.ceil(32768 * active.runtime.p5_config.safety_margin_ratio);
      const fitLimit = Math.min(Math.floor(mainLimit / 2), Math.floor(auxiliaryLimit / 3));
      expect(rawCost).toBeLessThan(fitLimit);
      expect(fullCost8).toBeGreaterThan(fitLimit);
      const batches = calls.map(
        (call) =>
          JSON.parse(textMessages(call)[1].content) as {
            turns: Array<{ id: string; user_source: unknown; assistant_source: unknown }>;
          },
      );
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.flatMap((batch) => batch.turns).length).toBeGreaterThan(1);
      for (const [index, batch] of batches.entries()) {
        expect(batch.turns.length).toBeLessThan(8);
        expect(batch.turns.every((turn) => turn.user_source && turn.assistant_source)).toBe(true);
        const call = calls[index];
        if (!call?.responseSchema) throw new Error("missing response schema");
        const fullCost =
          estimateMessages(textMessages(call)) + estimateTokens(contextDumps(call.responseSchema));
        expect(fullCost).toBeLessThanOrEqual(fitLimit);
      }
    } finally {
      business.close();
    }
  });

  it("sends the selected prepared format for its exact summary schema", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), "synthetic");
    try {
      ensureDefaults(business.orm, "synthetic");
      const session = createSession(business.orm, "session", { modelName: "synthetic" });
      for (let i = 0; i < 8; i++) {
        const key = `prepared-${i}`;
        const turn = prepareTurn(business.orm, session.id, `history ${"x".repeat(150)}`, key);
        if (!turn.generationToken) throw new Error("missing token");
        saveCompletedAssistantMessage(
          business.orm,
          session.id,
          "answer",
          key,
          turn.generationToken,
        );
      }
      const active = prepareTurn(business.orm, session.id, "current", "current");
      const current = getTurnByRequest(business.orm, session.id, "current");
      if (!current || !active.generationToken) throw new Error("missing current");
      Object.assign(active.runtime.p5_config, {
        context_window: 4096,
        max_output_tokens: 512,
        compression_trigger_ratio: 0.1,
        recent_turns: 4,
        summary_target_tokens: 512,
        summary_max_tokens: 2048,
      });
      active.runtime.resolved_model_contexts = {
        synthetic: {
          model: "synthetic",
          capacity: 8192,
          tokenizer_encoding: "cl100k_base",
          route_revision: 1,
        },
      };
      const prepared: Array<{
        schema: unknown;
        format: import("../../src/server/llm/request-format").PreparedRequestFormat;
      }> = [];
      const sent: Array<{
        responseSchema?: Record<string, unknown>;
        requestFormat?: import("../../src/server/llm/request-format").PreparedRequestFormat;
      }> = [];
      const gateway: ModelGateway = {
        config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 30 },
        async listModels() {
          return ["synthetic"];
        },
        async loadedContextCapacity() {
          return 8192;
        },
        async probeModelLoaded() {
          return true;
        },
        async prepareContextModel() {
          return {
            model: "synthetic",
            capacity: 8192,
            tokenizerEncoding: "cl100k_base",
            countText: (text) => [...text].length,
            assertCurrent() {},
          };
        },
        prepareRequestFormat(input) {
          const format = {
            level: "json_schema" as const,
            schema: input.responseSchema,
            tools: undefined,
            wireNames: new Map<string, string>(),
          };
          prepared.push({ schema: input.responseSchema, format });
          return format;
        },
        async complete(call) {
          sent.push(call);
          return JSON.stringify({ facts: [] });
        },
        async *streamChat() {
          yield "unused";
        },
      };
      await new ContextBuilder({ db: business.db, orm: business.orm, gateway }).build({
        sessionId: session.id,
        currentTurnId: current.id,
        runtime: active.runtime,
        generationToken: active.generationToken,
      });
      expect(sent.length).toBeGreaterThan(0);
      for (const call of sent) {
        const matching = prepared.find((entry) => entry.schema === call.responseSchema);
        expect(matching).toBeDefined();
        expect(call.requestFormat).toBe(matching?.format);
      }
    } finally {
      business.close();
    }
  });

  it("sends the two real actors and their independent message recording times", async () => {
    const business = runtimeFixtureBusiness(openBusinessDb(), "synthetic");
    try {
      ensureDefaults(business.orm, "synthetic");
      const session = createSession(business.orm, "session", { modelName: "synthetic" });
      const first = prepareTurn(business.orm, session.id, "old user ".repeat(160), "old");
      saveCompletedAssistantMessage(
        business.orm,
        session.id,
        "old assistant",
        "old",
        first.generationToken!,
      );
      const old = getTurnByRequest(business.orm, session.id, "old")!;
      const rows = business.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.turnId, old.id))
        .all();
      const user = rows.find((row) => row.role === "user")!;
      const assistant = rows.find((row) => row.role === "assistant")!;
      business.db
        .query("UPDATE messages SET created_at=? WHERE id=?")
        .run("2026-01-01T10:00:00Z", user.id);
      business.db
        .query("UPDATE messages SET created_at=? WHERE id=?")
        .run("2026-01-01T10:01:00Z", assistant.id);
      const recent = prepareTurn(business.orm, session.id, "recent", "recent");
      saveCompletedAssistantMessage(
        business.orm,
        session.id,
        "recent answer",
        "recent",
        recent.generationToken!,
      );
      const active = prepareTurn(business.orm, session.id, "current", "current");
      const current = getTurnByRequest(business.orm, session.id, "current")!;
      Object.assign(active.runtime.p5_config, {
        context_window: 4096,
        max_output_tokens: 512,
        compression_trigger_ratio: 0.1,
        recent_turns: 1,
        summary_target_tokens: 1024,
        summary_max_tokens: 2048,
      });
      const captured: unknown[] = [];
      const gateway: ModelGateway = {
        config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 30 },
        async listModels() {
          return ["synthetic"];
        },
        async loadedContextCapacity() {
          return 32768;
        },
        async probeModelLoaded() {
          return true;
        },
        async complete(call) {
          const input = call.messages[1]?.content;
          if (typeof input !== "string") throw new Error("missing summary JSON");
          captured.push(JSON.parse(input));
          return JSON.stringify({ facts: [] });
        },
        async *streamChat() {
          yield "unused";
        },
      };
      await new ContextBuilder({ db: business.db, orm: business.orm, gateway }).build({
        sessionId: session.id,
        currentTurnId: current.id,
        runtime: active.runtime,
        generationToken: active.generationToken!,
      });
      const wire = captured.find((value) => Array.isArray((value as { turns?: unknown }).turns)) as
        | {
            turns: Array<{
              id: string;
              user_source: { actor: { kind: string; id: string }; recorded_at: string };
              assistant_source: { actor: { kind: string; id: string }; recorded_at: string };
            }>;
          }
        | undefined;
      const turn = wire?.turns.find((value) => value.id === old.id);
      expect(turn?.user_source).toEqual({
        actor: { kind: "user", id: DEFAULT_USER_ID },
        recorded_at: "2026-01-01T10:00:00Z",
      });
      expect(turn?.assistant_source).toEqual({
        actor: { kind: "agent", id: DEFAULT_AGENT_ID },
        recorded_at: "2026-01-01T10:01:00Z",
      });
    } finally {
      business.close();
    }
  });
});
