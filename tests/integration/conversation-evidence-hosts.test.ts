import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createApp } from "../../src/server/app";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { setMemoryVisibility } from "../../src/server/db/memory-content-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  readQqStickerAssetRow,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import {
  resolveQqSummaryProvenance,
  saveQqConversationSummary,
} from "../../src/server/db/qq-summary-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  listMessages,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  captureQqTask,
  createQqBinding,
  qqConversationKey,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { RuntimeConfig } from "../../src/shared/contracts";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import { runtimeFixtureBusiness } from "../harness/business-db";
import { parseSseFrames } from "../harness/sse";

// 合成宿主测试：会话历史/摘要宿主接线（web-context-source、onebot11 context-source、
// app 组合解析器）。全部使用内存库与脚本化网关：不读真实数据、密钥，不拉起外部服务。
// 覆盖：工具正文进入下一模型请求；运行检查初始 exact、删旧 message 后 revoked，
// 且 createApp 注入的全放行 resolveSource 不能覆盖会话证据复验；检索关闭仍保留
// history；判断档不装 summary 而回复档安装；history.query/read 返回同会话原文。

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

type CompleteInput = Parameters<ModelGateway["complete"]>[0];
type ScriptedDecision = unknown | ((input: CompleteInput) => unknown);

class ScriptedGateway implements ModelGateway {
  config = { baseUrl: "http://unused.invalid", model: "model", timeoutSeconds: 60 };
  decisions: ScriptedDecision[] = [];
  deltas: string[] = [];
  completeCalls: CompleteInput[] = [];
  streamCalls: Parameters<ModelGateway["streamChat"]>[0][] = [];
  async listModels() {
    return ["model"];
  }
  async loadedContextCapacity() {
    return 32768;
  }
  async probeModelLoaded() {
    return true;
  }
  async complete(input: CompleteInput) {
    this.completeCalls.push(input);
    const next = this.decisions.shift();
    if (next === undefined) throw new Error("no scripted decision left");
    return JSON.stringify(typeof next === "function" ? next(input) : next);
  }
  async *streamChat(input: Parameters<ModelGateway["streamChat"]>[0]) {
    this.streamCalls.push(input);
    for (const delta of this.deltas) yield delta;
  }
}

type WebEvent = { type: string; name?: string; runId?: string };
type WebApp = ReturnType<typeof createApp>;
type WebSession = ReturnType<typeof createSession>;

function webSetup() {
  const business = runtimeFixtureBusiness(openBusinessDb(), "model");
  handles.push(business);
  ensureDefaults(business.orm, "model");
  const session = createSession(business.orm, "test", { modelName: "model" });
  return { business, session, gateway: new ScriptedGateway() };
}

function finalDecision() {
  return {
    kind: "final",
    outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
  };
}

async function postChat(
  app: WebApp,
  body: { session_id: string; message: string; client_request_id: string },
): Promise<WebEvent[]> {
  const response = await app.request("/v2/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return parseSseFrames(await response.text()).map((frame) => frame.data as WebEvent);
}

/** 从模型请求里按名字取最近一条 action_observation（内容为 JSON 文本）。 */
function lastObservation(
  messages: readonly { content: string | unknown[] }[],
  name: string,
): { arguments?: unknown; value?: { items?: unknown[] } } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const content = message?.content;
    if (typeof content !== "string" || !content.includes(`"${name}"`)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    const record = parsed as { kind?: string; value?: { name?: string } };
    if (record.kind !== "action_observation" || record.value?.name !== name) continue;
    return record.value as { arguments?: unknown; value?: { items?: unknown[] } };
  }
  return undefined;
}

function historyBodyRef(input: CompleteInput): string {
  const first = lastObservation(input.messages, "history.query")?.value?.items?.[0] as
    | { bodyRef?: unknown }
    | undefined;
  if (typeof first?.bodyRef !== "string")
    throw new Error("history.query observation lacks bodyRef");
  return first.bodyRef;
}

function readTexts(
  calls: readonly { messages: readonly { content: string | unknown[] }[] }[],
): unknown[] {
  const texts: unknown[] = [];
  for (const call of calls) {
    const items = lastObservation(call.messages, "history.read")?.value?.items;
    if (Array.isArray(items) && items.length)
      texts.push((items[0] as { text?: unknown } | undefined)?.text);
  }
  return texts;
}

const oldTurnBody = (marker: string) => `earlier question ${"f".repeat(300)} ${marker}`;

async function runOldTurn(
  app: WebApp,
  session: WebSession,
  gateway: ScriptedGateway,
  oldBody: string,
): Promise<void> {
  gateway.decisions = [finalDecision()];
  gateway.deltas = ["old answer"];
  const events = await postChat(app, {
    session_id: session.id,
    message: oldBody,
    client_request_id: "turn-old",
  });
  expect(events.at(-1)?.type).toBe("completed");
}

function seedMemoryFromOldTurn(
  business: ReturnType<typeof openBusinessDb>,
  sessionId: string,
  id: string,
  body: string,
) {
  const rows = listMessages(business.orm, sessionId);
  const user = rows.find((message) => message.role === "user");
  const assistant = rows.find(
    (message) => message.role === "assistant" && message.turnId === user?.turnId,
  );
  if (!user || !assistant) throw new Error("missing completed Web source");
  business.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: "memory",
      summary: "safe preview",
      tags: "[]",
      kinds: "[]",
      body,
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
      visibility: "session_private",
    })
    .run();
  business.orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId: user.turnId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    })
    .run();
}

function memoryBodyRef(input: CompleteInput): string {
  const item = lastObservation(input.messages, "memory.query")?.value?.items?.[0] as
    | { bodyRef?: unknown }
    | undefined;
  if (typeof item?.bodyRef !== "string") throw new Error("memory.query observation lacks bodyRef");
  return item.bodyRef;
}

/** 第二个完成轮：脚本 history.query → history.read → final(generate)。 */
async function runEvidenceTurn(
  app: WebApp,
  session: WebSession,
  gateway: ScriptedGateway,
  marker: string,
): Promise<WebEvent[]> {
  gateway.completeCalls.length = 0;
  gateway.streamCalls.length = 0;
  gateway.deltas = ["evidence answer"];
  gateway.decisions = [
    { kind: "invoke", name: "history.query", arguments: { query: marker } },
    (input: CompleteInput) => ({
      kind: "invoke",
      name: "history.read",
      arguments: { bodyRef: historyBodyRef(input), offset: 0, limit: 4096 },
    }),
    finalDecision(),
  ];
  const events = await postChat(app, {
    session_id: session.id,
    message: "follow-up question",
    client_request_id: "turn-evidence",
  });
  expect(events.at(-1)?.type).toBe("completed");
  return events;
}

/** QQ 宿主夹具（思路与 bot-context-source.test.ts 相同，不导入该测试文件）。 */
function qqSetup(
  input: { mode?: RuntimeConfig["p5_config"]["retrieval_mode"]; gateway?: ModelGateway } = {},
) {
  const h = runtimeFixtureBusiness(openBusinessDb(), "reply-model");
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000);
  const now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "context" });
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
  if (created.kind !== "saved") throw new Error("qq binding not saved");
  const binding = insertQqBinding(h.orm, created.binding);
  const captured = captureQqTask(binding, "reply");
  if (captured.kind !== "captured") throw new Error("qq snapshot not captured");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("missing agent row");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = input.mode ?? "off";
  const journal = new ConversationEventRepository(h.db);
  const outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("missing conversation");
  const gateway: ModelGateway = input.gateway ?? {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete() {
      throw new Error("qq fixture scripts no model decisions");
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const agentRuntime = createAgentRuntime({
    gateway,
    repository: new AgentRunRepository(h.db),
  });
  const buildSource = (tier: "judgement" | "reply") => {
    const spec: AgentSpec = {
      id: "test.bot",
      model: tier === "reply" ? "reply-model" : "judge-model",
      context: "conversation",
      instructions: "",
      availableActions: [],
      limits: { steps: 16 },
    };
    const source = new BotContextSource({
      db: h.db,
      orm: h.orm,
      gateway,
      agentRuntime,
      journal,
      outbox,
      conversationId: conversation.id,
      binding,
      snapshot: captured.snapshot,
      scheme,
      runtime,
      spec,
      path: "direct_reply",
      decisionTier: tier,
      targets: () => [{ id: "alice", speakerId: "20002" }],
      assertCurrent() {},
      now: () => now,
    });
    spec.availableActions = source.actions.map((action) => action.description);
    return source;
  };
  const seed = (text: string) => {
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
        occurredAtSeconds: seconds,
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
        occurredAtSeconds: seconds,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return { h, binding, conversation, buildSource, seed, now, runtime, agentRuntime, journal };
}

function seedQqMemory(f: ReturnType<typeof qqSetup>, body: string) {
  const eventKey = f.seed("synthetic QQ memory source");
  const event = f.h.orm
    .select()
    .from(schema.qqEvents)
    .where(eq(schema.qqEvents.eventKey, eventKey))
    .get()!;
  const id = crypto.randomUUID();
  const scopeKey = qqMemoryScopeKey({
    kind: "qq",
    accountId: f.binding.accountId,
    conversationKind: f.binding.kind,
    peerId: f.binding.peerId,
    agentId: f.binding.agentId,
  });
  f.h.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: "QQ memory",
      summary: "summary",
      tags: "[]",
      kinds: "[]",
      body,
      scope: "reality_user",
      scopeKey,
      status: "active",
      configSnapshot: "{}",
      createdAt: f.now,
      visibility: "session_private",
    })
    .run();
  f.h.orm
    .insert(schema.qqMemorySources)
    .values({
      memoryId: id,
      eventKey,
      scopeKey,
      conversationKey: qqConversationKey({
        accountId: f.binding.accountId,
        kind: f.binding.kind,
        peerId: f.binding.peerId,
      }),
      messageId: event.messageId,
      occurredAtSeconds: event.occurredAtSeconds,
      speakerKind: event.speakerKind,
      speakerId: event.speakerId,
    })
    .run();
  return id;
}

async function runQqMemory(
  f: ReturnType<typeof qqSetup>,
  gateway: ScriptedGateway,
  extraActions: readonly BuiltInAction[] = [],
) {
  const source = f.buildSource("reply");
  const actions = [...source.actions, ...extraActions];
  const spec: AgentSpec = {
    id: "test.qq-memory",
    model: "reply-model",
    context: "conversation",
    instructions: "",
    availableActions: actions.map((action) => action.description),
    limits: { steps: 16 },
  };
  const result = await f.agentRuntime.run(spec, {
    owner: {
      kind: "qq_binding",
      id: f.binding.id,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    },
    context: source,
    actions,
    authorizedTargets: ["alice"],
    outputMode: "buffered",
    signal: new AbortController().signal,
    requestId: crypto.randomUUID(),
  });
  return { result, calls: gateway.completeCalls };
}

describe("conversation evidence hosts", () => {
  it("qq host restores exact ordered raw provenance only on protected summary.read", async () => {
    const h = qqSetup();
    const first = h.seed("first provenance body");
    const second = h.seed("second provenance body");
    const sources = [first, second].map((id, index) => ({
      kind: "qq_observation",
      id,
      revision: createHash("sha256")
        .update(index === 0 ? "first provenance body" : "second provenance body")
        .digest("hex"),
      expiresAt: new Date(Date.parse(h.now) + 3600_000).toISOString(),
    }));
    const original = JSON.stringify(sources.map((ref) => [ref.kind, ref.id, ref.revision]));
    const reverse = JSON.stringify(
      [...sources].reverse().map((ref) => [ref.kind, ref.id, ref.revision]),
    );
    const compact = `qq-record:${createHash("sha256").update(original).digest("base64url")}`;
    const reversedCompact = `qq-record:${createHash("sha256").update(reverse).digest("base64url")}`;
    expect(reversedCompact).not.toBe(compact);
    const pkg = {
      facts: [
        {
          kind: "fact" as const,
          speaker: "20002",
          text: "REVERSIBLE_SUMMARY_FACT",
          source_ids: [compact, reversedCompact],
        },
      ],
      provenance: { [compact]: original, [reversedCompact]: reverse },
      sources,
      fromSeq: 1,
      throughSeq: 2,
      fromSeconds: 1,
      throughSeconds: 2,
      at: h.now,
    };
    expect(
      saveQqConversationSummary(h.h.orm, {
        conversationId: h.conversation.id,
        agentId: h.binding.agentId,
        throughSeq: 2,
        coveredSeq: 2,
        packages: [pkg],
        modelName: "reply-model",
        configSnapshot: h.runtime.p5_config,
        estimatedTokens: 1,
        at: h.now,
        expected: null,
        assertCurrent() {},
      }),
    ).toBe(true);
    const source = h.buildSource("reply");
    const material = await source.read({ signal: new AbortController().signal, observations: [] });
    expect(JSON.stringify(material.history)).toContain(compact);
    expect(JSON.stringify(material.history)).not.toContain(original);
    const query = source.actions.find((action) => action.description.name === "summary.query");
    const read = source.actions.find((action) => action.description.name === "summary.read");
    if (!query || !read) throw new Error("fixture: original summary actions missing");
    const context: ActionContext = {
      owner: {
        kind: "qq_binding",
        id: h.binding.id,
        userId: DEFAULT_USER_ID,
        agentId: h.binding.agentId,
      },
      runId: crypto.randomUUID(),
      signal: new AbortController().signal,
    };
    const found = await query.execute({ query: "REVERSIBLE_SUMMARY_FACT" }, context);
    const items = (found.value as { items: { bodyRef: string }[] }).items;
    expect(items).toHaveLength(1);
    const page = await read.execute({ bodyRef: items[0]!.bodyRef, limit: 4096 }, context);
    const text = (page.value as { items: { text: string }[] }).items[0]!.text;
    const facts = JSON.parse(text) as {
      kind: "fact";
      speaker: string;
      text: string;
      source_ids: string[];
    }[];
    expect(facts[0]!.source_ids).toEqual([compact, reversedCompact]);
    const decoded = resolveQqSummaryProvenance({
      facts,
      sources: pkg.sources,
      provenance: pkg.provenance,
    });
    expect(decoded[0]!.source_ids).toEqual([original, reverse]);
    h.h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(first);
    await expect(
      read.execute({ bodyRef: items[0]!.bodyRef, limit: 4096 }, context),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  });

  it("QQ host reads current private memory and blocks retained evidence after mode ABA", async () => {
    const gateway = new ScriptedGateway();
    gateway.loadedContextCapacity = async () => 65536;
    const f = qqSetup({ mode: "standard", gateway });
    const secret = "QQ-PRIVATE-MEMORY-SECRET";
    let positiveReadReached = false;
    let modeAbaCompleted = false;
    seedQqMemory(f, secret);
    gateway.decisions = [
      { kind: "invoke", name: "memory.query", arguments: { query: "" } },
      (input: CompleteInput) => ({
        kind: "invoke",
        name: "memory.read",
        arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
      }),
      (input: CompleteInput) => {
        expect(JSON.stringify(lastObservation(input.messages, "memory.read"))).toContain(secret);
        positiveReadReached = true;
        expect(
          f.journal.setMemoryReadMode(f.conversation.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind,
        ).toBe("saved");
        expect(
          f.journal.setMemoryReadMode(f.conversation.id, DEFAULT_USER_ID, "current_conversation", 2)
            ?.kind,
        ).toBe("saved");
        modeAbaCompleted = true;
        return {
          kind: "final",
          outputs: [{ kind: "inline", targetId: "alice", text: "not sent" }],
        };
      },
    ];
    await expect(runQqMemory(f, gateway)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(positiveReadReached).toBe(true);
    expect(modeAbaCompleted).toBe(true);
    expect(
      gateway.completeCalls.some((call) => JSON.stringify(call.messages).includes(secret)),
    ).toBe(true);
    expect(gateway.streamCalls).toHaveLength(0);
  });

  it("QQ rendered carrier exclusion never masks the same source in common material", async () => {
    const f = qqSetup();
    const eventKey = f.seed("shared source");
    const ref = {
      kind: "qq_observation",
      id: eventKey,
      revision: createHash("sha256").update("shared source").digest("hex"),
      expiresAt: new Date(Date.parse(f.now) + 3600_000).toISOString(),
    };
    const source = f.buildSource("reply");
    await source.read({
      signal: new AbortController().signal,
      observations: [
        { id: crypto.randomUUID(), name: "sticker.search", value: {}, sources: [ref] },
        { id: crypto.randomUUID(), name: "history.read", value: {}, sources: [ref] },
      ],
    });
    f.h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(eventKey);
    expect(() => source.assertRenderedSources([ref])).toThrow();
  });

  for (const revokeMemory of [false, true]) {
    it(`QQ rendered sticker carrier keeps retained memory currentness when mode ABA=${revokeMemory}`, async () => {
      const gateway = new ScriptedGateway();
      gateway.loadedContextCapacity = async () => 65536;
      const f = qqSetup({ mode: "standard", gateway });
      const secret = "QQ-MIXED-CARRIER-MEMORY";
      seedQqMemory(f, secret);
      const collection = createQqStickerCollection(f.h.orm, { name: "synthetic" });
      const stickerId = crypto.randomUUID();
      importQqSticker(f.h.orm, {
        id: stickerId,
        copy: { fileName: `${stickerId}.png`, byteSize: 64, mediaType: "image" },
        name: "synthetic",
        width: 64,
        height: 64,
        collectionIds: [collection.id],
      });
      setQqStickerEnabled(f.h.orm, stickerId, true);
      const revision = readQqStickerAssetRow(f.h.orm, stickerId)!.updatedAt;
      const sticker: BuiltInAction = {
        description: {
          name: "sticker.search",
          capability: "test",
          description: "synthetic carrier for source-boundary test",
          effect: "read",
          parameters: { type: "object", properties: {} },
        },
        async execute() {
          return {
            value: { items: [{ id: stickerId }] },
            sources: [{ kind: "qq_sticker", id: stickerId, revision }],
          };
        },
      };
      let readReached = false;
      let mutationReached = false;
      gateway.decisions = [
        { kind: "invoke", name: "memory.query", arguments: { query: "" } },
        (input: CompleteInput) => ({
          kind: "invoke",
          name: "memory.read",
          arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
        }),
        (input: CompleteInput) => {
          expect(JSON.stringify(lastObservation(input.messages, "memory.read"))).toContain(secret);
          readReached = true;
          return { kind: "invoke", name: "sticker.search", arguments: {} };
        },
        (input: CompleteInput) => {
          expect(JSON.stringify(lastObservation(input.messages, "sticker.search"))).toContain(
            stickerId,
          );
          setQqStickerEnabled(f.h.orm, stickerId, false);
          if (revokeMemory) {
            expect(
              f.journal.setMemoryReadMode(f.conversation.id, DEFAULT_USER_ID, "agent_shared", 1)
                ?.kind,
            ).toBe("saved");
            expect(
              f.journal.setMemoryReadMode(
                f.conversation.id,
                DEFAULT_USER_ID,
                "current_conversation",
                2,
              )?.kind,
            ).toBe("saved");
          }
          mutationReached = true;
          return { kind: "none" };
        },
      ];
      if (revokeMemory) {
        await expect(runQqMemory(f, gateway, [sticker])).rejects.toMatchObject({
          code: "CONTEXT_SOURCE_INVALID",
        });
      } else {
        expect((await runQqMemory(f, gateway, [sticker])).result.status).toBe("no_output");
      }
      expect(readReached).toBe(true);
      expect(mutationReached).toBe(true);
      expect(gateway.completeCalls).toHaveLength(4);
    });
  }

  it("QQ host reads explicit public derived memory but blocks stale grant after ABA", async () => {
    const gateway = new ScriptedGateway();
    gateway.loadedContextCapacity = async () => 65536;
    const f = qqSetup({ mode: "standard", gateway });
    const session = createSession(f.h.orm, "private Web source", { modelName: "reply-model" });
    const old = prepareTurn(f.h.orm, session.id, "PRIVATE WEB RAW SOURCE BODY ONLY", "web-source");
    saveCompletedAssistantMessage(
      f.h.orm,
      session.id,
      "PRIVATE WEB ANSWER",
      "web-source",
      old.generationToken!,
    );
    const id = crypto.randomUUID(),
      secret = "QQ-PUBLIC-DERIVED";
    let positiveReadReached = false;
    let rawDeniedReached = false;
    let grantAbaCompleted = false;
    seedMemoryFromOldTurn(f.h, session.id, id, secret);
    f.h.orm.transaction(
      (tx) =>
        setMemoryVisibility(tx, DEFAULT_AGENT_ID, id, {
          visibility: "public",
          recipient_agent_ids: [DEFAULT_AGENT_ID],
          expected_revision: 1,
        }),
      { behavior: "immediate" },
    );
    expect(
      f.journal.setMemoryReadMode(f.conversation.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind,
    ).toBe("saved");
    gateway.decisions = [
      { kind: "invoke", name: "history.query", arguments: { query: "PRIVATE WEB RAW" } },
      (input: CompleteInput) => {
        expect(lastObservation(input.messages, "history.query")?.value?.items ?? []).toEqual([]);
        rawDeniedReached = true;
        return { kind: "invoke", name: "memory.query", arguments: { query: "" } };
      },
      (input: CompleteInput) => ({
        kind: "invoke",
        name: "memory.read",
        arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
      }),
      (input: CompleteInput) => {
        expect(JSON.stringify(lastObservation(input.messages, "memory.read"))).toContain(secret);
        positiveReadReached = true;
        f.h.orm.transaction(
          (tx) => {
            setMemoryVisibility(tx, DEFAULT_AGENT_ID, id, {
              visibility: "session_private",
              recipient_agent_ids: [],
              expected_revision: 2,
            });
            setMemoryVisibility(tx, DEFAULT_AGENT_ID, id, {
              visibility: "public",
              recipient_agent_ids: [DEFAULT_AGENT_ID],
              expected_revision: 3,
            });
          },
          { behavior: "immediate" },
        );
        grantAbaCompleted = true;
        return {
          kind: "final",
          outputs: [{ kind: "inline", targetId: "alice", text: "not sent" }],
        };
      },
    ];
    await expect(runQqMemory(f, gateway)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(positiveReadReached).toBe(true);
    expect(rawDeniedReached).toBe(true);
    expect(grantAbaCompleted).toBe(true);
    expect(
      gateway.completeCalls.some((call) => JSON.stringify(call.messages).includes(secret)),
    ).toBe(true);
    expect(
      gateway.completeCalls.some((call) =>
        JSON.stringify(call.messages).includes("PRIVATE WEB RAW SOURCE BODY ONLY"),
      ),
    ).toBe(false);
    expect(gateway.streamCalls).toHaveLength(0);
  });

  it("web host reads same-conversation memory and retains only authorized material", async () => {
    const { business, session, gateway } = webSetup();
    const app = createApp({ business, gateway });
    await runOldTurn(app, session, gateway, "memory source");
    const secret = "SYNTHETIC-MEMORY-HOST-BODY";
    seedMemoryFromOldTurn(business, session.id, crypto.randomUUID(), secret);
    gateway.completeCalls.length = 0;
    gateway.streamCalls.length = 0;
    gateway.decisions = [
      { kind: "invoke", name: "memory.query", arguments: { query: "" } },
      (input: CompleteInput) => ({
        kind: "invoke",
        name: "memory.read",
        arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
      }),
      finalDecision(),
    ];
    const events = await postChat(app, {
      session_id: session.id,
      message: "ask",
      client_request_id: "memory-host",
    });
    expect(events.at(-1)?.type).toBe("completed");
    expect(
      gateway.completeCalls.some((call) => JSON.stringify(call.messages).includes(secret)),
    ).toBe(true);
    expect(gateway.streamCalls.some((call) => JSON.stringify(call.messages).includes(secret))).toBe(
      true,
    );
  });

  it("web host rejects retained memory after mode ABA before streaming or publishing", async () => {
    const { business, session, gateway } = webSetup();
    const app = createApp({ business, gateway, resolveSource: () => "available" as const });
    await runOldTurn(app, session, gateway, "memory source");
    const secret = "SYNTHETIC-MEMORY-REVOKED-BODY";
    seedMemoryFromOldTurn(business, session.id, crypto.randomUUID(), secret);
    const journal = new ConversationEventRepository(business.db);
    const canonical = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
    gateway.completeCalls.length = 0;
    gateway.streamCalls.length = 0;
    gateway.decisions = [
      { kind: "invoke", name: "memory.query", arguments: { query: "" } },
      (input: CompleteInput) => ({
        kind: "invoke",
        name: "memory.read",
        arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
      }),
      () => {
        expect(
          journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind,
        ).toBe("saved");
        expect(
          journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "current_conversation", 2)?.kind,
        ).toBe("saved");
        return finalDecision();
      },
    ];
    const events = await postChat(app, {
      session_id: session.id,
      message: "ask",
      client_request_id: "memory-aba",
    });
    expect(events.at(-1)?.type).not.toBe("completed");
    expect(gateway.streamCalls.some((call) => JSON.stringify(call.messages).includes(secret))).toBe(
      false,
    );
  });

  it("web host reads an explicitly granted same-Agent public memory and rejects grant ABA before final send", async () => {
    const { business, session, gateway } = webSetup();
    const app = createApp({ business, gateway, resolveSource: () => "available" as const });
    const sourceSession = createSession(business.orm, "private source", { modelName: "model" });
    await runOldTurn(app, sourceSession, gateway, "private source text");
    const memoryId = crypto.randomUUID();
    const secret = "SYNTHETIC-PUBLIC-DERIVED-BODY";
    seedMemoryFromOldTurn(business, sourceSession.id, memoryId, secret);
    const publish = (visibility: string, recipients: string[], expected_revision: number) =>
      app.request(`/agents/${DEFAULT_AGENT_ID}/memory/entries/${memoryId}/visibility`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility, recipient_agent_ids: recipients, expected_revision }),
      });
    expect((await publish("public", [DEFAULT_AGENT_ID], 1)).status).toBe(200);
    const journal = new ConversationEventRepository(business.db);
    const canonical = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
    expect(journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind).toBe(
      "saved",
    );
    gateway.completeCalls.length = 0;
    gateway.streamCalls.length = 0;
    gateway.decisions = [
      { kind: "invoke", name: "history.query", arguments: { query: "private source text" } },
      (input: CompleteInput) => {
        expect(lastObservation(input.messages, "history.query")?.value?.items ?? []).toEqual([]);
        return { kind: "invoke", name: "memory.query", arguments: { query: "" } };
      },
      (input: CompleteInput) => ({
        kind: "invoke",
        name: "memory.read",
        arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
      }),
      () => {
        business.orm.transaction(
          (tx) => {
            setMemoryVisibility(tx, DEFAULT_AGENT_ID, memoryId, {
              visibility: "session_private",
              recipient_agent_ids: [],
              expected_revision: 2,
            });
            setMemoryVisibility(tx, DEFAULT_AGENT_ID, memoryId, {
              visibility: "public",
              recipient_agent_ids: [DEFAULT_AGENT_ID],
              expected_revision: 3,
            });
          },
          { behavior: "immediate" },
        );
        return finalDecision();
      },
    ];
    const events = await postChat(app, {
      session_id: session.id,
      message: "ask",
      client_request_id: "public-aba",
    });
    expect(
      gateway.completeCalls.some((call) => JSON.stringify(call.messages).includes(secret)),
    ).toBe(true);
    expect(events.at(-1)?.type).not.toBe("completed");
    expect(gateway.streamCalls.some((call) => JSON.stringify(call.messages).includes(secret))).toBe(
      false,
    );
    gateway.completeCalls.length = 0;
    gateway.streamCalls.length = 0;
    gateway.decisions = [
      { kind: "invoke", name: "memory.query", arguments: { query: "" } },
      (input: CompleteInput) => ({
        kind: "invoke",
        name: "memory.read",
        arguments: { bodyRef: memoryBodyRef(input), offset: 0, limit: 4096 },
      }),
      finalDecision(),
    ];
    const fresh = await postChat(app, {
      session_id: session.id,
      message: "retry with fresh grant",
      client_request_id: "public-fresh",
    });
    expect(fresh.at(-1)?.type).toBe("completed");
    expect(gateway.streamCalls.some((call) => JSON.stringify(call.messages).includes(secret))).toBe(
      true,
    );
  });

  it("web host: history.read body reaches the next model request", async () => {
    const { business, session, gateway } = webSetup();
    const app = createApp({ business, gateway, resolveSource: () => "available" as const });
    const marker = "OLD-BODY-MARKER-7a1c";
    const oldBody = oldTurnBody(marker);
    await runOldTurn(app, session, gateway, oldBody);
    const events = await runEvidenceTurn(app, session, gateway, marker);
    const actionNames = events
      .filter((event) => event.type === "action_result")
      .map((event) => event.name);
    expect(actionNames).toContain("history.query");
    expect(actionNames).toContain("history.read");
    // read 之后的决策请求与生成请求都要带上工具正文（不是目录摘要）。
    const lastComplete = gateway.completeCalls.at(-1);
    const lastStream = gateway.streamCalls.at(-1);
    if (!lastComplete || !lastStream) throw new Error("missing model request after history.read");
    expect(readTexts([lastComplete])).toContain(oldBody);
    expect(readTexts([lastStream])).toContain(oldBody);
  });

  it("web host: inspection is exact, revoked after the source message is deleted despite an all-available resolver", async () => {
    const { business, session, gateway } = webSetup();
    let resolverCalls = 0;
    const app = createApp({
      business,
      gateway,
      resolveSource: () => {
        resolverCalls++;
        return "available" as const;
      },
    });
    const marker = "OLD-BODY-MARKER-2b8e";
    const oldBody = oldTurnBody(marker);
    await runOldTurn(app, session, gateway, oldBody);
    const events = await runEvidenceTurn(app, session, gateway, marker);
    const started = events.find((event) => event.type === "started");
    if (!started?.runId) throw new Error("missing started run");
    const runId = started.runId;
    const repo = new AgentRunRepository(business.db);
    const run = repo.getRun(runId);
    if (!run) throw new Error("missing run");
    const step = run.steps.find((candidate) =>
      repo
        .getContext({ runId, stepId: candidate.stepId })
        ?.sources.some((source) => source.kind === "conversation_evidence"),
    );
    if (!step) throw new Error("no step retained conversation evidence");
    const inspect = async () => {
      const response = await app.request(`/v2/runs/${runId}/context/${step.stepId}`);
      expect(response.status).toBe(200);
      return (await response.json()) as { status: string };
    };
    const callsBefore = resolverCalls;
    const before = await inspect();
    expect(resolverCalls).toBeGreaterThan(callsBefore);
    expect(before.status).toBe("exact");
    const oldMessage = listMessages(business.orm, session.id).find(
      (message) => message.role === "user" && message.content.includes(marker),
    );
    if (!oldMessage) throw new Error("missing old user message");
    business.db.query("DELETE FROM messages WHERE id=?").run(oldMessage.id);
    const after = await inspect();
    expect(after.status).toBe("revoked");
  });

  it("qq host: memory off keeps history; judgement hides summary while reply installs it", () => {
    const h = qqSetup({ mode: "off" });
    const names = (tier: "judgement" | "reply") =>
      h.buildSource(tier).actions.map((action) => action.description.name);
    const judgement = names("judgement");
    expect(judgement).toContain("history.query");
    expect(judgement).toContain("history.read");
    expect(judgement.some((name) => name.startsWith("memory."))).toBe(false);
    // 判断档不能借摘要工具旁路回复档的水位包。
    expect(judgement.some((name) => name.startsWith("summary."))).toBe(false);
    const reply = names("reply");
    expect(reply).toContain("history.query");
    expect(reply).toContain("history.read");
    expect(reply).toContain("summary.query");
    expect(reply).toContain("summary.read");
    expect(reply.some((name) => name.startsWith("memory."))).toBe(false);
  });

  it("qq host: history.query/read returns the same conversation's original text with retrieval off", async () => {
    const h = qqSetup({ mode: "off" });
    const marker = "QQ-HISTORY-BODY-91d4";
    const body = `${marker} ${"q".repeat(48)}`;
    h.seed(body);
    const source = h.buildSource("reply");
    await source.read({ signal: new AbortController().signal, observations: [] });
    const query = source.actions.find((action) => action.description.name === "history.query");
    const read = source.actions.find((action) => action.description.name === "history.read");
    if (!query || !read) throw new Error("missing history actions");
    const owner: RunOwner = {
      kind: "qq_binding",
      id: h.binding.id,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const context: ActionContext = {
      owner,
      runId: crypto.randomUUID(),
      signal: new AbortController().signal,
    };
    const found = await query.execute({ query: marker }, context);
    expect(found.value).toMatchObject({ status: "ok" });
    const items = (found.value as { items: { id: string; summary: string; bodyRef: string }[] })
      .items;
    expect(items).toHaveLength(1);
    expect(items[0].summary).toContain(marker);
    const ref = JSON.parse(items[0].id) as [{ conversationId: string }, string, number];
    expect(ref[1]).toBe("history");
    expect(ref[0].conversationId).toBe(h.conversation.id);
    const page = await read.execute({ bodyRef: items[0].bodyRef, offset: 0, limit: 4096 }, context);
    expect(page.value).toMatchObject({ status: "ok" });
    const text = (page.value as { items: { text: string }[] }).items[0].text;
    expect(text).toBe(body);
  });
});
