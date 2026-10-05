import type { Database } from "bun:sqlite";
import type { ModelMessage, RunOwner } from "../../../shared/contracts/agent-run";
import type { ConversationEvent, WakeSignal } from "../../../shared/contracts/conversation";
import type { SourceRef } from "../../../shared/contracts/evidence";
import type { QqEffectiveMediaPolicy } from "../../../shared/contracts/qq-media-input";
import type { QqConversationScope } from "../../../shared/contracts/qq-message";
import type { AgentRuntime, PreparedOutput } from "../../agent/agent-runtime";
import type { AgentSpec, OutputDraft } from "../../agent/agent-specs";
import { AGENT_DECISION_JSON_SCHEMA } from "../../agent/agent-specs";
import type { ActionContext, BuiltInAction } from "../../agent/built-in-actions";
import { inputUnits, textMessage, uniqueSources } from "../../agent/context-engine";
import { ConversationHost } from "../../agent/conversation-host";
import { createImageByteResolver } from "../../agent/image-byte-resolver";
import type { ModelResolvedPrepareOutput } from "../../agent/model-port";
import {
  parseModelEnvelope,
  parseModelScoreEnvelope,
  parseModelTextEnvelope,
} from "../../agent/model-response-envelope";
import type { AgentTaskService } from "../../agent/task-service";
import { observationRelevant } from "../../conversation/observation-relevance";
import { AgentRunRepository } from "../../db/agent-run-repository";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { bodyRevision } from "../../db/conversation-event-repository";
import { KnowledgeReadRepository } from "../../db/knowledge-read-repository";
import { readOrganizationSettings } from "../../db/organization-repository";
import {
  idempotentIntentId,
  type OutboundIntentRepository,
} from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { recordQqIdleJudgement } from "../../db/qq-dispatch-repository";
import {
  readEffectiveQqScheme,
  readQqGroupCapabilityRevision,
} from "../../db/qq-group-config-repository";
import { type MediaTaskSourceGuard, normalizeQuestionKey } from "../../db/qq-media-task-repository";
import { readQqMemberNames } from "../../db/qq-member-repository";
import { recordQqOutboundMessageFact } from "../../db/qq-message-repository";
import type { QqConversationScope as QqGateConversationScope } from "../../db/qq-observation-repository";
import { readQqOwnerIdentity } from "../../db/qq-owner-repository";
import {
  effectiveQqTriggers,
  type QqSchemeRow,
  readQqScheme,
  schemeMediaInput,
  schemeMessageSettings,
  schemeOutputReserve,
  schemePrompts,
  schemeReply,
  schemeRhythm,
} from "../../db/qq-scheme-repository";
import { readQqRetentionDays, readQqSettings } from "../../db/qq-settings-repository";
import { newestMemberMessageSeconds } from "../../db/qq-speech-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import type { WakeRepository } from "../../db/wake-repository";
import { fail } from "../../errors";
import type { ModelGateway } from "../../llm/model-gateway";
import type { ModuleQueryFactory, ModuleSourceResolver } from "../../modules/composition";
import { contextDumps } from "../../modules/memory-query";
import { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";
import { captureQqTask, checkQqTask, qqConversationKey } from "../../services/qq-binding-contract";
import {
  attentionTriggerFilter,
  QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS,
} from "../../services/qq-dispatch";
import { prepareQqJudgement } from "../../services/qq-judgement-preparation";
import type { QqMediaReadAdapter } from "../../services/qq-media-reader";
import type {
  QqMediaQuestionAnchorResolver,
  QqMediaReadImageService,
} from "../../services/qq-media-tools";
import { createQqMediaTools } from "../../services/qq-media-tools";
import type { QqPreparedReply } from "../../services/qq-prepared-reply";
import {
  QQ_EXPRESSION_MEDIA_RULE,
  QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_MEDIA_RULE,
  QQ_REPLY_ENVELOPE_OUTPUT_RULE,
  qqJudgeAllowsSpeech,
  qqJudgeOutcome,
  qqReplaceOutputRule,
  qqReplaceOutputRuleInText,
} from "../../services/qq-prompt-contract";
import { isObservationExpired, speechExpiresAt } from "../../services/qq-retention";
import {
  checkQqSpeechSend,
  disabledKindsFromTriggers,
  isInitiativeSpeech,
  type QqSpeechKind,
} from "../../services/qq-speaking-contract";
import {
  createQqStickerSearch,
  currentQqStickerCatalog,
} from "../../services/qq-sticker-capability";
import { planQqPreparedReply, type QqStickerStage } from "../../services/qq-sticker-runner";
import { compileSystemPrompt, runtimeFromAgent } from "../../services/runtime-config";
import type { BotCompressionJob } from "./background-compression";
import { BotContextSource, type BotContextTarget } from "./context-source";
import type { QqMediaInputService, QqMediaProjection } from "./media-input-service";
import { consumeModelMediaData, isModelImageUnsupportedError } from "./media-input-service";
import { loadQqMessageFact, projectQqMessageFacts } from "./message-projection";
export interface OneBotPolicy {
  maxSteps: number;
  deliveryTtlSeconds: number;
}

// 规格 §10：native 同次分类的内部 envelope 响应 schema。本体权威（decision/scoreResult/text）
// 原样保留各自约束，附属 media 白名单由 model-response-envelope 解析；宿主只在存在待分类
// unknown 图时把对应 schema 换成 envelope 版本，text-only 决策照走原 schema。
const QQ_DECISION_ENVELOPE_SCHEMA: Record<string, unknown> = {
  ...AGENT_DECISION_JSON_SCHEMA,
  // oneOf 的每个分支都允许附带附属 media 分类（可选键，不进 required）。
  oneOf: ((AGENT_DECISION_JSON_SCHEMA.oneOf as Record<string, unknown>[]) ?? []).map((branch) => ({
    ...branch,
    properties: {
      ...((branch.properties as Record<string, unknown>) ?? {}),
      media: { type: "array", items: { type: "object" } },
    },
  })),
};
const QQ_SCORE_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scoreResult"],
  properties: {
    scoreResult: {
      type: "object",
      additionalProperties: false,
      required: ["score"],
      properties: {
        score: QQ_JUDGEMENT_RESPONSE_SCHEMA.properties.score,
        reason: QQ_JUDGEMENT_RESPONSE_SCHEMA.properties.reason,
      },
    },
    media: { type: "array", items: { type: "object" } },
  },
};
const QQ_TEXT_ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string" },
    media: { type: "array", items: { type: "object" } },
  },
};
export interface BotHostDiagnostic {
  runId?: string;
  conversationId: string;
  stage: string;
  status: string;
  code?: string;
  sourceSeq: number;
  targetId?: string;
  details?: Record<string, string | number | boolean | null>;
}
export interface OneBotHostOptions {
  modules?: ModuleQueryFactory;
  resolveSource?: ModuleSourceResolver;
  orm: Orm;
  agentRuntime: AgentRuntime;
  host?: ConversationHost;
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">;
  journal: ConversationEventRepository;
  wakes: WakeRepository;
  outbox: OutboundIntentRepository;
  stickers: QqStickerStage;
  stickersEnabled?: () => boolean;
  mediaEnabled?: () => boolean;
  mediaAdapter?: (scheme: QqSchemeRow) => QqMediaReadAdapter;
  /** T11 B：同源组装的媒体准备服务（按方案取 prompt/节奏，与 mediaAdapter 同形）；缺省＝无自动图。 */
  mediaInputService?: (scheme: QqSchemeRow) => QqMediaInputService;
  policy: () => OneBotPolicy;
  now?: () => string;
  onDiagnostic?: (event: BotHostDiagnostic) => void | Promise<void>;
  enqueueCompression?: (job: BotCompressionJob) => void;
  /** 外部（MCP）动作：每次唤醒现取；没有登记时返回空表（行为与不加这个功能一致）。 */
  externalActions?: () => readonly BuiltInAction[];
  tasks?: AgentTaskService;
  /** 本群能力 guard：缺省按开发默认构造（测试可注入同一份事实的替身）。 */
  guard?: QqGroupCapabilityGuard;
}
/** One host for direct and shared conversations; topology changes targets, not the model loop. */
export class OneBotHost {
  private readonly host: ConversationHost;
  private readonly guard: QqGroupCapabilityGuard;
  constructor(private readonly options: OneBotHostOptions) {
    this.host = options.host ?? new ConversationHost({ runtime: options.agentRuntime });
    this.guard = options.guard ?? new QqGroupCapabilityGuard(options.orm);
  }
  async activate(wake: WakeSignal, signal: AbortSignal) {
    const o = this.options,
      db = (o.orm as Orm & { $client: Database }).$client,
      now = () => o.now?.() ?? new Date().toISOString(),
      seconds = () => Math.floor(Date.parse(now()) / 1000);
    const conversation = o.journal.get(wake.conversationId);
    if (!conversation || conversation.channel !== "onebot11")
      throw new Error("BOT_CONVERSATION_REQUIRED");
    const binding = readQqBinding(o.orm, conversation.sourceId);
    if (!binding || binding.agentId !== conversation.agentId) throw new Error("BINDING_CHANGED");
    // 生效方案＝基础方案 + 本群差异（ADR0019 §13.2）：新轮读取当前值，未固定的项跟随基础方案。
    const scheme = readEffectiveQqScheme(o.orm, binding),
      agent = getAgentRow(o.orm, binding.agentId);
    if (!scheme || !agent) throw new Error("BOT_CONFIGURATION_MISSING");
    const guard = this.guard;
    // 本群作用域的所有者：能力停用、群内来源撤权与叶子任务都按绑定 × 当前助手判定。
    const groupOwner: RunOwner = {
      kind: "qq_binding",
      id: binding.id,
      userId: DEFAULT_USER_ID,
      agentId: agent.id,
    };
    const captured = captureQqTask(binding, "reply", readQqOwnerIdentity(o.orm));
    if (captured.kind !== "captured") throw new Error(captured.reason);
    const snapshot = captured.snapshot,
      // 背景摘要任务单独按组织用途捕获（ADR0019 §13.1 B）：它可以在暂停/普通配置变化后跑完，
      // 但身份与授权一旦变化就必须终止——发布边界只认这份快照。
      capturedBackground = captureQqTask(binding, "organization", readQqOwnerIdentity(o.orm));
    if (capturedBackground.kind !== "captured") throw new Error(capturedBackground.reason);
    const backgroundSnapshot = capturedBackground.snapshot,
      runtime = {
        ...runtimeFromAgent(agent),
        knowledge_read: new KnowledgeReadRepository(db).freeze(agent.id),
      },
      policy = o.policy();
    const path = wake.cause as QqSpeechKind;
    if (!["direct_reply", "follow_up", "chiming_in", "idle_topic"].includes(path))
      throw new Error("BOT_WAKE_CAUSE_INVALID");
    const initiative = isInitiativeSpeech(path),
      split = schemeReply(scheme).split_by_speaker;
    const focus = o.journal.eventsAfter(conversation.id, Math.max(0, wake.throughSeq - 1), 1)
      .items[0];
    const focusKey =
      focus?.source.kind === "qq_event"
        ? focus.source.id
        : focus?.source.kind === "qq_media"
          ? (
              db.query("SELECT event_key FROM qq_media_notes WHERE id=?").get(focus.source.id) as {
                event_key: string;
              } | null
            )?.event_key
          : undefined;
    const settleOpportunity = (readyAtSeconds?: number) =>
      db
        .transaction(() => {
          if (readyAtSeconds !== undefined)
            o.wakes.defer(
              wake.id,
              wake.leaseToken!,
              new Date(readyAtSeconds * 1000).toISOString(),
              now(),
            );
          else {
            o.wakes.complete(wake.id, wake.leaseToken!, "no_output", wake.throughSeq, now());
            o.journal.acknowledge(conversation.id, wake.throughSeq);
          }
        })
        .immediate();
    const focusOccurredAt = focusKey
      ? (
          db.query("SELECT occurred_at_seconds FROM qq_events WHERE event_key=?").get(focusKey) as {
            occurred_at_seconds: number;
          } | null
        )?.occurred_at_seconds
      : undefined;
    if (
      !initiative &&
      (focusOccurredAt === undefined ||
        seconds() - focusOccurredAt > QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS)
    ) {
      settleOpportunity();
      return { status: "expired" as const };
    }
    const hasConfirmedReply = (sourceSeq: number, participantId: string | null): boolean =>
      !!db
        .query(`SELECT 1 FROM outbound_intents i
          WHERE i.conversation_id=? AND i.source_through_seq>=? AND i.status='confirmed'
            AND (json_extract(i.target,'$.participantId') IS NULL OR json_extract(i.target,'$.participantId')=?)
            AND EXISTS(SELECT 1 FROM outbound_parts p WHERE p.intent_id=i.id
              AND p.attempted_at IS NOT NULL AND p.status='confirmed') LIMIT 1`)
        .get(conversation.id, sourceSeq, participantId);
    // A newer addressed reply can cover an older ordinary opportunity for the same
    // recipient. Idle openers are not responses to a particular source.
    if (
      path !== "idle_topic" &&
      focusKey &&
      focus &&
      hasConfirmedReply(focus.seq, focus.participant?.id ?? null)
    ) {
      settleOpportunity();
      return { status: "no_output" as const, reason: "already_replied" };
    }
    // Different immediate causes can describe the same person's already attempted input.
    // Coverage belongs to the actual output audience and observed source sequence, not the
    // conversation-wide cursor: replying to one member must not consume another member's turn.
    if (!initiative && focusKey && focus) {
      const covered = db
        .query(`
        SELECT i.status FROM outbound_intents i
        WHERE i.conversation_id=? AND i.source_through_seq>=?
          AND (json_extract(i.target,'$.participantId') IS NULL OR json_extract(i.target,'$.participantId')=?)
          AND i.status IN('failed','unknown','stale')
          AND EXISTS(SELECT 1 FROM outbound_parts p WHERE p.intent_id=i.id
            AND p.attempted_at IS NOT NULL AND p.status IN('confirmed','failed','unknown','not_sent'))
        ORDER BY i.created_at DESC LIMIT 1
      `)
        .get(conversation.id, focus.seq, focus.participant?.id ?? null) as {
        status: string;
      } | null;
      if (covered) {
        settleOpportunity();
        return {
          status: "no_output" as const,
          reason: "already_attempted",
        };
      }
    }
    let opportunities: ReturnType<WakeRepository["readyParticipants"]> = [];
    const preparation = (initial = false) => {
      opportunities =
        path === "chiming_in"
          ? o.wakes
              .readyParticipants({ conversationId: conversation.id, cause: path, at: now() })
              .filter(
                (opportunity) =>
                  !hasConfirmedReply(opportunity.wake.throughSeq, opportunity.participantId),
              )
          : [];
      const pendingTargets = [
        ...new Map(
          opportunities.map((opportunity) => [
            opportunity.participantId,
            {
              speakerId:
                opportunity.participantId === "anonymous" ? null : opportunity.participantId,
              newestSeconds: Math.floor(Date.parse(opportunity.occurredAt) / 1000),
              messageCount: 1,
            },
          ]),
        ).values(),
      ].sort(
        (left, right) =>
          left.newestSeconds - right.newestSeconds ||
          (left.speakerId ?? "").localeCompare(right.speakerId ?? ""),
      );
      return prepareQqJudgement(
        o.orm,
        {
          bindingId: binding.id,
          path,
          nowSeconds: seconds(),
          ...(focusKey ? { focusEventKey: focusKey } : {}),
        },
        {
          eligibilityOnly: true,
          ...(path === "chiming_in" ? { pendingTargets } : {}),
          // T08 gate 桥（§8.1）：仅当本 run 一次成功模型调用真实消费了该图（MODEL_IMAGE_
          // UNSUPPORTED 等失败不记账）且当前授权仍有效才返回 model_consumed proof——
          // 解除 legacy 旧失败误挡；未消费/已撤源/跨 run 一律 null，闸保持关闭。
          // 仅 strict/commit preparation 传入——initial 资格阶段不需要 proof。
          ...(initial
            ? {}
            : {
                nativeReadProof: (proofInput: {
                  scope: QqGateConversationScope;
                  mediaNoteIds: readonly string[];
                  now: string;
                }) => {
                  const s = proofInput.scope;
                  const scopeMatch =
                    s.accountId === binding.accountId &&
                    s.conversationKind === binding.kind &&
                    s.peerId === binding.peerId &&
                    s.agentId === binding.agentId;
                  if (!scopeMatch) {
                    return proofInput.mediaNoteIds.map((mediaNoteId) => ({
                      mediaNoteId,
                      proof: null,
                    }));
                  }
                  if (runNativeConsumed.size === 0) {
                    return proofInput.mediaNoteIds.map((mediaNoteId) => ({
                      mediaNoteId,
                      proof: null,
                    }));
                  }
                  source.assertCurrent();
                  return proofInput.mediaNoteIds.map((mediaNoteId) => {
                    const consumed = runNativeConsumed.get(mediaNoteId);
                    if (!consumed || consumed.sourceRefs.length === 0)
                      return { mediaNoteId, proof: null };
                    // T-spec detail 规格门：这张图本 run 有问题锚定的 detail 需求时，已消费
                    // 记录里的 variant 形状必须覆盖锚登记的全部 variant（旧 512 变体解不开
                    // 新 detail 规格）——不覆盖就不是真消费过这张图的细问规格，返 null 让既有
                    // legacy 失败闸照旧闭着。不改既有 reason 码，不新增闸。
                    const anchor = detailAnchors.get(mediaNoteId);
                    if (anchor !== undefined) {
                      const consumedVariants = new Set(
                        consumed.variants.map((v) => `${v.variantId}@${v.variantPolicy}`),
                      );
                      if (
                        anchor.variants.some(
                          (v) => !consumedVariants.has(`${v.variantId}@${v.variantPolicy}`),
                        )
                      ) {
                        return { mediaNoteId, proof: null };
                      }
                    }
                    return {
                      mediaNoteId,
                      proof: {
                        kind: "model_consumed" as const,
                        consumedAt: consumed.consumedAt,
                        sourceRefs: consumed.sourceRefs,
                      },
                    };
                  });
                },
              }),
          ...(initial
            ? {
                initialNativeReadEligibility: (eligInput: {
                  scope: QqGateConversationScope;
                  mediaNoteIds: readonly string[];
                  now: string;
                }) => {
                  // 首次资格探询只回答「本 run 有**可能**真实供图」，不是「已理解」（§8.1）：它不解
                  // 任何闸、不写缓存、不发状态，因此不触 source/assertAuthority/资产缓存——这三者
                  // 在首次 preparation 时要么尚未声明、要么本就不该为「可尝试」而要求。首见原图没有
                  // 已有 asset/ref 照常可尝试；但这绝不成为许可：严格闸只认 nativeReadProof 的
                  // model_consumed，本回调的答案不进任何 proof 路径。
                  if (!mediaSettings || mediaSettings.mode !== "native") return [];
                  if (!mediaSettings.stages.decision) return [];
                  if (!focusKey) return [];
                  // 能力面三件必须**同时为真**才谈得上「这一轮还能供图」，不是"两边相等就算"：
                  // 全局 media 开关未关、本群 guard 当前仍放行、本 run 冻结快照 mediaCapable 为真。
                  // 写成相等比较会把「全局与 guard 同时为 false」也判成一致——那是关闭状态，不是放行。
                  if (!mediaCapable) return [];
                  if (o.mediaEnabled?.() === false) return [];
                  if (!guard.allowed(groupOwner, "media")) return [];
                  // 纪元漂移（off→on / revision++）后旧 fetch/写不得复活。
                  if (readQqGroupCapabilityRevision(o.orm, binding, "media") !== frozenMediaCapRev)
                    return [];
                  const s = eligInput.scope;
                  if (
                    s.accountId !== binding.accountId ||
                    s.conversationKind !== binding.kind ||
                    s.peerId !== binding.peerId ||
                    s.agentId !== binding.agentId
                  )
                    return [];
                  const focusFact =
                    projectQqMessageFacts(
                      { db, orm: o.orm },
                      mediaScope(),
                      [focusKey],
                      eligInput.now,
                    )[0] ?? null;
                  if (!focusFact) return [];
                  const directFact =
                    focusFact.replyTo !== null
                      ? loadQqMessageFact(
                          { db, orm: o.orm },
                          mediaScope(),
                          focusFact.replyTo.platformMessageId,
                          eligInput.now,
                        )
                      : null;
                  // 授权 fact 集合＝本轮要回应的那条消息 + 它直接引用的原图消息（§7.1 自动范围）。
                  const inScopeFacts = [focusFact, directFact].filter(
                    (fact): fact is NonNullable<typeof fact> => fact !== null,
                  );
                  const eligible: string[] = [];
                  for (const mediaNoteId of eligInput.mediaNoteIds) {
                    const note = db
                      .query(
                        "SELECT event_key, segment_kind, source_ref, expires_at FROM qq_media_notes WHERE id=?",
                      )
                      .get(mediaNoteId) as
                      | {
                          event_key: string;
                          segment_kind: string;
                          source_ref: string;
                          expires_at: string;
                        }
                      | undefined;
                    if (!note || note.segment_kind !== "image") continue;
                    // 媒体行本身仍可读：来源引用非空、未过期限。没有资产/缓存行是首见的正常状态，
                    // 不在这里当阻断理由（供图与否由下面的事实绑定与上面的能力纪元决定）。
                    if (note.source_ref.trim() === "") continue;
                    if (isObservationExpired(note.expires_at, eligInput.now)) continue;
                    // 事件键绑定：note.event_key 必须落在授权 fact 上，且由那条 fact 自己的 image
                    // part 认领同一 mediaId。焦点/直接原图范围之外或同 scope 无关消息里的失败行
                    // 一律不解锁——一张焦点图不能放任窗口里的无关失败行通过。
                    const owner_ = inScopeFacts.find((fact) => fact.id === note.event_key);
                    if (!owner_) continue;
                    if (
                      !owner_.parts.some(
                        (part) => part.kind === "image" && part.mediaId === mediaNoteId,
                      )
                    )
                      continue;
                    eligible.push(mediaNoteId);
                  }
                  return eligible;
                },
              }
            : {}),
        },
      );
    };
    // §8.1/§13.3：run 开始时冻结群 media 能力纪元——off→on/revision++ 后旧 fetch/写不允许复活。
    const frozenMediaCapRev = readQqGroupCapabilityRevision(o.orm, binding, "media");
    /**
     * §8.1 current_run_consumed 记账（本 run）：mediaId → 成功消费该图的模型调用完成时刻。
     * 仅在模型调用**成功**后记录（决策 envelope parse 成功 / 评分叶子返回 / 生成 structured
     * parse 成功）；MODEL_IMAGE_UNSUPPORTED 等失败发送不记账、不卸 legacy 失败闸；仅
     * prepared/已下载资源也不构成 proof。查询面：nativeReadProof 闭包（gate 桥）。
     * 声明位置在 preparation/首次 gate 调用之前——避免 nativeReadProof closure TDZ。
     */
    const runNativeConsumed = new Map<
      string,
      {
        consumedAt: string;
        sourceRefs: readonly SourceRef[];
        /** 该次成功调用真实发出的 variant 形状（宿主取字节锚，非模型内容）。 */
        variants: readonly { variantId: string; variantPolicy: string }[];
      }
    >();
    /**
     * T-spec detail 同次升规格锚（宿主侧真实回查，零额外模型调用）：mediaId → 该图本 run
     * 已冻结的 question 锚（`resolveQuestion` 产出的真 `assertQuestionCurrent` 回调）＋成功
     * 准备所产出的全部 variant 形状。两处消费：① `assertAuthority` 每次末段对**已登记**
     * 锚直接 `assertQuestionCurrent(o.orm)`（真实 DB 回调，正文修订/图范围移动按原 reason
     * 硬拒）；② `nativeReadProof` 校验已消费记录是否真覆盖该 detail 规格的 variant。声明位置
     * 在首次 preparation 之前（`nativeReadProof` 闭包同步执行，map 必须先于它初始化；也早于
     * `assertConfiguration` 的定义，避免 TDZ）。
     */
    const detailAnchors = new Map<
      string,
      {
        readonly assertQuestionCurrent: MediaTaskSourceGuard;
        readonly variants: readonly { variantId: string; variantPolicy: string }[];
      }
    >();
    // T11 B：三相自动图的同一真源装配——服务按方案构造（与 mediaAdapter 同形同侧），
    // 策略组 = media_input 组 + rhythm 的普通动图真源；能力放行与既有媒体工具同一判定。
    // 装配整体前移到首次 preparation 之前：initial 资格闭包在该调用内同步执行，
    // 其引用不得晚于该调用声明（TDZ）。
    const mediaCapable =
      o.mediaEnabled?.() !== false &&
      o.mediaAdapter !== undefined &&
      guard.allowed(groupOwner, "media");
    const mediaService = mediaCapable && o.mediaInputService ? o.mediaInputService(scheme) : null;
    const mediaSettings: QqEffectiveMediaPolicy | null = mediaService
      ? {
          ...schemeMediaInput(scheme),
          ordinary_frame_count: schemeRhythm(scheme).media_frame_count,
          ordinary_frame_max_dimension: schemeRhythm(scheme).media_max_dimension,
        }
      : null;
    // 分类缓存槽/typed 结果缓存的共同真源修订：宿主从生效方案的实际媒体输入形状规范化
    // （prompt、帧数、最大边）。classificationPolicy 与 createQqMediaTools 的 policyRevision
    // 同值同源，不在消费/回读两侧各自组合。
    const mediaPolicyRevision = bodyRevision(
      JSON.stringify({
        prompt: schemePrompts(scheme).media,
        frames: schemeRhythm(scheme).media_frame_count,
        maxDimension: schemeRhythm(scheme).media_max_dimension,
      }),
    );
    // 同次分类消费（规格 §10）：sentMediaIds/sentSources 取自对应相投影的真实发送集；
    // consume 在宿主（可信侧）执行，白名单/重复/伪造 mediaId 一律 fail closed。
    const mediaScope = () => ({
      conversationId: conversation.id,
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      bindingId: binding.id,
      bindingEpoch: conversation.bindingEpoch,
      authorityRevision: binding.authorityRevision,
    });
    let prepared = preparation(true);
    if (prepared.kind !== "prepared") {
      settleOpportunity(prepared.readyAtSeconds);
      return { status: "no_output" as const, reason: prepared.reason };
    }
    let targets: BotContextTarget[] = [];
    const authorizedTargets: string[] = [];
    const setTargets = () => {
      targets =
        prepared.kind !== "prepared"
          ? []
          : binding.kind === "private"
            ? [{ id: binding.peerId, speakerId: binding.peerId }]
            : !split || path === "idle_topic"
              ? [{ id: binding.peerId, speakerId: null }]
              : prepared.targets.map((p) => ({
                  id: p.speakerId ?? "anonymous",
                  speakerId: p.speakerId,
                }));
      if (binding.kind === "group" && split && path === "direct_reply") {
        const attention = attentionTriggerFilter(binding);
        const addressed = o.journal
          .eventsAfter(conversation.id, conversation.consumedSeq, Number.MAX_SAFE_INTEGER)
          .items.filter(
            (e) =>
              e.kind === "inbound" &&
              e.addressing.reasons.some((r) => r === "mention" || r === "reply_to_agent") &&
              seconds() - Math.floor(Date.parse(e.occurredAt) / 1000) <=
                QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS &&
              (!attention || (!!e.participant?.id && attention.includes(e.participant.id))),
          );
        const byId = new Map(targets.map((t) => [t.id, t]));
        for (const event of addressed) {
          const speaker = event.participant?.id ?? null;
          byId.set(speaker ?? "anonymous", { id: speaker ?? "anonymous", speakerId: speaker });
        }
        targets = [...byId.values()];
      }
      authorizedTargets.splice(0, authorizedTargets.length, ...targets.map((t) => t.id));
    };
    setTargets();
    const assertConfiguration = () => {
      const current = readQqBinding(o.orm, binding.id);
      const check = checkQqTask(snapshot, current, "send", readQqOwnerIdentity(o.orm));
      if (check.kind === "blocked") throw new Error(check.reason);
      if (
        readQqScheme(o.orm, scheme.id)?.revision !== scheme.revision ||
        getAgentRow(o.orm, agent.id)?.configVersion !== agent.configVersion
      )
        throw new Error("BOT_CONFIGURATION_CHANGED");
      // §8.1/§13.3：群 media 能力纪元检查——off→on/rev++ 后旧 fetch/asset/variant 写不得通过。
      if (readQqGroupCapabilityRevision(o.orm, binding, "media") !== frozenMediaCapRev)
        throw new Error("MEDIA_CAPABILITY_EPOCH_CHANGED");
      const settings = readQqSettings(o.orm);
      if (settings.accountId !== binding.accountId || getAgentRow(o.orm, agent.id)?.isActive !== 1)
        throw new Error("BOT_ACCOUNT_CHANGED");
      const gate = checkQqSpeechSend({
        kind: path,
        featureEnabled: settings.enabled === 1,
        conversationPaused: current?.paused ?? true,
        disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(current!, scheme)),
      });
      if (gate.kind === "blocked") throw new Error(gate.reason);
      if (o.journal.row(conversation.id)?.closed_at) throw new Error("BINDING_EPOCH_CHANGED");
    };
    const assertAuthority = () => {
      signal.throwIfAborted();
      if (!wake.leaseToken || !o.wakes.owns(wake.id, wake.leaseToken, now()))
        throw new Error("WAKE_LEASE_LOST");
      assertConfiguration();
      // T-spec detail 同次升规格锚复验（零额外模型调用/额外 read）：放在 assertAuthority 末段
      // 而非 assertConfiguration 内——问题锚回调自己只复验事实/来源/正文修订（其起点是
      // assertConfiguration，不是 source.assertCurrent），所以这里逐锚复跑不会回到
      // assertAuthority，形成递归。未登记锚（ordinary read）不动。
      for (const anchor of detailAnchors.values()) anchor.assertQuestionCurrent(o.orm);
    };
    /**
     * 已在运行的背景任务（水位压缩）的边界（ADR0019 §13.1 B、§13.3 D/H）：
     * 作用域、权威、全局开关与来源复验不变即可完成；**暂停与普通配置变化不杀已在跑的任务**
     * （它们只在该任务尚未开始时拒绝，见下面的启动闸门）。「群停用后已运行的摘要整理仍可完成」是
     * 已批准语义，旧实现用含 paused/revision 的 `assertConfiguration` 会让它在暂停瞬间失败。
     */
    const assertBackgroundCurrent = () => {
      const current = readQqBinding(o.orm, binding.id);
      const check = checkQqTask(backgroundSnapshot, current, "publish", readQqOwnerIdentity(o.orm));
      if (check.kind === "blocked") throw new Error(check.reason.toUpperCase());
      const settings = readQqSettings(o.orm);
      if (settings.enabled !== 1 || settings.accountId !== binding.accountId)
        throw new Error("BOT_ACCOUNT_CHANGED");
      if (getAgentRow(o.orm, agent.id)?.isActive !== 1) throw new Error("BOT_ACCOUNT_CHANGED");
      if (o.journal.row(conversation.id)?.closed_at) throw new Error("BINDING_EPOCH_CHANGED");
      // 本群停用「会话历史摘要」后，未提交的摘要结果不得再发布（立即生效，不等下一轮）。
      guard.assert(groupOwner, "history_summary");
    };
    /** 排队中的背景任务在开始前判定：暂停与普通配置变化拒绝它，而不是让它花掉模型调用再丢弃。 */
    const assertBackgroundStart = () => {
      const current = readQqBinding(o.orm, binding.id);
      if (current === null) throw new Error("BINDING_CHANGED");
      // 暂停先判：否则暂停带来的 revision 变化会被读成普通的 binding_changed。
      if (current.paused) throw new Error("CONVERSATION_PAUSED");
      const check = checkQqTask(backgroundSnapshot, current, "start", readQqOwnerIdentity(o.orm));
      if (check.kind === "blocked") throw new Error(check.reason.toUpperCase());
      if (
        readQqScheme(o.orm, scheme.id)?.revision !== scheme.revision ||
        getAgentRow(o.orm, agent.id)?.configVersion !== agent.configVersion
      )
        throw new Error("BOT_CONFIGURATION_CHANGED");
      const settings = readQqSettings(o.orm);
      if (settings.enabled !== 1 || settings.accountId !== binding.accountId)
        throw new Error("BOT_ACCOUNT_CHANGED");
      if (getAgentRow(o.orm, agent.id)?.isActive !== 1) throw new Error("BOT_ACCOUNT_CHANGED");
      if (o.journal.row(conversation.id)?.closed_at) throw new Error("BINDING_EPOCH_CHANGED");
    };
    const usage = { calls: 0, inputUnits: 0 };
    const budget = { maxCalls: policy.maxSteps + 8, maxInputUnits: policy.maxSteps * 200_000 };
    const stickerRequest = () => ({
      schemeId: scheme.id,
      // 本群作用域随请求一起带上：候选要按生效素材集合裁剪，不能只看基础方案。
      binding,
      scope: {
        kind: "qq" as const,
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
      },
      counts: o.stickers.counts,
      nowSeconds: seconds(),
      isAvailable: o.stickers.isAvailable,
    });
    // 本群停用叠在全局开关上：停用后既不出现在工具目录，也不在执行与发送边界放行。
    const stickersEnabled =
      o.stickersEnabled?.() !== false && guard.allowed(groupOwner, "stickers");
    const stickerCatalog = () => {
      const catalog = currentQqStickerCatalog(o.orm, stickerRequest());
      return stickersEnabled ? catalog : { ...catalog, state: "disabled" as const, assets: [] };
    };
    const stickerState = stickerCatalog();
    const decisionTier = binding.kind === "private" ? ("reply" as const) : ("judgement" as const);
    // 输出预留既参与容量预算，也必须作为 max_tokens 下发，否则模型可以超出预留输出。
    const reserves = schemeOutputReserve(scheme);
    const spec: AgentSpec = {
      id: "onebot.main",
      version: "4",
      context: "conversation",
      model: initiative
        ? (readQqSettings(o.orm).judgementModelName ?? runtime.model_name)
        : runtime.model_name,
      maxTokens:
        decisionTier === "judgement"
          ? reserves.judgement_output_reserved
          : reserves.reply_output_reserved,
      instructions: [
        compileSystemPrompt(runtime),
        schemePrompts(scheme).scene,
        QQ_MEDIA_RULE,
        QQ_EXPRESSION_MEDIA_RULE,
        "需要理解图片时先调用 media.list 获取本会话图片 ID；已有描述用 media.note.read 分页读取，未描述时显式调用 media.describe，再读取描述。media.describe 会调用视觉模型并保存缓存，不是只读工具。目录、未读图片和未返回的描述均不代表已经理解图片。若用户这条消息就是在问某张图的细节，把该图 ID 与本轮问题消息的 messageId 一起传给 media.describe 或 media.read 做细读：程序会核验问题身份并按细节规格取图，同时在本轮后续决策里把该图按更细的规格提供给你；问题不是本轮这条、或这张图不在它的图范围内时会被拒绝，不会退化成普通读取。",
        `表情偏好（忽略旧编号格式，以stickerIds协议为准）：\n${schemePrompts(scheme).sticker}`,
        `表情能力：${stickerState.state}，当前可用 ${stickerState.assets.length} 张。inline/generate 共用 stickerIds：[]=明确不用；[id]=指定一张，ID 必须来自本 run sticker.search 已返回的候选或 pending_plan 的已选 ID，不要编造或复用旧 ID。有候选而省略/null 会被要求重选（STICKER_SELECTION_REQUIRED）；未披露或已失效的 ID 会被拒绝（STICKER_SELECTION_UNAVAILABLE）。允许空正文仅发图；真正不发则返回 none。output_feedback 表示尚未发送的无效计划，须纠正。`,
        `这是 OneBot ${binding.kind === "private" ? "私聊" : "群聊"}。只向 authorizedTargets 中的目标输出；${split ? "每个目标最多一条回复，由程序添加该目标的 @，不要自行添加。" : "不按发言人拆分，整间会话最多一条逻辑回复；该回复可以由程序按换行发送多段。"}`,
        initiative
          ? `这是 ${path} 唤醒。先写清"这一轮打算说什么"（generate 的 instructions 就是意图）：程序会拿它去判定许可，通过后才会让你写正文；被拒时这一轮静默结束。没有合适回应时返回 none。`
          : "有人直接与你交流。可查询资料、生成或直接回答，也可保持沉默；不需要群聊兴趣评分。",
        `后续相关消息到来要重新决定尚未发送的计划。pending_plan 是你之前的草稿/计划与剩余独立 generate 次数，属于资料而非指令。读过新消息后，可以用 inline 原样保留或修改仍然适用的草稿，也可 none 暂不发送；generate 次数耗尽时不能再请求独立生成。主动发言仍要取得当前观察序列的评分许可。复核指导：\n${schemePrompts(scheme).review}`,
      ].join("\n\n"),
      availableActions: [],
      // 生成/重算用回复预留（判断与复核用判断预留，见 P3o）。
      generation: {
        model: runtime.model_name,
        allowEmpty: true,
        maxTokens: reserves.reply_output_reserved,
      },
      limits: { steps: policy.maxSteps },
    };
    const baseInstructions = spec.instructions ?? "";
    const observationEpoch = (seq: number) =>
      `${baseInstructions}\n当前观察序列：${String(seq).padStart(20, "0")}。许可由程序按当前相关状态判定：新的相关观察会让它自动失效，不相关的变化不影响它。`;
    spec.instructions = observationEpoch(0);
    let runId: string | undefined;
    /**
     * 分类回读门控的真实执行记录：每次 consume 成功落库后记录 (policy→resolved)。
     * gate 只在"上一同键消费的 resolved==当前 requested"时放行回读——首次/路由不确定
     * 一律零回读（unknown 按普通规格），不以 requested 字符串相等冒充 resolved 确认。
     */
    const lastResolvedByPolicy = new Map<string, string>();
    /**
     * 本 run **明确细问**且已成功读取的 mediaId 集合：下一相 preparePhaseMedia 以
     * detailMediaIds 送入投影，升普通规格并进 explicit 桶（§7.5）——是否真的送 native
     * 画面仍由当相阶段开关与能力守卫视。
     *
     * 这里只记**问题锚定**的 detail 读取：普通 media.read（无 questionMessageId）只是把图
     * 取到手里，不表达「本轮明确要细看这张」，因此绝不进这个集合、不得升规格。一个没有
     * asset/ref 的首见行仍可成功读取（准备发生在那一步），但它带来的只是本次工具结果。
     */
    const runDetailMediaIds = new Set<string>();
    const phaseSentIds = (phase: "decision" | "evaluation" | "generation") =>
      new Set((source.mediaProjection(phase)?.images ?? []).map((image) => image.mediaId));
    const phaseSentSources = (phase: "decision" | "evaluation" | "generation") =>
      new Map(
        (source.mediaProjection(phase)?.images ?? []).flatMap((image) =>
          image.sources
            .filter((ref) => ref.kind === "qq_media_source")
            .map((ref) => [ref.id, ref] as const),
        ),
      );
    const hasUnknownImages = (phase: "decision" | "evaluation" | "generation") =>
      (source.mediaProjection(phase)?.images ?? []).some((image) => image.category === "unknown");
    const envelopeOnly = (raw: string) =>
      parseModelEnvelope(JSON.parse(raw) as unknown, phaseSentIds("decision")).decision;
    const consumeClassifications = (
      phase: "decision" | "evaluation" | "generation",
      classifications: readonly {
        mediaId: string;
        category: "ordinary" | "expression" | "unknown";
      }[],
      actualModel: string,
      signal: AbortSignal,
    ) => {
      if (classifications.length === 0) return;
      consumeModelMediaData({
        store: { db, orm: o.orm },
        owner: groupOwner,
        scope: mediaScope(),
        sentMediaIds: phaseSentIds(phase),
        sentSources: phaseSentSources(phase),
        classifications,
        actualModel,
        policyRevision: mediaPolicyRevision,
        assertCurrent: () => assertAuthority(),
        signal,
      });
      // 真实执行观测记录：本 policy 键下最近一次消费的实际模型（resolved）。它**不作为**
      // 回读门控依据（历史 resolved 不证下一次解析），仅保留供诊断/后续方案评估。
      lastResolvedByPolicy.set(mediaPolicyRevision, actualModel);
      // 分类是 (asset,policy) 缓存槽的写入，不改变任何来源修订——不需要/不应该
      // invalidate 当前视图（mid-generation 失效会打死本轮 reconsider）。
    };
    /** §8.1 current_run_consumed：相调用成功后把该相真实发送的 mediaId 全部记为已消费
     * （sourceRefs 取该相投影中对应图像的真实来源引用，末验仍 current）。
     * consumedAt 用宿主 now()（与 journal/harness 时钟同源），不用 Date.now() 避免混域。 */
    const recordNativeConsumed = (phase: "decision" | "evaluation" | "generation") => {
      const at = now();
      const projection = source.mediaProjection(phase);
      for (const mediaId of phaseSentIds(phase)) {
        const imageSources =
          projection?.images
            .filter((image) => image.mediaId === mediaId)
            .flatMap((image) => image.sources) ?? [];
        // variant 形状取该相投影里这张图**真实发出**的全部 variant（多帧动画每帧一个
        // variantId/策略），供 nativeReadProof 与 detail 锚比对：旧 512 变体解不开新 detail
        // 规格时不得冒充已消费。
        const imageVariants =
          projection?.images
            .filter((image) => image.mediaId === mediaId)
            .map((image) => ({ variantId: image.variantId, variantPolicy: image.variantPolicy })) ??
          [];
        runNativeConsumed.set(mediaId, {
          consumedAt: at,
          sourceRefs: imageSources,
          variants: imageVariants,
        });
      }
    };
    const mediaFocus = () => ({
      // §7.1 自动范围＝本轮应回应消息（responseMessageIds）里的图＋它直接引用原图。
      // direct_reply/chiming_in 都有焦点消息（wake 事件）；idle_topic 没有"应回应消息"。
      triggerMessageIds: focusKey ? [focusKey] : [],
      responseMessageIds: focusKey && path !== "idle_topic" ? [focusKey] : [],
      responseQqs: targets.map((target) => target.speakerId ?? "anonymous"),
      assistantQq: binding.accountId,
    });
    // 主 run 的发送边界 resolver：三相已验证投影的字节都登记在本 run（conversation owner）
    // 下；评分叶子另行按 Step5a 重登记（不跨 run 借用）。运行结束在 activate 外层 release。
    const runResolver = mediaService ? createImageByteResolver() : null;
    const registerProjection = (phase: "decision" | "generation") => {
      const projection = source.mediaProjection(phase);
      if (!runResolver || !projection || projection.images.length === 0) return;
      source.assertSources(projection.sources);
      guard.assertSources(groupOwner, projection.sources);
      for (const image of projection.images) {
        const row = db
          .query("SELECT asset_id, policy, bytes FROM qq_media_variants WHERE id=?")
          .get(image.variantId) as
          | { asset_id: string; policy: string; bytes: Uint8Array }
          | undefined;
        if (!row || row.asset_id !== image.assetId || row.policy !== image.variantPolicy)
          throw new Error("MEDIA_IMAGE_VARIANT_MISMATCH");
        if (runId === undefined || owner === undefined) throw new Error("MEDIA_IMAGE_RUN_MISSING");
        runResolver.register({
          runId,
          owner,
          part: image.content,
          bytes: new Uint8Array(row.bytes),
          sources: image.sources,
          assertCurrent: () => source.assertCurrent(),
        });
      }
    };
    const source = new BotContextSource({
      modules: o.modules,
      resolveSource: o.resolveSource,
      db,
      orm: o.orm,
      gateway: o.gateway,
      agentRuntime: o.agentRuntime,
      journal: o.journal,
      outbox: o.outbox,
      conversationId: conversation.id,
      binding,
      snapshot,
      scheme,
      runtime,
      spec,
      path,
      ...(focusKey
        ? {
            trigger: {
              sourceId: focusKey,
              seq: wake.throughSeq,
              participantId: focus?.participant?.id ?? null,
            },
          }
        : {}),
      decisionTier,
      targets: () => targets,
      assertCurrent: assertAuthority,
      assertBackgroundCurrent,
      assertStartable: assertBackgroundStart,
      guard,
      // 规格 §10 评分协议预算真源：与 callScoreLeaf 同一 imported/本模块常量
      // （QQ_SCORE_ENVELOPE_SCHEMA / QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE），宿主不复制第二份串。
      // 实际是否走 envelope 仍由 callScoreLeaf 的 scoreUsesEnvelope 唯一决定；ctx 的
      // scoreProtocolUnits 取 max(plain, 实际)——plain 轮按 envelope 上界估，fail-closed
      // 不放宽、不给免费 units；缺省 plain 语义由 ctx 侧保持，宿主不新增分支。
      scoreProtocol: {
        responseSchema: QQ_SCORE_ENVELOPE_SCHEMA,
        outputRule: QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE,
      },
      ...(mediaService && mediaSettings
        ? {
            mediaInput: {
              service: mediaService,
              settings: mediaSettings ?? fail("CONTEXT_SOURCE_INVALID", "媒体策略缺失"),
              focus: mediaFocus,
              capabilityEnabled: mediaCapable,
              // 分类回读键与 consumeModelMediaData 的 policyRevision 同一真源（plain 串）。
              classificationPolicy: mediaPolicyRevision,
              // 回读门控（T10 钩子后真实语义）：钩子在 actualModel 冻结后重备，
              // lastResolvedByPolicy 是上次同键真实消费的 resolved——与本 call used 一致
              // 才放行回读；首调/不一致＝零回读（unknown 按普通规格）。
              classificationGate: () => lastResolvedByPolicy.get(mediaPolicyRevision) ?? null,
              // D2：回复展开深度/模式真源（生效方案的 message_settings 组）。
              messageSettings: schemeMessageSettings(scheme),
              // 本 run 明确细问且已成功读取的 mediaId（§7.5）：下一相按当相阶段开关把它升
              // 普通规格并进 explicit 桶。集合只由问题锚定的 detail 读取写入，ordinary
              // read 永不入内——这是「升规格」的唯一入口，不在服务侧另开第二条升级路径。
              detailMediaIds: () => runDetailMediaIds,
            },
          }
        : {}),
      usage,
      budget,
      now,
      onRead: (seq) => {
        spec.instructions = observationEpoch(seq);
        if (runId) o.journal.linkRun(runId, conversation.id, seq, wake.id);
      },
    });
    const diagnose = (event: Omit<BotHostDiagnostic, "runId" | "conversationId" | "sourceSeq">) => {
      try {
        const result = o.onDiagnostic?.({
          ...event,
          runId,
          conversationId: conversation.id,
          sourceSeq: source.observedSeq,
        });
        if (result) void Promise.resolve(result).catch(() => {});
      } catch {
        /* Observability must not affect output or delivery state. */
      }
    };
    /**
     * §9/T14 观测面（B3 span 先行）：把相媒体准备的真实结果发到 bot.host.feedback 诊断通道，
     * create-runtime 原样透传 details 进 runtime_spans（可由 runs span API 读回）。字段全部
     * scalar 安全值：phase/requestedMode/actualMode/why/requestedModel/resolvedModel/
     * imageCount/omissionCount + 逐条 `omission:<n>`（固定形状 JSON 串 {mediaId,reason}，
     * 逐 id 逐条不拼接；记录真实 projection 全量，不设业务数值帽）；resolved 不可得＝null，
     * 不用 requested 顶替。无 bytes/base64/URL/path/正文。
     */
    const emitMediaMode = (
      phase: "decision" | "evaluation" | "generation",
      extra: {
        why?: string | null;
        code?: string;
        actualModeOverride?: string;
        resolvedModel?: string | null;
        requestedModel?: string;
      } = {},
      projectionOverride?: QqMediaProjection,
    ): void => {
      const projection: QqMediaProjection | undefined =
        projectionOverride ?? source.mediaProjection(phase);
      if (!projection) return;
      const details: Record<string, string | number | boolean | null> = {
        phase,
        requestedMode: projection.requestedMode,
        actualMode: extra.actualModeOverride ?? projection.actualMode,
        why: extra.why ?? null,
        requestedModel: extra.requestedModel ?? spec.model ?? runtime.model_name,
        resolvedModel: extra.resolvedModel ?? null,
        imageCount: projection.images.length,
        omissionCount: projection.omissions.length,
      };
      for (const [index, omission] of projection.omissions.entries()) {
        details[`omission:${index}`] = JSON.stringify({
          mediaId: omission.mediaId,
          reason: omission.reason,
        });
      }
      diagnose({
        stage: "media_mode",
        status: "observed",
        ...(extra.code ? { code: extra.code } : {}),
        details,
      });
    };
    /**
     * T10/§9 三相准备钩子（决策/生成；评分叶子的钩子见 evaluateIntent 的请求）：网关在
     * actualModel 冻结后调用。imagesAllowed=true → 请求原样（投影已在相准备时按方案
     * settings 真源完成；模式观测走 emitMediaMode 白名单落 span）。
     * imagesAllowed=false → 严格 §9：仅当本相真实准备了原生图（当前相关闭＝没有可降的
     * native 发送，不 fallback）才 requestMediaFallback + describeAfterUnsupported 重备，
     * 请求消息剥离 image part、注入 description notes（data_only）；无可用视觉模型＝
     * unavailable，同样不编内容。返回前真实 assertCurrent——provider/authority 变化
     * 不发（网关只有 signal 检查，这里是 host final guard）。
     */
    const preparePhaseForModel = async (input: {
      readonly phase: "next" | "generate";
      readonly model: string;
      readonly imagesAllowed: boolean;
      readonly messages: readonly ModelMessage[];
      readonly signal?: AbortSignal;
    }): Promise<ModelResolvedPrepareOutput> => {
      const qqPhase: "decision" | "generation" = input.phase === "next" ? "decision" : "generation";
      source.assertCurrent();
      if (input.imagesAllowed) {
        // resolved 已冻结：以真实 used 重备本相媒体，分类回读门控按真实 resolved 放行
        // （同 call 分类经 envelope 消费以真实 resolved 落库）。投影形状不变＝请求消息原样。
        const freshProjection = await source.repreparePhaseForModel(
          qqPhase,
          input.model,
          input.signal ?? signal,
        );
        // 重备后立即把最终投影的全部 variants 登记进本 run resolver（bindRun 时投影可能
        // 尚未存在；同一 partKey 幂等覆盖，不产生预算重复）。避免 resolver-missing 零 HTTP。
        if (freshProjection && freshProjection.images.length > 0) {
          if (runId === undefined) throw new Error("MEDIA_IMAGE_RUN_MISSING");
          source.assertSources(freshProjection.sources);
          guard.assertSources(groupOwner, freshProjection.sources);
          for (const image of freshProjection.images) {
            const row = db
              .query("SELECT asset_id, policy, bytes FROM qq_media_variants WHERE id=?")
              .get(image.variantId) as
              | { asset_id: string; policy: string; bytes: Uint8Array }
              | undefined;
            if (!row || row.asset_id !== image.assetId || row.policy !== image.variantPolicy)
              throw new Error("MEDIA_IMAGE_VARIANT_MISMATCH");
            runResolver?.register({
              runId,
              owner,
              part: image.content,
              bytes: new Uint8Array(row.bytes),
              sources: image.sources,
              assertCurrent: () => source.assertCurrent(),
            });
          }
        }
        emitMediaMode(qqPhase, { why: null, resolvedModel: input.model });
        return {};
      }
      const nativeImages = source.mediaProjection(qqPhase)?.images.length ?? 0;
      if (nativeImages === 0) return {};
      source.requestMediaFallback(qqPhase, "model_image_unsupported");
      const fallbackProjection = await source.repreparePhaseMedia(qqPhase, input.signal ?? signal);
      emitMediaMode(
        qqPhase,
        {
          why: "model_image_unsupported",
          code: "MODEL_IMAGE_UNSUPPORTED",
          actualModeOverride: fallbackProjection?.actualMode,
          resolvedModel: input.model,
        },
        fallbackProjection,
      );
      const notes = fallbackProjection?.notes ?? [];
      const stripped = input.messages
        .map((message) => ({
          ...message,
          content: message.content.filter((part) => part.kind !== "image"),
        }))
        .filter((message) => message.content.length > 0);
      const messages: ModelMessage[] =
        notes.length > 0
          ? [
              ...stripped,
              textMessage(
                "user",
                contextDumps({ kind: "qq_media_notes", trust: "data_only", notes }),
              ),
            ]
          : stripped;
      // 最终 materials 预算复验（当前真源）：超上限＝该次尝试不发出（fail closed）。
      const ceiling = source.phaseUnitsCeiling(qqPhase);
      if (ceiling !== undefined && inputUnits(messages) > ceiling) {
        fail("CONTEXT_BUDGET_EXCEEDED", "fallback 后的材料超过模型容量");
      }
      return { messages };
    };
    // 披露表：本 run 的 sticker.search 实际返回过哪些 ID（带素材修订），按 owner/run 记账。
    // 显式 stickerIds 只认这里出现过的 ID；跨 run、猜测、已失效的一律拒绝。
    const owner: RunOwner = {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: agent.id,
    };
    const stickerDisclosures = new Map<string, Map<string, string>>();
    const disclosureKey = (run: string | undefined, scope: RunOwner) =>
      JSON.stringify([
        run ?? null,
        scope.kind,
        scope.id,
        scope.userId ?? null,
        scope.agentId ?? null,
      ]);
    const disclosedSticker = (id: string) => {
      const revision = stickerDisclosures.get(disclosureKey(runId, owner))?.get(id);
      if (revision === undefined) return undefined;
      const asset = stickerCatalog().assets.find((entry) => entry.id === id);
      return asset && asset.updatedAt === revision ? asset : undefined;
    };
    /**
     * media.describe/read 的 questionMessageId 锚解析（宿主唯一真源）：被指消息必须是本会话
     * 内、当前 Agent 有权、未过期的真实消息，且属于 focus 消息本身或它的直接引用目标
     * （focus depth1 + target）；questionKey 由真实原文规范化冻结，模型措辞零参与。
     */
    const resolveQuestion: QqMediaQuestionAnchorResolver = (input) => {
      if (!focusKey) return null;
      source.assertCurrent();
      const readScope: QqConversationScope = {
        conversationId: conversation.id,
        accountId: binding.accountId,
        conversationKind: binding.kind,
        peerId: binding.peerId,
        agentId: binding.agentId,
        bindingId: binding.id,
        bindingEpoch: conversation.bindingEpoch,
        authorityRevision: binding.authorityRevision,
      };
      // 统一 fact 加载 + 验证函数：question + focus + direct target 三个 fact 都加载，
      // 然后用统一规则匹配 mediaNote（event_key + segment_index + mediaId）。
      // 返回 null = 无合法关联（供 initial 与 assertQuestionCurrent 共用）。
      // at = now() 每次调用重新取——assertQuestionCurrent 复跑时用当前时间戳，
      // 不用 initial 时的冻结时间（跨到期时能按当前期限拒）。
      const buildAndValidate = () => {
        const at = now();
        // 1. focus fact：eventKey 域加载（focusKey 是内部 eventKey）
        const focusFacts = projectQqMessageFacts(
          { db, orm: o.orm },
          readScope,
          [focusKey as string],
          at,
        );
        const focusFact = focusFacts[0] ?? null;
        if (!focusFact) return null;

        // 2. question fact：平台消息 ID 域加载
        const questionFact = loadQqMessageFact(
          { db, orm: o.orm },
          readScope,
          input.questionMessageId,
          at,
        );
        if (!questionFact) return null;

        // 3. focus∪depth1 判定：question 是 focus 本身，或 focus 的直接引用目标
        const focusPlatformId = focusFact.platformMessageId;
        const isFocusMessage =
          focusPlatformId !== null && questionFact.platformMessageId === focusPlatformId;
        const isDirectTarget =
          focusFact.replyTo !== null &&
          questionFact.platformMessageId === focusFact.replyTo.platformMessageId;
        if (!isFocusMessage && !isDirectTarget) return null;

        // 4. 构建授权 fact 集合：question fact + focus fact + direct target fact
        const directTargetFact =
          focusFact.replyTo !== null
            ? loadQqMessageFact(
                { db, orm: o.orm },
                readScope,
                focusFact.replyTo.platformMessageId,
                at,
              )
            : null;
        const authorizedFacts = [questionFact, focusFact, directTargetFact].filter(
          (f): f is NonNullable<typeof f> => f !== null,
        );

        // 5. 媒体 note 精确匹配：
        //    - mediaNote.event_key === input.eventKey === matchingFact.id（严格域一致）
        //    - mediaNote.segment_index === input.segmentIndex
        //    - matching fact parts 包含 kind=image && mediaId === input.mediaNoteId
        const mediaNote = db
          .query("SELECT event_key, segment_index, segment_kind FROM qq_media_notes WHERE id=?")
          .get(input.mediaNoteId) as
          | { event_key: string; segment_index: number; segment_kind: string }
          | undefined;
        if (!mediaNote || mediaNote.segment_kind !== "image") return null;

        // 严格域绑定：event_key === input.eventKey === matchingFact.id
        if (mediaNote.event_key !== input.eventKey) return null;
        if (mediaNote.segment_index !== input.segmentIndex) return null;

        // 在授权 facts 中找到与 mediaNote.event_key 匹配的 fact，然后验证其 parts
        // 包含该 mediaId 的 image part
        const matchingFact = authorizedFacts.find((fact) => fact.id === mediaNote.event_key);
        if (!matchingFact) return null;
        const imagePart = matchingFact.parts.find(
          (part) => part.kind === "image" && part.mediaId === input.mediaNoteId,
        );
        if (!imagePart) return null;

        return { questionFact, focusFact, matchingFact, imagePart, mediaNote };
      };

      // 统一验证
      const validated = buildAndValidate();
      if (!validated) return null;

      // 正文提取（仅 question fact）
      const body = validated.questionFact.parts
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join("");
      if (body.trim() === "") return null;
      const questionSource = validated.questionFact.sources[0];
      if (!questionSource) return null;
      const revision = bodyRevision(body);
      return {
        questionKey: normalizeQuestionKey(body),
        eventKey: validated.questionFact.id,
        bodyRevision: revision,
        source: questionSource,
        // 统一复验：重建相同 question+focus+direct fact 集合，严格验证 note event/index/
        // mediaId 与 fact parts 匹配——初验后任何关联变化都必须拒。
        assertQuestionCurrent: () => {
          // 复验入口＝基础授权（assertConfiguration），不是 source.assertCurrent：后者会经
          // assertAuthority 回到 assertAuthority 末段的问题锚复验，形成无限递归。这里
          // signal + 基础配置/权威/能力纪元/发言闸照旧全跑，锚自身的 fact/源/正文复验
          // 由下面的 buildAndValidate 真实重建完成——不吞异常、不重入抑制。
          signal.throwIfAborted();
          assertConfiguration();
          const revalidated = buildAndValidate();
          if (!revalidated) {
            fail("CONTEXT_SOURCE_INVALID", "问题消息或媒体关联已变化");
          }
          // 正文修订复验
          const currentBody = revalidated.questionFact.parts
            .flatMap((part) => (part.kind === "text" ? [part.text] : []))
            .join("");
          if (bodyRevision(currentBody) !== revision) {
            fail("CONTEXT_SOURCE_INVALID", "问题原文已变化");
          }
        },
      };
    };
    /**
     * media.read 背后的受控读取（T08 fix2）：走 media 服务 prepareByMediaId 同一实现——
     * 真实受控 fetch/cache/asset+link+variant/分类回读/detail 规格，宿主只做 variant
     * scoped 复验 + 当前 run resolver 登记 + runDetailMediaIds 记账。绝不手写
     * fetch/codec 第二准备链，也绝不发 raw bytes。
     */
    const readMediaImage: QqMediaReadImageService = async (input) => {
      source.assertCurrent();
      if (!mediaService) fail("CONTEXT_SOURCE_INVALID", "媒体读取服务未接线");
      const noteRow = db
        .query("SELECT event_key, segment_kind FROM qq_media_notes WHERE id=?")
        .get(input.mediaNoteId) as { event_key: string; segment_kind: string } | undefined;
      if (!noteRow || noteRow.event_key !== input.eventKey || noteRow.segment_kind !== "image") {
        fail("CONTEXT_SOURCE_INVALID", "媒体引用不属于本会话");
      }
      const detail = input.question
        ? {
            questionKey: input.questionKey ?? "",
            eventKey: input.question.eventKey,
            source: input.question.source,
            assertQuestionCurrent: input.question.assertQuestionCurrent,
          }
        : undefined;
      const result = await mediaService.prepareByMediaId({
        scope: mediaScope(),
        phase: "generation",
        focus: mediaFocus(),
        facts: projectQqMessageFacts({ db, orm: o.orm }, mediaScope(), [input.eventKey], now()),
        replies: { roots: [], sources: [] },
        settings: mediaSettings ?? fail("CONTEXT_SOURCE_INVALID", "媒体策略缺失"),
        model: runtime.model_name,
        now: now(),
        runId: runId ?? "",
        signal: input.signal ?? signal,
        assertCurrent: () => source.assertCurrent(),
        capabilityEnabled: mediaCapable,
        owner: groupOwner,
        mediaId: input.mediaNoteId,
        detail: input.question ? (detail ?? undefined) : undefined,
      });
      // variant scoped 复验 + 当前 run resolver 登记（bytes 只进 resolver，不进工具结果）。
      if (runResolver) {
        for (const image of result.images) {
          const row = db
            .query("SELECT asset_id, policy, bytes FROM qq_media_variants WHERE id=?")
            .get(image.variantId) as
            | { asset_id: string; policy: string; bytes: Uint8Array }
            | undefined;
          if (!row || row.asset_id !== image.assetId || row.policy !== image.variantPolicy)
            throw new Error("MEDIA_IMAGE_VARIANT_MISMATCH");
          if (runId === undefined) throw new Error("MEDIA_IMAGE_RUN_MISSING");
          runResolver.register({
            runId,
            owner,
            part: image.content,
            bytes: new Uint8Array(row.bytes),
            sources: image.sources,
            assertCurrent: () => source.assertCurrent(),
          });
        }
      }
      // 只有问题锚定的**细问**读取才登记进 detail 集合：ordinary read（无 question 锚）
      // 刻意不入，因此不得升普通规格、不得进 explicit 桶。
      if (input.question !== undefined && input.questionKey?.trim()) {
        // 登记成功之前复验来源与问题锚（await 之后的真实状态，不把「prepared ok」当成锚成立）：
        // 来源失效走既有 assertCurrent reason，问题正文/图范围移动走锚自身 reason。
        source.assertCurrent();
        input.question.assertQuestionCurrent(o.orm);
        runDetailMediaIds.add(result.mediaId);
        detailAnchors.set(result.mediaId, {
          assertQuestionCurrent: input.question.assertQuestionCurrent,
          variants: result.images.map((image) => ({
            variantId: image.variantId,
            variantPolicy: image.variantPolicy,
          })),
        });
      }
      return {
        category: result.category,
        images: result.images.map((image) => ({
          source: image.sources[0],
          mimeType: image.mimeType,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
          frameIndex: image.frameIndex,
        })),
      };
    };
    const mediaEnabled = mediaCapable;
    const purposes = readOrganizationSettings(o.orm);
    // mediaPolicyRevision 的计算已上移到 mediaSettings 装配处（分类回读/typed 缓存同一真源）。
    const mediaRhythm = schemeRhythm(scheme);
    const mediaActions =
      mediaEnabled && o.mediaAdapter
        ? createQqMediaTools({
            db,
            orm: o.orm,
            conversationId: conversation.id,
            binding,
            adapter: o.mediaAdapter(scheme),
            modelConfig: {
              visionModelName: purposes.vision_model_name,
              transcriptionModelName: purposes.transcription_model_name,
            },
            supplementWindowMinutes: mediaRhythm.media_supplement_window_minutes,
            policyRevision: mediaPolicyRevision,
            assertCurrent: () => source.assertCurrent(),
            fit: (name, arguments_, actionSignal) =>
              source.actionResultFitter(name, arguments_, actionSignal),
            now,
            // typed 描述来源的签发方：真实任务投影 + journal 时间线复验（T08）。
            evidence: { db, orm: o.orm },
            // questionMessageId 锚解析（宿主唯一真源）+ media.read 受控读取
            // （prepareByMediaId 同一实现：真实 fetch/cache/asset+variant，宿主只登记）。
            resolveQuestion,
            readImage: readMediaImage,
            onDescribed: (eventKey, actualTaskId) => {
              // typed 新任务通知：只做诊断登记（actualTaskId 进 details），仍沿既有回调；
              // 旧 ingestMedia 只对 legacy note 生效（note IS NOT NULL 的行），typed 结果
              // 不回写 legacy note，因此不在这里伪造 media_revision 事件。
              const notes = db
                .query("SELECT id FROM qq_media_notes WHERE event_key=? AND note IS NOT NULL")
                .all(eventKey) as { id: string }[];
              for (const note of notes) o.journal.ingestMedia(note.id, binding.id);
              diagnose({
                stage: "media",
                status: "typed_task",
                code: "QQ_MEDIA_READ_TASK_SETTLED",
                details: { eventKey, actualTaskId },
              });
              source.invalidate();
            },
          })
        : [];
    // 本群停用系统能力后，模型可见工具目录里不再出现对应动作——不是只在界面隐藏
    // （ADR0019 §13.3 D）。历史原文（history）不属能力停用面，照旧保留。
    const actions = [
      ...source.actions,
      ...mediaActions,
      ...(o.tasks?.conversationActions(conversation.id) ?? o.externalActions?.() ?? []),
      ...(stickersEnabled
        ? [
            createQqStickerSearch({
              orm: o.orm,
              request: stickerRequest,
              assertCurrent: () => source.assertCurrent(),
              fit: (arguments_, actionSignal) =>
                source.actionResultFitter("sticker.search", arguments_, actionSignal),
              onDisclosed: (context, refs) => {
                const key = disclosureKey(context.runId, context.owner);
                const ids = stickerDisclosures.get(key) ?? new Map<string, string>();
                stickerDisclosures.set(key, ids);
                for (const ref of refs)
                  if (ref.kind === "qq_sticker") ids.set(ref.id, ref.revision);
              },
            }),
          ]
        : []),
    ].filter((action) => guard.actionAllowed(action, groupOwner));
    /**
     * ── 许可（0.4.0 P4 §4.1 后半）──
     *
     * 不再要求模型自行 `invoke speech.evaluate`：主 Agent 只产出**意图**（收件人 ＋ 要说什么），
     * 程序在写正文之前触发一次评分。许可绑定的是**相关状态摘要**——评分材料本身（时间线、人设、
     * 场景、目标、方案修订）哈希之后的值：
     *   * 同一相关状态只评一次（同一轮里重复的草稿复用同一份许可，不重复花模型调用）；
     *   * 不相关的新消息不改材料 → 摘要不变 → 许可继续有效；
     *   * 相关状态变了 → 摘要变 → 旧许可自动失效（复评，或发布前被判失效）。
     * 许可只活在**本轮**（内存 Map）：跨 run 不复用，重启自然不复活。
     */
    const licenses = new Map<string, { allowed: boolean; stateDigest: string }>();
    /**
     * Step5a 的"已验证 asset 重登记"实现：评分叶子的 image part 只带来源事实，字节在本
     * 评分叶子的 run/owner 下从**已验证 asset**重新登记——variant 行按 id 取出后必须与投影
     * 声明的 assetId/variantPolicy 一致，且投影 sources（asset/任务 ref，含 scope+revision）
     * 过 guard+context-source 双复验；任何一项不成立即整相拒绝（fail closed），父 run 的
     * 裸句柄从不进入本函数（跨 leaf 借用是负测断言的行为）。
     */
    const registerScoreImages = (
      context: ActionContext,
    ): Omit<
      Parameters<ReturnType<typeof createImageByteResolver>["register"]>[0],
      "runId" | "owner"
    >[] => {
      void context;
      const projection = source.mediaProjection("evaluation");
      if (!projection || projection.images.length === 0) return [];
      source.assertSources(projection.sources);
      guard.assertSources(groupOwner, projection.sources);
      return projection.images.map((image) => {
        const row = db
          .query("SELECT id, asset_id, policy, bytes, mime_type FROM qq_media_variants WHERE id=?")
          .get(image.variantId) as
          | { id: string; asset_id: string; policy: string; bytes: Uint8Array; mime_type: string }
          | undefined;
        if (!row || row.asset_id !== image.assetId || row.policy !== image.variantPolicy)
          throw new Error("SCORE_IMAGE_VARIANT_MISMATCH");
        return {
          part: image.content,
          bytes: new Uint8Array(row.bytes),
          sources: image.sources,
          assertCurrent: () => source.assertCurrent(),
        };
      });
    };
    const evaluateIntent = async (
      target: BotContextTarget | null,
      intent: string,
      signal: AbortSignal,
    ): Promise<{ allowed: boolean; stateDigest: string }> => {
      let evaluation = await source.prepareEvaluation({ signal, target, intent });
      const { stateDigest } = evaluation;
      const cached = licenses.get(stateDigest);
      if (cached) return cached;
      // 群里来源撤权后，评分素材不得再交给模型：已有来源复验之上再加本群作用域那一层。
      guard.assertSources(groupOwner, evaluation.sources);
      // 相媒体观测：真实 evaluation 投影同源（preparePhaseMedia("evaluation") 的结果）。
      emitMediaMode("evaluation", { why: null });
      // T11 Step5/Step5a：评分改走原生消息叶子（completeMessageLeaf）。评分材料现在可能
      // 携带图片 part——字节只在发送边界解析：评分叶子有**自己的 runId/owner**，图片必须
      // 在本叶子 run 内从已验证 asset 重新登记（resolveScoreImage，B 组接线），父 run 的
      // 裸句柄不跨 run 使用。叶子结束（成功或失败）时 agent-runtime 的 finally 按
      // run/owner release 本叶子登记，宿主不另造清理。无图评分的调用形状与之前逐字等价。
      // 规格 §10：评分相存在待分类 unknown 图才换 envelope；scoreResult 本体仍由
      // qqJudgeOutcome 验证（validate 内先剥离 envelope）。
      let scoreUsesEnvelope = hasUnknownImages("evaluation");
      let scoreEnvelopeResult: { score: number; reason?: string | null } | null = null;
      // 评分叶子调用（T11 Step5/Step5a）：字节只在发送边界解析，评分叶子有自己的 runId/owner，
      // 图片在本叶子 run 内从已验证 asset 重新登记；叶子结束（成功或失败）时 agent-runtime 的
      // finally 按 run/owner release。无图评分的调用形状与之前逐字等价。§9 fallback 重试时
      // 重取评分材料后经同一入口再调（resolver/spec 按新材料重建）。
      const callScoreLeaf = (evaln: typeof evaluation, why: string | null = null) => {
        const scoreResolver = createImageByteResolver();
        // 规格 §10 同源声明：本次评分实际发送的 responseSchema 与系统"输出要求"声明共用
        // 同一个 scoreUsesEnvelope 选择——envelope 时把判断档 plain 输出要求经
        // qqReplaceOutputRule 整段替换为 envelope 版本，不追加互相矛盾的第二条规则。
        const scoreMessages = scoreUsesEnvelope
          ? qqReplaceOutputRule(evaln.messages, "judgement", QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE)
          : evaln.messages;
        return o.agentRuntime.completeMessageLeaf(
          {
            id: "onebot.initiative.evaluate",
            model: evaln.model,
            // 评分调用也要有输出预算：主决策走方案的输出预留，这里此前没给 max_tokens，
            // 思考型模型（DeepSeek V4.1 Flash 默认思考）会吃厂商默认上限后空正文收场
            // （2026-09-29 MODEL_OUTPUT_LIMIT）。用同一份判断预留。
            maxTokens: reserves.judgement_output_reserved,
            limits: { inputUnits: evaln.inputUnits },
            responseSchema: scoreUsesEnvelope
              ? QQ_SCORE_ENVELOPE_SCHEMA
              : QQ_JUDGEMENT_RESPONSE_SCHEMA,
          },
          {
            messages: scoreMessages,
            imageResolver: scoreResolver,
            // 模型调用前在本评分叶子的 run/owner 下重登记已验证资产（Step5a）。
            bindRun: (context) => {
              if (context.runId === undefined) throw new Error("SCORE_RUN_ID_REQUIRED");
              for (const part of registerScoreImages(context)) {
                scoreResolver.register({ ...part, runId: context.runId, owner: context.owner });
              }
            },
            // 每次实际发送前复验当前授权真源（fix1）；重试同 used，不重新 prepare。
            assertPreparedCurrent: ({ model }) => {
              source.assertCurrent();
              emitMediaMode("evaluation", {
                why,
                ...(why ? { code: "MODEL_IMAGE_UNSUPPORTED" } : {}),
                requestedModel: evaln.model,
                resolvedModel: model,
              });
            },
            signal,
            // 许可评分也算进这一轮的账。
            usage,
            budget,
            owner: {
              kind: "qq_binding",
              id: binding.id,
              userId: DEFAULT_USER_ID,
              agentId: agent.id,
            },
            sources: evaln.sources,
            validate: (text, meta) => {
              if (scoreUsesEnvelope) {
                // resolved 不可得（理论上不可达：onModelResolved 先于 validate）＝明确拒绝，
                // 不用 requested 顶替模型维度、不写分类。
                if (meta?.resolvedModel === undefined || meta.resolvedModel === "")
                  throw new Error("JUDGEMENT_RESOLVED_MODEL_MISSING");
                const envelope = parseModelScoreEnvelope(
                  JSON.parse(text) as unknown,
                  phaseSentIds("evaluation"),
                );
                consumeClassifications("evaluation", envelope.media, meta.resolvedModel, signal);
                scoreEnvelopeResult = envelope.scoreResult;
                const verdict = qqJudgeOutcome(JSON.stringify(envelope.scoreResult));
                if (verdict.kind === "unreadable") throw new Error("JUDGEMENT_UNREADABLE");
                return verdict;
              }
              const verdict = qqJudgeOutcome(text);
              if (verdict.kind === "unreadable") throw new Error("JUDGEMENT_UNREADABLE");
              return verdict;
            },
          },
        );
      };
      // §9 fallback（评分相，本宿主可直接捕）：仅精确 MODEL_IMAGE_UNSUPPORTED 且本相真发了
      // 原生图时，转 describeAfterUnsupported 备用（requestedMode 仍 native），重建评分材料后
      // 重试恰一次；鉴权/超长/限流/网络/5xx/超时绝不降级（整轮既有重试如实报错）。
      // 当前相 media 关闭（stage/capability off 无图）＝没有可降的 native 发送，不 fallback。
      let raw: string;
      try {
        raw = await callScoreLeaf(evaluation);
        recordNativeConsumed("evaluation");
      } catch (error) {
        if (
          !isModelImageUnsupportedError(error) ||
          (source.mediaProjection("evaluation")?.images.length ?? 0) === 0
        )
          throw error;
        source.requestMediaFallback("evaluation", "model_image_unsupported");
        evaluation = await source.prepareEvaluation({ signal, target, intent });
        // 重建后的评分材料重新过本群来源复验；材料已变＝新 stateDigest（旧许可天然失效）。
        guard.assertSources(groupOwner, evaluation.sources);
        scoreUsesEnvelope = hasUnknownImages("evaluation");
        // 相模式观测：以重备后的真实投影为准（description 或无视觉模型时的 unavailable）。
        emitMediaMode(
          "evaluation",
          { why: "model_image_unsupported", code: "MODEL_IMAGE_UNSUPPORTED" },
          source.mediaProjection("evaluation"),
        );
        raw = await callScoreLeaf(evaluation, "model_image_unsupported");
      }
      // envelope 评分的许可判定用已剥离的 scoreResult（raw 是 envelope 原文，不直接判）。
      const verdict =
        scoreUsesEnvelope && scoreEnvelopeResult !== null
          ? qqJudgeOutcome(JSON.stringify(scoreEnvelopeResult))
          : qqJudgeOutcome(raw);
      const allowed = qqJudgeAllowsSpeech(verdict, schemeRhythm(scheme).initiative_min_score);
      const record = { allowed, stateDigest };
      licenses.set(stateDigest, record);
      return record;
    };
    spec.availableActions = actions.map((a) => a.description);
    const audience = () => ({
      topology: conversation.topology,
      participantIds: initiative ? [null] : targets.map((t) => t.speakerId),
      attentionMembers: attentionTriggerFilter(binding) ?? undefined,
    });
    const relevant = (event: ConversationEvent) => observationRelevant(event, audience());
    const generationAttempts = new Map<string, number>();
    const generationLimit = 1 + schemeRhythm(scheme).max_recompute_count;
    let pendingOutputs: readonly PreparedOutput[] = [];
    const rememberPlan = (
      reason: string,
      drafts: readonly OutputDraft[] = [],
      outputs?: readonly PreparedOutput[],
    ) => {
      if (outputs) pendingOutputs = outputs.map((output) => ({ ...output }));
      diagnose({ stage: "reconsider", status: "pending", code: reason });
      source.setPendingPlan(
        {
          reason,
          observedSeq: source.observedSeq,
          outputs: pendingOutputs,
          proposedOutputs: drafts,
          generationBudget: targets.map((target) => ({
            targetId: target.id,
            remaining: Math.max(0, generationLimit - (generationAttempts.get(target.id) ?? 0)),
          })),
        },
        uniqueSources([
          ...source.sources,
          ...pendingOutputs.flatMap((output) => output.sources ?? []),
        ]),
      );
    };
    const refresh = async (
      drafts: readonly OutputDraft[] = [],
      outputs?: readonly PreparedOutput[],
    ) => {
      source.assertCurrent();
      const updates = o.journal.eventsAfter(
        conversation.id,
        source.observedSeq,
        Number.MAX_SAFE_INTEGER,
      ).items;
      if (!updates.some(relevant)) return false;
      rememberPlan("new_observation", drafts, outputs);
      prepared = preparation();
      setTargets();
      source.invalidate();
      return true;
    };
    const staged = new Map<string, QqPreparedReply>();
    const reserved = new Set<string>();
    let result: Awaited<ReturnType<ConversationHost["activate"]>> | undefined;
    try {
      result = await this.host.activate({
        conversation,
        requestId: wake.id,
        spec,
        owner,
        context: source,
        authorizedTargets,
        actions,
        usage,
        budget,
        outputMode: "buffered",
        // 许可不通过（低于门槛）＝静默结束，不是整轮失败：见计划 §4.1 与 P0 基线里的那条待改进。
        // 许可被拒＝这一轮不开口（静默结束）；"模型犯错"类的 blocked 码不在此列，照旧失败。
        // 许可的时效由既有机制保证：相关变化会让这一轮重新观察（`refresh`），`assertCurrent` 再兜一层。
        silentBlockCodes: ["INITIATIVE_NOT_ELIGIBLE", "MEDIA_READ_FAILED"],
        signal,
        onEvent(event) {
          if (event.type === "started") {
            runId = event.runId;
            o.journal.linkRun(runId, conversation.id, source.observedSeq, wake.id);
          }
        },
        // T10 准备钩子透传（决策/生成相）：actualModel 冻结后由网关调用一次；
        // 钩子闭包见 preparePhaseForModel（§9 严格 fallback + 相模式观测）。
        prepareWithResolved: (hook) => preparePhaseForModel(hook),
        // 每次实际发送前（含 schema/tools 重试与 stream）复验当前授权真源。
        assertPreparedCurrent: () => source.assertCurrent(),
        // §8.1 current_run_consumed 记账：runtime 在相模型调用成功返回后通知；
        // 宿主按当相真实发送的 mediaId+sourceRefs 记录 native proof。
        onModelCallConsumed: (consumed) => {
          const phase: "decision" | "generation" =
            consumed.phase === "next" ? "decision" : "generation";
          recordNativeConsumed(phase);
        },
        // §9 真实 HTTP unsupported 重试边界：runtime 在相调用被精确拒绝后调用恰一次；
        // 宿主标该相 fallback、重备 description 材料并返回剥离原生图＋notes 的最终消息
        // （null＝无可降路径，原样抛）。非 unsupported 永不进入这里。
        onPhaseMediaUnsupported: async (input) => {
          const qqPhase: "decision" | "generation" =
            input.phase === "next" ? "decision" : "generation";
          const nativeImages = source.mediaProjection(qqPhase)?.images.length ?? 0;
          if (nativeImages === 0) return null;
          source.requestMediaFallback(qqPhase, "model_image_unsupported");
          const fallbackProjection = await source.repreparePhaseMedia(
            qqPhase,
            input.signal ?? signal,
          );
          emitMediaMode(
            qqPhase,
            {
              why: "model_image_unsupported",
              code: "MODEL_IMAGE_UNSUPPORTED",
              resolvedModel: input.model,
            },
            fallbackProjection,
          );
          const notes = fallbackProjection?.notes ?? [];
          const stripped = input.messages
            .map((message) => ({
              ...message,
              content: message.content.filter((part) => part.kind !== "image"),
            }))
            .filter((message) => message.content.length > 0);
          const messages: ModelMessage[] =
            notes.length > 0
              ? [
                  ...stripped,
                  textMessage(
                    "user",
                    contextDumps({ kind: "qq_media_notes", trust: "data_only", notes }),
                  ),
                ]
              : stripped;
          return { messages };
        },
        ...(runResolver
          ? {
              imageResolver: runResolver,
              // 决策相（bindRun 在首次 read 前调用恰一次）与生成相（prepareGeneration 后、
              // 模型调用前）的字节登记边界：都按当前投影 sources 复验后注册本 run/owner。
              bindRun: () => registerProjection("decision"),
              // 规格 §10：每次决策调用前现取当前 decision 投影——存在待分类 unknown 图
              // 才走 envelope schema；parse 先白名单收窄分类（未发送/重复/伪造 mediaId
              // 直接拒绝）、同次分类消费落库，本体 decision 交还原解析链。
              decisionEnvelope: () => {
                // 相媒体观测：真实 decision 投影同源（read() 内 preparePhaseMedia 的结果）。
                emitMediaMode("decision", { why: null });
                if (!hasUnknownImages("decision")) return undefined;
                return {
                  responseSchema: QQ_DECISION_ENVELOPE_SCHEMA,
                  parse: (raw: string, meta?: { resolvedModel: string }) => {
                    // 分类消费的模型维度=真实 resolved（onModelResolved 同真源）；
                    // resolved 不可得时明确不写（unknown 不允许顶替模型维度）。
                    const resolvedModel = meta?.resolvedModel ?? "";
                    if (resolvedModel === "") return envelopeOnly(raw);
                    const envelope = parseModelEnvelope(
                      JSON.parse(raw) as unknown,
                      phaseSentIds("decision"),
                    );
                    consumeClassifications("decision", envelope.media, resolvedModel, signal);
                    return envelope.decision;
                  },
                };
              },
            }
          : {}),
        prepareGeneration: async (draft, input) => {
          const generation = await source.prepareGeneration(draft, input);
          generationAttempts.set(draft.targetId, (generationAttempts.get(draft.targetId) ?? 0) + 1);
          registerProjection("generation");
          // 相媒体观测：真实 generation 投影同源（preparePhaseMedia("generation") 的结果）。
          emitMediaMode("generation", { why: null });
          // 规格 §10：生成相存在待分类 unknown 图时，buffered 下一次 structured complete 取
          // {text, media} envelope——剥离后正文照常提交，分类经 consume 同 call 落库。
          // 同一选择点把 generation.instructions 里的 plain reply 输出要求整段替换为 envelope
          // 版本（与实际 schema 同源；找不到/重复＝fail-closed，不无声留下冲突声明）。
          if (hasUnknownImages("generation")) {
            return {
              ...generation,
              instructions: qqReplaceOutputRuleInText(
                generation.instructions ?? "",
                "reply",
                QQ_REPLY_ENVELOPE_OUTPUT_RULE,
              ),
              responseEnvelope: {
                responseSchema: QQ_TEXT_ENVELOPE_SCHEMA,
                parse: (raw: string, meta?: { resolvedModel: string }) => {
                  const envelope = parseModelTextEnvelope(
                    JSON.parse(raw) as unknown,
                    phaseSentIds("generation"),
                  );
                  // resolved 不可得＝不消费分类（unknown 不顶替模型维度），正文照常剥离。
                  const resolvedModel = meta?.resolvedModel ?? "";
                  if (resolvedModel !== "")
                    consumeClassifications("generation", envelope.media, resolvedModel, signal);
                  return { text: envelope.text };
                },
              },
            };
          }
          return generation;
        },
        prepareOutput: async (draft) => {
          if (initiative) {
            const current = preparation();
            if (current.kind === "blocked")
              return {
                blocked: true,
                code:
                  current.reason === "media_read_failed"
                    ? "MEDIA_READ_FAILED"
                    : "INITIATIVE_NOT_ELIGIBLE",
              };
          }
          if (reserved.has(draft.targetId))
            return {
              blocked: true,
              code: split ? "ONE_OUTPUT_PER_SPEAKER" : "ONE_OUTPUT_PER_CONVERSATION",
            };
          if (draft.stickerIds && draft.stickerIds.length > 1)
            return { blocked: true, code: "STICKER_COUNT_EXCEEDED" };
          const stickerId = draft.stickerIds?.[0];
          if (draft.stickerIds == null) {
            // 有候选＝必须显式决定（[] 或 [id]）；关闭/无候选＝归一为不选，普通会话不必多答一题。
            if (stickerCatalog().state === "available")
              return { blocked: true, code: "STICKER_SELECTION_REQUIRED" };
            draft.stickerIds = [];
          } else if (stickerId && !disclosedSticker(stickerId))
            return { blocked: true, code: "STICKER_SELECTION_UNAVAILABLE" };
          const outputId = crypto.randomUUID();
          if (initiative) {
            // §4.1 的顺序：先意图 → 程序触发许可 → 通过才写正文。`generate` 的 instructions 就是
            // 这一轮"要说什么"（意图）；`inline` 把正文写进了决策，许可仍在这里过，绝不先发后判。
            source.assertCurrent();
            const target = targets.find((entry) => entry.id === draft.targetId) ?? null;
            const license = await evaluateIntent(
              path === "idle_topic" || !split ? null : target,
              draft.kind === "generate" ? draft.instructions : draft.text,
              signal,
            );
            if (!license.allowed) return { blocked: true, code: "INITIATIVE_NOT_ELIGIBLE" };
          }
          reserved.add(draft.targetId);
          return { outputId };
        },
        beforeFinal: async (drafts) => {
          reserved.clear();
          if (await refresh(drafts)) return true;
          if (
            drafts.some(
              (draft) =>
                draft.kind === "generate" &&
                (generationAttempts.get(draft.targetId) ?? 0) >= generationLimit,
            )
          ) {
            rememberPlan("generation_budget_exhausted", drafts);
            return true;
          }
          return false;
        },
        reconsider: async (outputs) => {
          if (await refresh([], outputs)) return true;
          let invalidOutput = false;
          for (const output of outputs) {
            if (output.status !== "prepared") {
              if (
                output.code === "STICKER_COUNT_EXCEEDED" ||
                output.code === "STICKER_SELECTION_REQUIRED" ||
                output.code === "STICKER_SELECTION_UNAVAILABLE"
              )
                invalidOutput = true;
              continue;
            }
            const raw = output.text ?? "",
              text = split ? raw.replace(/\s*\r?\n+\s*/g, " ").trim() : raw;
            const selection = source.selection;
            if (!selection) throw new Error("BOT_CONTEXT_MISSING");
            // 显式选图在发前再对一次当前事实：本 run 披露过、素材仍在目录里且修订未变。
            const explicitId = output.stickerIds?.[0] ?? null;
            const selectedAsset = explicitId ? disclosedSticker(explicitId) : undefined;
            if (explicitId && !selectedAsset) {
              output.status = "blocked";
              output.code = "STICKER_SELECTION_UNAVAILABLE";
              invalidOutput = true;
              diagnose({
                stage: "sticker",
                status: "feedback",
                code: output.code,
                targetId: output.targetId,
              });
              continue;
            }
            diagnose({
              stage: "sticker",
              status: selectedAsset ? "selected" : "none",
              targetId: output.targetId,
              code: selectedAsset ? undefined : stickersEnabled ? "explicit_none" : "module_paused",
              details: selectedAsset ? { stickerId: selectedAsset.id } : undefined,
            });
            output.stickerIds = selectedAsset ? [selectedAsset.id] : [];
            output.sources = selectedAsset
              ? [{ kind: "qq_sticker", id: selectedAsset.id, revision: selectedAsset.updatedAt }]
              : [];
            const target = targets.find((t) => t.id === output.targetId)!;
            const pending: QqPreparedReply = {
              text: text || null,
              snapshot,
              schemeRevision: scheme.revision,
              agentConfigVersion: agent.configVersion,
              path,
              nowSeconds: seconds(),

              selection,
              stickerId: selectedAsset?.id ?? null,
              targetSpeakerId: target.speakerId,
            };
            staged.set(output.outputId, pending);
            if (planQqPreparedReply(o.orm, pending, o.stickers).kind !== "planned") {
              output.status = "blocked";
              output.code = "EMPTY_OUTPUT";
              invalidOutput = true;
              diagnose({
                stage: "output",
                status: "feedback",
                code: output.code,
                targetId: output.targetId,
              });
            }
          }
          if (await refresh([], outputs)) return true;
          if (invalidOutput) {
            rememberPlan("output_feedback", [], outputs);
            return true;
          }
          return false;
        },
        commitOutputs: async (outputs: readonly PreparedOutput[], currentRunId, terminal) =>
          db
            .transaction(() => {
              source.assertCurrent();
              if (initiative) {
                const current = preparation();
                if (current.kind === "blocked")
                  throw Object.assign(new Error(current.reason), {
                    code:
                      current.reason === "media_read_failed"
                        ? "MEDIA_READ_FAILED"
                        : "INITIATIVE_NOT_ELIGIBLE",
                  });
              }
              if (
                o.journal
                  .eventsAfter(conversation.id, source.observedSeq, Number.MAX_SAFE_INTEGER)
                  .items.some(relevant)
              )
                throw new Error("CONVERSATION_CHANGED_AT_COMMIT");
              for (const [ordinal, output] of outputs.entries()) {
                if (output.status !== "prepared") continue;
                // 本群停用「表情」后，仍带素材的提交不再放行（停用即时生效，不等下一轮）。
                if ((output.stickerIds?.length ?? 0) > 0) guard.assert(groupOwner, "stickers");
                const pending = staged.get(output.outputId);
                if (!pending) throw new Error("OUTPUT_PREPARATION_MISSING");
                const plan = planQqPreparedReply(o.orm, pending, o.stickers);
                if (plan.kind !== "planned") throw new Error("OUTPUT_CHANGED_AT_COMMIT");
                // 每次提交都现读保留窗口：改设置只影响之后写出的到期戳，已在队列里的行保持原样。
                const expiresAt = speechExpiresAt(
                  Math.floor(Date.parse(terminal.at) / 1000),
                  readQqRetentionDays(o.orm),
                );
                const participantId =
                  binding.kind === "group" && split
                    ? (pending.targetSpeakerId ?? undefined)
                    : undefined;
                const intent = o.outbox.commit({
                  // 幂等键：同一个机会被重跑（崩溃重排、结果未知后重来）时会命中同一行，
                  // 于是"计划中"的被替换、"已尝试过"的原样返回——都不会发出第二条。
                  id: idempotentIntentId([
                    conversation.id,
                    source.observedSeq,
                    path,
                    participantId ?? "room",
                  ]),
                  runId: currentRunId,
                  conversationId: conversation.id,
                  ordinal,
                  target: {
                    accountId: binding.accountId,
                    conversationKind: binding.kind,
                    peerId: binding.peerId,
                    participantId,
                    agentId: agent.id,
                    bindingId: binding.id,
                    bindingEpoch: conversation.bindingEpoch,
                    bindingRevision: binding.revision,
                    authorityRevision: binding.authorityRevision,
                    ownerIdentityRevision: readQqOwnerIdentity(o.orm)?.revision ?? null,
                    schemeId: scheme.id,
                    schemeRevision: scheme.revision,
                    agentConfigVersion: agent.configVersion,
                    sources: uniqueSources([...source.sources, ...(output.sources ?? [])]),
                    attentionMembers: attentionTriggerFilter(binding) ?? undefined,
                  },
                  speechKind: path,
                  sourceThroughSeq: source.observedSeq,
                  deliverBy: new Date(
                    Date.parse(terminal.at) + policy.deliveryTtlSeconds * 1000,
                  ).toISOString(),
                  createdAt: terminal.at,
                  expiresAt,
                  parts: [...plan.parts],
                });
                o.journal.append({
                  conversationId: conversation.id,
                  eventKey: `output:${intent.id}`,
                  kind: "delivery",
                  source: {
                    kind: "outbound_intent",
                    id: intent.id,
                    revision: "planned",
                    expiresAt,
                  },
                  occurredAt: terminal.at,
                  runId: currentRunId,
                  outputId: intent.id,
                });
                // 出站身份快照（§3.2/§13.4）：commit 时存当前平台身份——真实发送账号（binding
                // 的登录账号，绝不用 Agent UUID 充当 QQ 号）＋优先昵称。私聊没有群名片语义：
                // 不把登录名伪称群名片，group_card 恒空（T03 Step6）。
                const assistantNames = readQqMemberNames(
                  o.orm,
                  {
                    accountId: binding.accountId,
                    conversationKind: binding.kind,
                    peerId: binding.peerId,
                  },
                  binding.accountId,
                );
                const preferredName =
                  binding.kind === "group" ? (assistantNames?.groupCard ?? null) : null;
                const preferredNickname = assistantNames?.personalNickname ?? null;
                recordQqOutboundMessageFact(o.orm, {
                  intentId: intent.id,
                  accountId: binding.accountId,
                  agentId: agent.id,
                  identity: {
                    qq: binding.accountId,
                    groupCard: preferredName,
                    personalNickname: preferredNickname,
                    legacyDisplayName: null,
                    nameState: preferredName || preferredNickname ? "known" : "unknown",
                  },
                  occurredAtSeconds: Math.floor(Date.parse(terminal.at) / 1000),
                });
              }
              if (path === "idle_topic")
                recordQqIdleJudgement(o.orm, {
                  conversationKey: qqConversationKey({
                    accountId: binding.accountId,
                    kind: binding.kind,
                    peerId: binding.peerId,
                  }),
                  basisSeconds:
                    prepared.kind === "prepared"
                      ? (newestMemberMessageSeconds(
                          o.orm,
                          {
                            kind: "qq",
                            accountId: binding.accountId,
                            conversationKind: binding.kind,
                            peerId: binding.peerId,
                            agentId: binding.agentId,
                          },
                          { attentionMembers: attentionTriggerFilter(binding) ?? undefined },
                        ) ?? seconds())
                      : Math.floor(Date.parse(focus?.occurredAt ?? now()) / 1000),
                  nowSeconds: Math.floor(Date.parse(terminal.at) / 1000),
                });
              o.journal.acknowledge(conversation.id, source.observedSeq);
              const deliveredTargets = new Set(
                outputs
                  .filter((output) => output.status === "prepared")
                  .map((output) => output.targetId),
              );
              const failedTargets = new Map(
                outputs
                  .filter(
                    (output) =>
                      output.status !== "prepared" && !deliveredTargets.has(output.targetId),
                  )
                  .map((output) => [output.targetId, output.code ?? "AGENT_OUTPUT_FAILED"]),
              );
              const covered = opportunities
                .filter((opportunity) => {
                  const targetId = split
                    ? (opportunity.participantId ?? "anonymous")
                    : binding.peerId;
                  return (
                    !failedTargets.has(targetId) &&
                    prepared.kind === "prepared" &&
                    prepared.targets.some(
                      (target) => target.speakerId === opportunity.participantId,
                    )
                  );
                })
                .map((opportunity) => ({
                  id: opportunity.wake.id,
                  throughSeq: opportunity.wake.throughSeq,
                }));
              const ownTarget =
                binding.kind === "private" || !split
                  ? binding.peerId
                  : (focus?.participant?.id ?? "anonymous");
              o.wakes.complete(
                wake.id,
                wake.leaseToken!,
                terminal.status,
                source.observedSeq,
                now(),
                covered,
                failedTargets.get(ownTarget),
              );
              o.journal.linkRun(currentRunId, conversation.id, source.observedSeq, wake.id);
              return new AgentRunRepository(db).finishRun(
                currentRunId,
                terminal.status,
                terminal.event,
                terminal.at,
              );
            })
            .immediate(),
      });
    } finally {
      // 主 run 的字节登记随 run 结束释放（成功/失败/取消都释放本 run+owner；评分叶子由
      // agent-runtime 的 finally 各自释放，两层互不覆盖）。
      if (runResolver && runId !== undefined) runResolver.release(runId, owner);
    }
    const compression = source.takeCompressionJob();
    if (compression) o.enqueueCompression?.(compression);
    if (result === undefined) throw new Error("BOT_RUN_INCOMPLETE");
    return result;
  }
}
