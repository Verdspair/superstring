// P0 离线验收环境（0.4.0）：OneBot 整链夹具。
//
// 把「合成事件 → 唤醒 → 主 Agent → 生成 → 提交出站意图 → 投递」装进一个可脚本化的夹具，并记录
// 三样东西：模型调用（`model.calls`）、出站意图（`outbox`）、真正发出去的消息（`sent`）。
// 不接网络、不读真实数据：模型是脚本桩（见 `./model.ts`），发送端是记录桩，时间由 `clock` 控制。
//
// 用法：
//   const h = createOneBotHarness({ model: [decideGenerate("20002"), say("在的")] });
//   h.receive({ id: "1", speaker: "20002", addressed: true });
//   await h.activate("direct_reply");
//   await h.deliver();
//   expect(h.sent).toHaveLength(1);
//   closeHarnesses();   // 或 afterEach(closeHarnesses)

import { eq } from "drizzle-orm";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { ModelPort } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  correctMemory as correctMemoryEntry,
  memoryRevision,
} from "../../src/server/db/memory-content-repository";
import { entries } from "../../src/server/db/memory-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  createQqScheme,
  type QqSchemeRow,
  schemePrompts,
  schemeRhythm,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  immediate,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../src/server/services/onebot-connection";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  qqConversationKey,
  qqConversationScopeOf,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { recordInbound } from "../../src/server/services/qq-intake";
import type { QqMediaReadAdapter } from "../../src/server/services/qq-media-reader";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import type { QqSendPort } from "../../src/server/services/qq-send-transport";
import type { MemoryContentResponse } from "../../src/shared/contracts";
import { type ModelStep, type ScriptedModel, scriptedModel } from "./model";

/** 发送端每次返回什么；默认全部"确认送达"。 */
export type SendOutcome = "confirmed" | "failed" | "unknown" | "not_sent";

export interface ReceiveInput {
  /** 平台消息 id（去重键的一部分）。 */
  readonly id: string;
  readonly text?: string;
  /** 群聊里是发言人；私聊可省略（默认用 peer）。 */
  readonly speaker?: string;
  /** 明确 @ 本账号（私聊不需要）。 */
  readonly addressed?: boolean;
  /** 引用某条消息（回复她时被认作"被叫到"）。 */
  readonly replyTo?: string;
  /** 附一张图（上游文件引用）；图片只在主 Agent 显式调用 `media.describe` 时被读取。 */
  readonly image?: string;
}

export interface OneBotHarnessOptions {
  readonly kind?: "group" | "private";
  /** 按发言人分开回答；默认开。 */
  readonly splitBySpeaker?: boolean;
  readonly triggers?: Partial<
    Record<"direct_reply" | "follow_up" | "chiming_in" | "idle_topic", boolean>
  >;
  readonly mergeWindowSeconds?: number;
  readonly maxRecomputeCount?: number;
  /** 主动发言门槛；默认沿用方案默认（6）。 */
  readonly initiativeMinScore?: number;
  /** 起始时钟（秒）。 */
  readonly nowSeconds?: number;
  readonly accountId?: string;
  readonly peerId?: string;
  /** 群聊默认发言人。 */
  readonly member?: string;
  /** 会话模型名；判断模型默认叫 `judge-model`。 */
  readonly conversationModel?: string;
  readonly judgementModelName?: string | null;
  /** 脚本步骤（自动包成 scriptedModel）或自带端口。 */
  readonly model?: readonly ModelStep[] | Partial<ModelPort>;
  readonly sendOutcomes?: readonly SendOutcome[];

  readonly stickersAvailable?: boolean;
  /**
   * 视觉桩的答复，按序取、用完重复最后一项：`"fail"` 表示这次读取失败，字符串是媒体说明。
   * 不传＝媒体工具不接线（图片只记录、没有读取工具，和未配置视觉模型的安装一致）。
   */
  readonly vision?: readonly ("fail" | string)[];
  /** 媒体工具（media.list/describe/note.read）是否接线；默认跟随 `vision` 给没给。 */
  readonly mediaEnabled?: boolean;
  /** 模型的容量（字节口径）。默认 65536。 */
  readonly capacity?: number;
  readonly onDiagnostic?: ConstructorParameters<typeof OneBotHost>[0]["onDiagnostic"];
}

export interface OneBotHarness {
  readonly db: ReturnType<typeof openBusinessDb>["db"];
  readonly orm: ReturnType<typeof openBusinessDb>["orm"];
  readonly clock: { seconds: number };
  readonly journal: ConversationEventRepository;
  readonly wakes: WakeRepository;
  readonly outbox: OutboundIntentRepository;
  readonly runs: AgentRunRepository;
  readonly adapter: OneBot11Adapter;
  readonly host: OneBotHost;
  readonly scheme: { id: string; revision: number };
  readonly bindingId: string;
  readonly model: ScriptedModel | null;
  /** 真正交给了发送端的请求。 */
  readonly sent: OneBotSendRequest[];
  readonly sendResults: OneBotSendResult[];
  now(): string;
  advance(seconds: number): void;
  receive(input: ReceiveInput): unknown;
  /** 领取一次唤醒并跑完；没有可领的唤醒时返回 null。 */
  activate(cause?: string): Promise<unknown>;
  /** 投递所有待发的出站意图；返回处理的条数。 */
  deliver(): Promise<number>;
  /** 跑一次冷场扫描（定时宿主做的事）；返回本次的排程与跳过原因。 */
  sweep(): { scheduled: readonly unknown[]; skipped: readonly unknown[] };
  /**
   * 视觉调用的记录：模型名与随图发出的那段说明（方案「媒体」槽位）。
   * 只有主 Agent 显式调用 `media.describe` 才会增加；入站不再自动读图（ADR0019 §8.11）。
   */
  readonly visionCalls: readonly { model: string; prompt: string }[];
  /** 这个绑定对应的 OneBot 会话 id（重排唤醒、诊断查询用）。 */
  readonly conversationId: string;
  /** 最近一条入站消息落在会话里的序号（重排同一个机会时要原样传回）。 */
  readonly lastEventSeq: number;
  /**
   * 造一条本会话的长期记忆 **以及它的观察来源**（不经过整理器）：返回记忆 id，
   * 场景据此让脚本化的选择器选中它。`name`/`summary` 决定关键词检索能否命中。
   */
  memory(body: string, options?: { name?: string; summary?: string; ageSeconds?: number }): string;
  /** 人工纠正：旧行退休、返回新的更正文案（旧正文不可再被选中）。 */
  correctMemory(
    id: string,
    fields: { name: string; summary: string; tags: string[]; body: string },
  ): MemoryContentResponse;
  /** 给本会话绑定的助手授权一份资料，返回文档 id。 */
  knowledge(name: string, body: string): string;
  /** 撤掉资料授权：下一个**新的**读取不再包含它（失败关闭）。 */
  revokeKnowledge(id: string): void;
  /** 与 `BotContextSource` 同口径的"当前观察序列"（入站/媒体修订/出站的最大序号）。 */
  observedSeq(): number;
  /** 丢掉进程内的宿主／运行时／投递器，只留数据库——模拟重启。 */
  restart(): void;
  close(): void;
}

const harnesses = new Set<OneBotHarness>();

/** 测试收尾用：关掉本轮创建的全部夹具（隔离库）。 */
export function closeHarnesses(): void {
  for (const harness of [...harnesses]) harness.close();
}

function sendResult(outcome: SendOutcome, index: number): OneBotSendResult {
  if (outcome === "confirmed") return { kind: "confirmed", messageId: `mock-${index}` };
  if (outcome === "failed") return { kind: "failed", retcode: 1200 };
  if (outcome === "not_sent") return { kind: "not_sent", reason: "not_ready" };
  return { kind: "unknown", reason: "transport_error" };
}

export function createOneBotHarness(options: OneBotHarnessOptions = {}): OneBotHarness {
  const kind = options.kind ?? "group";
  const accountId = options.accountId ?? "10001";
  const peerId = options.peerId ?? (kind === "group" ? "30003" : "20002");
  const member = options.member ?? "20002";
  const conversationModel = options.conversationModel ?? "reply-model";
  const clock = { seconds: options.nowSeconds ?? 2_000_000_000 };
  const now = () => new Date(clock.seconds * 1000).toISOString();

  const handle = openBusinessDb();
  const { db, orm } = handle;
  ensureDefaults(orm, conversationModel);
  updateQqSettings(orm, {
    accountId,
    enabled: true,
    ...(options.judgementModelName === null
      ? {}
      : { judgementModelName: options.judgementModelName ?? "judge-model" }),
    expectedRevision: 1,
  });
  const scheme = createQqScheme(orm, {
    name: `${kind}-harness`,
    reply: { split_by_speaker: options.splitBySpeaker ?? true },
    triggers: {
      direct_reply: options.triggers?.direct_reply ?? true,
      follow_up: options.triggers?.follow_up ?? true,
      chiming_in: options.triggers?.chiming_in ?? true,
      idle_topic: options.triggers?.idle_topic ?? true,
    },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      merge_window_seconds: options.mergeWindowSeconds ?? 2,
      max_recompute_count: options.maxRecomputeCount ?? 1,
      ...(options.initiativeMinScore === undefined
        ? {}
        : { initiative_min_score: options.initiativeMinScore }),
    },
  });
  const bindingId = "11111111-1111-4111-8111-111111111111";
  orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId,
      conversationKind: kind,
      peerId,
      agentId: DEFAULT_AGENT_ID,
      schemeId: scheme.id,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();

  const journal = new ConversationEventRepository(db);
  const wakes = new WakeRepository(db);
  const outbox = new OutboundIntentRepository(db);
  const runs = new AgentRunRepository(db);
  const scripted = Array.isArray(options.model)
    ? scriptedModel(options.model as readonly ModelStep[])
    : null;
  const port: Partial<ModelPort> =
    scripted !== null ? scripted.port : ((options.model as Partial<ModelPort> | undefined) ?? {});
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => options.capacity ?? 65536,
  };

  const sent: OneBotSendRequest[] = [];
  const sendResults: OneBotSendResult[] = [];
  const outcomes = options.sendOutcomes ?? ["confirmed"];
  const sendPort: QqSendPort = {
    async send(request) {
      sent.push(request);
      const outcome = outcomes[Math.min(sent.length - 1, outcomes.length - 1)] ?? "confirmed";
      const result = sendResult(outcome, sent.length);
      sendResults.push(result);
      return result;
    },
  };

  // 媒体（ADR0019 §8.11）：入站不再自动读图，读取只在主 Agent 显式调用媒体工具时发生。
  // 宿主拿到的是一个合成适配器：每次 `media.describe` 花一次视觉调用、结果按 `vision` 选项给；
  // 缓存复用、尝试计数、补充重试全部走宿主与读取器的真实代码，这里只替换视觉模型本身。
  const visionOutcomes = options.vision;
  const visionCalls: { model: string; prompt: string }[] = [];
  const mediaOn = options.mediaEnabled ?? visionOutcomes !== undefined;
  if (mediaOn) {
    orm
      .update(schema.organizationSettings)
      .set({ visionModelName: "vision-stub" })
      .where(eq(schema.organizationSettings.id, 1))
      .run();
  }
  let visionIndex = 0;
  const adapterFor = (config: {
    mediaPrompt: string;
    frames: number;
    maxDimension: number;
  }): QqMediaReadAdapter => ({
    capabilities: ["image"] as const,
    async read(input): Promise<string> {
      visionCalls.push({ model: input.model, prompt: config.mediaPrompt });
      const outcome = visionOutcomes?.[Math.min(visionIndex, visionOutcomes.length - 1)] ?? "fail";
      visionIndex += 1;
      if (outcome === "fail") throw new Error("HARNESS_VISION_FAILED");
      return outcome;
    },
  });
  let lastSeq = 0;
  const observedSeq = (): number => {
    const conversation = journal.ensureOneBot(bindingId);
    if (!conversation) return 0;
    return (
      db
        .query(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_events WHERE conversation_id=? AND kind IN ('inbound','media_revision','outbound')",
        )
        .get(conversation.id) as { seq: number }
    ).seq;
  };

  // 这一层是"进程内状态"：`restart()` 丢掉它、只留库——重启恢复场景就靠它把
  // "在内存里的宿主"和"已经落库的事实"分开。
  const build = () => {
    const runtime = new AgentRuntime({
      repository: runs,
      now,
      model: {
        complete: async () => '{"kind":"none"}',
        async *streamText() {
          yield "";
        },
        completeMultimodal: async () => "",
        ...port,
      },
    });
    const adapter = new OneBot11Adapter({ orm, journal, wakes, nowSeconds: () => clock.seconds });
    const host = new OneBotHost({
      orm,
      journal,
      wakes,
      outbox,
      agentRuntime: runtime,
      gateway,
      stickers: { counts: ["confirmed"], isAvailable: () => options.stickersAvailable ?? false },
      policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600 }),
      now,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      // 与运行时同构：媒体工具按方案取提示词与帧参数；合成适配器只替换视觉模型本身。
      ...(mediaOn
        ? {
            mediaEnabled: () => true,
            mediaAdapter: (scheme: QqSchemeRow) =>
              adapterFor({
                mediaPrompt: schemePrompts(scheme).media,
                frames: schemeRhythm(scheme).media_frame_count,
                maxDimension: schemeRhythm(scheme).media_max_dimension,
              }),
          }
        : {}),
    });
    const delivery = new OutboundDelivery({
      orm,
      repository: outbox,
      journal,
      port: sendPort,
      stickerFile: () => null,
      authorize: () => true,
      now,
    });
    return { adapter, host, delivery };
  };
  let current = build();

  // 记忆与资料的造数：来源都是"这条会话里的一条观察"，与生产读取同一套授权与有效性规则。
  const memoryScopeKey = qqMemoryScopeKey(
    qqConversationScopeOf({
      accountId,
      conversationKind: kind,
      peerId,
      agentId: DEFAULT_AGENT_ID,
    }),
  );
  const knowledgeRepository = new KnowledgeRepository(db);
  const seedSourceEvent = () => {
    const eventKey = crypto.randomUUID();
    const seconds = Math.floor(Date.parse(now()) / 1000);
    orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId,
        conversationKind: kind,
        peerId,
        agentId: DEFAULT_AGENT_ID,
        messageId: eventKey,
        occurredAtSeconds: seconds,
        speakerKind: "member",
        speakerId: peerId,
        recordedAt: now(),
      })
      .run();
    return { eventKey, seconds };
  };

  const harness: OneBotHarness = {
    db,
    orm,
    clock,
    journal,
    wakes,
    outbox,
    runs,
    get adapter() {
      return current.adapter;
    },
    get host() {
      return current.host;
    },
    scheme,
    bindingId,
    model: scripted,
    sent,
    sendResults,
    now,
    advance: (seconds) => {
      clock.seconds += seconds;
    },
    receive: (input) => {
      const speaker = input.speaker ?? (kind === "group" ? member : peerId);
      const base = {
        post_type: "message",
        time: clock.seconds,
        self_id: Number(accountId),
        user_id: Number(speaker),
        message_id: input.id,
        message: [
          ...(input.replyTo ? [{ type: "reply", data: { id: input.replyTo } }] : []),
          ...(input.addressed && kind === "group" ? [{ type: "at", data: { qq: accountId } }] : []),
          ...(input.image ? [{ type: "image", data: { file: input.image } }] : []),
          { type: "text", data: { text: input.text ?? "hello" } },
        ],
        sender: { nickname: speaker },
      };
      const payload =
        kind === "group"
          ? { ...base, message_type: "group", sub_type: "normal", group_id: Number(peerId) }
          : { ...base, message_type: "private", sub_type: "friend" };
      const normalized = normalizeOneBotMessage(payload, accountId);
      const recorded = recordInbound(orm, normalized, {
        accountId,
        conversationIngress: current.adapter,
      });
      const conversation = journal.ensureOneBot(bindingId);
      if (conversation) {
        const row = db
          .query(
            "SELECT seq FROM conversation_events WHERE conversation_id=? AND event_key=? ORDER BY seq DESC LIMIT 1",
          )
          .get(
            conversation.id,
            normalized.kind === "message" ? normalized.observation.eventKey : "",
          ) as { seq: number } | null;
        if (row) lastSeq = row.seq;
      }
      return recorded;
    },
    visionCalls,
    get conversationId() {
      return journal.ensureOneBot(bindingId)!.id;
    },
    get lastEventSeq() {
      return lastSeq;
    },
    observedSeq,
    activate: async (cause) => {
      const wake = wakes.claim({ at: now(), leaseMs: 120_000, cause });
      if (!wake) return null;
      try {
        return await current.host.activate(wake, new AbortController().signal);
      } catch (error) {
        // 与生产调度器同构：激活抛错后必须结清租约（并按默认策略排重试），
        // 否则并发槽位被占死、后续唤醒领不到。错误照旧抛给调用方。
        const code = (error as { code?: unknown }).code;
        wakes.fail(wake.id, wake.leaseToken!, {
          at: now(),
          errorCode: typeof code === "string" ? code : "BOT_RUN_FAILED",
          maxAttempts: 3,
          retryDelayMs: 15_000,
        });
        throw error;
      }
    },
    deliver: () => current.delivery.runOnce(),
    sweep: () => current.adapter.sweep(clock.seconds),
    memory(body, options) {
      const { eventKey, seconds } = seedSourceEvent();
      const id = crypto.randomUUID();
      orm
        .insert(schema.memoryEntries)
        .values({
          id,
          agentId: DEFAULT_AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: options?.name ?? body.slice(0, 20),
          summary: options?.summary ?? body.slice(0, 40),
          tags: "[]",
          kinds: '["semantic"]',
          body,
          scope: "reality_user",
          scopeKey: memoryScopeKey,
          status: "active",
          configSnapshot: "{}",
          createdAt: new Date((seconds - (options?.ageSeconds ?? 20)) * 1000).toISOString(),
        })
        .run();
      orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: id,
          eventKey,
          scopeKey: memoryScopeKey,
          conversationKey: qqConversationKey({ accountId, kind, peerId }),
          messageId: eventKey,
          occurredAtSeconds: seconds,
          speakerKind: "member",
          speakerId: peerId,
        })
        .run();
      return id;
    },
    correctMemory(id, fields) {
      const row = entries(orm, DEFAULT_AGENT_ID, [id])[0];
      return immediate(db, () =>
        correctMemoryEntry(orm, DEFAULT_AGENT_ID, id, {
          expected_revision: memoryRevision(row),
          ...fields,
        }),
      );
    },
    knowledge(name, body) {
      const document = knowledgeRepository.importDocument({
        name,
        category_id: "default",
        original_text: body,
      });
      knowledgeRepository.replaceGrants(document.id, document.revision, [DEFAULT_AGENT_ID]);
      return document.id;
    },
    revokeKnowledge(id) {
      knowledgeRepository.replaceGrants(id, knowledgeRepository.detail(id).revision, []);
    },
    restart: () => {
      current = build();
    },
    close: () => {
      harnesses.delete(harness);
      handle.close();
    },
  };
  harnesses.add(harness);
  return harness;
}
