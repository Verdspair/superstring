// H1 性能回归验收（ROOTBACKEND-PERFORMANCE-REVIEW factRowExists N+1）：水位压缩输入
// compressionRecords 对每条入站消息各发一次 qq_message_facts 存在性点查（源码 3794-3802，
// 在 messages.map 内经 3877 分支逐条 .get()）。修复后存在性判定必须合并为一次批量
// SELECT ... IN (SELECT value FROM json_each(?))（绑定的就是本次调用已收集的 eventKeys，
// 只做存在性、不做 TTL 判定），DB 查询次数不随消息条数线性增长；判定结果与逐条点查
// 完全一致：有 facts 行（含已过期）的消息 unavailable，真缺失行且原正文有效的消息
// legacy_partial。夹具走真实 BotContextSource.compressionRecords 入口（同
// qq-compression-text-relations 夹具同构），公开入口 read + 真实 compressionRecords
// 方法，不为测试新增生产导出。查询计数用 h.db.query 包装（与既有测试同手法），只计
// 绑定本会话 scope 的 qq_message_facts 存在性查询。

import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { CompressionRecord } from "../../src/server/agent/conversation-compression";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { contextDumps } from "../../src/server/db/json-text";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { recordQqMessageFact } from "../../src/server/db/qq-message-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import type { QqContextMessage } from "../../src/server/services/qq-context-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { QQ_COMPRESSION_DEFAULT } from "../../src/shared/contracts/qq";
import { closeHarnesses } from "../harness/onebot";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const handle of handles.splice(0)) handle.close();
});

/** 与 qq-compression-text-relations 同构的精简夹具：回复档 + 水位压缩。 */
function setup(input: { watermarkTrigger?: number } = {}) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "fact-query-bounded",
    compression: { ...QQ_COMPRESSION_DEFAULT, watermark_trigger: input.watermarkTrigger ?? 1 },
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
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete() {
      return JSON.stringify({ ids: [] });
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const agentRuntime = createAgentRuntime({
    gateway,
    repository: new AgentRunRepository(h.db),
  });
  const spec: AgentSpec = {
    id: "test.bot",
    model: "reply-model",
    context: "conversation",
    instructions: "respond concisely",
    availableActions: [],
    limits: { steps: 16 },
  };
  const buildSource = () =>
    new BotContextSource({
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
      decisionTier: "reply",
      targets: () => [{ id: "alice", speakerId: "20002" }],
      assertCurrent() {},
      now: () => now,
    });
  /** 种一条真实入站观察；noFact 跳过 facts 行（真缺失），factExpired 让行存在但已过期。 */
  const seed = (
    text: string,
    age: number,
    options: { noFact?: boolean; factExpired?: boolean } = {},
  ) => {
    const id = crypto.randomUUID();
    const occurredAt = seconds - age;
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: id,
        occurredAtSeconds: occurredAt,
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
        occurredAtSeconds: occurredAt,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    if (!options.noFact) {
      recordQqMessageFact(h.orm, {
        eventKey: id,
        groupCard: "阿林",
        groupCardSource: "wire",
        personalNickname: "林某",
        personalNicknameSource: "wire",
        legacyDisplayName: null,
        nameState: "known",
        parts: [{ kind: "text", text }],
        replyToMessageId: null,
        occurredAtSeconds: occurredAt,
      });
      if (options.factExpired) {
        h.db
          .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
          .run(new Date((seconds - 1) * 1000).toISOString(), id);
      }
    }
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return {
    ...h,
    source: buildSource(),
    newSource: buildSource,
    binding,
    conversation,
    seed,
    seconds,
    now,
  };
}

const compressionRecordsOf = (source: BotContextSource, messages: readonly QqContextMessage[]) =>
  (
    source as unknown as {
      compressionRecords(messages: readonly QqContextMessage[]): CompressionRecord[];
    }
  ).compressionRecords(messages);

const inboundMessage = (eventKey: string, text: string): QqContextMessage => ({
  speaker: "member",
  speakerId: "20002",
  text,
  occurredAtSeconds: 1,
  mediaNotes: [],
  mediaUnread: 0,
  sources: [{ kind: "qq_observation", id: eventKey, revision: "original" }],
});

interface FactQueryProbe {
  statements: { sql: string; bindings: unknown[] }[];
  /** 绑定本会话 scope 的 qq_message_facts 存在性查询执行次数。 */
  existenceQueries: number;
  /** 每次存在性查询的 json_each 键数（批量修复后单次查询绑定 N 个键）。 */
  boundKeyCounts: number[];
}

/**
 * 包装 h.db.query 计数 qq_message_facts 存在性查询：匹配 SQL 形状
 * （FROM qq_message_facts + JOIN qq_events + scope 绑定参数），对 .get/.all 执行计数。
 */
function instrumentFactQueries(h: ReturnType<typeof setup>): {
  probe: FactQueryProbe;
  restore: () => void;
} {
  const probe: FactQueryProbe = { statements: [], existenceQueries: 0, boundKeyCounts: [] };
  const originalQuery = h.db.query;
  const query = h.db.query.bind(h.db);
  h.db.query = ((statementSql: string, ...prepareArguments: unknown[]) => {
    const statement = Reflect.apply(query, h.db, [statementSql, ...prepareArguments]);
    // 精确匹配存在性语句形状（旧逐条 SELECT 1 与新批量 SELECT f.event_key 共有的
    // 别名 join）：drizzle 投影内部查询（eventById/projectOne 等）不产生这个别名形状，
    // 不误计入投影路径的合法查询。
    const isFactExistence =
      statementSql.includes("FROM qq_message_facts f JOIN qq_events e") &&
      !statementSql.includes("LEFT JOIN qq_observation_text") &&
      statementSql.includes("event_key");
    if (!isFactExistence) return statement;
    const count = (bindings: unknown[]) => {
      probe.existenceQueries += 1;
      probe.statements.push({ sql: statementSql, bindings });
      // 批量查询首参是 json_each 的键数组 JSON（keys, scope 四维）。
      const first = bindings[0];
      if (typeof first === "string" && first.startsWith("[")) {
        try {
          probe.boundKeyCounts.push((JSON.parse(first) as unknown[]).length);
        } catch {
          probe.boundKeyCounts.push(0);
        }
      } else {
        probe.boundKeyCounts.push(1);
      }
    };
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get" || property === "all") {
          return (...bindings: unknown[]) => {
            count(bindings);
            return Reflect.apply(
              target[property as "get" | "all"] as (...args: unknown[]) => unknown,
              target,
              bindings,
            );
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof h.db.query;
  return { probe, restore: () => (h.db.query = originalQuery) };
}

describe("压缩输入 facts 存在性判定有界查询（H1 N+1 修复）", () => {
  it.each([1, 16, 128] as const)(
    "存在性判定一次批量查询完成：%i 条消息，输出与逐条判定逐字相等",
    (count) => {
      const h = setup({ watermarkTrigger: 1 });
      // 三类来源交错：有 facts 行（含过期行）、真缺失行 —— 覆盖存在性分支与 legacy 分支。
      const keys: string[] = [];
      for (let index = 0; index < count; index += 1) {
        if (index % 3 === 0) keys.push(h.seed(`正文-${index}`, 30000));
        else if (index % 3 === 1) keys.push(h.seed(`过期-${index}`, 30000, { factExpired: true }));
        else keys.push(h.seed(`缺失-${index}`, 30000, { noFact: true }));
      }
      const source = h.newSource();
      const messages = keys.map((key, index) => inboundMessage(key, `原始正文-${index}`));
      const { probe, restore } = instrumentFactQueries(h);
      let records: CompressionRecord[];
      try {
        records = compressionRecordsOf(source, messages);
      } finally {
        restore();
      }
      expect(records).toHaveLength(count);
      // 存在性判定不随 N 线性发查询：批量修复后至多一次（投影路径不产生存在性查询）。
      expect(probe.existenceQueries).toBeLessThanOrEqual(1);
      if (probe.boundKeyCounts.length > 0) {
        expect(probe.boundKeyCounts[0]).toBe(keys.length);
      }
      // 输出逐字判定（与修复前逐条判定同义，不弱化健康语义）：
      // kind0 有有效 facts 行 → full 文字关系投影（发送时双名快照 + 正文片段，无 currentName）；
      // kind1 行存在但已过期 → unavailable（不回旧正文/名字）；kind2 真缺失行且原正文
      // 有效 → legacy_partial 沿原正文。occurredAtSeconds/seq 与说话人按原规则。
      for (const [index, record] of records.entries()) {
        const kind = index % 3;
        if (kind === 0) {
          expect(record.text).toBe(
            contextDumps({
              id: keys[index],
              platformMessageId: keys[index],
              seq: record.seq,
              occurredAtSeconds: h.seconds - 30000,
              completeness: "full",
              speaker: {
                role: "member",
                qq: "20002",
                groupCard: "阿林",
                personalNickname: "林某",
                legacyDisplayName: null,
                nameState: "known",
              },
              parts: [{ kind: "text", text: `正文-${index}` }],
              mentions: [],
              replyTo: null,
            }),
          );
          expect(record.speaker).toBe("20002");
          expect(record.seq).not.toBeNull();
        } else if (kind === 1) {
          expect(record.text).toBe(contextDumps({ completeness: "unavailable" }));
        } else {
          expect(record.text).toBe(
            contextDumps({ completeness: "legacy_partial", text: `原始正文-${index}` }),
          );
        }
      }
    },
  );

  it("边界：无 eventKey 的消息不触发任何 facts 存在性查询", () => {
    const h = setup();
    const source = h.newSource();
    const { probe, restore } = instrumentFactQueries(h);
    try {
      const records = compressionRecordsOf(source, [
        {
          speaker: "assistant",
          speakerId: null,
          text: "assistant history",
          occurredAtSeconds: 1,
          mediaNotes: [],
          mediaUnread: 0,
          sources: [],
        },
      ]);
      expect(records).toHaveLength(1);
    } finally {
      restore();
    }
    expect(probe.existenceQueries).toBe(0);
  });
});
