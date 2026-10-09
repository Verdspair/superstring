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
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { ModelPort } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import type { BotCompressionJob } from "../../src/server/channels/onebot11/background-compression";
import { BotCompressionQueue } from "../../src/server/channels/onebot11/background-compression";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { mapBotHostDiagnosticTelemetry } from "../../src/server/channels/onebot11/create-runtime";
import { createQqMediaInputService } from "../../src/server/channels/onebot11/media-input-service";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  bodyRevision,
  ConversationEventRepository,
} from "../../src/server/db/conversation-event-repository";
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
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import type {
  OneBotSendRequest,
  OneBotSendResult,
} from "../../src/server/services/onebot-connection";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  qqConversationKey,
  qqConversationScopeOf,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { recordInbound } from "../../src/server/services/qq-intake";
import type { QqMediaReadAdapter } from "../../src/server/services/qq-media-reader";
import { qqExecutionModuleSourceAccess } from "../../src/server/services/qq-member-roster-sources";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import type { QqSendPort } from "../../src/server/services/qq-send-transport";
import type { MemoryContentResponse } from "../../src/shared/contracts";
import {
  QQ_MEDIA_INPUT_SCHEME_DEFAULT,
  QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT,
  type QqSchemeMediaInput,
  type QqSchemeMessageSettings,
} from "../../src/shared/contracts/qq";
import type { QqMediaInputSettings } from "../../src/shared/contracts/qq-media-input";
import type { QqMessageSettings } from "../../src/shared/contracts/qq-message";
import { type ModelStep, type ScriptedModel, scriptedModel } from "./model";

/** 发送端每次返回什么；默认全部"确认送达"。 */
export type SendOutcome = "confirmed" | "failed" | "unknown" | "not_sent";

export interface ReceiveInput {
  /** 平台消息 id（去重键的一部分）。 */
  readonly id: string;
  /** null＝省略 text 段（真纯图 wire）；undefined＝维持既有 "hello" 缺省。 */
  readonly text?: string | null;
  /** 群聊里是发言人；私聊可省略（默认用 peer）。 */
  readonly speaker?: string;
  /** 明确 @ 本账号（私聊不需要）。 */
  readonly addressed?: boolean;
  /** 引用某条消息（回复她时被认作"被叫到"）。 */
  readonly replyTo?: string;
  /** 附一张图（上游文件引用）；图片只在主 Agent 显式调用 `media.describe` 时被读取。 */
  readonly image?: string;
  /** 额外 @ 对象（原位 at 片段，target 为 QQ 号字符串或 "all"）。 */
  readonly mentions?: readonly string[];
  /** 发送时群名片快照（undefined＝wire 缺省；空串＝显式清空）。 */
  readonly groupCard?: string;
  /** 发送时个人昵称快照（undefined＝wire 缺省；空串＝显式清空）。 */
  readonly personalNickname?: string;
  /** 原始图片段扩展提示（原样进 image 段 data，仅平台证据语义，不新增授权）。 */
  readonly imageHint?: Record<string, unknown>;
  /** 群匿名消息（仅 group）：wire 走 sub_type:"anonymous" 真实语义，不伪造 QQ 号。 */
  readonly anonymous?: boolean;
  /**
   * true＝wire 完全省略 nickname 键（匿名/缺省场景，不用 QQ 号冒充个人昵称）；
   * 缺省＝维持既有夹具行为（未给 personalNickname 时以 speaker 号串冒名，兼容旧用例）。
   */
  readonly omitPersonalNickname?: boolean;
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
  /**
   * 自主接话节奏三参数（方案 rhythm 的纯测试入口）：缺省沿用方案默认（15/5/ON），
   * 不在夹具里特判产品行为。只有不测计数门槛的宿主行为用例才显式收窄（如 1/0），
   * 计数门槛用例使用默认值或明确指定的参数。
   */
  readonly initiativeBatchTargetCount?: number;
  readonly initiativeBatchJitterCount?: number;
  readonly initiativeQueueOnBusy?: boolean;
  /**
   * P7/S55：接线生产 BotCompressionQueue（与 create-runtime 同一构造，无第二链）。true 时
   * 宿主 enqueue 的压缩任务进入真实队列，测试用 `h.compressionRunOnce()` 手动消费（不自动
   * 后台运行）。缺省 false＝既有行为（job 丢弃）。
   */
  readonly compressionQueue?: boolean;
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
  /** 方案 message_settings 组覆盖（T11 Step1）：省略＝已批准默认组。 */
  readonly messageSettings?: Partial<QqMessageSettings>;
  /** 方案 media_input 组覆盖（T11 Step1）：省略＝已批准默认组（native、三阶段全开）；stages 可部分覆盖。 */
  readonly mediaInput?: Omit<Partial<QqMediaInputSettings>, "stages"> & {
    stages?: Partial<QqMediaInputSettings["stages"]>;
  };
  /** 合成图片字节表：key＝ReceiveInput.image 引用，值＝受控合成字节（不落盘、不走网络）。 */
  readonly imageBytes?: Readonly<Record<string, Uint8Array>>;
  /**
   * 受控 fetch 门（native 自动图强测用）：fetchSource 查 bytes 前调用；测试用它构造
   * "fetch pending 中段"的真实取消窗口（abort 源仍是调用方 AbortController）。
   */
  readonly fetchHook?: (sourceRef: string) => Promise<void>;
  /**
   * 视觉桩的答复，按序取、用完重复最后一项：`"fail"` 表示这次读取失败，字符串是媒体说明。
   * 不传＝媒体工具不接线（图片只记录、没有读取工具，和未配置视觉模型的安装一致）。
   */
  readonly vision?: readonly ("fail" | string)[];
  /** 媒体工具（media.list/describe/note.read）是否接线；默认跟随 `vision` 给没给。 */
  readonly mediaEnabled?: boolean;
  /** 模型的容量（字节口径）。默认 65536。 */
  readonly capacity?: number;
  /**
   * 真实容量 getter（`Pick<ModelGateway,"loadedContextCapacity">`）：宿主与生产拿同一个
   * 容量来源，不另开模型路径。省略＝维持既有行为——用 `capacity`（或默认 65536）当场答，
   * **不发 HTTP、不碰真实模型服务**。
   */
  readonly capacityGateway?: Pick<ModelGateway, "loadedContextCapacity">;
  /**
   * 诊断的辅助订阅者：拿到与生产 mapper **同一批**诊断事件（只读辅助，不代持久化）。
   * 省略＝只有 `telemetry:true` 那条落库链。既有写法（内存数组断言）行为不变。
   */
  readonly onDiagnostic?: ConstructorParameters<typeof OneBotHost>[0]["onDiagnostic"];
  /**
   * 真实可观测落库（同一 `RuntimeTelemetry` 生产 mapper 链）：
   * 诊断经 `mapBotHostDiagnosticTelemetry` 落 `bot.host.feedback` span，`AgentRuntime`
   * 用**同一实例**发 `agent.*` span，两者可在同一 trace 下按 run/owner 读回。
   * 缺省 false＝既有行为（诊断只到 `onDiagnostic` 订阅者，不写库）。
   */
  readonly telemetry?: boolean;
  /** Host-only member reads for synthetic OneBot runtime integration tests. */
  readonly memberTools?: ConstructorParameters<typeof OneBotHost>[0]["memberTools"];
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
  activate(cause?: string, opts?: { signal?: AbortSignal }): Promise<unknown>;
  /** 投递所有待发的出站意图；返回处理的条数。 */
  deliver(): Promise<number>;
  /** 跑一次冷场扫描（定时宿主做的事）；返回本次的排程与跳过原因。 */
  sweep(): { scheduled: readonly unknown[]; skipped: readonly unknown[] };
  /**
   * 视觉调用的记录：模型名与随图发出的那段说明（方案「媒体」槽位）。
   * 只有主 Agent 显式调用 `media.describe` 才会增加；入站不再自动读图（ADR0019 §8.11）。
   */
  readonly visionCalls: readonly { model: string; prompt: string }[];
  /** 本夹具的受控合成图片字节表（key＝上游 file 引用；native 服务注入前的 A 组挂点）。 */
  readonly imageBytes: Readonly<Record<string, Uint8Array>>;
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
  /** P7/S55：手动消费一条已 enqueue 的后台压缩任务（不自动后台运行）。 */
  compressionRunOnce(): Promise<void>;
  /**
   * 本夹具的真实观测实例（`telemetry:true` 时非空）：宿主诊断的 `bot.host.feedback`
   * span 与 AgentRuntime 的 `agent.*` span 用的是这**同一个**实例。缺省＝null（零 span）。
   * 读回走同一业务库的 `runtime_spans`（既有表，不新增 API/权限）。
   */
  readonly telemetry: RuntimeTelemetry | null;
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
    ...(options.messageSettings === undefined
      ? {}
      : {
          messageSettings: {
            ...QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT,
            ...options.messageSettings,
          } as QqSchemeMessageSettings,
        }),
    ...(options.mediaInput === undefined
      ? {}
      : {
          mediaInput: {
            ...QQ_MEDIA_INPUT_SCHEME_DEFAULT,
            ...options.mediaInput,
            stages: {
              ...QQ_MEDIA_INPUT_SCHEME_DEFAULT.stages,
              ...options.mediaInput.stages,
            },
          } as QqSchemeMediaInput,
        }),
    reply: { split_by_speaker: options.splitBySpeaker ?? true },
    // 触发器默认是一对合法组合（连续与自主互斥，方案保存契约拒绝双 true）：默认自主开、
    // 连续关，测连续交谈的用例显式传 follow_up:true / chiming_in:false。调用方显式传双 true
    // 不在这里静默归一——让 createQqScheme 的互斥校验按真实契约抛错，不靠旧双真读取归一伪造合法保存。
    triggers: {
      direct_reply: options.triggers?.direct_reply ?? true,
      follow_up: options.triggers?.follow_up ?? false,
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
      initiative_batch_target_count:
        options.initiativeBatchTargetCount ?? QQ_RHYTHM_DEFAULT.initiative_batch_target_count,
      initiative_batch_jitter_count:
        options.initiativeBatchJitterCount ?? QQ_RHYTHM_DEFAULT.initiative_batch_jitter_count,
      initiative_queue_on_busy:
        options.initiativeQueueOnBusy ?? QQ_RHYTHM_DEFAULT.initiative_queue_on_busy,
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
  // 容量 getter：给了 capacityGateway 就走那个真实 getter（同一 `ModelGateway` 方法签名
  // `loadedContextCapacity(model, {signal})`），宿主→context-source 与生产同一条调用点，
  // 不另开模型路径。**null 按生产原样透传**——目录里没有该模型就是「无法确认容量」，
  // 由 context-source 走真实的 CONTEXT_CAPACITY_UNKNOWN 拒绝，夹具不拿默认容量顶替。
  // 不给＝维持既有行为（当场答 capacity/默认 65536，不发 HTTP、不碰真实模型服务）。
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async (model: string, signalOptions?: { signal?: AbortSignal }) =>
      options.capacityGateway
        ? options.capacityGateway.loadedContextCapacity(model, signalOptions)
        : (options.capacity ?? 65536),
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
  // 受控合成字节表（T11 Step1）：key＝上游 file 引用。native 服务注入属 B 组（factory 签名
  // 收件后接线）；A 组先把它挂在夹具上供测试与后续接线消费，不造假的产品 service。
  const imageBytes: Readonly<Record<string, Uint8Array>> = options.imageBytes ?? {};
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
  // `vision` 桩的一次答复：按序取、用完重复最后一项；没给桩（或用尽）＝这次读取失败。
  // 显式 media adapter（media.describe 工具）与默认视觉叶子桩共用这一个游标与同一个
  // `visionCalls` 账：两条互斥路径各自真实发生一次时各记一次、各消费一个 outcome，
  // 同一次 read 只走其中一条路径，所以不会被消费两遍。
  const nextVisionOutcome = (): "fail" | string => {
    const outcome = visionOutcomes?.[Math.min(visionIndex, visionOutcomes.length - 1)] ?? "fail";
    visionIndex += 1;
    return outcome;
  };
  const adapterFor = (config: {
    mediaPrompt: string;
    frames: number;
    maxDimension: number;
  }): QqMediaReadAdapter => ({
    capabilities: ["image"] as const,
    // 受控 bytes 桥（identity 派生）：与 read/服务同一条受控来源——显式 imageBytes 优先，
    // 否则按 sourceRef 派生确定性合成 PNG（同一 ref 恒同 bytes，不同 ref 不同 bytes）；
    // 不退 NULL、不造假第二下载路径。
    async fetchBytes(input) {
      const explicit = imageBytes[input.sourceRef];
      if (explicit) return { bytes: explicit };
      const seed = new TextEncoder().encode(`harness-image:${input.sourceRef}`);
      const fill = (seed.reduce((acc, b) => (acc * 31 + b) % 251, 7) + 4) & 0xff;
      return { bytes: encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(fill), 8, 8) };
    },
    async read(input): Promise<string> {
      visionCalls.push({ model: input.model, prompt: config.mediaPrompt });
      const outcome = nextVisionOutcome();
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
  // 真实可观测（`telemetry:true` opt-in）：与生产同一个 `RuntimeTelemetry` 类、同一个业务库连接
  // （run/span 仓库读回的就是这个 db），`restart()` 之后沿用同一实例，不新建第二条观测链。
  // 缺省不构造＝既有行为（既有夹具零 `runtime_spans` 写入，SQL 行数假设不受影响）。
  const telemetry = options.telemetry === true ? new RuntimeTelemetry(db) : null;
  const build = () => {
    // 与生产同构：本群 guard 既是执行边界，也是来源复验链的首项（runtime.ts 的 resolveDomainSource）。
    // 动作结果带回来的 `qq_group_capability` 引用在下一轮读取时按同一份事实复验，不是只在投递口。
    const guard = new QqGroupCapabilityGuard(orm);
    const compressionQueue = new BotCompressionQueue();
    const runtime = new AgentRuntime({
      repository: runs,
      now,
      // 同一实例：AgentRuntime 的 agent.* span 与宿主诊断的 bot.host.feedback span
      // 因此挂在同一 runtime 观测面，测试按 run/owner 一次读回即可，不用手插 span。
      ...(telemetry ? { telemetry } : {}),
      // 读工具经 ActionExecutor 装配本群 guard——广告面、执行点与返回的
      // 来源引用按同一份停用状态判定；不传权限面与并行上限＝沿用默认，行为不变。
      actionExecutor: new ActionExecutor(undefined, undefined, guard),
      model: {
        complete: async () => '{"kind":"none"}',
        async *streamText() {
          yield "";
        },
        // 视觉叶子（native/description 读取的真实调用点）的受控桩：**只在**没有别的
        // completeMultimodal 提供者时生效——用户自带 `model` 端口优先（既有写法不变）。
        // 它挂在真实端口的方法上，而不是替代服务端/适配器：读取仍走
        // createQqMediaAdapter → completeVisionLeaf → 本端口，prompt/model/帧与
        // production 同一来源。
        // 记一次真实视觉调用：与 adapterFor 显式读取**同一个计数账**，所以两条互斥路径
        // 各自真实发生一次时各记一次（不因为 native 路径本就不走该叶子就隐去 description 叶子）。
        completeMultimodal: async (request) => {
          visionCalls.push({ model: request.model, prompt: request.prompt });
          const outcome = nextVisionOutcome();
          // 没有视觉 outcome 就必须失败关闭：空串会被读取器当成"空描述"并留成 failed
          // 任务，看上去像一次成功读取——这里显式抛错，不制造假成功。
          if (visionOutcomes === undefined || outcome === "fail") {
            throw new Error("HARNESS_VISION_FAILED");
          }
          return outcome;
        },
        ...port,
      },
    });
    const adapter = new OneBot11Adapter({ orm, journal, wakes, nowSeconds: () => clock.seconds });
    const host = new OneBotHost({
      memberTools: options.memberTools,
      orm,
      journal,
      wakes,
      outbox,
      agentRuntime: runtime,
      gateway,
      stickers: { counts: ["confirmed"], isAvailable: () => options.stickersAvailable ?? false },
      policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600 }),
      ...(options.compressionQueue
        ? { enqueueCompression: (job: BotCompressionJob) => compressionQueue.enqueue(job) }
        : {}),
      now,
      // 生产同一条诊断链：宿主诊断先经 `mapBotHostDiagnosticTelemetry` 落 span。
      // `onDiagnostic` 订阅者是**辅助观察者**，不再兼任持久化——它与落库并存，不是二选一
      // （create-runtime 的宿主同样只有这一条 onDiagnostic，生产 mapper 在其内）。
      onDiagnostic(event) {
        if (telemetry) {
          const mapped = mapBotHostDiagnosticTelemetry(event);
          telemetry.record(mapped.name, mapped.metadata);
        }
        return options.onDiagnostic?.(event);
      },
      // 与运行时同一份 guard：本群能力来源引用按当前纪元复验（停用或旧纪元一律不可用）。
      resolveSource: (source, owner) =>
        (options.memberTools
          ? qqExecutionModuleSourceAccess(
              source,
              owner,
              options.memberTools.policyRevision(),
              options.memberTools.enabled(),
            )
          : undefined) ?? guard.sourceAccess(source, owner),
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
            // T11 B：native 自动图的受控服务注入（同一 factory、合成 bytes 源；不落盘、
            // 不走网络）。baselinePolicy 与宿主 createQqMediaTools 同一组合串（同一真源）。
            ...(mediaOn
              ? {
                  mediaInputService: (scheme: QqSchemeRow) => {
                    const prompt = schemePrompts(scheme).media;
                    const policyRevision = bodyRevision(
                      JSON.stringify({
                        prompt,
                        frames: schemeRhythm(scheme).media_frame_count,
                        maxDimension: schemeRhythm(scheme).media_max_dimension,
                      }),
                    );
                    return createQqMediaInputService({
                      store: { db, orm },
                      fetchSource: async ({ sourceRef }) => {
                        if (options.fetchHook) await options.fetchHook(sourceRef);
                        const bytes = imageBytes[sourceRef];
                        if (bytes) return { bytes };
                        // 受控确定性合成字节（与 fetchBytes 桥同源）：测试无显式 bytes 的
                        // 上游引用也走同一受控链，不伪造 unknown/NULL。
                        const seed = new TextEncoder().encode(`harness-image:${sourceRef}`);
                        const fill = (seed.reduce((acc, b) => (acc * 31 + b) % 251, 7) + 4) & 0xff;
                        return {
                          bytes: encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(fill), 8, 8),
                        };
                      },
                      agentRuntime: runtime,
                      prompt,
                      // 与 mediaOn 时 organization settings 的 vision-stub 同真源：
                      // description 备用（§9）需要真实视觉模型名才发起描述读取。
                      modelConfig: {
                        // 与组织设置同真源（mediaOn 时已设 vision-stub）——真实 null 传给
                        // 服务即 unavailable（S40 no-model 路径），不伪造 unknown。
                        visionModelName: mediaOn
                          ? ((
                              db
                                .query(
                                  "SELECT vision_model_name AS v FROM organization_settings WHERE id=1",
                                )
                                .get() as { v: string | null }
                            )?.v ?? null)
                          : null,
                        transcriptionModelName: null,
                      },
                      baselinePolicy: `baseline/v1/${policyRevision}`,
                    });
                  },
                }
              : {}),
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
    return { adapter, host, delivery, compressionQueue };
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
          ...(input.mentions?.map((target) => ({ type: "at", data: { qq: target } })) ?? []),
          ...(input.image
            ? [{ type: "image", data: { file: input.image, ...(input.imageHint ?? {}) } }]
            : []),
          ...(input.text === null ? [] : [{ type: "text", data: { text: input.text ?? "hello" } }]),
        ],
        // 双昵称快照（规格 §3.1）：undefined＝wire 缺省（键不出现），空串＝显式清空；
        // omitPersonalNickname=true＝nickname 键整个不出现（匿名/缺名场景，不拿 QQ 号冒名）。
        sender: {
          ...(input.omitPersonalNickname ? {} : { nickname: input.personalNickname ?? speaker }),
          ...(input.groupCard === undefined ? {} : { card: input.groupCard }),
        },
      };
      const payload =
        kind === "group"
          ? {
              ...base,
              message_type: "group",
              // 群匿名消息走平台真实 sub_type 语义（onebot-protocol 认 anonymous）；
              // 私聊无匿名，保持 friend。
              sub_type: input.anonymous ? "anonymous" : "normal",
              group_id: Number(peerId),
            }
          : { ...base, message_type: "private", sub_type: "friend" };
      const normalized = normalizeOneBotMessage(payload, accountId);
      const recorded = recordInbound(orm, normalized, {
        accountId,
        conversationIngress: current.adapter,
      });
      const conversation = journal.ensureOneBot(bindingId);
      if (conversation) {
        // 入站事件的存储键由 intake 组装（带渠道前缀），夹具不重建键：按 kind=inbound
        // 取 lastSeq 之后最新落库的一条，就是本次 receive 的消息。
        const fresh = journal.eventsAfter(conversation.id, lastSeq, 20).items;
        const inbound = [...fresh].reverse().find((entry) => entry.kind === "inbound");
        if (inbound) lastSeq = inbound.seq;
      }
      return recorded;
    },
    visionCalls,
    imageBytes,
    telemetry,
    get conversationId() {
      return journal.ensureOneBot(bindingId)!.id;
    },
    get lastEventSeq() {
      return lastSeq;
    },
    observedSeq,
    activate: async (cause, opts?: { signal?: AbortSignal }) => {
      const wake = wakes.claim({ at: now(), leaseMs: 120_000, cause });
      if (!wake) return null;
      try {
        // opts.signal＝调用方真实取消所有权（P4/T15）：caller abort 穿透宿主任务清理，
        // 由既有 wakes.fail 结清租约并记真实 cancel；未提供＝维持独立 controller 原行为。
        return await current.host.activate(wake, opts?.signal ?? new AbortController().signal);
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
    compressionRunOnce: () => current.compressionQueue?.runOnce(),
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
