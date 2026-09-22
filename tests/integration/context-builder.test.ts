// R4 context-builder integration tests and
// No live model is called.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import {
  catalog,
  catalogFingerprint,
  history,
  memoryBodies,
  summaries,
  systemPrompt,
} from "../../src/server/db/context-repository";
import { correctMemory, memoryContent } from "../../src/server/db/memory-content-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  immediate,
  listMessages,
  nowIso,
  type Orm,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  ContextBuilder,
  contextDumps,
  contextKeywords,
  estimateMessages,
  estimateTokens,
  SELECTION_JSON_SCHEMA,
  SUMMARY_RESULT_JSON_SCHEMA,
  validateContextIds,
} from "../../src/server/services/context-builder";
import { unicodeStrip } from "../../src/server/services/text";

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

describe("0.2.1 corrected memory context", () => {
  it("recalls the corrected revision in the shared format, not the retired body", async () => {
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
      const chatSession = newSession(ctx.orm);
      const current = activeTurn(ctx.orm, chatSession, "ask", "餐费多少");
      const result = await builder(ctx).build({
        sessionId: chatSession,
        currentTurnId: current.turn.id,
        runtime: current.prepared.runtime,
        generationToken: current.prepared.generationToken,
      });
      expect(JSON.stringify(result)).toContain("餐费80元");
      expect(JSON.stringify(result)).toContain("manual_correction");
      expect(JSON.stringify(result)).not.toContain("餐费999元错误");
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

describe("0.2.1 disabled memory isolation", () => {
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
        const data = JSON.parse(call.messages[1].content) as {
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
      expect(JSON.parse(call?.messages[1].content ?? "{}").manual_corrections).toEqual([]);
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
      expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
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

  for (const [mode, expected] of [
    ["off", 0],
    ["conservative", 3],
    ["standard", 3],
    ["broad", 3],
    ["full_catalog", 3],
    ["full_body", 3],
  ] as const) {
    it(`implements retrieval mode ${mode}`, async () => {
      const ctx = setup();
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
      const messages = await builder(ctx).build({
        sessionId,
        currentTurnId: current.turn.id,
        runtime,
        generationToken: current.prepared.generationToken,
      });
      const injected = messages.find((item) => item.content.startsWith("以下是授权的长期记忆数据"));
      if (expected === 0) {
        expect(injected).toBeUndefined();
      } else {
        expect(injected).toBeDefined();
        const payload = JSON.parse(
          injected?.content.split("\n").slice(1).join("\n") ?? "[]",
        ) as unknown[];
        expect(payload).toHaveLength(expected);
      }
      if (mode === "off" || mode === "full_body") {
        expect(ctx.gateway.completeCalls).toHaveLength(0);
      } else {
        expect(ctx.gateway.completeCalls.length).toBeGreaterThan(0);
      }
    });
  }

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
        const data = JSON.parse(call.messages[1].content) as { turns: Array<{ id: string }> };
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

  it("rejects a memory body changed during the final capacity refresh", async () => {
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
    expect(code).toBe("CONTEXT_SOURCE_INVALID");
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
