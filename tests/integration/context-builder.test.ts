// R4 context-builder integration tests and
// No live model is called.

import { describe, expect, it, spyOn } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { evidenceCatalogEntry } from "../../src/server/agent/built-in-actions";
import { ContextEngine } from "../../src/server/agent/context-engine";
import {
  ContextBuilder,
  type ContextDiagnostic,
  contextKeywords,
  estimateMessages,
  estimateTokens,
  SELECTION_JSON_SCHEMA,
  SUMMARY_RESULT_JSON_SCHEMA,
  validateContextIds,
} from "../../src/server/agent/conversation-context";
import { createApp } from "../../src/server/app";
import { WebChannel } from "../../src/server/channels/web-channel";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  catalog,
  catalogFingerprint,
  history,
  memoryBodies,
  summaries,
  systemPrompt,
} from "../../src/server/db/context-repository";
import { contextDumps } from "../../src/server/db/json-text";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { correctMemory, memoryContent } from "../../src/server/db/memory-content-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  deleteMessage,
  ensureDefaults,
  getTurnByRequest,
  immediate,
  listMessages,
  nowIso,
  type Orm,
  prepareTurn,
  saveCompletedAssistantMessage,
  saveFailedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { SqliteKnowledgeModule } from "../../src/server/modules/knowledge-module";
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { unicodeStrip } from "../../src/server/services/text";
import {
  DEFAULT_MEMORY_CONSOLIDATION_PROMPT,
  DEFAULT_MEMORY_RETRIEVAL_PROMPT,
} from "../../src/shared/contracts";
import type { Evidence, SourceRef } from "../../src/shared/contracts/evidence";

const MODEL = "qwen/qwen3-4b-2507";

type CompleteCall = Parameters<ModelGateway["complete"]>[0];

class ContextGateway implements ModelGateway {
  readonly config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  readonly completeCalls: CompleteCall[] = [];
  readonly streamCalls: Array<Parameters<ModelGateway["streamChat"]>[0]> = [];
  capacity = 32768;
  capacityCalls = 0;
  onCapacity?: (call: number) => void;
  completeReply?: (call: CompleteCall) => string;
  streamDeltas = ["完成"];

  async listModels(): Promise<string[]> {
    return [MODEL];
  }

  async loadedContextCapacity(
    _model?: string,
    _options?: { signal?: AbortSignal },
  ): Promise<number | null> {
    this.capacityCalls += 1;
    this.onCapacity?.(this.capacityCalls);
    return this.capacity;
  }

  async probeModelLoaded(): Promise<boolean> {
    return true;
  }

  async complete(call: CompleteCall): Promise<string> {
    this.completeCalls.push(call);
    const firstContent = call.messages[0]?.content;
    if (
      typeof firstContent === "string" &&
      firstContent.includes("Return exactly one JSON decision")
    )
      return JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
      });
    if (this.completeReply) return this.completeReply(call);
    const title = String(call.responseSchema?.title ?? "");
    if (title === "Selection") {
      const ids = ((call.responseSchema?.properties as Record<string, unknown>)?.ids ?? {}) as {
        items?: { enum?: string[] };
        maxItems?: number;
      };
      return JSON.stringify({ ids: (ids.items?.enum ?? []).slice(0, ids.maxItems ?? 0) });
    }
    return JSON.stringify({ facts: [] });
  }

  async *streamChat(call: Parameters<ModelGateway["streamChat"]>[0]): AsyncGenerator<string> {
    this.streamCalls.push(call);
    for (const delta of this.streamDeltas) yield delta;
  }
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const gateway = new ContextGateway();
  return { business, orm: business.orm, gateway };
}

type Setup = ReturnType<typeof setup>;

function newSession(orm: Orm, title = "会话"): string {
  return createSession(orm, title, { modelName: MODEL }).id;
}

function completedTurn(
  orm: Orm,
  sessionId: string,
  key: string,
  user = "用户消息",
  assistant = "助手回复",
) {
  const prepared = prepareTurn(orm, sessionId, user, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  saveCompletedAssistantMessage(orm, sessionId, assistant, key, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return turn;
}

function activeTurn(orm: Orm, sessionId: string, key: string, user = "当前问题") {
  const prepared = prepareTurn(orm, sessionId, user, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  const userMessage = orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, prepared.messageId))
    .get();
  if (!userMessage) throw new Error("current user message missing");
  return { prepared, turn, sequenceNo: userMessage.sequenceNo };
}

function seedMemory(orm: Orm, turnId: string, index: number, body = `正文${index}`): string {
  const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  if (!turn) throw new Error("source turn missing");
  const messages = orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turnId))
    .all();
  const user = messages.find((item) => item.role === "user");
  const assistant = messages.find((item) => item.role === "assistant");
  if (!user || !assistant) throw new Error("source pair missing");
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: index === 1 ? "Qwen Straße" : `记忆${index}`,
      summary: `摘要${index}`,
      tags: JSON.stringify([`标签${index}`]),
      kinds: JSON.stringify(["semantic"]),
      body,
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    })
    .run();
  return id;
}

function builder(ctx: Setup): ContextBuilder {
  return new ContextBuilder({ orm: ctx.orm, db: ctx.business.db, gateway: ctx.gateway });
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect((caught as { code?: string })?.code).toBe(code);
}

describe("tool-first initial context", () => {
  for (const mode of [
    "off",
    "conservative",
    "standard",
    "broad",
    "full_catalog",
    "full_body",
  ] as const) {
    it(`never prefetches memory or knowledge or runs a selector in ${mode}`, async () => {
      const ctx = setup();
      const memoryQuery = spyOn(SqliteMemoryModule.prototype, "query");
      const knowledgeQuery = spyOn(SqliteKnowledgeModule.prototype, "query");
      try {
        const sessionId = newSession(ctx.orm);
        const previous = completedTurn(ctx.orm, sessionId, "prefetch-source");
        seedMemory(ctx.orm, previous.id, 1, "unread memory body");
        const repository = new KnowledgeRepository(ctx.business.db);
        const document = repository.importDocument({
          category_id: "default",
          name: "unread document",
          original_text: "unread knowledge body",
        });
        repository.replaceGrants(document.id, document.revision, [DEFAULT_AGENT_ID]);
        const current = activeTurn(ctx.orm, sessionId, "prefetch-now", "qwen strasse");
        const runtime = structuredClone(current.prepared.runtime);
        runtime.p5_config.retrieval_mode = mode;
        runtime.p5_config.compression_enabled = false;
        let sources: SourceRef[] = [];
        const result = await builder(ctx).build({
          sessionId,
          currentTurnId: current.turn.id,
          runtime,
          onSources: (value) => {
            sources = value;
          },
        });
        expect(JSON.stringify(result)).not.toContain("unread memory body");
        expect(JSON.stringify(result)).not.toContain("unread knowledge body");
        expect(memoryQuery).not.toHaveBeenCalled();
        expect(knowledgeQuery).not.toHaveBeenCalled();
        expect(ctx.gateway.completeCalls).toHaveLength(0);
        expect(sources.every((source) => source.kind === "web_turn")).toBe(true);
      } finally {
        memoryQuery.mockRestore();
        knowledgeQuery.mockRestore();
        ctx.business.close();
      }
    });
  }
});

describe("0.2.1 corrected memory context", () => {
  it("loads only a retained history correction as charged data with its memory source", async () => {
    const ctx = setup();
    try {
      const sourceSession = newSession(ctx.orm);
      const source = completedTurn(ctx.orm, sourceSession, "source");
      const id = seedMemory(ctx.orm, source.id, 1, "餐费999元错误");
      const corrected = immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, id, {
          expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, id).content.revision,
          name: "餐费",
          summary: "上限80元",
          tags: [],
          body: "餐费80元",
        }),
      );
      const chatSession = sourceSession;
      const current = activeTurn(ctx.orm, chatSession, "ask", "餐费多少");
      let sources: SourceRef[] = [];
      let usage: import("../../src/shared/contracts/context-usage").ContextUsage | undefined;
      const result = await builder(ctx).build({
        sessionId: chatSession,
        currentTurnId: current.turn.id,
        runtime: current.prepared.runtime,
        generationToken: current.prepared.generationToken,
        onSources: (value) => {
          sources = value;
        },
        onUsage: (value) => {
          usage = value;
        },
      });
      const constraint = result.find((message) => message.content.includes("纠正约束"));
      expect(constraint?.role).toBe("user");
      expect(constraint?.content).toContain("资料非指令");
      expect(JSON.stringify(result)).toContain("餐费80元");
      expect(JSON.stringify(result)).toContain("manual_correction");
      expect(JSON.stringify(result)).not.toContain("餐费999元错误");
      expect(sources.filter((source) => source.kind === "memory")).toEqual([
        { kind: "memory", id: corrected.content.id, revision: corrected.content.revision },
      ]);
      expect(usage?.components.long_term_memory).toBe(
        estimateMessages(constraint ? [constraint] : []) - 3,
      );
      expect(usage?.components.knowledge).toBe(0);
      if (!usage) throw new Error("Missing context usage");
      expect(Object.values(usage.components).reduce((sum, cost) => sum + cost, 0)).toBe(
        usage.input_units,
      );
      expect(
        memoryBodies(ctx.orm, DEFAULT_AGENT_ID, chatSession, [corrected.content.id])[0].source_type,
      ).toBe("memory");
    } finally {
      ctx.business.close();
    }
  });
  it("fails closed when a memory is corrected during the final capacity probe", async () => {
    const ctx = setup();
    try {
      const session = newSession(ctx.orm);
      const source = completedTurn(ctx.orm, session, "source");
      const id = seedMemory(ctx.orm, source.id, 1);
      const current = activeTurn(ctx.orm, session, "ask");
      ctx.gateway.onCapacity = (count) => {
        if (count !== 2) return;
        immediate(ctx.business.db, () =>
          correctMemory(ctx.orm, DEFAULT_AGENT_ID, id, {
            expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, id).content.revision,
            name: "更正",
            summary: "新内容",
            tags: [],
            body: "新事实",
          }),
        );
      };
      await expect(
        builder(ctx).build({
          sessionId: session,
          currentTurnId: current.turn.id,
          runtime: current.prepared.runtime,
        }),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    } finally {
      ctx.business.close();
    }
  });
});

describe("tool-first context checkpoints", () => {
  for (const change of [
    "new correction",
    "replace correction",
    "suppress correction",
    "history body",
    "current question",
  ] as const) {
    it(`rejects ${change} after the context has been built`, async () => {
      const ctx = setup();
      try {
        const sessionId = newSession(ctx.orm);
        const old = completedTurn(ctx.orm, sessionId, "checkpoint-old");
        let memoryId = seedMemory(ctx.orm, old.id, 1, "wrong");
        const correct = () =>
          immediate(ctx.business.db, () =>
            correctMemory(ctx.orm, DEFAULT_AGENT_ID, memoryId, {
              expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, memoryId).content
                .revision,
              name: "corrected",
              summary: "corrected",
              tags: [],
              body: "right",
            }),
          );
        if (change === "replace correction" || change === "suppress correction")
          memoryId = correct().content.id;
        const current = activeTurn(ctx.orm, sessionId, "checkpoint-now");
        const context = builder(ctx);
        await context.build({
          sessionId,
          currentTurnId: current.turn.id,
          runtime: current.prepared.runtime,
        });
        expect(() => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
        if (change === "new correction" || change === "replace correction") correct();
        else if (change === "suppress correction")
          ctx.orm
            .update(schema.memoryEntries)
            .set({ status: "suppressed" })
            .where(eq(schema.memoryEntries.id, memoryId))
            .run();
        else
          ctx.business.db
            .query("UPDATE messages SET content='changed' WHERE turn_id=? AND role='user'")
            .run(change === "history body" ? old.id : current.turn.id);
        expectCode(
          () => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID),
          "CONTEXT_SOURCE_INVALID",
        );
      } finally {
        ctx.business.close();
      }
    });
  }
  it("fails rather than omitting an oversized correction while retaining its historical error", async () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const old = completedTurn(ctx.orm, sessionId, "oversized-old", "old incorrect claim");
      const id = seedMemory(ctx.orm, old.id, 1, "old incorrect claim");
      immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, id, {
          expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, id).content.revision,
          name: "correction",
          summary: "right",
          tags: [],
          body: "correct ".repeat(900),
        }),
      );
      const current = activeTurn(ctx.orm, sessionId, "oversized-now");
      const runtime = structuredClone(current.prepared.runtime);
      Object.assign(runtime.p5_config, {
        context_window: 4096,
        max_output_tokens: 512,
        compression_enabled: false,
      });
      const context = builder(ctx);
      await expect(
        context.build({ sessionId, currentTurnId: current.turn.id, runtime }),
      ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
      expectCode(
        () => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID),
        "CONTEXT_SOURCE_INVALID",
      );
    } finally {
      ctx.business.close();
    }
  });
  it("ignores unread corrections in another session and revoked unread knowledge", async () => {
    const ctx = setup();
    try {
      const elsewhere = newSession(ctx.orm);
      const old = completedTurn(ctx.orm, elsewhere, "unread-source");
      const memoryId = seedMemory(ctx.orm, old.id, 1, "unread wrong");
      const sessionId = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, sessionId, "unread-now");
      const repository = new KnowledgeRepository(ctx.business.db);
      const document = repository.importDocument({
        category_id: "default",
        name: "unread",
        original_text: "unread knowledge",
      });
      repository.replaceGrants(document.id, document.revision, [DEFAULT_AGENT_ID]);
      const context = builder(ctx);
      let sources: SourceRef[] = [];
      const messages = await context.build({
        sessionId,
        currentTurnId: current.turn.id,
        runtime: current.prepared.runtime,
        onSources: (value) => {
          sources = value;
        },
      });
      immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, memoryId, {
          expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, memoryId).content.revision,
          name: "unread correction",
          summary: "elsewhere",
          tags: [],
          body: "unread right",
        }),
      );
      repository.replaceGrants(document.id, repository.detail(document.id).revision, []);
      expect(() => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      expect(sources.map((source) => [source.kind, source.id])).toEqual([
        ["web_turn", current.turn.id],
      ]);
      expect(JSON.stringify(messages)).not.toContain("unread");
      expectCode(
        () => context.assertCurrent(current.turn.id, "foreign-agent"),
        "CONTEXT_SOURCE_INVALID",
      );
      expectCode(
        () => context.assertCurrent("missing-turn", DEFAULT_AGENT_ID),
        "CONTEXT_SOURCE_INVALID",
      );
    } finally {
      ctx.business.close();
    }
  });
});

describe("0.2.1 disabled memory isolation", () => {
  it("neither loads nor tracks an existing correction when memory is off", async () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const old = completedTurn(ctx.orm, sessionId, "off-old");
      const id = seedMemory(ctx.orm, old.id, 1, "wrong");
      const correction = immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, id, {
          expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, id).content.revision,
          name: "correction",
          summary: "correct",
          tags: [],
          body: "existing correction body",
        }),
      );
      const current = activeTurn(ctx.orm, sessionId, "off-now");
      current.prepared.runtime.p5_config.retrieval_mode = "off";
      const context = builder(ctx);
      let sources: SourceRef[] = [];
      let usage: import("../../src/shared/contracts/context-usage").ContextUsage | undefined;
      const messages = await context.build({
        sessionId,
        currentTurnId: current.turn.id,
        runtime: current.prepared.runtime,
        onSources: (value) => {
          sources = value;
        },
        onUsage: (value) => {
          usage = value;
        },
      });
      expect(JSON.stringify(messages)).not.toContain("existing correction body");
      expect(sources.every((source) => source.kind === "web_turn")).toBe(true);
      expect(usage?.components.long_term_memory).toBe(0);
      ctx.orm
        .update(schema.memoryEntries)
        .set({ status: "suppressed" })
        .where(eq(schema.memoryEntries.id, correction.content.id))
        .run();
      expect(() => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
    } finally {
      ctx.business.close();
    }
  });
  it("does not fail an off-mode request when an unrelated correction changes", async () => {
    const ctx = setup();
    try {
      const session = newSession(ctx.orm);
      const source = completedTurn(ctx.orm, session, "source");
      const id = seedMemory(ctx.orm, source.id, 1, "旧错误");
      const current = activeTurn(ctx.orm, session, "ask");
      current.prepared.runtime.p5_config.retrieval_mode = "off";
      ctx.gateway.onCapacity = (count) => {
        if (count !== 2) return;
        immediate(ctx.business.db, () =>
          correctMemory(ctx.orm, DEFAULT_AGENT_ID, id, {
            expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, id).content.revision,
            name: "更正",
            summary: "新内容",
            tags: [],
            body: "未授权本轮读取的纠正",
          }),
        );
      };
      const result = await builder(ctx).build({
        sessionId: session,
        currentTurnId: current.turn.id,
        runtime: current.prepared.runtime,
      });
      expect(JSON.stringify(result)).not.toContain("未授权本轮读取的纠正");
      expect(ctx.gateway.completeCalls).toHaveLength(0);
    } finally {
      ctx.business.close();
    }
  });
});

describe("0.2.1 corrected summary lifecycle", () => {
  for (const keepFact of [true, false]) {
    it(`tracks only retained raw turns and nonempty summary dependencies (facts=${keepFact})`, async () => {
      const ctx = setup();
      try {
        const sessionId = newSession(ctx.orm);
        const old = completedTurn(ctx.orm, sessionId, "dependency-old", "old claim ".repeat(160));
        const memoryId = seedMemory(ctx.orm, old.id, 1, "wrong old claim");
        const recent = completedTurn(ctx.orm, sessionId, "dependency-recent");
        const current = activeTurn(ctx.orm, sessionId, "dependency-now");
        const runtime = structuredClone(current.prepared.runtime);
        Object.assign(runtime.p5_config, {
          context_window: 4096,
          max_output_tokens: 512,
          compression_trigger_ratio: 0.1,
          recent_turns: 1,
          summary_target_tokens: 1024,
          summary_max_tokens: 2048,
        });
        const correct = () =>
          immediate(ctx.business.db, () =>
            correctMemory(ctx.orm, DEFAULT_AGENT_ID, memoryId, {
              expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, memoryId).content
                .revision,
              name: "correction",
              summary: "right",
              tags: [],
              body: "corrected old claim",
            }),
          );
        const corrected = correct();
        ctx.gateway.completeReply = (call) => {
          const replyRaw = call.messages[1].content;
          if (typeof replyRaw !== "string") throw new Error("text content expected");
          const data = JSON.parse(replyRaw) as { turns: { id: string }[] };
          return JSON.stringify({
            facts: keepFact
              ? [
                  {
                    kind: "fact",
                    speaker: "user",
                    text: "corrected old claim",
                    source_ids: [data.turns[0].id],
                  },
                ]
              : [],
          });
        };
        const context = builder(ctx);
        let sources: SourceRef[] = [];
        const messages = await context.build({
          sessionId,
          currentTurnId: current.turn.id,
          runtime,
          onSources: (value) => {
            sources = value;
          },
        });
        expect(
          sources
            .filter((source) => source.kind === "web_turn")
            .map((source) => source.id)
            .sort(),
        ).toEqual([current.turn.id, recent.id, ...(keepFact ? [old.id] : [])].sort());
        expect(sources.filter((source) => source.kind === "memory")).toEqual(
          keepFact
            ? [{ kind: "memory", id: corrected.content.id, revision: corrected.content.revision }]
            : [],
        );
        expect(JSON.stringify(messages).includes("纠正约束")).toBe(keepFact);
        expect(JSON.stringify(messages)).not.toContain("wrong old claim");
        immediate(ctx.business.db, () =>
          correctMemory(ctx.orm, DEFAULT_AGENT_ID, corrected.content.id, {
            expected_revision: corrected.content.revision,
            name: "new correction",
            summary: "new",
            tags: [],
            body: "new correction body",
          }),
        );
        if (keepFact)
          expectCode(
            () => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID),
            "CONTEXT_SOURCE_INVALID",
          );
        else expect(() => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      } finally {
        ctx.business.close();
      }
    });
  }
  it("invalidates the old summary, supplies correction to regeneration and never reuses it in off mode", async () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const old = completedTurn(ctx.orm, sessionId, "old", "餐费999元".repeat(80));
      const id = seedMemory(ctx.orm, old.id, 1, "餐费999元");
      completedTurn(ctx.orm, sessionId, "recent");
      const current = activeTurn(ctx.orm, sessionId, "now");
      const runtime = {
        ...current.prepared.runtime,
        p5_config: {
          ...current.prepared.runtime.p5_config,
          context_window: 4096,
          max_output_tokens: 512,
          retrieval_mode: "standard" as const,
          compression_trigger_ratio: 0.1,
          recent_turns: 1,
          summary_target_tokens: 1024,
          summary_max_tokens: 2048,
        },
      };
      ctx.gateway.completeReply = (call) => {
        if (call.responseSchema?.title !== "SummaryResult") return JSON.stringify({ ids: [] });
        const summaryRaw = call.messages[1].content;
        if (typeof summaryRaw !== "string") throw new Error("text content expected");
        const data = JSON.parse(summaryRaw) as {
          turns: Array<{ id: string }>;
          manual_corrections: Array<{ body: string }>;
        };
        return JSON.stringify({
          facts: [
            {
              kind: "fact",
              speaker: "user",
              text: data.manual_corrections[0]?.body ?? "餐费999元",
              source_ids: [data.turns[0].id],
            },
          ],
        });
      };
      await builder(ctx).build({ sessionId, currentTurnId: current.turn.id, runtime });
      const previous = ctx.orm.select().from(schema.sessionSummaries).all();
      expect(previous).toHaveLength(1);
      immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, id, {
          expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, id).content.revision,
          name: "餐费",
          summary: "更正80元",
          tags: [],
          body: "用户后来纠正餐费80元",
        }),
      );
      expect(
        ctx.orm
          .select()
          .from(schema.sessionSummaries)
          .where(eq(schema.sessionSummaries.id, previous[0].id))
          .get()?.isValid,
      ).toBe(0);
      const rebuilt = await builder(ctx).build({
        sessionId,
        currentTurnId: current.turn.id,
        runtime,
      });
      expect(rebuilt.some((message) => message.content.includes("用户后来纠正餐费80元"))).toBe(
        true,
      );
      const turns = history(ctx.orm, DEFAULT_AGENT_ID, sessionId, current.sequenceNo);
      expect(summaries(ctx.orm, DEFAULT_AGENT_ID, sessionId, turns, true)).toHaveLength(1);
      expect(summaries(ctx.orm, DEFAULT_AGENT_ID, sessionId, turns, false)).toHaveLength(0);
      ctx.gateway.completeCalls.length = 0;
      await builder(ctx).build({
        sessionId,
        currentTurnId: current.turn.id,
        runtime: { ...runtime, p5_config: { ...runtime.p5_config, retrieval_mode: "off" } },
      });
      const call = ctx.gateway.completeCalls.find(
        (item) => item.responseSchema?.title === "SummaryResult",
      );
      const callRaw = call?.messages[1].content ?? "{}";
      expect(JSON.parse(typeof callRaw === "string" ? callRaw : "{}").manual_corrections).toEqual(
        [],
      );
    } finally {
      ctx.business.close();
    }
  });
});

describe("R4 pure context contract", () => {
  it("counts UTF-8 bytes and message overhead exactly like the contract", () => {
    expect(estimateTokens("A中😀")).toBe(8);
    expect(estimateMessages([{ role: "user", content: "中" }])).toBe(22);
  });

  it("sorts object keys recursively while preserving arrays", () => {
    expect(contextDumps({ z: [{ b: 2, a: 1 }], a: 0 })).toBe('{"a":0,"z":[{"a":1,"b":2}]}');
  });

  it("matches the contract's casefold keyword results, including ß, long-s and ligatures", () => {
    expect(contextKeywords("Straße STRASSE")).toEqual(["strasse"]);
    expect(contextKeywords("ﬀoo ſystem ẞ")).toEqual(["ffoo", "system", "ss"]);
    expect(contextKeywords("İstanbul Σςσ ＡＢＣ")).toEqual(["stanbul"]);
    expect(contextKeywords("中文测试")).toEqual(["中文测试"]);
  });

  it("splits long CJK terms into adjacent bigrams and caps at 24 unique items", () => {
    expect(contextKeywords("中华人民共和国")).toEqual([
      "中华",
      "华人",
      "人民",
      "民共",
      "共和",
      "和国",
    ]);
    expect(
      contextKeywords(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")),
    ).toHaveLength(24);
  });

  it("rejects duplicate, unauthorized and over-limit model selections", () => {
    expectCode(() => validateContextIds(["a", "a"], ["a"]), "CONTEXT_INVALID_SELECTION");
    expectCode(() => validateContextIds(["b"], ["a"]), "CONTEXT_INVALID_SELECTION");
    expectCode(() => validateContextIds(["a", "b"], ["a", "b"], 1), "CONTEXT_INVALID_SELECTION");
  });

  it("freezes the exact auxiliary JSON-schema shapes", () => {
    expect(SELECTION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(SELECTION_JSON_SCHEMA.required).toEqual(["ids"]);
    expect(SUMMARY_RESULT_JSON_SCHEMA.$defs.SummaryFact.properties.kind.pattern).toBe(
      "^(fact|decision|todo|uncertainty)$",
    );
    expect(SUMMARY_RESULT_JSON_SCHEMA.$defs.SummaryFact.properties.source_ids.minItems).toBe(1);
  });

  it("uses the contract's strip semantics for final model answers", () => {
    expect(unicodeStrip("\u0085回答\u001c")).toBe("回答");
    expect(unicodeStrip("\ufeff回答\ufeff")).toBe("\ufeff回答\ufeff");
  });
});

describe("R4 context repository authorization", () => {
  it("returns ordered complete history and rejects foreign ids", () => {
    const { orm } = setup();
    const sessionId = newSession(orm);
    const first = completedTurn(orm, sessionId, "h1", "一", "答一");
    const second = completedTurn(orm, sessionId, "h2", "二", "答二");
    const current = activeTurn(orm, sessionId, "h3");
    expect(
      history(orm, DEFAULT_AGENT_ID, sessionId, current.sequenceNo).map((item) => item.id),
    ).toEqual([first.id, second.id]);
    // `history()` delegates the explicit-id authorization check to
    // memory_repository.turns(), whose source code is `MEMORY_SOURCE_INVALID`.
    // The context-layer `CONTEXT_SOURCE_INVALID` is reserved for later
    // revalidation failures during a build.
    expectCode(
      () => history(orm, DEFAULT_AGENT_ID, sessionId, current.sequenceNo, [crypto.randomUUID()]),
      "MEMORY_SOURCE_INVALID",
    );
  });

  it("searches memory metadata/body case-insensitively and returns metadata only", () => {
    const { orm } = setup();
    const sessionId = newSession(orm);
    const source = completedTurn(orm, sessionId, "m1");
    const id = seedMemory(orm, source.id, 1, "偏好正文");
    const rows = catalog(orm, DEFAULT_AGENT_ID, sessionId, { keywords: ["qwen", "strasse"] });
    expect(rows.map((item) => item.id)).toEqual([id]);
    expect(rows[0].body).toBeUndefined();
    expect(memoryBodies(orm, DEFAULT_AGENT_ID, sessionId, [id])[0].body).toBe("偏好正文");
  });

  it("changes the catalog fingerprint for metadata/status, not for the body alone", () => {
    const { orm } = setup();
    const sessionId = newSession(orm);
    const source = completedTurn(orm, sessionId, "f1");
    const id = seedMemory(orm, source.id, 1, "正文A");
    const before = catalogFingerprint(orm, DEFAULT_AGENT_ID, sessionId);
    orm
      .update(schema.memoryEntries)
      .set({ body: "正文B" })
      .where(eq(schema.memoryEntries.id, id))
      .run();
    expect(catalogFingerprint(orm, DEFAULT_AGENT_ID, sessionId)).toBe(before);
    orm
      .update(schema.memoryEntries)
      .set({ summary: "新摘要" })
      .where(eq(schema.memoryEntries.id, id))
      .run();
    expect(catalogFingerprint(orm, DEFAULT_AGENT_ID, sessionId)).not.toBe(before);
  });

  it("batched source integrity fails closed on context-valid loss, message deletion and retirement", () => {
    const { orm } = setup();
    const sessionId = newSession(orm);
    const keepTurn = completedTurn(orm, sessionId, "k1");
    const keepId = seedMemory(orm, keepTurn.id, 2);
    const sourceValidTurn = completedTurn(orm, sessionId, "s1");
    const sourceValidId = seedMemory(orm, sourceValidTurn.id, 3);
    const contextValidTurn = completedTurn(orm, sessionId, "c1");
    const contextValidId = seedMemory(orm, contextValidTurn.id, 4);
    const messageTurn = completedTurn(orm, sessionId, "m1");
    const messageId = seedMemory(orm, messageTurn.id, 5);
    const retireTurn = completedTurn(orm, sessionId, "r1");
    const retireId = seedMemory(orm, retireTurn.id, 6);
    expect(new Set(catalog(orm, DEFAULT_AGENT_ID, sessionId).map((item) => item.id))).toEqual(
      new Set([keepId, sourceValidId, contextValidId, messageId, retireId]),
    );
    orm
      .update(schema.turns)
      .set({ sourceValid: 0 })
      .where(eq(schema.turns.id, sourceValidTurn.id))
      .run();
    orm
      .update(schema.turns)
      .set({ contextValid: 0 })
      .where(eq(schema.turns.id, contextValidTurn.id))
      .run();
    const assistant = orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, messageTurn.id))
      .all()
      .find((message) => message.role === "assistant");
    if (!assistant) throw new Error("assistant message missing");
    deleteMessage(orm, sessionId, assistant.id);
    orm
      .update(schema.memoryEntries)
      .set({ configSnapshot: JSON.stringify({ correction_retired: true }) })
      .where(eq(schema.memoryEntries.id, retireId))
      .run();
    expect(new Set(catalog(orm, DEFAULT_AGENT_ID, sessionId).map((item) => item.id))).toEqual(
      new Set([keepId]),
    );
    const fingerprint = catalogFingerprint(orm, DEFAULT_AGENT_ID, sessionId);
    orm
      .update(schema.turns)
      .set({ contextValid: 1 })
      .where(eq(schema.turns.id, contextValidTurn.id))
      .run();
    expect(catalogFingerprint(orm, DEFAULT_AGENT_ID, sessionId)).not.toBe(fingerprint);
  });

  it("does not leak another agent's session identity through a cross-agent chat source", () => {
    const { orm } = setup();
    const sessionId = newSession(orm);
    const turn = completedTurn(orm, sessionId, "x1", "跨Agent机密", "跨Agent回复");
    const memoryId = seedMemory(orm, turn.id, 7);
    const other = crypto.randomUUID();
    orm
      .insert(schema.agents)
      .values({
        id: other,
        name: "other",
        systemPrompt: "",
        description: "",
        additionalInstructions: "",
        p5Config: "{}",
        modelName: MODEL,
        temperature: 0.7,
        memoryConsolidationModelName: null,
        memoryConsolidationPrompt: DEFAULT_MEMORY_CONSOLIDATION_PROMPT,
        memoryConsolidationAdditionalInstructions: "",
        memoryRetrievalModelName: null,
        memoryRetrievalPrompt: DEFAULT_MEMORY_RETRIEVAL_PROMPT,
        contextCompressionModelName: null,
        personaIntensity: 60,
        isActive: 1,
        configVersion: 1,
        updatedAt: nowIso(),
        createdAt: nowIso(),
      })
      .run();
    orm.insert(schema.agentKnowledgeReadSettings).values({ agentId: other }).run();
    orm
      .insert(schema.agentPersonas)
      .values({
        id: crypto.randomUUID(),
        agentId: other,
        coreIdentity: "",
        communicationStyle: "",
        interactionBoundaries: "",
        exampleDialogues: "",
        advancedInstructions: "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const foreignSessionId = createSession(orm, "foreign", {
      agentId: other,
      modelName: MODEL,
    }).id;
    const foreignTurn = completedTurn(
      orm,
      foreignSessionId,
      "f1",
      "private-secret",
      "foreign-reply",
    );
    orm
      .update(schema.memorySources)
      .set({ turnId: foreignTurn.id })
      .where(eq(schema.memorySources.memoryId, memoryId))
      .run();
    const detail = memoryContent(orm, DEFAULT_AGENT_ID, memoryId);
    const chat = detail.content.sources.find((source) => source.type === "chat");
    if (!chat || chat.type !== "chat") throw new Error("chat source missing");
    expect(chat.session_id).toBeNull();
    expect(detail.source_messages[0]?.session_title).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("private-secret");
    expect(detail.content.validity).toBe("invalid");
  });

  it("compiles only non-empty system prompt sections", () => {
    const { orm } = setup();
    const sessionId = newSession(orm);
    const current = activeTurn(orm, sessionId, "s1");
    const runtime = {
      ...current.prepared.runtime,
      system_prompt: "角色",
      additional_instructions: "额外",
    };
    expect(systemPrompt(runtime)).toEqual([
      { role: "system", content: "角色\n\n## 基础额外指令\n额外" },
    ]);
  });
});

describe("R4 ContextBuilder end-to-end", () => {
  it("recompresses injected summaries to the independent reading cap without truncating stored summaries", async () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      for (let i = 0; i < 4; i++)
        completedTurn(ctx.orm, sessionId, `read-${i}`, "x".repeat(600), "y".repeat(100));
      const current = activeTurn(ctx.orm, sessionId, "read-now");
      const runtime = {
        ...current.prepared.runtime,
        p5_config: {
          ...current.prepared.runtime.p5_config,
          context_window: 8192,
          max_output_tokens: 512,
          compression_trigger_ratio: 0.1,
          recent_turns: 1,
          summary_target_tokens: 1024,
          summary_max_tokens: 4096,
          summary_read_max_tokens: 500,
          recall_max_tokens: 2048,
        },
      };
      ctx.gateway.completeReply = (call) => {
        if (call.responseSchema?.title !== "SummaryResult") return JSON.stringify({ ids: [] });
        const message = call.messages.at(-1);
        if (!message) throw new Error("Missing summary input");
        if (typeof message.content !== "string") throw new Error("text content expected");
        const data = JSON.parse(message.content);
        return JSON.stringify({
          facts: [
            {
              kind: "fact",
              speaker: "user",
              text: (call.maxTokens ?? 0) <= 500 ? "short" : "x".repeat(400),
              source_ids: [data.turns[0].id],
            },
          ],
        });
      };
      let usage: import("../../src/shared/contracts/context-usage").ContextUsage | undefined;
      const messages = await builder(ctx).build({
        sessionId,
        currentTurnId: current.turn.id,
        generationToken: current.prepared.generationToken,
        runtime,
        onUsage: (value) => {
          usage = value;
        },
      });
      // The recent user turn, current question and summary data are all lower-trust input.
      expect(messages.filter((message) => message.role === "user")).toHaveLength(3);
      expect(messages.find((message) => message.content.includes("有损分段摘要数据"))?.role).toBe(
        "user",
      );
      expect(
        messages
          .filter((message) => message.role === "system")
          .some((message) => message.content.includes("source_ids")),
      ).toBe(false);
      if (!usage) throw new Error("Missing context usage");
      expect(usage.components.summaries).toBeGreaterThan(0);
      expect(usage.components.summaries).toBeLessThanOrEqual(500);
      expect(usage.components).not.toHaveProperty("recalled_originals");
      expect(
        ctx.gateway.completeCalls.every((call) => call.responseSchema?.title === "SummaryResult"),
      ).toBe(true);
      expect(ctx.gateway.completeCalls.some((call) => call.maxTokens === 500)).toBe(true);
      const saved = summaries(
        ctx.orm,
        runtime.agent_id,
        sessionId,
        history(ctx.orm, runtime.agent_id, sessionId, current.sequenceNo),
      );
      expect(
        saved.some((item) => item.content.facts.some((fact) => fact.text.length === 400)),
      ).toBe(true);
      expect(Object.values(usage.components).reduce((a, b) => a + b, 0)).toBe(usage.input_units);
    } finally {
      ctx.business.close();
    }
  });

  it("new configs use 900 seconds while explicit old values and absent read caps survive", async () => {
    const { P5ConfigSchema } = await import("../../src/shared/contracts");
    expect(P5ConfigSchema.parse({}).auxiliary_timeout_seconds).toBe(900);
    expect(P5ConfigSchema.parse({ auxiliary_timeout_seconds: 120 }).auxiliary_timeout_seconds).toBe(
      120,
    );
    expect(P5ConfigSchema.parse({}).summary_read_max_tokens).toBeUndefined();
    expect(P5ConfigSchema.safeParse({ summary_read_max_tokens: 0 }).success).toBe(false);
  });
  it("propagates caller cancellation to the capacity probe", async () => {
    const ctx = setup();
    const sessionId = newSession(ctx.orm);
    const active = activeTurn(ctx.orm, sessionId, "abort-capacity");
    let receivedSignal: AbortSignal | undefined;
    ctx.gateway.loadedContextCapacity = async (_model, options) => {
      receivedSignal = options?.signal;
      return await new Promise<number>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const controller = new AbortController();
    const pending = builder(ctx).build({
      sessionId,
      currentTurnId: active.turn.id,
      runtime: active.prepared.runtime,
      generationToken: active.prepared.generationToken,
      signal: controller.signal,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(receivedSignal?.aborted).toBe(true);
    expect((caught as Error)?.name).toBe("AbortError");
  });

  it("propagates cancellation during compression without publishing a summary or retaining a checkpoint", async () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      completedTurn(ctx.orm, sessionId, "abort-summary-old", "history ".repeat(300));
      completedTurn(ctx.orm, sessionId, "abort-summary-recent");
      const current = activeTurn(ctx.orm, sessionId, "abort-summary-now");
      const runtime = structuredClone(current.prepared.runtime);
      Object.assign(runtime.p5_config, {
        context_window: 4096,
        max_output_tokens: 512,
        compression_trigger_ratio: 0.1,
        recent_turns: 1,
      });
      const controller = new AbortController();
      let aborted = false;
      ctx.gateway.complete = async (call) => {
        call.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        controller.abort(new DOMException("cancelled", "AbortError"));
        return '{"facts":[]}';
      };
      const context = builder(ctx);
      await expect(
        context.build({
          sessionId,
          currentTurnId: current.turn.id,
          runtime,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(aborted).toBe(true);
      expect(ctx.orm.select().from(schema.sessionSummaries).all()).toHaveLength(0);
      expectCode(
        () => context.assertCurrent(current.turn.id, DEFAULT_AGENT_ID),
        "CONTEXT_SOURCE_INVALID",
      );
    } finally {
      ctx.business.close();
    }
  });

  it("builds base + complete history + current question and freezes main capacity", async () => {
    const ctx = setup();
    const sessionId = newSession(ctx.orm);
    completedTurn(ctx.orm, sessionId, "b1", "过去问题", "过去回答");
    const current = activeTurn(ctx.orm, sessionId, "b2", "现在问题");
    const runtime = {
      ...current.prepared.runtime,
      p5_config: { ...current.prepared.runtime.p5_config, retrieval_mode: "off" as const },
    };
    const messages = await builder(ctx).build({
      sessionId,
      currentTurnId: current.turn.id,
      runtime,
      generationToken: current.prepared.generationToken,
    });
    expect(messages).toEqual([
      { role: "system", content: "## 核心身份\n你是一个可靠、简洁的中文助手。" },
      { role: "user", content: "过去问题" },
      { role: "assistant", content: "过去回答" },
      { role: "user", content: "现在问题" },
    ]);
    const frozen = getTurnByRequest(ctx.orm, sessionId, "b2");
    expect(JSON.parse(frozen?.runtimeConfigSnapshot ?? "{}").resolved_model_capacities[MODEL]).toBe(
      32768,
    );
    expect(ctx.gateway.capacityCalls).toBe(2); // initial observation + final refresh
  });

  for (const mode of [
    "off",
    "conservative",
    "standard",
    "broad",
    "full_catalog",
    "full_body",
  ] as const) {
    it(`exposes only on-demand paged memory reads in ${mode}`, async () => {
      const ctx = setup();
      try {
        const sessionId = newSession(ctx.orm);
        const source = completedTurn(ctx.orm, sessionId, `source-${mode}`);
        for (let index = 1; index <= 3; index += 1)
          seedMemory(ctx.orm, source.id, index, `共同主题正文${index}`);
        const current = activeTurn(ctx.orm, sessionId, `current-${mode}`, "共同主题是什么");
        const runtime = {
          ...current.prepared.runtime,
          p5_config: {
            ...current.prepared.runtime.p5_config,
            retrieval_mode: mode,
            compression_enabled: false,
          },
        };
        const agentRuntime = createAgentRuntime({
          gateway: ctx.gateway,
          repository: new AgentRunRepository(ctx.business.db),
        });
        const sourceAdapter = new WebContextSource({
          db: ctx.business.db,
          orm: ctx.orm,
          gateway: ctx.gateway,
          agentRuntime,
          builder: builder(ctx),
          runtime,
          sessionId,
          turnId: current.turn.id,
          generationToken: current.prepared.generationToken ?? "missing",
          maxSteps: 16,
        });
        const signal = new AbortController().signal;
        const material = await sourceAdapter.read({ signal, observations: [] });
        expect(JSON.stringify(material)).not.toContain("共同主题正文");
        expect(material.sources?.every((source) => source.kind === "web_turn")).toBe(true);
        expect(ctx.gateway.completeCalls).toHaveLength(0);
        expect(await sourceAdapter.read({ signal, observations: [] })).toBe(material);
        const query = sourceAdapter.actions.find(
          (action) => action.description.name === "memory.query",
        );
        const read = sourceAdapter.actions.find(
          (action) => action.description.name === "memory.read",
        );
        if (mode === "off") {
          expect(query).toBeUndefined();
          expect(read).toBeUndefined();
          return;
        }
        if (!query || !read) throw new Error("missing evidence actions");
        const actionContext = {
          owner: {
            kind: "web_turn",
            id: current.turn.id,
            agentId: runtime.agent_id,
            userId: DEFAULT_USER_ID,
          },
          signal,
          runId: `read-${mode}`,
        };
        const result = await query.execute({ query: "共同主题", limit: 1 }, actionContext);
        const entries = (result.value as { items: { id: string; bodyRef: string }[] }).items;
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(JSON.stringify(result.value)).not.toContain("共同主题正文");
        const first = await read.execute({ bodyRef: entry.bodyRef, limit: 4 }, actionContext);
        const page = (first.value as { items: { text: string; nextOffset: number }[] }).items[0];
        expect(page.text).toBe("共同主题");
        expect(page.nextOffset).toBe(4);
        const second = await read.execute(
          { bodyRef: entry.bodyRef, offset: page.nextOffset, limit: 4 },
          actionContext,
        );
        expect(JSON.stringify(second.value)).toContain("正文");
        expect(ctx.gateway.completeCalls).toHaveLength(0);
        const observations = [
          {
            id: "query",
            name: "memory.query",
            arguments: { query: "共同主题", limit: 1 },
            ...result,
          },
          {
            id: "page",
            name: "memory.read",
            arguments: { bodyRef: entry.bodyRef, limit: 4 },
            ...first,
          },
        ];
        await sourceAdapter.read({ signal, observations });
        ctx.orm
          .update(schema.memoryEntries)
          .set({ body: "changed after first next" })
          .where(eq(schema.memoryEntries.id, entry.id))
          .run();
        await expect(sourceAdapter.read({ signal, observations })).rejects.toMatchObject({
          code: "CONTEXT_SOURCE_INVALID",
        });
      } finally {
        ctx.business.close();
      }
    });
  }

  it("charges paged Web knowledge reads to the cumulative knowledge allowance", async () => {
    const ctx = setup();
    const sessionId = newSession(ctx.orm);
    const current = activeTurn(ctx.orm, sessionId, "paged-knowledge", "question");
    const runtime = {
      ...current.prepared.runtime,
      p5_config: { ...current.prepared.runtime.p5_config, retrieval_mode: "off" as const },
    };
    if (!runtime.knowledge_read) throw new Error("missing knowledge settings");
    runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1700 };
    const agentRuntime = createAgentRuntime({
      gateway: ctx.gateway,
      repository: new AgentRunRepository(ctx.business.db),
    });
    const adapter = new WebContextSource({
      db: ctx.business.db,
      orm: ctx.orm,
      gateway: ctx.gateway,
      agentRuntime,
      builder: builder(ctx),
      runtime,
      sessionId,
      turnId: current.turn.id,
      generationToken: current.prepared.generationToken ?? "missing",
      maxSteps: 16,
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async () => [
            {
              id: "doc",
              text: "x".repeat(10000),
              preview: { title: "title", summary: "preview" },
              sources: [],
            },
          ],
        },
      }),
    });
    const signal = new AbortController().signal;
    const actionContext = { owner: { kind: "test", id: "test" }, signal };
    await adapter.read({ signal, observations: [] });
    const query = adapter.actions.find((a) => a.description.name === "knowledge.query");
    const read = adapter.actions.find((a) => a.description.name === "knowledge.read");
    if (!query || !read) throw new Error("missing actions");
    const found = await query.execute({ query: "question" }, actionContext);
    const bodyRef = (found.value as { items: { bodyRef: string }[] }).items[0].bodyRef;
    const observed = [
      { id: "query", name: "knowledge.query", arguments: { query: "question" }, ...found },
    ];
    await adapter.read({ signal, observations: observed });
    const page = await read.execute({ bodyRef, limit: 4096 }, actionContext);
    const entry = (page.value as { items: { text: string; nextOffset: number }[] }).items[0];
    expect(page.value).toMatchObject({ status: "ok" });
    expect(entry.text.length).toBeLessThan(1700);
    await adapter.read({
      signal,
      observations: [
        ...observed,
        { id: "page", name: "knowledge.read", arguments: { bodyRef, limit: 4096 }, ...page },
      ],
    });
    const next = await read.execute({ bodyRef, offset: entry.nextOffset }, actionContext);
    expect(next.value).toMatchObject({ status: "ok" });
    const nextEntry = (next.value as { items: { text: string; nextOffset: number }[] }).items[0];
    expect(nextEntry.text.length).toBeLessThan(entry.text.length);
    await adapter.read({
      signal,
      observations: [
        ...observed,
        { id: "page", name: "knowledge.read", arguments: { bodyRef, limit: 4096 }, ...page },
        {
          id: "next",
          name: "knowledge.read",
          arguments: { bodyRef, offset: entry.nextOffset },
          ...next,
        },
      ],
    });
    const exhausted = await read.execute({ bodyRef, offset: nextEntry.nextOffset }, actionContext);
    expect(exhausted.value).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
    });
  });

  it("advertises host-provided external actions to the web decision", async () => {
    const ctx = setup();
    const sessionId = newSession(ctx.orm);
    const current = activeTurn(ctx.orm, sessionId, "ext-1", "问题");
    const runtime = {
      ...current.prepared.runtime,
      p5_config: { ...current.prepared.runtime.p5_config, retrieval_mode: "off" as const },
    };
    const agentRuntime = createAgentRuntime({
      gateway: ctx.gateway,
      repository: new AgentRunRepository(ctx.business.db),
    });
    const adapter = new WebContextSource({
      db: ctx.business.db,
      orm: ctx.orm,
      gateway: ctx.gateway,
      agentRuntime,
      builder: builder(ctx),
      runtime,
      sessionId,
      turnId: current.turn.id,
      generationToken: current.prepared.generationToken ?? "missing",
      maxSteps: 16,
      extraActions: [
        {
          description: {
            name: "mcp.demo.echo",
            description: "外部工具",
            parameters: { type: "object", properties: {} },
            capability: "mcp.demo",
            effect: "read",
          },
          async execute() {
            return { value: { status: "ok", text: "pong" }, sources: [] };
          },
        },
      ],
    });
    // 宿主给的外部动作进了执行表，也进了模型看到的动作声明。
    expect(adapter.actions.map((action) => action.description.name)).toContain("mcp.demo.echo");
    expect(adapter.spec.availableActions.map((action) => action.name)).toContain("mcp.demo.echo");
  });

  it("publishes a reusable summary with complete source links", async () => {
    const ctx = setup();
    // The main model is intentionally budgeted to 4096 below, but the actual
    // loaded capacity remains 32768. The compression model therefore has room
    // for its strict JSON schema + source turns + 1024 output reservation
    // while the main-context budget is still small enough to trigger summary.
    ctx.gateway.capacity = 32768;
    const sessionId = newSession(ctx.orm);
    const old = completedTurn(
      ctx.orm,
      sessionId,
      "sum-old",
      "旧问题".repeat(100),
      "旧回答".repeat(100),
    );
    // `recent_turns=1` means the newest complete historical turn must remain as
    // raw text. Two historical turns are therefore required before the contract
    // algorithm is allowed to summarize the older prefix.
    completedTurn(ctx.orm, sessionId, "sum-recent", "最近问题", "最近回答");
    const current = activeTurn(ctx.orm, sessionId, "sum-now", "当前问题");
    ctx.gateway.completeReply = (call) => {
      if (String(call.responseSchema?.title) === "SummaryResult") {
        const sumRaw = call.messages[1].content;
        if (typeof sumRaw !== "string") throw new Error("text content expected");
        const data = JSON.parse(sumRaw) as { turns: Array<{ id: string }> };
        return JSON.stringify({
          facts: data.turns.length
            ? [
                {
                  kind: "fact",
                  speaker: "user",
                  text: "用户曾提出旧问题",
                  source_ids: [data.turns[0].id],
                },
              ]
            : [],
        });
      }
      return JSON.stringify({ ids: [] });
    };
    const runtime = {
      ...current.prepared.runtime,
      p5_config: {
        ...current.prepared.runtime.p5_config,
        context_window: 4096,
        max_output_tokens: 512,
        retrieval_mode: "off" as const,
        compression_trigger_ratio: 0.1,
        recent_turns: 1,
        summary_target_tokens: 1024,
        summary_max_tokens: 2048,
      },
    };
    const messages = await builder(ctx).build({
      sessionId,
      currentTurnId: current.turn.id,
      runtime,
      generationToken: current.prepared.generationToken,
    });
    expect(messages.some((item) => item.content.startsWith("以下是本会话的有损分段摘要数据"))).toBe(
      true,
    );
    const saved = summaries(ctx.orm, DEFAULT_AGENT_ID, sessionId, [
      ...history(ctx.orm, DEFAULT_AGENT_ID, sessionId, current.sequenceNo),
    ]);
    expect(saved).toHaveLength(1);
    expect(saved[0].turnIds).toEqual([old.id]);
  });

  it("ignores an unread memory body changed during the final capacity refresh", async () => {
    const ctx = setup();
    const sessionId = newSession(ctx.orm);
    const source = completedTurn(ctx.orm, sessionId, "mut-source");
    const id = seedMemory(ctx.orm, source.id, 1, "原正文");
    const current = activeTurn(ctx.orm, sessionId, "mut-current", "qwen strasse");
    ctx.gateway.onCapacity = (call) => {
      if (call === 2) {
        ctx.orm
          .update(schema.memoryEntries)
          .set({ body: "变化后的正文" })
          .where(eq(schema.memoryEntries.id, id))
          .run();
      }
    };
    let code = "";
    try {
      await builder(ctx).build({
        sessionId,
        currentTurnId: current.turn.id,
        runtime: current.prepared.runtime,
        generationToken: current.prepared.generationToken,
      });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    expect(code).toBe("");
    expect(ctx.gateway.completeCalls).toHaveLength(0);
  });

  it("production POST /chat really uses ContextBuilder before streamChat", async () => {
    const business = openBusinessDb();
    const gateway = new ContextGateway();
    gateway.capacity = 0;
    const app = createApp({ business, gateway });
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "会话", mode: "chat" }),
    });
    const sessionId = ((await created.json()) as { id: string }).id;
    const response = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        message: "你好",
        client_request_id: "r4-wire",
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"code":"CONTEXT_CAPACITY_ERROR"');
    expect(gateway.streamCalls).toHaveLength(0);
    expect(
      listMessages(business.orm, sessionId).find((item) => item.role === "assistant")?.errorCode,
    ).toBe("CONTEXT_CAPACITY_ERROR");
  });

  it("DirectService persists contract-strip output rather than JS-trim output", async () => {
    const business = openBusinessDb();
    const gateway = new ContextGateway();
    gateway.streamDeltas = ["\u0085回答\u001c"];
    const app = createApp({ business, gateway });
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "会话", mode: "chat" }),
    });
    const sessionId = ((await created.json()) as { id: string }).id;
    const response = await app.request("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        message: "你好",
        client_request_id: "r4-strip",
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(
      listMessages(business.orm, sessionId).find((item) => item.role === "assistant")?.content,
    ).toBe("回答");
  });
});

it("never runs a hidden selector even when its configured model would return malformed IDs", async () => {
  const ctx = setup();
  try {
    const sessionId = newSession(ctx.orm);
    const source = completedTurn(ctx.orm, sessionId, "selection-source");
    seedMemory(ctx.orm, source.id, 1, "记忆正文");
    const current = activeTurn(ctx.orm, sessionId, "selection-current", "qwen strasse");
    ctx.gateway.completeReply = () => '{"ids":["outside-candidates"]}';
    const messages = await builder(ctx).build({
      sessionId,
      currentTurnId: current.turn.id,
      runtime: current.prepared.runtime,
      generationToken: current.prepared.generationToken,
    });
    expect(JSON.stringify(messages)).not.toContain("记忆正文");
    expect(ctx.gateway.completeCalls).toHaveLength(0);
    expect(
      ctx.business.db.query("SELECT status FROM agent_runs WHERE spec_id = 'context.select'").all(),
    ).toHaveLength(0);
  } finally {
    ctx.business.close();
  }
});

/** An unused retrieval allowance must not trigger either a read or a degraded initial context. */
it("answers without prefetch or a degradation when an unused memory allowance is tiny", async () => {
  const ctx = setup();
  try {
    const sourceSession = newSession(ctx.orm);
    const source = completedTurn(ctx.orm, sourceSession, "budget-source");
    seedMemory(ctx.orm, source.id, 1, "很长的一段记忆正文");
    const chatSession = newSession(ctx.orm);
    const current = activeTurn(ctx.orm, chatSession, "budget-current", "问题");
    const runtime = structuredClone(current.prepared.runtime);
    // 记忆预算是 min(剩余, 预置 max_tokens)：把预置压到 1，任何一条正文都放不下。
    runtime.p5_config.retrieval_presets.standard.max_tokens = 1;
    const diagnostics: ContextDiagnostic[] = [];
    const built = await new ContextBuilder({
      orm: ctx.orm,
      db: ctx.business.db,
      gateway: ctx.gateway,
      diagnosticSink: (record) => diagnostics.push(record),
    }).build({
      sessionId: chatSession,
      currentTurnId: current.turn.id,
      runtime,
      generationToken: current.prepared.generationToken,
    });
    expect(JSON.stringify(built)).not.toContain("很长的一段记忆正文");
    const ready = diagnostics.at(-1);
    expect(ready?.status).toBe("ready");
    expect(ready?.error_code).toBeUndefined();
    expect(ready?.memory_ids).toEqual([]);
    expect(ctx.gateway.completeCalls).toHaveLength(0);
  } finally {
    ctx.business.close();
  }
});

/**
 * 漂移 A（Web 侧）：同一批里的多个只读资料工具并发跑时，每个 fit 只看得到"上一轮已提交的
 * observations"。各自单独放得下、合起来超过下一步上限 → 下一步渲染时整轮 `AGENT_CONTEXT_LIMIT`。
 * 保守联合预留：把本批其它在飞结果的增量也算进来，宁可少装，不许炸轮。
 */
function webJointFixture() {
  const ctx = setup();
  const sessionId = newSession(ctx.orm);
  completedTurn(ctx.orm, sessionId, "joint-history", "历史上的问题", "历史上的回答");
  const current = activeTurn(ctx.orm, sessionId, "joint-current", "现在的问题");
  const runtime = {
    ...current.prepared.runtime,
    p5_config: {
      ...current.prepared.runtime.p5_config,
      retrieval_mode: "standard" as const,
      compression_enabled: false,
    },
  };
  if (!runtime.knowledge_read) throw new Error("missing knowledge settings");
  runtime.knowledge_read = { ...runtime.knowledge_read, budget: 1_000_000 };
  // Isolate the joint context ceiling from each domain's independent tool allowance.
  runtime.p5_config.retrieval_presets.standard = {
    ...runtime.p5_config.retrieval_presets.standard,
    max_tokens: 1_000_000,
  };
  const lengths = { memory: 0, knowledge: 0 };
  const evidence = (id: string, length: number): Evidence => ({
    id,
    text: "body",
    sources: [],
    preview: { title: id, summary: "x".repeat(length) },
  });
  const items = {
    memory: () => [evidence("m1", lengths.memory)],
    knowledge: () => [evidence("k1", lengths.knowledge), evidence("k2", lengths.knowledge)],
  };
  const agentRuntime = createAgentRuntime({
    gateway: ctx.gateway,
    repository: new AgentRunRepository(ctx.business.db),
  });
  const adapter = new WebContextSource({
    db: ctx.business.db,
    orm: ctx.orm,
    gateway: ctx.gateway,
    agentRuntime,
    builder: builder(ctx),
    runtime,
    sessionId,
    turnId: current.turn.id,
    generationToken: current.prepared.generationToken ?? "missing",
    maxSteps: 16,
    modules: () => ({
      memory: { query: async () => (lengths.memory ? items.memory() : []) },
      knowledge: {
        query: async () => {
          if (!lengths.knowledge) return [];
          // 让 memory 的拟合先登记：并发顺序确定，断言才稳定。
          await new Promise((resolve) => setTimeout(resolve, 5));
          return items.knowledge();
        },
      },
    }),
  });
  return { ctx, sessionId, current, runtime, agentRuntime, adapter, lengths, items };
}
/** 与 WebContextSource.fit 同口径的投影增量：U(observations + [probe]) - U(observations)。 */
function webProjection(
  adapter: WebContextSource,
  material: Awaited<ReturnType<WebContextSource["read"]>>,
) {
  const engine = new ContextEngine();
  const base = engine.render(adapter.spec, material, [], ["reply"], "stream").units;
  return {
    base,
    project: (name: "memory.query" | "knowledge.query", value: unknown) =>
      engine.render(
        adapter.spec,
        material,
        [
          {
            id: "00000000-0000-0000-0000-000000000000",
            name,
            arguments: { query: "apples" },
            value,
            sources: [],
          },
        ],
        ["reply"],
        "stream",
      ).units - base,
  };
}
/** 模型桩：按脚本回答决策；其它叶子调用给空答复。 */
function scriptedGateway(ctx: Setup, responses: string[]) {
  const seen: Parameters<ModelGateway["complete"]>[0][] = [];
  const base = ctx.gateway.complete.bind(ctx.gateway);
  ctx.gateway.complete = async (request) => {
    seen.push(request);
    const decisionContent = request.messages[0]?.content;
    if (
      typeof decisionContent === "string" &&
      decisionContent.includes("Return exactly one JSON decision")
    )
      return responses.shift() ?? '{"kind":"none"}';
    return base(request);
  };
  return seen;
}
function actionObservations(request: Parameters<ModelGateway["complete"]>[0]) {
  return request.messages.flatMap((message) => {
    try {
      if (typeof message.content !== "string") return [];
      const data = JSON.parse(message.content) as { kind?: string; value?: unknown };
      return data.kind === "action_observation"
        ? [
            data.value as {
              name: string;
              value: { status: string; items: { id: string }[] };
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
}
const jointWebInput = (fixture: ReturnType<typeof webJointFixture>, requestId: string) => ({
  owner: {
    kind: "web_turn",
    id: fixture.current.turn.id,
    userId: DEFAULT_USER_ID,
    agentId: fixture.runtime.agent_id,
  },
  context: fixture.adapter,
  actions: fixture.adapter.actions,
  authorizedTargets: ["reply"],
  outputMode: "stream" as const,
  signal: new AbortController().signal,
  requestId,
});
describe("Web 同批资料工具的联合预留（漂移 A）", () => {
  it("同批两个查询合起来超限时后者被裁到装得下，整轮完成而不是上下文超限失败", async () => {
    const fixture = webJointFixture();
    const { ctx, adapter, lengths, items } = fixture;
    const material = await adapter.read({ signal: new AbortController().signal, observations: [] });
    const limit = adapter.spec.limits.inputUnits;
    if (limit === undefined) throw new Error("missing Web input limit");
    const projection = webProjection(adapter, material);
    const room = limit - projection.base;
    const value = (kind: "memory" | "knowledge", count: number) => ({
      status: "ok",
      items: items[kind]()
        .slice(0, count)
        .map((item) => evidenceCatalogEntry(kind, item)),
    });
    const measure = (kind: "memory" | "knowledge", count: number, length: number) => {
      const saved = lengths[kind];
      lengths[kind] = length;
      const projected = projection.project(`${kind}.query`, value(kind, count));
      lengths[kind] = saved;
      return projected;
    };
    lengths.memory = Math.max(0, Math.floor(room * 0.6) - measure("memory", 1, 0));
    lengths.knowledge = Math.max(0, Math.floor(room * 0.3) - measure("knowledge", 1, 0));
    // 预置条件自检（与 fitter 同口径）：单独都装得下，合起来装不下 → 第二个条目必被裁。
    expect(measure("memory", 1, lengths.memory)).toBeLessThanOrEqual(room);
    expect(
      measure("knowledge", 1, lengths.knowledge) + measure("memory", 1, lengths.memory),
    ).toBeLessThanOrEqual(room);
    expect(
      measure("knowledge", 2, lengths.knowledge) + measure("memory", 1, lengths.memory),
    ).toBeGreaterThan(room);
    const seen = scriptedGateway(ctx, [
      JSON.stringify({
        kind: "invoke",
        calls: [
          { name: "memory.query", arguments: { query: "apples" } },
          { name: "knowledge.query", arguments: { query: "apples" } },
        ],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
      }),
    ]);
    // 装配在下一步渲染时按 stepSpec.limits.inputUnits 复查：这里不裁就会整轮 AGENT_CONTEXT_LIMIT。
    const result = await fixture.agentRuntime.run(
      adapter.spec,
      jointWebInput(fixture, "joint-web"),
    );
    expect(result.status).toBe("completed");
    expect(seen).toHaveLength(2);
    const observed = actionObservations(seen[1]);
    const memory = observed.find((entry) => entry.name === "memory.query");
    const knowledge = observed.find((entry) => entry.name === "knowledge.query");
    expect(memory?.value.items.map((item) => item.id)).toEqual(["m1"]);
    expect(knowledge?.value.status).toBe("ok");
    expect(knowledge?.value.items.map((item) => item.id)).toEqual(["k1"]);
  });
  it("顺序单查询不回归：没有同批兄弟时整份结果照装", async () => {
    const fixture = webJointFixture();
    const { ctx, adapter, lengths } = fixture;
    await adapter.read({ signal: new AbortController().signal, observations: [] });
    lengths.knowledge = 1000;
    const seen = scriptedGateway(ctx, [
      JSON.stringify({
        kind: "invoke",
        calls: [{ name: "knowledge.query", arguments: { query: "apples" } }],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "answer" }],
      }),
    ]);
    const result = await fixture.agentRuntime.run(adapter.spec, jointWebInput(fixture, "solo-web"));
    expect(result.status).toBe("completed");
    const observed = actionObservations(seen[1]);
    const knowledge = observed.find((entry) => entry.name === "knowledge.query");
    expect(knowledge?.value.items.map((item) => item.id)).toEqual(["k1", "k2"]);
  });
});

/**
 * 白盒探针：泄漏目标就是私有的检查点 Map。一轮终态落库后，其检查点闭包无法再区分
 * “已释放”和“仍被保留”（两种情况下 assertCurrent 都会因生成已结束而失败），
 * 所以泄漏本身只能直接观察这个 Map。
 */
function retainedCheckpoints(context: ContextBuilder): Map<string, unknown> {
  return (context as unknown as { checkpoints: Map<string, unknown> }).checkpoints;
}

/** 记录每次释放时该会话助手消息的落库状态，证明清理发生在提交/终态写入之后。 */
function trackRelease(
  context: ContextBuilder,
  orm: Orm,
  sessionId: string,
): Array<string | undefined> {
  const original = context.release.bind(context);
  const states: Array<string | undefined> = [];
  context.release = (turnId, generationToken) => {
    states.push(
      listMessages(orm, sessionId).find((message) => message.role === "assistant")?.status,
    );
    original(turnId, generationToken);
  };
  return states;
}

function webReleaseFixture(options: { heartbeatIntervalMs?: number } = {}) {
  const ctx = setup();
  const contextBuilder = builder(ctx);
  const channel = new WebChannel({
    db: ctx.business.db,
    orm: ctx.orm,
    gateway: ctx.gateway,
    contextBuilder,
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
  });
  return { ctx, contextBuilder, channel };
}

describe("turn checkpoint release", () => {
  it("releases the checkpoint after a completed web reply, only after the commit", async () => {
    const { ctx, contextBuilder, channel } = webReleaseFixture();
    try {
      const sessionId = newSession(ctx.orm);
      const reply = await channel.openReply({
        sessionId,
        message: "你好",
        clientRequestId: "release-completed",
      });
      const turn = getTurnByRequest(ctx.orm, sessionId, "release-completed");
      if (!turn) throw new Error("turn missing");
      const states = trackRelease(contextBuilder, ctx.orm, sessionId);
      const types: string[] = [];
      let retainedWhileStreaming = false;
      for await (const event of reply) {
        // 用量事件说明上下文已构建完成：终态落库前检查点必须仍在。
        if (event.type === "context_usage")
          retainedWhileStreaming =
            retainedWhileStreaming || retainedCheckpoints(contextBuilder).has(turn.id);
        types.push(event.type);
      }
      expect(types.at(-1)).toBe("completed");
      expect(types).toContain("output_delta");
      expect(retainedWhileStreaming).toBe(true);
      // 提交完成后才清理：释放时助手消息已落库为 completed。
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((status) => status === "completed")).toBe(true);
      expect(retainedCheckpoints(contextBuilder).has(turn.id)).toBe(false);
    } finally {
      ctx.business.close();
    }
  });

  it("releases the checkpoint when the reply fails with partial output", async () => {
    const { ctx, contextBuilder, channel } = webReleaseFixture();
    try {
      const sessionId = newSession(ctx.orm);
      ctx.gateway.streamChat = async function* (): AsyncGenerator<string> {
        yield "partial";
        throw new Error("broken");
      };
      const reply = await channel.openReply({
        sessionId,
        message: "问题",
        clientRequestId: "release-failed",
      });
      const turn = getTurnByRequest(ctx.orm, sessionId, "release-failed");
      if (!turn) throw new Error("turn missing");
      const states = trackRelease(contextBuilder, ctx.orm, sessionId);
      let failure: unknown;
      try {
        for await (const _event of reply) {
          /* drain to the classified failure */
        }
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string } | undefined)?.code).toBe("MODEL_ERROR");
      const assistant = listMessages(ctx.orm, sessionId).find((m) => m.role === "assistant");
      expect(assistant?.status).toBe("failed");
      expect(assistant?.content).toBe("partial");
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((status) => status === "failed")).toBe(true);
      expect(retainedCheckpoints(contextBuilder).has(turn.id)).toBe(false);
    } finally {
      ctx.business.close();
    }
  });

  it("releases the checkpoint when the consumer disconnects mid-stream", async () => {
    const { ctx, contextBuilder, channel } = webReleaseFixture();
    try {
      const sessionId = newSession(ctx.orm);
      ctx.gateway.streamChat = async function* (): AsyncGenerator<string> {
        yield "第一段";
        await sleep(40);
        yield "第二段";
      };
      const reply = await channel.openReply({
        sessionId,
        message: "问题",
        clientRequestId: "release-disconnect",
      });
      const turn = getTurnByRequest(ctx.orm, sessionId, "release-disconnect");
      if (!turn) throw new Error("turn missing");
      const states = trackRelease(contextBuilder, ctx.orm, sessionId);
      // 拉到首个输出增量再放弃消费：上下文已构建、生产者在等确认，检查点必须还在。
      let item = await reply.next();
      while (
        !item.done &&
        item.value.type !== "output_delta" &&
        !["completed", "failed", "cancelled", "replay"].includes(item.value.type)
      )
        item = await reply.next();
      if (item.done || item.value.type !== "output_delta") throw new Error("missing output delta");
      expect(retainedCheckpoints(contextBuilder).has(turn.id)).toBe(true);
      await reply.return(undefined);
      // 既有断开语义不变：cancelled + CLIENT_DISCONNECTED，且先落库再释放。
      const assistant = listMessages(ctx.orm, sessionId).find((m) => m.role === "assistant");
      expect(assistant?.status).toBe("cancelled");
      expect(assistant?.errorCode).toBe("CLIENT_DISCONNECTED");
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((status) => status === "cancelled")).toBe(true);
      expect(retainedCheckpoints(contextBuilder).has(turn.id)).toBe(false);
    } finally {
      ctx.business.close();
    }
  });

  it("releases the checkpoint when the turn is cancelled mid-stream", async () => {
    const { ctx, contextBuilder, channel } = webReleaseFixture({ heartbeatIntervalMs: 5 });
    try {
      const sessionId = newSession(ctx.orm);
      ctx.gateway.streamChat = async function* (): AsyncGenerator<string> {
        yield "第一段";
        await sleep(40);
        yield "第二段";
      };
      const reply = await channel.openReply({
        sessionId,
        message: "问题",
        clientRequestId: "release-cancelled",
      });
      const turn = getTurnByRequest(ctx.orm, sessionId, "release-cancelled");
      if (!turn) throw new Error("turn missing");
      const states = trackRelease(contextBuilder, ctx.orm, sessionId);
      let failure: unknown;
      let cancelled = false;
      try {
        for await (const event of reply) {
          // 增量未确认前生产者不会继续；此时删除用户消息即用户取消本轮。
          if (event.type === "output_delta" && !cancelled) {
            const user = listMessages(ctx.orm, sessionId).find((m) => m.role === "user");
            if (!user) throw new Error("user message missing");
            deleteMessage(ctx.orm, sessionId, user.id);
            cancelled = true;
          }
        }
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string } | undefined)?.code).toBe("GENERATION_CANCELLED");
      const assistant = listMessages(ctx.orm, sessionId).find((m) => m.role === "assistant");
      expect(assistant?.status).toBe("cancelled");
      expect(assistant?.errorCode).toBe("GENERATION_CANCELLED");
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((status) => status === "cancelled")).toBe(true);
      expect(retainedCheckpoints(contextBuilder).has(turn.id)).toBe(false);
    } finally {
      ctx.business.close();
    }
  });

  it("keeps another active turn's checkpoint and its protection intact after a release", async () => {
    const ctx = setup();
    try {
      const sessionA = newSession(ctx.orm);
      completedTurn(ctx.orm, sessionA, "iso-old-a");
      const activeA = activeTurn(ctx.orm, sessionA, "iso-now-a");
      const sessionB = newSession(ctx.orm);
      const sourceB = completedTurn(ctx.orm, sessionB, "iso-old-b");
      const memoryId = seedMemory(ctx.orm, sourceB.id, 1, "旧错误");
      const corrected = immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, memoryId, {
          expected_revision: memoryContent(ctx.orm, DEFAULT_AGENT_ID, memoryId).content.revision,
          name: "更正",
          summary: "新",
          tags: [],
          body: "最初更正",
        }),
      );
      const activeB = activeTurn(ctx.orm, sessionB, "iso-now-b");
      const tokenA = activeA.prepared.generationToken;
      const tokenB = activeB.prepared.generationToken;
      if (!tokenA || !tokenB) throw new Error("fresh tokens expected");
      const context = builder(ctx);
      await context.build({
        sessionId: sessionA,
        currentTurnId: activeA.turn.id,
        runtime: activeA.prepared.runtime,
        generationToken: tokenA,
      });
      await context.build({
        sessionId: sessionB,
        currentTurnId: activeB.turn.id,
        runtime: activeB.prepared.runtime,
        generationToken: tokenB,
      });
      expect(() => context.assertCurrent(activeA.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      expect(() => context.assertCurrent(activeB.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      // 共用一个 builder 的两轮：释放 A 只删除 A 的检查点。
      context.release(activeA.turn.id, tokenA);
      expectCode(
        () => context.assertCurrent(activeA.turn.id, DEFAULT_AGENT_ID),
        "CONTEXT_SOURCE_INVALID",
      );
      expect(retainedCheckpoints(context).has(activeB.turn.id)).toBe(true);
      expect(() => context.assertCurrent(activeB.turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      // B 仍保留检查点：后续纠正变化照旧被拦截。
      immediate(ctx.business.db, () =>
        correctMemory(ctx.orm, DEFAULT_AGENT_ID, corrected.content.id, {
          expected_revision: corrected.content.revision,
          name: "第二次更正",
          summary: "新2",
          tags: [],
          body: "后续更正",
        }),
      );
      expectCode(
        () => context.assertCurrent(activeB.turn.id, DEFAULT_AGENT_ID),
        "CONTEXT_SOURCE_INVALID",
      );
    } finally {
      ctx.business.close();
    }
  });

  it("cannot let a stale release drop the renewed generation's checkpoint for the same turn", async () => {
    const ctx = setup();
    try {
      const sessionId = newSession(ctx.orm);
      const first = prepareTurn(ctx.orm, sessionId, "重试问题", "retry-turn");
      const turn = getTurnByRequest(ctx.orm, sessionId, "retry-turn");
      if (!first.generationToken || !turn) throw new Error("first generation missing");
      const context = builder(ctx);
      await context.build({
        sessionId,
        currentTurnId: turn.id,
        runtime: first.runtime,
        generationToken: first.generationToken,
      });
      // 第一代失败后，同一 client_request_id 重试得到新一代 token（Turn 不变）。
      saveFailedAssistantMessage(
        ctx.orm,
        sessionId,
        "retry-turn",
        "MODEL_ERROR",
        first.generationToken,
      );
      const second = prepareTurn(ctx.orm, sessionId, "重试问题", "retry-turn");
      if (!second.generationToken) throw new Error("renewed generation missing");
      if (second.generationToken === first.generationToken) throw new Error("token must renew");
      await context.build({
        sessionId,
        currentTurnId: turn.id,
        runtime: second.runtime,
        generationToken: second.generationToken,
      });
      expect(() => context.assertCurrent(turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      // 旧代的收尾清理不得删除新代检查点（Turn 仍活跃、内容未变，不抛证明仍在）。
      context.release(turn.id, first.generationToken);
      expect(() => context.assertCurrent(turn.id, DEFAULT_AGENT_ID)).not.toThrow();
      expect(retainedCheckpoints(context).has(turn.id)).toBe(true);
      // 新代自己的收尾仍能正常释放。
      context.release(turn.id, second.generationToken);
      expectCode(() => context.assertCurrent(turn.id, DEFAULT_AGENT_ID), "CONTEXT_SOURCE_INVALID");
    } finally {
      ctx.business.close();
    }
  });
});
