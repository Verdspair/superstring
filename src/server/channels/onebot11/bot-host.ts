import type { Database } from "bun:sqlite";
import { SPEECH_REPLY_DESCRIPTION } from "../../../shared/contracts/agent-action-descriptions";
import type { OutputDraft } from "../../../shared/contracts/agent-output";
import {
  AGENT_DECISION_JSON_SCHEMA,
  SpeechReplyArgumentsSchema,
} from "../../../shared/contracts/agent-output";
import type { ModelMessage, RunOwner } from "../../../shared/contracts/agent-run";
import type { ConversationEvent, WakeSignal } from "../../../shared/contracts/conversation";
import type { SourceRef } from "../../../shared/contracts/evidence";
import { qqEffectiveReplyPrompt } from "../../../shared/contracts/qq";
import type { QqEffectiveMediaPolicy } from "../../../shared/contracts/qq-media-input";
import type { AgentRuntime, PreparedOutput, TargetHooks } from "../../agent/agent-runtime";
import type { AgentSpec } from "../../agent/agent-specs";
import type { BuiltInAction } from "../../agent/built-in-actions";
import { inputUnits, textMessage, uniqueSources } from "../../agent/context-engine";
import { ConversationHost } from "../../agent/conversation-host";
import { createImageByteResolver } from "../../agent/image-byte-resolver";
import type { ModelResolvedPrepareOutput } from "../../agent/model-port";
import { parseModelEnvelope, parseModelTextEnvelope } from "../../agent/model-response-envelope";
import type { AgentTaskService } from "../../agent/task-service";
import { observationRelevant } from "../../conversation/observation-relevance";
import { AgentRunRepository } from "../../db/agent-run-repository";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { bodyRevision } from "../../db/conversation-event-repository";
import { contextDumps } from "../../db/json-text";
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
import { attemptedUnreadMediaNoteIds } from "../../db/qq-media-repository";
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
import { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";
import {
  captureQqTask,
  checkQqTask,
  qqConversationKey,
  qqConversationScopeOfBinding,
} from "../../services/qq-binding-contract";
import type { QqContextTier } from "../../services/qq-context-contract";
import { qqPhaseTier } from "../../services/qq-context-contract";
import {
  attentionTriggerFilter,
  QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS,
} from "../../services/qq-dispatch";
import { prepareQqJudgement } from "../../services/qq-judgement-preparation";
import { qqMediaPolicyRevision } from "../../services/qq-media-contract";
import type { QqMediaReadAdapter } from "../../services/qq-media-reader";
import type {
  QqMediaQuestionAnchorResolver,
  QqMediaReadImageService,
} from "../../services/qq-media-tools";
import { createQqMediaTools } from "../../services/qq-media-tools";
import type { QqPreparedReply } from "../../services/qq-prepared-reply";
import {
  parseQqBatchJudgement,
  QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_EXPRESSION_MEDIA_RULE,
  QQ_JUDGEMENT_ENVELOPE_OUTPUT_RULE,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  QQ_MEDIA_RULE,
  QQ_REPLY_ENVELOPE_OUTPUT_RULE,
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
import {
  BotContextSource,
  type BotContextTarget,
  type MediaPhaseState as QqMediaPhaseState,
} from "./context-source";
import type {
  QqMediaInputService,
  QqMediaProjection,
  QqPreparedMediaImage,
} from "./media-input-service";
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

// 运行时与唤醒结算共用静默拒绝码，避免把未发言记为失败。
// 媒体读取失败仍由提交前复验抛错。
const QQ_SILENT_BLOCK_CODES = ["INITIATIVE_NOT_ELIGIBLE", "MEDIA_READ_FAILED"] as const;
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
/** 运行时 hook 相名 → QQ 相名（映射唯一实现；宿主内多处使用同一份）。非 next 一律 generation。 */
const qqPhaseOf = (phase: "next" | "generate" | "leaf"): "decision" | "generation" =>
  phase === "next" ? "decision" : "generation";

/** One host for direct and shared conversations; topology changes targets, not the model loop. */
export class OneBotHost {
  private readonly host: ConversationHost;
  private readonly guard: QqGroupCapabilityGuard;
  constructor(private readonly options: OneBotHostOptions) {
    this.host = options.host ?? new ConversationHost({ runtime: options.agentRuntime });
    this.guard = options.guard ?? new QqGroupCapabilityGuard(options.orm);
  }
  /**
   * 主动批次（chiming_in/idle_topic）的 parent 编排入口。`reply` 非空＝本调用是一个达标目标的
   * 回复子 run：自有 source/hooks，usage/budget/signal 经 AsyncLocal taskTree 沿父继承。
   */
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
      // 连续交谈（follow_up）是"必回且按人回"：即使方案关了按发言人拆分，也要按人各回一条
      // （规格 §3.3）。direct 与主动路径尊重方案开关；存储的 split 设置不改。
      split = path === "follow_up" ? true : schemeReply(scheme).split_by_speaker;
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
      path === "direct_reply" &&
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
    /**
     * 自主批次候选：从 cause 游标 chimingInObservedSeq 到本 wake throughSeq 之间，按发言人
     * 取合格成员入站事件（含注意力过滤与来源有效期），已确认回复的跳过。每个成员一条候选。
     */
    const chimingOpportunities = (): ReturnType<WakeRepository["readyParticipants"]> => {
      const boundary = o.journal.chimingInObservedSeq(conversation.id);
      const attention = attentionTriggerFilter(binding);
      const items = o.journal.eventsAfter(conversation.id, boundary, Number.MAX_SAFE_INTEGER).items;
      const bySpeaker = new Map<
        string,
        { wake: typeof wake; participantId: string; occurredAt: string }
      >();
      const replied = new Map<string, boolean>();
      for (const event of items) {
        if (event.seq > wake.throughSeq) break;
        if (event.kind !== "inbound") continue;
        const speaker = event.participant?.id;
        if (!speaker) continue;
        if (attention && !attention.includes(speaker)) continue;
        let covered = replied.get(speaker);
        if (covered === undefined) {
          covered = hasConfirmedReply(wake.throughSeq, speaker);
          replied.set(speaker, covered);
        }
        if (covered) continue;
        const existing = bySpeaker.get(speaker);
        if (!existing || event.occurredAt > existing.occurredAt)
          bySpeaker.set(speaker, { wake, participantId: speaker, occurredAt: event.occurredAt });
      }
      return [...bySpeaker.values()];
    };
    const preparation = (initial = false, src?: BotContextSource) => {
      // 自主批次候选来自冻结范围（见 chimingOpportunities）；其余路径没有逐人机会集合。
      opportunities = path === "chiming_in" ? chimingOpportunities() : [];
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
                  src?.assertCurrent();
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
    const mediaPolicyRevision = qqMediaPolicyRevision({
      prompt: schemePrompts(scheme).media,
      frames: schemeRhythm(scheme).media_frame_count,
      maxDimension: schemeRhythm(scheme).media_max_dimension,
    });
    // 同次分类消费（规格 §10）：sentMediaIds/sentSources 取自对应相投影的真实发送集；
    // consume 在宿主（可信侧）执行，白名单/重复/伪造 mediaId 一律 fail closed。
    const mediaScope = () =>
      qqConversationScopeOfBinding({
        conversationId: conversation.id,
        binding,
        bindingEpoch: conversation.bindingEpoch,
      });
    let prepared = preparation(true);
    if (prepared.kind !== "prepared") {
      settleOpportunity(prepared.readyAtSeconds);
      return { status: "no_output" as const, reason: prepared.reason };
    }
    const targets: BotContextTarget[] = [];
    const authorizedTargets: string[] = [];
    const setTargets = () => {
      const next =
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
        const byId = new Map(next.map((t) => [t.id, t]));
        for (const event of addressed) {
          const speaker = event.participant?.id ?? null;
          byId.set(speaker ?? "anonymous", { id: speaker ?? "anonymous", speakerId: speaker });
        }
        next.splice(0, next.length, ...byId.values());
      }
      // 原地更新（保持数组身份）：run 工厂用同一数组别名，重算目标后 run 内视图立即生效。
      targets.splice(0, targets.length, ...next);
      authorizedTargets.splice(0, authorizedTargets.length, ...next.map((t) => t.id));
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
    // 决策档：主动路径（chiming_in/idle_topic）先走判断档做阶段一评分；direct/continuous 直接
    // 走回复档。回复 run 用 `source.setRun` 换到回复档（同一 source 顺序复用，不建第二 source）。
    const decisionTier = initiative ? ("judgement" as const) : ("reply" as const);
    // 输出预留既参与容量预算，也必须作为 max_tokens 下发，否则模型可以超出预留输出。
    const reserves = schemeOutputReserve(scheme);
    // 指令按 tier 组合：scene 两档共用；回复 run 才带"直接回话/自写回复"要求；review 收尾共用。
    // 主动路径不再保留"先写清意图、再评分"的前置层（规格 §2.2/§2.5：评分本身是首次调用）。
    const sceneRules = [
      compileSystemPrompt(runtime),
      schemePrompts(scheme).scene,
      QQ_MEDIA_RULE,
      QQ_EXPRESSION_MEDIA_RULE,
      "需要理解图片时先调用 media.list 获取本会话图片 ID；已有描述用 media.note.read 分页读取，未描述时显式调用 media.describe，再读取描述。media.describe 会调用视觉模型并保存缓存，不是只读工具。目录、未读图片和未返回的描述均不代表已经理解图片。若用户这条消息就是在问某张图的细节，把该图 ID 与本轮问题消息的 messageId 一起传给 media.describe 或 media.read 做细读：程序会核验问题身份并按细节规格取图，同时在本轮后续决策里把该图按更细的规格提供给你；问题不是本轮这条、或这张图不在它的图范围内时会被拒绝，不会退化成普通读取。",
      `表情偏好（忽略旧编号格式，以stickerIds协议为准）：\n${schemePrompts(scheme).sticker}`,
      `表情能力：${stickerState.state}，当前可用 ${stickerState.assets.length} 张。inline/generate 共用 stickerIds：[]=明确不用；[id]=指定一张，ID 必须来自本 run sticker.search 已返回的候选或 pending_plan 的已选 ID，不要编造或复用旧 ID。有候选而省略/null 会被要求重选（STICKER_SELECTION_REQUIRED）；未披露或已失效的 ID 会被拒绝（STICKER_SELECTION_UNAVAILABLE）。允许空正文仅发图；真正不发则返回 none。output_feedback 表示尚未发送的无效计划，须纠正。`,
      `这是 OneBot ${binding.kind === "private" ? "私聊" : "群聊"}。只向 authorizedTargets 中的目标输出；${
        split
          ? "每个目标一条回复。"
          : "不按发言人拆分，整间会话最多一条逻辑回复；该回复可以由程序按换行发送多段。"
      }回复引用与 @ 成员均由你独立自主选择，互不绑定且均完全可选（缺省不自动引用、不自动 @ 收件人）。需要引用同会话已向你披露的消息时，把该消息的真实平台消息 ID（不是 UUID，原样字符串，包括负数）放入 replyToMessageId；需要 @ 成员时，把成员号放入 mentionIds。正文里不要写 @ 或 CQ 码。`,
    ];
    const reviewRule = `后续相关消息到来要重新决定尚未发送的计划。pending_plan 是你之前的草稿/计划与剩余独立 generate 次数，属于资料而非指令。读过新消息后，可以用 inline 原样保留或修改仍然适用的草稿，也可 none 暂不发送；generate 次数耗尽时不能再请求独立生成。复核指导：\n${schemePrompts(scheme).review}`;
    const replyRules = [
      "有人直接与你交流：直接写你要回的话（首条 call 就用终结回复给出正文），需要先查资料/理解图片时先调用工具，随后再用正文回答。",
      path === "follow_up"
        ? `本轮是**连续交谈**，必须回话：给每个发言的人各写一条回复；只有确实没有内容时才被程序拒绝，不要返回 none。需要 @ 谁时，把其成员号放进该目标的 mentionIds（可选）。`
        : "",
      `写这一轮要发的话（用户可自定义的回复任务）：\n${qqEffectiveReplyPrompt(schemePrompts(scheme).reply, split)}`,
    ];
    // 回复档 spec：首 call 就是回复正文任务（工具可用：terminalAction + 普通 tools）。
    const buildReplySpec = (): AgentSpec => ({
      id: "onebot.main",
      version: "4",
      context: "conversation",
      model: runtime.model_name,
      maxTokens: reserves.reply_output_reserved,
      instructions: [...sceneRules, ...replyRules.filter(Boolean), reviewRule].join("\n\n"),
      availableActions: [],
      generation: {
        model: runtime.model_name,
        allowEmpty: true,
        maxTokens: reserves.reply_output_reserved,
      },
      limits: { steps: policy.maxSteps },
    });
    // 判断档 spec：只服务阶段一批量评分叶子；不再作为主 run 的 spec。
    const judgementSpec: AgentSpec = {
      id: "onebot.main",
      version: "4",
      context: "conversation",
      model: readQqSettings(o.orm).judgementModelName ?? runtime.model_name,
      maxTokens: reserves.judgement_output_reserved,
      instructions: [
        ...sceneRules,
        `这是 ${path} 唤醒。程序先按当前观察序列判定许可；达标后才会让你写正文。没有合适回应时返回 none。`,
        reviewRule,
      ].join("\n\n"),
      availableActions: [],
      generation: {
        model: runtime.model_name,
        allowEmpty: true,
        maxTokens: reserves.reply_output_reserved,
      },
      limits: { steps: policy.maxSteps },
    };
    const spec: AgentSpec = initiative ? judgementSpec : buildReplySpec();
    // 结构化 mention 校验已迁入 buildRun（按 source 及 targets 校验，删除旧无界 journal 循环）。
    // 观察序列戳以**原 base** 拼（不叠加，重复 read 不累积）；每个 run/子 run 以自己 spec 的
    // base 计算。
    const epochText = (base: string, seq: number) =>
      `${base}\n当前观察序列：${String(seq).padStart(20, "0")}。许可由程序按当前相关状态判定：新的相关观察会让它自动失效，不相关的变化不影响它。`;
    spec.instructions = epochText(spec.instructions ?? "", 0);
    // 本 run 的 id 由 host.activate 的 onEvent 回填；主路径单 run 用它，主动批次下每个达标
    // 目标各有自己的子 run id（作为参数传入各 run 块）。源回调（onRead/diagnose/媒体读取）
    // 按主（父）run id 记账。
    const runRef: { current: string | undefined } = { current: undefined };
    // 会话级 owner（凭据作用域）：主路径与各子 run 的 registerEvidence/披露键共用同一会话身份。
    const owner: RunOwner = {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: agent.id,
    };
    /**
     * 单 run 工厂（C2 host factory）：把所有依赖会话 source 的 helper/hook 与 run 级可变状态
     * （spec、targets/authorizedTargets、视图缓存、观测、预留、媒体相位边界、runId、actions）
     * 绑到**本 run 自己的 source** 上。主路径调一次（session source）；主动批次每个达标目标用
     * `source.childReplySession(...)` 建的独立 source 各调一次——绝不共用同一 source 实例
     * （规格 §3.2 target snapshot）。只共享不可变材料/视图快照；机会准备/水位压缩仍在 activate
     * 里做一次，不随子 run 复跑。
     */
    const buildRun = (
      reuse:
        | {
            parent: BotContextSource;
            intents: { value: unknown; sources: readonly SourceRef[] };
          }
        | undefined,
      runSpec: AgentSpec,
      runTargets: BotContextTarget[],
      runAuthorized: string[],
      tier: QqContextTier,
      ref: { current: string | undefined },
    ) => {
      const spec = runSpec;
      const targets = runTargets;
      const authorizedTargets = runAuthorized;
      /**
       * 分类回读门控的真实执行记录：每次 consume 成功落库后记录 (policy→resolved)。
       * gate 只在"上一同键消费的 resolved==当前 requested"时放行回读——首次/路由不确定
       * 一律零回读（unknown 按普通规格），不以 requested 字符串相等冒充 resolved 确认。
       * **本 run 独立**（子 run 不共享父的消费记录）。
       */
      const lastResolvedByPolicy = new Map<string, string>();
      /**
       * 本 run **明确细问**且已成功读取的 mediaId 集合：下一相 preparePhaseMedia 以
       * detailMediaIds 送入投影，升普通规格并进 explicit 桶（§7.5）。**本 run 独立**。
       */
      const runDetailMediaIds = new Set<string>();
      // read 回调按本 run 的 spec/runId 记账（不落到外部/兄弟的 spec 或 run ref）。
      const runBase = runSpec.instructions ?? "";
      const onRead = (seq: number) => {
        spec.instructions = epochText(runBase, seq);
        if (ref.current) o.journal.linkRun(ref.current, conversation.id, seq, wake.id);
      };
      // 媒体相位边界：决策相与每个并行生成目标各一份（缺省＝共享边界）。所有相读取都带边界，
      // 兄弟目标不会读到/覆写彼此的投影（规格 §3.2）。
      const mediaProjection = (
        phase: "decision" | "evaluation" | "generation",
        boundary?: QqMediaPhaseState,
      ) => source.mediaProjection(phase, boundary);
      const phaseSentIds = (
        phase: "decision" | "evaluation" | "generation",
        boundary?: QqMediaPhaseState,
      ) => new Set((mediaProjection(phase, boundary)?.images ?? []).map((image) => image.mediaId));
      const phaseSentSources = (
        phase: "decision" | "evaluation" | "generation",
        boundary?: QqMediaPhaseState,
      ) =>
        new Map(
          (mediaProjection(phase, boundary)?.images ?? []).flatMap((image) =>
            image.sources
              .filter((ref) => ref.kind === "qq_media_source")
              .map((ref) => [ref.id, ref] as const),
          ),
        );
      const hasUnknownImages = (
        phase: "decision" | "evaluation" | "generation",
        boundary?: QqMediaPhaseState,
      ) =>
        (mediaProjection(phase, boundary)?.images ?? []).some(
          (image) => image.category === "unknown",
        );
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
        boundary?: QqMediaPhaseState,
      ) => {
        if (classifications.length === 0) return;
        consumeModelMediaData({
          store: { db, orm: o.orm },
          owner: groupOwner,
          scope: mediaScope(),
          sentMediaIds: phaseSentIds(phase, boundary),
          sentSources: phaseSentSources(phase, boundary),
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
      const recordNativeConsumed = (
        phase: "decision" | "evaluation" | "generation",
        boundary?: QqMediaPhaseState,
      ) => {
        const at = now();
        const projection = mediaProjection(phase, boundary);
        for (const mediaId of phaseSentIds(phase, boundary)) {
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
              .map((image) => ({
                variantId: image.variantId,
                variantPolicy: image.variantPolicy,
              })) ?? [];
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
      // 本 run 的图片字节登记：variant 复验（SQL 比对 asset/policy）→ run 绑定复验 →
      // resolver 登记，一条规则服务三相投影与细问读取；错误码前缀由调用点传入。
      const verifyAndRegisterImages = (
        images: readonly QqPreparedMediaImage[],
        errorPrefix: "MEDIA_IMAGE" | "SCORE_IMAGE",
        register: (
          entry: Parameters<ReturnType<typeof createImageByteResolver>["register"]>[0],
        ) => void,
        runId: string | undefined,
      ) => {
        for (const image of images) {
          const row = db
            .query("SELECT asset_id, policy, bytes FROM qq_media_variants WHERE id=?")
            .get(image.variantId) as
            | { asset_id: string; policy: string; bytes: Uint8Array }
            | undefined;
          if (!row || row.asset_id !== image.assetId || row.policy !== image.variantPolicy)
            throw new Error(`${errorPrefix}_VARIANT_MISMATCH`);
          if (runId === undefined) throw new Error(`${errorPrefix}_RUN_MISSING`);
          register({
            runId,
            owner,
            part: image.content,
            bytes: new Uint8Array(row.bytes),
            sources: image.sources,
            assertCurrent: () => source.assertCurrent(),
          });
        }
      };
      const registerProjection = (
        phase: "decision" | "generation",
        boundary?: QqMediaPhaseState,
        runIdOverride?: string,
      ) => {
        const projection = mediaProjection(phase, boundary);
        if (!runResolver || !projection || projection.images.length === 0) return;
        source.assertSources(projection.sources);
        guard.assertSources(groupOwner, projection.sources);
        verifyAndRegisterImages(
          projection.images,
          "MEDIA_IMAGE",
          (entry) => runResolver.register(entry),
          runIdOverride ?? runRef.current,
        );
      };
      // §9 fallback 的消息重写：剥掉原生 image part（剥空的消息丢弃），有 notes 时追加一条
      // data_only 的 user 资料消息。preparePhaseForModel 与 onPhaseMediaUnsupported 两处共用
      // 同一实现（预算复验仍只由 preparePhaseForModel 侧保留，不并入本函数）。
      const strippedMediaFallbackMessages = (
        messages: readonly ModelMessage[],
        notes: readonly { mediaId: string; text: string; taskId: string }[],
      ): ModelMessage[] => {
        const stripped = messages
          .map((message) => ({
            ...message,
            content: message.content.filter((part) => part.kind !== "image"),
          }))
          .filter((message) => message.content.length > 0);
        return notes.length > 0
          ? [
              ...stripped,
              textMessage(
                "user",
                contextDumps({ kind: "qq_media_notes", trust: "data_only", notes }),
              ),
            ]
          : stripped;
      };
      // 媒体的可变 run 钩子（detailMediaIds/classificationGate 等）按**本 run** 绑：子 run 不复用
      // 父的集合/门控；service/guard/repo 只读共享。
      const mediaInputOption =
        mediaService && mediaSettings
          ? {
              mediaInput: {
                service: mediaService,
                settings: mediaSettings ?? fail("CONTEXT_SOURCE_INVALID", "媒体策略缺失"),
                focus: mediaFocus,
                capabilityEnabled: mediaCapable,
                // 分类回读键与 consumeModelMediaData 的 policyRevision 同一真源（plain 串）。
                classificationPolicy: mediaPolicyRevision,
                // 回读门控（T10 钩子后真实语义）：lastResolvedByPolicy 是上次同键真实消费的
                // resolved——与本 call used 一致才放行回读；首调/不一致＝零回读。
                classificationGate: () => lastResolvedByPolicy.get(mediaPolicyRevision) ?? null,
                messageSettings: schemeMessageSettings(scheme),
                // 本 run 明确细问且已成功读取的 mediaId（§7.5）：下一相按当相阶段开关升普通规格。
                detailMediaIds: () => runDetailMediaIds,
              },
            }
          : {};
      const source = reuse
        ? reuse.parent.childReplySession({
            spec,
            targets,
            decisionTier: tier,
            batchIntents: reuse.intents,
            onRead,
            ...mediaInputOption,
          })
        : new BotContextSource({
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
            decisionTier: tier,
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
            ...mediaInputOption,
            usage,
            budget,
            now,
            onRead,

            // 预算/补充诊断经既有 diagnose→runtime feedback span（observers 可从 runs span API 读回）。
            // 闭包引用下方 diagnose：context-source 只在构造后的异步 read/view 里调用本回调
            // （构造本身不触发），不会先于 diagnose 初始化执行。
            onDiagnostic: (event) => {
              if (event.kind === "context_budget_exceeded") {
                diagnose({
                  stage: "context_budget",
                  status: "failed",
                  code: "CONTEXT_BUDGET_EXCEEDED",
                  details: {
                    stage: event.stage,
                    tier: event.tier,
                    model: event.model,
                    capacity: event.capacity,
                    ceiling: event.ceiling,
                    renderedCost: event.renderedCost,
                    roomFor: event.roomFor,
                  },
                });
                return;
              }
              // 原 supplemental 事件：stage+code 同错误透传，语义不变（此前只落 console）。
              diagnose({
                stage: event.kind,
                status: "failed",
                code: event.code,
                details: event.name === undefined ? undefined : { name: event.name },
              });
            },
          });
      const diagnose = (
        event: Omit<BotHostDiagnostic, "runId" | "conversationId" | "sourceSeq">,
        runIdOverride?: string,
      ) => {
        try {
          const result = o.onDiagnostic?.({
            ...event,
            runId: runIdOverride ?? runRef.current,
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
        boundary?: QqMediaPhaseState,
        runIdOverride?: string,
      ): void => {
        const projection: QqMediaProjection | undefined =
          projectionOverride ?? mediaProjection(phase, boundary);
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
        diagnose(
          {
            stage: "media_mode",
            status: "observed",
            ...(extra.code ? { code: extra.code } : {}),
            details,
          },
          runIdOverride,
        );
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
      const preparePhaseForModel = async (
        input: {
          readonly phase: "next" | "generate";
          readonly model: string;
          readonly imagesAllowed: boolean;
          readonly messages: readonly ModelMessage[];
          readonly signal?: AbortSignal;
        },
        runIdOverride?: string,
      ): Promise<ModelResolvedPrepareOutput> => {
        const qqPhase = qqPhaseOf(input.phase);
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
            const runId = runIdOverride ?? runRef.current;
            if (runId === undefined) throw new Error("MEDIA_IMAGE_RUN_MISSING");
            source.assertSources(freshProjection.sources);
            guard.assertSources(groupOwner, freshProjection.sources);
            verifyAndRegisterImages(
              freshProjection.images,
              "MEDIA_IMAGE",
              (entry) => runResolver?.register(entry),
              runId,
            );
          }
          emitMediaMode(qqPhase, { why: null, resolvedModel: input.model });
          return {};
        }
        const nativeImages = source.mediaProjection(qqPhase)?.images.length ?? 0;
        if (nativeImages === 0) return {};
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
            actualModeOverride: fallbackProjection?.actualMode,
            resolvedModel: input.model,
          },
          fallbackProjection,
        );
        const messages = strippedMediaFallbackMessages(
          input.messages,
          fallbackProjection?.notes ?? [],
        );
        // 最终 materials 预算复验（当前真源）：超上限＝该次尝试不发出（fail closed）。
        const ceiling = source.phaseUnitsCeiling(qqPhase);
        const units = inputUnits(messages);
        if (ceiling !== undefined && units > ceiling) {
          // 判据就是 ceiling−units（无 envelope512），roomFor 按同一公式实算；capacity 只读
          // source 既有缓存（cachedCapacity），不重复探测；该模型未被探过＝unknown→null。
          diagnose({
            stage: "context_budget",
            status: "failed",
            code: "CONTEXT_BUDGET_EXCEEDED",
            details: {
              stage: "media_fallback",
              tier: qqPhaseTier(qqPhase, decisionTier),
              model: input.model,
              capacity: source.cachedCapacity(input.model) ?? null,
              ceiling,
              renderedCost: units,
              roomFor: ceiling - units,
            },
          });
          fail("CONTEXT_BUDGET_EXCEEDED", "fallback 后的材料超过模型容量");
        }
        return { messages };
      };
      // 披露表：本 run 的 sticker.search 实际返回过哪些 ID（带素材修订），按 owner/run 记账。
      // 显式 stickerIds 只认这里出现过的 ID；跨 run、猜测、已失效的一律拒绝。
      const stickerDisclosures = new Map<string, Map<string, string>>();
      const disclosureKey = (run: string | undefined, scope: RunOwner) =>
        JSON.stringify([
          run ?? null,
          scope.kind,
          scope.id,
          scope.userId ?? null,
          scope.agentId ?? null,
        ]);
      const disclosedSticker = (id: string, runIdOverride?: string) => {
        const revision = stickerDisclosures
          .get(disclosureKey(runIdOverride ?? runRef.current, owner))
          ?.get(id);
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
        const readScope = qqConversationScopeOfBinding({
          conversationId: conversation.id,
          binding,
          bindingEpoch: conversation.bindingEpoch,
        });
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
          runId: runRef.current ?? "",
          signal: input.signal ?? signal,
          assertCurrent: () => source.assertCurrent(),
          capabilityEnabled: mediaCapable,
          owner: groupOwner,
          mediaId: input.mediaNoteId,
          detail: input.question ? (detail ?? undefined) : undefined,
        });
        // variant scoped 复验 + 当前 run resolver 登记（bytes 只进 resolver，不进工具结果）。
        if (runResolver) {
          verifyAndRegisterImages(
            result.images,
            "MEDIA_IMAGE",
            (entry) => runResolver.register(entry),
            runRef.current,
          );
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
       * ── 许可（0.4.0 P4 §4.1 后半，batch-first 后）──
       *
       * 一次批评分对整批候选产出 {score,intent}（无独立意图轮）；达标目标进入各自回复子 run，
       * 正文前的许可判定随该次评分完成。许可绑定**相关状态摘要**——评分材料（时间线、人设、
       * 场景、目标、方案修订）哈希之后的值：相关状态不变则摘要不变，变化则旧许可失效
       * （复评，或发布前被判失效）。许可只活在**本轮**（内存 Map）：跨 run 不复用。
       */
      /** 每目标一条许可：allowed + 相关状态摘要 + 该目标的意图（供该目标回复任务首 call 用）。 */
      const licenses = new Map<string, { allowed: boolean; stateDigest: string; intent: string }>();
      /**
       * Step5a 的"已验证 asset 重登记"实现：评分叶子的 image part 只带来源事实，字节在本
       * 评分叶子的 run/owner 下从**已验证 asset**重新登记——variant 行按 id 取出后必须与投影
       * 声明的 assetId/variantPolicy 一致，且投影 sources（asset/任务 ref，含 scope+revision）
       * 过 guard+context-source 双复验；任何一项不成立即整相拒绝（fail closed），父 run 的
       * 裸句柄从不进入本函数（跨 leaf 借用是负测断言的行为）。
       */
      const registerScoreImages = (): Omit<
        Parameters<ReturnType<typeof createImageByteResolver>["register"]>[0],
        "runId" | "owner"
      >[] => {
        const projection = source.mediaProjection("evaluation");
        if (!projection || projection.images.length === 0) return [];
        source.assertSources(projection.sources);
        guard.assertSources(groupOwner, projection.sources);
        return projection.images.map((image) => {
          const row = db
            .query(
              "SELECT id, asset_id, policy, bytes, mime_type FROM qq_media_variants WHERE id=?",
            )
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
      /**
       * 阶段一批量评分：**一次**判断调用对整批候选逐人给出 {targetId,score,intent,sourceSeqs}
       * （规格 §2.2）。宿主只做程序校验：targetId 必须与本批冻结候选一一对应（missing/未知/
       * 重复均为协议错误）、sourceSeqs 必须落在本批冻结的真实成员事件上（引用不授权）；低分与
       * 协议错误分开（低分消费本批观察边界，协议错误走失败）。
       * 返回映射：targetId → 许可（allowed / stateDigest）。同一 stateDigest 复用缓存。
       */
      const evaluateBatch = async (
        input: { targets: readonly BotContextTarget[] },
        signal: AbortSignal,
        reuseRaw?: string,
      ): Promise<Map<string, { allowed: boolean; stateDigest: string }>> => {
        // 评分媒体准备先于叶子 bindRun：先把 source 绑到真实父批 run（onRunId 已创建 id），
        // preparePhaseMedia 才有 run 级投影；叶子字节登记仍按叶子 runId 走既有 scoreResolver。
        if (ref.current !== undefined) source.bindRunId(ref.current);
        let prepared = await source.prepareBatchEvaluation({
          signal,
          targets: input.targets,
          throughSeq: wake.throughSeq,
        });
        const frozen = new Set(input.targets.map((entry) => entry.id));
        guard.assertSources(groupOwner, prepared.sources);
        emitMediaMode("evaluation", { why: null });
        const callBatchLeaf = (evaln: typeof prepared, why: string | null = null) => {
          const scoreResolver = createImageByteResolver();
          // 消息内图 part 的基准投影（prepareBatchEvaluation 组装时刻）；重备后按它判形状变化。
          const bakedImages = source.mediaProjection("evaluation")?.images ?? [];
          const scoreOwner = {
            kind: "qq_binding",
            id: binding.id,
            userId: DEFAULT_USER_ID,
            agentId: agent.id,
          };
          let scoreRunId: string | undefined;
          return o.agentRuntime.completeMessageLeaf(
            {
              id: "onebot.initiative.evaluate_batch",
              model: evaln.model,
              maxTokens: reserves.judgement_output_reserved,
              limits: { inputUnits: evaln.limit },
              responseSchema: QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA,
            },
            {
              messages: evaln.messages,
              imageResolver: scoreResolver,
              bindRun: (context) => {
                if (context.runId === undefined) throw new Error("SCORE_RUN_ID_REQUIRED");
                scoreRunId = context.runId;
                // 把阶段一判断 run 显式链到本 wake（conversation/observedSeq/wake_id）：崩溃恢复
                // 经此精确链接读回该 run 的受保护 step output（不按时间戳猜）。
                o.journal.linkRun(context.runId, conversation.id, wake.throughSeq, wake.id);
                for (const part of registerScoreImages()) {
                  scoreResolver.register({ ...part, runId: context.runId, owner: context.owner });
                }
              },
              prepareWithResolved: async (hook) => {
                // resolved 落定：评分相媒体按真实模型重备（evaluation 相专用，不借 decision/
                // generation 钩子免冲错分类器）。新投影图片全部按叶 scope 重登记进本叶
                // scoreResolver；notes/消息随钩子更新；上线前按叶 inputUnits 预算复验（fail closed）。
                if (hook.imagesAllowed) {
                  const freshProjection = await source.repreparePhaseForModel(
                    "evaluation",
                    hook.model,
                    hook.signal ?? signal,
                  );
                  if (freshProjection && freshProjection.images.length > 0) {
                    if (scoreRunId === undefined) throw new Error("SCORE_RUN_ID_REQUIRED");
                    for (const part of registerScoreImages()) {
                      scoreResolver.register({ ...part, runId: scoreRunId, owner: scoreOwner });
                    }
                  }
                  emitMediaMode("evaluation", { why: null, resolvedModel: hook.model });
                  // resolved 模型切换图规格时投影形状可能变：消息内旧图 part 按序换成新投影
                  // part（resolver 条目已同步重登记）、多余旧 part 剥除——不重装全 material，
                  // 换后仍按叶 inputUnits 预算复验（fail closed）。
                  const freshImages = freshProjection?.images ?? [];
                  const shapeChanged =
                    freshImages.length !== bakedImages.length ||
                    freshImages.some(
                      (image, index) =>
                        bakedImages[index]?.mediaId !== image.mediaId ||
                        bakedImages[index]?.variantId !== image.variantId,
                    );
                  if (shapeChanged) {
                    // 旧图 slot 按序换入新投影 part；剩余 fresh（旧 slot 少于新帧数）按序附为
                    // user 图资料消息——不漏帧、不复制已有 part、不重渲 material。
                    let cursor = 0;
                    const replaced = hook.messages.map((message) => ({
                      ...message,
                      content: message.content.flatMap((part) => {
                        if (part.kind !== "image") return [part];
                        if (cursor >= freshImages.length) return [];
                        return [freshImages[cursor++].content];
                      }),
                    }));
                    const remaining = freshImages.slice(cursor).map((image) => image.content);
                    const withImages =
                      remaining.length === 0
                        ? replaced
                        : [...replaced, { role: "user" as const, content: remaining }];
                    const messages = withImages.filter((message) => message.content.length > 0);
                    if (inputUnits(messages) > evaln.limit)
                      fail("CONTEXT_BUDGET_EXCEEDED", "评分相重备材料超过评分叶 inputUnits 上限");
                    return { messages };
                  }
                  return {};
                }
                const nativeImages = source.mediaProjection("evaluation")?.images.length ?? 0;
                if (nativeImages === 0) {
                  // 模型不收图且本相无原生图：同样发一条已知 why 的真实 resolved 事件
                  //（why 取本叶调用语义，不拿 requested 冒 resolved）。
                  emitMediaMode("evaluation", {
                    why,
                    ...(why ? { code: "MODEL_IMAGE_UNSUPPORTED" } : {}),
                    resolvedModel: hook.model,
                  });
                  return {};
                }
                source.requestMediaFallback("evaluation", "model_image_unsupported");
                const fallbackProjection = await source.repreparePhaseMedia(
                  "evaluation",
                  hook.signal ?? signal,
                );
                emitMediaMode(
                  "evaluation",
                  {
                    why: "model_image_unsupported",
                    code: "MODEL_IMAGE_UNSUPPORTED",
                    actualModeOverride: fallbackProjection?.actualMode,
                    resolvedModel: hook.model,
                  },
                  fallbackProjection,
                );
                const messages = strippedMediaFallbackMessages(
                  hook.messages,
                  fallbackProjection?.notes ?? [],
                );
                if (inputUnits(messages) > evaln.limit)
                  fail("CONTEXT_BUDGET_EXCEEDED", "评分相 fallback 材料超过评分叶 inputUnits 上限");
                return { messages };
              },
              assertPreparedCurrent: (input: { model: string }) => {
                // 源 guard 每次 HTTP 前仍在；诊断带 boundary 实际传入的真实 resolved model
                //（requested 只作 requested 标注，不冒 resolved）；fallback 相位带 why/code。
                source.assertCurrent();
                emitMediaMode("evaluation", {
                  why,
                  ...(why ? { code: "MODEL_IMAGE_UNSUPPORTED" } : {}),
                  requestedModel: evaln.model,
                  resolvedModel: input.model,
                });
              },
              signal,
              usage,
              budget,
              owner: scoreOwner,
              sources: evaln.sources,
            },
          );
        };
        let raw: string;
        if (reuseRaw !== undefined) {
          // 崩溃恢复：复用上次成功判断步的 raw（受保护 step output），不再新增模型调用；下面的
          // 覆盖/引用校验仍按**当前** source/authority 复验（不 blind cache 重放）。
          raw = reuseRaw;
        } else {
          try {
            raw = await callBatchLeaf(prepared);
            recordNativeConsumed("evaluation");
          } catch (error) {
            // §9 fallback（评分相）：仅精确 MODEL_IMAGE_UNSUPPORTED 且本相真发了原生图时，转
            // describeAfterUnsupported 备用后重备材料重试恰一次；其余错误原样抛。
            if (
              !isModelImageUnsupportedError(error) ||
              (source.mediaProjection("evaluation")?.images.length ?? 0) === 0
            )
              throw error;
            source.requestMediaFallback("evaluation", "model_image_unsupported");
            prepared = await source.prepareBatchEvaluation({
              signal,
              targets: input.targets,
              throughSeq: wake.throughSeq,
            });
            guard.assertSources(groupOwner, prepared.sources);
            emitMediaMode(
              "evaluation",
              { why: "model_image_unsupported", code: "MODEL_IMAGE_UNSUPPORTED" },
              source.mediaProjection("evaluation"),
            );
            raw = await callBatchLeaf(prepared, "model_image_unsupported");
          }
        }
        const outcome = parseQqBatchJudgement(raw);
        if (outcome.kind === "unreadable")
          throw Object.assign(new Error("JUDGEMENT_UNREADABLE"), { code: "JUDGEMENT_UNREADABLE" });
        // 目标覆盖必须与本批冻结候选集合一一对应：missing 也是协议错误（不是低分/沉默）。
        const seen = new Set<string>();
        for (const evaluation of outcome.evaluations) {
          if (!frozen.has(evaluation.targetId))
            throw Object.assign(new Error("JUDGEMENT_TARGET_UNKNOWN"), {
              code: "JUDGEMENT_TARGET_UNKNOWN",
            });
          if (seen.has(evaluation.targetId))
            throw Object.assign(new Error("JUDGEMENT_TARGET_DUPLICATE"), {
              code: "JUDGEMENT_TARGET_DUPLICATE",
            });
          seen.add(evaluation.targetId);
          // 引用必须落在本批冻结的真实成员事件上；引用不授予权限（真实授权仍在发送边界复验）。
          for (const seq of evaluation.sourceSeqs)
            if (!prepared.memberSourceSeqs.has(seq))
              throw Object.assign(new Error("JUDGEMENT_SOURCE_SEQ_INVALID"), {
                code: "JUDGEMENT_SOURCE_SEQ_INVALID",
              });
        }
        if (seen.size !== frozen.size)
          throw Object.assign(new Error("JUDGEMENT_TARGET_MISSING"), {
            code: "JUDGEMENT_TARGET_MISSING",
          });
        const minScore = schemeRhythm(scheme).initiative_min_score;
        const licensesOut = new Map<string, { allowed: boolean; stateDigest: string }>();
        // 许可按 **targetId** 唯一存放：同一 stateDigest 下不同人的分数/意图各自成项，不互相覆盖。
        for (const evaluation of outcome.evaluations) {
          // 分数达到门槛＝该目标合格；意图随分数保存，供该目标的回复任务作为首 call 的要点。
          licenses.set(evaluation.targetId, {
            allowed: evaluation.score >= minScore,
            stateDigest: prepared.stateDigest,
            intent: evaluation.intent,
          });
          licensesOut.set(evaluation.targetId, {
            allowed: evaluation.score >= minScore,
            stateDigest: prepared.stateDigest,
          });
        }
        return licensesOut;
      };
      // 终结回复能力由 runtime 经 terminalAction.description 进入同次投递目录（系统声明与原生
      // tools 都广告它），这里只登记普通工具。
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
        // 主动批次的目标集已由阶段一门槛冻结并推进了观察边界：新到达只重观察上下文，不重算机会集合
        // （重算会读到已推进边界而清空目标）。direct/continuous 仍按原机会重算。
        if (!initiative) {
          prepared = preparation(false, source);
          setTargets();
        }
        source.invalidate();
        return true;
      };
      const staged = new Map<string, QqPreparedReply>();
      const reserved = new Set<string>();
      /** 已早提交的目标（规格 §4.1）：整批终态结算时不再重复写 intent/事件。 */
      const committedTargets = new Set<string>();
      const resolveQuote = (messageId: string): SourceRef[] =>
        source.resolveReplyToMessage(messageId);
      const validateMentions = (ids: readonly string[] | undefined): readonly string[] =>
        source.resolveMentionIds(
          ids,
          targets.flatMap((target) => (target.speakerId ? [target.speakerId] : [])),
        );
      /**
       * 单目标提交流程（在宿主原事务内调用，供早提交与终态结算共用）：写该目标的 outbox intent、
       * delivery 事件与出站身份快照。返回 intent id（未提交＝undefined）。不做评分/上下文重构。
       */
      const commitIntentFor = (
        output: PreparedOutput,
        currentRunId: string,
        at: string,
        ordinal: number,
        opportunitySeq: number,
      ): string | undefined => {
        if (output.status !== "prepared" || committedTargets.has(output.targetId)) return undefined;
        // 本群停用「表情」后，仍带素材的提交不再放行（停用即时生效，不等下一轮）。
        if ((output.stickerIds?.length ?? 0) > 0) guard.assert(groupOwner, "stickers");
        const pending = staged.get(output.outputId);
        if (!pending) throw new Error("OUTPUT_PREPARATION_MISSING");
        // 引用来源提交前复验：重新解析引用并比对保存的 refs 修订（必须相同，不重铸覆盖）；源守卫照常检验。
        if (pending.replyToMessageId) {
          const freshQuoteSources = resolveQuote(pending.replyToMessageId);
          for (const fresh of freshQuoteSources) {
            const saved = (output.sources ?? []).find(
              (s) => s.kind === fresh.kind && s.id === fresh.id,
            );
            if (!saved || saved.revision !== fresh.revision) {
              fail("CONTEXT_SOURCE_INVALID", "引用消息来源或修订已变更");
            }
          }
          source.assertSources(output.sources ?? []);
          source.assertSources(freshQuoteSources);
        }
        const plan = planQqPreparedReply(o.orm, pending, o.stickers);
        if (plan.kind !== "planned") throw new Error("OUTPUT_CHANGED_AT_COMMIT");
        // 每次提交都现读保留窗口：改设置只影响之后写出的到期戳，已在队列里的行保持原样。
        const expiresAt = speechExpiresAt(
          Math.floor(Date.parse(at) / 1000),
          readQqRetentionDays(o.orm),
        );
        const participantId =
          binding.kind === "group" && split ? (pending.targetSpeakerId ?? undefined) : undefined;
        const intent = o.outbox.commit({
          // 幂等键：同一个机会被重跑（崩溃重排、结果未知后重来）时会命中同一行，
          // 于是"计划中"的被替换、"已尝试过"的原样返回——都不会发出第二条。
          id: idempotentIntentId([conversation.id, opportunitySeq, path, participantId ?? "room"]),
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
          sourceThroughSeq: opportunitySeq,
          deliverBy: new Date(Date.parse(at) + policy.deliveryTtlSeconds * 1000).toISOString(),
          createdAt: at,
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
          occurredAt: at,
          runId: currentRunId,
          outputId: intent.id,
        });
        // 出站身份快照（§3.2/§13.4）：commit 时存当前平台身份——真实发送账号（binding 的登录账号，
        // 绝不用 Agent UUID 充当 QQ 号）＋优先昵称。私聊没有群名片语义：group_card 恒空（T03 Step6）。
        const assistantNames = readQqMemberNames(
          o.orm,
          { accountId: binding.accountId, conversationKind: binding.kind, peerId: binding.peerId },
          binding.accountId,
        );
        const preferredName = binding.kind === "group" ? (assistantNames?.groupCard ?? null) : null;
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
          occurredAtSeconds: Math.floor(Date.parse(at) / 1000),
        });
        committedTargets.add(output.targetId);
        return intent.id;
      };
      /**
       * 单目标输出定稿（早提交与终态结算共用）：生成文本/选图/mention 定型为该目标的
       * QqPreparedReply 并放入 staged；素材在发前再对一次当前事实；非法即把 output 置 blocked。
       */
      const stageOutput = (output: PreparedOutput, runIdOverride?: string): void => {
        const raw = output.text ?? "",
          text = split ? raw.replace(/\s*\r?\n+\s*/g, " ").trim() : raw;
        const selection = source.selection;
        if (!selection) throw new Error("BOT_CONTEXT_MISSING");
        // 引用解析与来源合并：提供 replyToMessageId 时校验并解析披露来源
        let quoteSources: SourceRef[] = [];
        if (output.replyToMessageId) {
          quoteSources = resolveQuote(output.replyToMessageId);
        }
        // 结构化 mention 校验（无旧无界 journal 循环，写回去重后的 IDs）
        const validMentions = validateMentions(output.mentionIds);
        output.mentionIds = [...validMentions];
        // 显式选图在发前再对一次当前事实：本 run 披露过、素材仍在目录里且修订未变。
        const explicitId = output.stickerIds?.[0] ?? null;
        const selectedAsset = explicitId ? disclosedSticker(explicitId, runIdOverride) : undefined;
        if (explicitId && !selectedAsset) {
          output.status = "blocked";
          output.code = "STICKER_SELECTION_UNAVAILABLE";
          diagnose({
            stage: "sticker",
            status: "feedback",
            code: output.code,
            targetId: output.targetId,
          });
          return;
        }
        diagnose({
          stage: "sticker",
          status: selectedAsset ? "selected" : "none",
          targetId: output.targetId,
          code: selectedAsset ? undefined : stickersEnabled ? "explicit_none" : "module_paused",
          details: selectedAsset ? { stickerId: selectedAsset.id } : undefined,
        });
        output.stickerIds = selectedAsset ? [selectedAsset.id] : [];
        const stickerSources = selectedAsset
          ? [
              {
                kind: "qq_sticker" as const,
                id: selectedAsset.id,
                revision: selectedAsset.updatedAt,
              },
            ]
          : [];
        output.sources = uniqueSources([
          ...(output.sources ?? []),
          ...stickerSources,
          ...quoteSources,
        ]);
        const target = targets.find((t) => t.id === output.targetId)!;
        const pending: QqPreparedReply = {
          text: text || null,
          ...(output.replyToMessageId ? { replyToMessageId: output.replyToMessageId } : {}),
          snapshot,
          schemeRevision: scheme.revision,
          agentConfigVersion: agent.configVersion,
          path,
          nowSeconds: seconds(),
          selection,
          stickerId: selectedAsset?.id ?? null,
          targetSpeakerId: target.speakerId,
          // 显式 @ 走结构化 IDs（宿主已按真实合法成员/授权校验）；正文 CQ 只作文字。
          mentionIds: validMentions,
        };
        staged.set(output.outputId, pending);
        if (planQqPreparedReply(o.orm, pending, o.stickers).kind !== "planned") {
          output.status = "blocked";
          output.code = "EMPTY_OUTPUT";
          diagnose({
            stage: "output",
            status: "feedback",
            code: output.code,
            targetId: output.targetId,
          });
        }
      };
      /**
       * 真正与 run 相关的块（宿主入口 + 各相钩子 + 提交钩子）：主路径的单 run 与主动批次下每个
       * 达标目标的回复子 run 共用同一份实现。子 run 传自己的 `ref`（run id）与 `settleWake=false`
       * （批次 wake 由父统一结算）；机会准备 / source 视图 / 水位压缩只在 activate 里做一次。
       */
      const activateReply = async (
        settleWake: boolean,
      ): Promise<Awaited<ReturnType<ConversationHost["activate"]>>> => {
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
            silentBlockCodes: QQ_SILENT_BLOCK_CODES,
            // 终结回复动作：模型一次 invoke speech.reply 直接给出正文（inline 草稿），与 final
            // 同形状走同一提交路径；不执行工具、不返回模型确认。目标/mention 由 prepareOutput
            // 与提交边界照常校验。
            terminalAction: {
              name: SPEECH_REPLY_DESCRIPTION.name,
              description: SPEECH_REPLY_DESCRIPTION,
              parse: (arguments_) => {
                const parsed = SpeechReplyArgumentsSchema.parse(arguments_);
                return parsed.outputs;
              },
            },
            signal,
            onEvent(event) {
              if (event.type === "started") {
                ref.current = event.runId;
                o.journal.linkRun(ref.current, conversation.id, source.observedSeq, wake.id);
              }
            },
            // T10 准备钩子透传（决策/生成相）：actualModel 冻结后由网关调用一次；
            // 钩子闭包见 preparePhaseForModel（§9 严格 fallback + 相模式观测）。
            prepareWithResolved: (hook) => preparePhaseForModel(hook, ref.current),
            // 每次实际发送前（含 schema/tools 重试与 stream）复验当前授权真源。
            assertPreparedCurrent: () => source.assertCurrent(),
            // §8.1 current_run_consumed 记账：runtime 在相模型调用成功返回后通知；
            // 宿主按当相真实发送的 mediaId+sourceRefs 记录 native proof。
            onModelCallConsumed: (consumed) => {
              recordNativeConsumed(qqPhaseOf(consumed.phase));
            },
            // §9 真实 HTTP unsupported 重试边界：runtime 在相调用被精确拒绝后调用恰一次；
            // 宿主标该相 fallback、重备 description 材料并返回剥离原生图＋notes 的最终消息
            // （null＝无可降路径，原样抛）。非 unsupported 永不进入这里。
            onPhaseMediaUnsupported: async (input) => {
              const qqPhase = qqPhaseOf(input.phase);
              const nativeImages = mediaProjection(qqPhase)?.images.length ?? 0;
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
              const messages = strippedMediaFallbackMessages(
                input.messages,
                fallbackProjection?.notes ?? [],
              );
              return { messages };
            },
            ...(runResolver
              ? {
                  imageResolver: runResolver,
                  // 决策相（bindRun 在首次 read 前调用恰一次）与生成相（prepareGeneration 后、
                  // 模型调用前）的字节登记边界：都按当前投影 sources 复验后注册本 run/owner。
                  bindRun: () => registerProjection("decision", undefined, ref.current),
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
              // 本目标的媒体相位边界与发送闭包；决策相与单目标路径走共享边界。
              const boundary = source.targetScope();
              const generation = await source.prepareGeneration(draft, {
                ...input,
                ...(boundary === undefined ? {} : { boundary }),
              });
              generationAttempts.set(
                draft.targetId,
                (generationAttempts.get(draft.targetId) ?? 0) + 1,
              );
              registerProjection("generation", boundary, ref.current);
              const hooks: TargetHooks = {
                // 本目标的 resolved 准备钩子：按本目标边界重备生成相媒体；决策相仍走共享边界。
                prepareWithResolved: async (hook) => {
                  const qqPhase = qqPhaseOf(hook.phase);
                  if (qqPhase !== "generation") return preparePhaseForModel(hook, ref.current);
                  const mediaBoundary = boundary;
                  if (hook.imagesAllowed) {
                    const freshProjection = await source.repreparePhaseForModel(
                      qqPhase,
                      hook.model,
                      hook.signal ?? signal,
                      mediaBoundary,
                    );
                    if (freshProjection && freshProjection.images.length > 0) {
                      if (ref.current === undefined) throw new Error("MEDIA_IMAGE_RUN_MISSING");
                      source.assertSources(freshProjection.sources);
                      guard.assertSources(groupOwner, freshProjection.sources);
                      verifyAndRegisterImages(
                        freshProjection.images,
                        "MEDIA_IMAGE",
                        (entry) => runResolver?.register(entry),
                        ref.current,
                      );
                    }
                    emitMediaMode(
                      qqPhase,
                      { why: null, resolvedModel: hook.model },
                      undefined,
                      mediaBoundary,
                    );
                    return {};
                  }
                  const nativeImages = mediaProjection(qqPhase, mediaBoundary)?.images.length ?? 0;
                  if (nativeImages === 0) return {};
                  source.requestMediaFallback(qqPhase, "model_image_unsupported", mediaBoundary);
                  const fallbackProjection = await source.repreparePhaseMedia(
                    qqPhase,
                    hook.signal ?? signal,
                    mediaBoundary,
                  );
                  emitMediaMode(
                    qqPhase,
                    {
                      why: "model_image_unsupported",
                      code: "MODEL_IMAGE_UNSUPPORTED",
                      actualModeOverride: fallbackProjection?.actualMode,
                      resolvedModel: hook.model,
                    },
                    fallbackProjection,
                    mediaBoundary,
                  );
                  const messages = strippedMediaFallbackMessages(
                    hook.messages,
                    fallbackProjection?.notes ?? [],
                  );
                  const ceiling = source.phaseUnitsCeiling(qqPhase, mediaBoundary);
                  const units = inputUnits(messages);
                  if (ceiling !== undefined && units > ceiling)
                    fail("CONTEXT_BUDGET_EXCEEDED", "fallback 后的材料超过模型容量");
                  return { messages };
                },
                // 每次发送，本目标边界（decision 相走共享边界）。
                onPhaseMediaUnsupported: async (hook) => {
                  const qqPhase = qqPhaseOf(hook.phase);
                  const mediaBoundary = hook.phase === "generate" ? boundary : undefined;
                  if ((mediaProjection(qqPhase, mediaBoundary)?.images.length ?? 0) === 0)
                    return null;
                  source.requestMediaFallback(qqPhase, "model_image_unsupported", mediaBoundary);
                  const fallbackProjection = await source.repreparePhaseMedia(
                    qqPhase,
                    hook.signal ?? signal,
                    mediaBoundary,
                  );
                  emitMediaMode(
                    qqPhase,
                    {
                      why: "model_image_unsupported",
                      code: "MODEL_IMAGE_UNSUPPORTED",
                      resolvedModel: hook.model,
                    },
                    fallbackProjection,
                    mediaBoundary,
                  );
                  return {
                    messages: strippedMediaFallbackMessages(
                      hook.messages,
                      fallbackProjection?.notes ?? [],
                    ),
                  };
                },
                onModelCallConsumed: (consumed) =>
                  recordNativeConsumed(
                    qqPhaseOf(consumed.phase),
                    consumed.phase === "generate" ? boundary : undefined,
                  ),
                ...(runResolver === null ? {} : { imageResolver: runResolver }),
              };
              return {
                ...generation,
                hooks,
                // 规格 §10：生成相存在待分类 unknown 图时换 envelope，按本目标边界判定/消费。
                ...(hasUnknownImages("generation", boundary)
                  ? {
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
                            phaseSentIds("generation", boundary),
                          );
                          const resolvedModel = meta?.resolvedModel ?? "";
                          if (resolvedModel !== "")
                            consumeClassifications(
                              "generation",
                              envelope.media,
                              resolvedModel,
                              signal,
                              boundary,
                            );
                          return { text: envelope.text };
                        },
                      },
                    }
                  : {}),
              };
            },
            prepareOutput: async (draft) => {
              // 阶段一资格/门槛已在进入回复 run 前判定（authorizedTargets 只含达标目标），这里只做
              // 每目标一次的预留与素材校验，不再重跑资格判断。
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
              } else if (stickerId && !disclosedSticker(stickerId, ref.current))
                return { blocked: true, code: "STICKER_SELECTION_UNAVAILABLE" };
              const outputId = crypto.randomUUID();
              // 阶段一评分与门槛已在进入回复 run 前完成，且回复 run 的 authorizedTargets 只含达标目标：
              // 这里不再二次评分（删除旧的 prepareOutput 批量许可 wrapper）。
              reserved.add(draft.targetId);
              return { outputId };
            },
            beforeFinal: async (drafts) => {
              reserved.clear();
              if (await refresh(drafts)) return true;
              // 发布闸（§7.1/§8.1）：主动接话发布时，对象「试过但没读出」且本 run 未真实消费的
              // 图仍无有效解除即硬失败；与准备闸同一谓词真源。
              if (path === "chiming_in" && drafts.length > 0) {
                const scopeEventKeys = new Set<string>();
                for (const draft of drafts) {
                  const speaker =
                    targets.find((target) => target.id === draft.targetId)?.speakerId ?? null;
                  for (const key of source.selectedEventKeys(speaker)) scopeEventKeys.add(key);
                }
                const unproven = attemptedUnreadMediaNoteIds(
                  o.orm,
                  [...scopeEventKeys],
                  now(),
                ).filter((mediaNoteId) => !runNativeConsumed.has(mediaNoteId));
                if (unproven.length > 0)
                  throw Object.assign(new Error("MEDIA_READ_UNRESOLVED_AT_PUBLISH"), {
                    code: "MEDIA_READ_FAILED",
                  });
              }
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
                // 已早提交的目标不再复核/重开（不被 reconsider 再次提交或抹除）。
                if (committedTargets.has(output.targetId)) continue;
                if (output.status !== "prepared") {
                  if (
                    output.code === "STICKER_COUNT_EXCEEDED" ||
                    output.code === "STICKER_SELECTION_REQUIRED" ||
                    output.code === "STICKER_SELECTION_UNAVAILABLE"
                  )
                    invalidOutput = true;
                  continue;
                }
                stageOutput(output, ref.current);
                if (output.status !== "prepared") invalidOutput = true;
              }
              if (await refresh([], outputs)) return true;
              if (invalidOutput) {
                rememberPlan("output_feedback", [], outputs);
                return true;
              }
              return false;
            },
            commitOutputs: async (outputs: readonly PreparedOutput[], currentRunId, terminal) => {
              // 连续交谈（follow_up）是"必回"：这一轮没有可提交输出（模型返回 none 或全部被
              // 静默挡下）时明确拒绝，不静默当 no_output——沉默不是对要求回话的合法回答。
              if (path === "follow_up" && !outputs.some((output) => output.status === "prepared"))
                throw Object.assign(new Error("CONTINUOUS_REPLY_REQUIRED"), {
                  code: "CONTINUOUS_REPLY_REQUIRED",
                });
              return db
                .transaction(() => {
                  source.assertCurrent();
                  // 机会身份统一用**冻结的 wake.throughSeq**（主动批次）或当轮 observedSeq（direct/continuous）：
                  // 运行中 refresh 会推进 observedSeq，child/重排若取新值即换机会身份，故键与 ack 都用冻结界。
                  const opportunitySeq = initiative ? wake.throughSeq : source.observedSeq;
                  if (
                    o.journal
                      .eventsAfter(conversation.id, source.observedSeq, Number.MAX_SAFE_INTEGER)
                      .items.some(relevant)
                  )
                    throw new Error("CONVERSATION_CHANGED_AT_COMMIT");
                  for (const [ordinal, output] of outputs.entries()) {
                    // 已早提交的目标跳过（不重复写 intent/事件）；未早提交的（含早提交关闭）在此结算。
                    commitIntentFor(output, currentRunId, terminal.at, ordinal, opportunitySeq);
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
                  // 子回复 run 只负责自己单 target 的 outbox（commitIntentFor 已写）；wake/游标/覆盖
                  // 由父统一结算（子 run 不 acknowledge 全局游标、不 complete wake、不 linkRun）。
                  if (settleWake) {
                    o.journal.acknowledge(conversation.id, opportunitySeq);
                    const deliveredTargets = new Set(
                      outputs
                        .filter((output) => output.status === "prepared")
                        .map((output) => output.targetId),
                    );
                    // 静默目标仍需结算已观察的参与者机会。
                    const failedTargets = new Map(
                      outputs
                        .filter(
                          (output) =>
                            output.status !== "prepared" &&
                            !deliveredTargets.has(output.targetId) &&
                            !(
                              output.status === "blocked" &&
                              QQ_SILENT_BLOCK_CODES.some((code) => code === output.code)
                            ),
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
                      opportunitySeq,
                      now(),
                      covered,
                      failedTargets.get(ownTarget),
                    );
                    o.journal.linkRun(currentRunId, conversation.id, opportunitySeq, wake.id);
                  }
                  return new AgentRunRepository(db).finishRun(
                    currentRunId,
                    terminal.status,
                    terminal.event,
                    terminal.at,
                  );
                })
                .immediate();
            },
            ...(settleWake
              ? {}
              : {
                  // 规格 §4.1 早提交（仅主动批次子 run）：本目标生成完成即刻提交（不等兄弟目标或整批
                  // settled）。冻结 API：宿主做单 target 合法校验（stageOutput）＋同源事务写，键用冻结
                  // wake.throughSeq；返回是否已提交。已提交目标在 reconsider/终态结算被跳过，不因兄弟失败抹除。
                  commitOutput: async (
                    output: PreparedOutput,
                    runId: string,
                    meta: { ordinal: number; at: string },
                  ): Promise<boolean> =>
                    db
                      .transaction(() => {
                        if (committedTargets.has(output.targetId)) return false;
                        source.assertCurrent();
                        stageOutput(output, runId);
                        return (
                          commitIntentFor(output, runId, meta.at, meta.ordinal, wake.throughSeq) !==
                          undefined
                        );
                      })
                      .immediate(),
                }),
          });
        } finally {
          // 本 run 的字节登记随 run 结束释放（成功/失败/取消都释放本 run+owner；评分叶子由
          // agent-runtime 的 finally 各自释放，两层互不覆盖）。子 run 释放自己的 id；父 run 的
          // 登记在批次结算处释放（见下）。机会准备/source 视图/水位压缩只在 activate 里做一次。
          if (runResolver && ref.current !== undefined) runResolver.release(ref.current, owner);
        }
        if (result === undefined) throw new Error("BOT_RUN_INCOMPLETE");
        return result;
      };
      return { source, activateReply, evaluateBatch, licenses };
    };
    // 水位压缩只在 activate 做一次：任一返回路径都带走本 source 的压缩任务（不重复压、不泄漏）。
    const finish = <T>(src: BotContextSource, value: T): T => {
      const job = src.takeCompressionJob();
      if (job) o.enqueueCompression?.(job);
      return value;
    };
    // 主动批次：**一个**真实父 run（runTaskGroup）覆盖阶段一评分叶子与阶段二各达标目标的回复
    // 子 run；评分/子 run 经 AsyncLocal 继承父 usage/scope/sources，不另起 ledger。父 run id
    // 由 onRunId 捕获（不是第 1 个子 run 的 id）。协议/评分失败原样抛走原失败结算（父 run→failed）。
    if (initiative) {
      const memberBatch =
        path === "chiming_in" && binding.kind === "group" && prepared.kind === "prepared"
          ? prepared.targets.map((entry) => ({
              id: entry.speakerId ?? "anonymous",
              speakerId: entry.speakerId,
            }))
          : targets;
      const roomTargets: BotContextTarget[] =
        binding.kind === "private"
          ? [{ id: binding.peerId, speakerId: binding.peerId }]
          : [{ id: binding.peerId, speakerId: null }];
      const perTarget = split && path !== "idle_topic";
      // 崩溃恢复（规格 §8.2）：同一 wake 上次成功判断步的 raw（受保护 step output），经 run 的
      // wake_id 精确链接（不按最近时间戳猜）——存在则复用，不重新 judge。
      const recoverStage1Raw = (): string | undefined => {
        // 恢复只认同一机会身份（wake/会话/冻结 observed_seq/绑定所有者/助手），不按时间戳猜。
        const runRow = db
          .query(
            "SELECT run_id FROM agent_runs WHERE spec_id='onebot.initiative.evaluate_batch' AND wake_id=? AND conversation_id=? AND observed_seq=? AND owner_kind='qq_binding' AND owner_id=? AND agent_id=? AND status='completed' ORDER BY started_at DESC LIMIT 1",
          )
          .get(wake.id, conversation.id, wake.throughSeq, binding.id, agent.id) as {
          run_id: string;
        } | null;
        if (!runRow) return undefined;
        const stepRow = db
          .query(
            "SELECT step_id FROM agent_steps WHERE run_id=? AND status='completed' ORDER BY step_no LIMIT 1",
          )
          .get(runRow.run_id) as { step_id: string } | null;
        if (!stepRow) return undefined;
        const ctx = new AgentRunRepository(db).getContext({
          runId: runRow.run_id,
          stepId: stepRow.step_id,
        });
        // 受保护判断只有 exact 且未到期可复用；撤销/到期改走合法重判，不硬拒。
        if (
          ctx === null ||
          ctx.status !== "exact" ||
          (ctx.expiresAt !== null && ctx.expiresAt <= now())
        )
          return undefined;
        // 旧判断消费过的来源已撤权/过期时 raw 不得复用：按当前授权一次复验，撤权原样抛。
        parentBatch.source.assertSources(ctx.sources);
        const out = ctx.output as { text?: unknown } | null | undefined;
        return typeof out?.text === "string" ? out.text : undefined;
      };
      const parentBatch = buildRun(undefined, judgementSpec, memberBatch, [], "judgement", runRef);
      const outcome = await o.agentRuntime.runTaskGroup(
        { id: "onebot.initiative.batch", version: "1" },
        {
          owner,
          conversationId: conversation.id,
          signal,
          sources: parentBatch.source.sources,
          usage,
          budget,
          onRunId: (runId) => {
            runRef.current = runId;
            o.journal.linkRun(runId, conversation.id, wake.throughSeq, wake.id);
          },
        },
        async (groupSignal) => {
          // 阶段一：**一次**批量评分叶子（本批首个模型调用），逐 target 给 {score,intent}。完整
          // 覆盖/未知/重复/missing/非法 refs 都是协议错误（evaluateBatch 内抛）；低于门槛是正常
          // no_output。评分先于回复 run——删除旧"主 next 先写意图→prepareOutput 再评分"层序。
          groupSignal.throwIfAborted();
          // 零达标/全已提交（崩溃恢复）：父 run 以同一 owner 原事务写 no_output 终态（RT 的
          // finish(completed) 遇 ended 不再追加），并与 wake 结算/游标推进同事务，减少 crash 窗。
          const settleInitiative = (reason: "no_output" | "already_committed") => {
            db.transaction(() => {
              if (path === "chiming_in")
                o.journal.advanceChimingInObservedSeq(conversation.id, wake.throughSeq);
              o.wakes.complete(wake.id, wake.leaseToken!, "no_output", wake.throughSeq, now());
              if (runRef.current)
                new AgentRunRepository(db).finishRun(
                  runRef.current,
                  "no_output",
                  { type: "no_output" },
                  now(),
                  { conversationId: conversation.id },
                );
            }).immediate();
            return { kind: reason };
          };
          // 崩溃恢复（规格 §8.2）：同一冻结机会若**全部**候选都已有 outbox 行（早提交事务已写），
          // 直接判为已提交——不重判（0 次模型调用）、不重生成。部分已提交时仍要判定剩余范围。
          const committedOf = (entry: { id: string; speakerId: string | null }) => {
            const participantId =
              binding.kind === "group" && split ? (entry.speakerId ?? undefined) : undefined;
            return o.outbox.row(
              idempotentIntentId([conversation.id, wake.throughSeq, path, participantId ?? "room"]),
            );
          };
          if (memberBatch.length > 0 && memberBatch.every((entry) => committedOf(entry) !== null))
            return settleInitiative("already_committed");
          const licensed = await parentBatch.evaluateBatch(
            { targets: memberBatch },
            groupSignal,
            recoverStage1Raw(),
          );
          const qualified = memberBatch.filter((entry) => licensed.get(entry.id)?.allowed);
          if (qualified.length === 0) return settleInitiative("no_output");
          // 生成前按 stable key 预查：同一机会（冻结 throughSeq）的 target 若已有 outbox 行
          //（committed/attempted/unknown），不重生成、不重发；恢复靠原行，不靠下次空 range 当 no_output。
          const pendingTargets = qualified.filter((entry) => committedOf(entry) === null);
          if (pendingTargets.length === 0) return settleInitiative("already_committed");
          // 阶段二：每个达标 target 一个**独立 source 的回复子 run**（`childReplySession` 只共享
          // 不可变材料/视图快照；run 级状态——spec/targets/views/observations/预留/媒体边界/runId
          // ——各自独立，互不覆写，规格 §3.2）。intent 只作 data_only 材料，每 child 只带本人的。
          // 父先把 reply 档视图建**一次**：子 run 复制该不可变视图，水位/摘要只压一次
          // （避免 N 个子 run 并发重建同一档视图产生重复压缩竞态）。
          parentBatch.source.setRun(buildReplySpec(), "reply");
          await parentBatch.source.read({ signal: groupSignal, observations: [] });
          const replyTasks = (
            perTarget
              ? pendingTargets.map((target) => ({
                  targets: [target as BotContextTarget],
                  intents: [
                    {
                      targetId: target.id,
                      intent: parentBatch.licenses.get(target.id)?.intent ?? "",
                    },
                  ],
                }))
              : [
                  {
                    targets: roomTargets,
                    intents: pendingTargets.map((entry) => ({
                      targetId: entry.id,
                      intent: parentBatch.licenses.get(entry.id)?.intent ?? "",
                    })),
                  },
                ]
          ).map((task) => {
            const ref: { current: string | undefined } = { current: undefined };
            const run = buildRun(
              {
                parent: parentBatch.source,
                intents: { value: task.intents, sources: parentBatch.source.sources },
              },
              buildReplySpec(),
              [...task.targets],
              task.targets.map((t) => t.id),
              "reply",
              ref,
            );
            return { ...task, ref, run };
          });
          const settled = await Promise.allSettled(
            replyTasks.map((task) => task.run.activateReply(false)),
          );
          // 全部子 run 失败＝本批无有效结果：抛错走原失败结算（父 run→failed），不吞成 no_output。
          if (settled.length > 0 && settled.every((entry) => entry.status === "rejected"))
            throw (settled[0] as PromiseRejectedResult).reason;
          return { kind: "ran" as const, settled, replyTasks };
        },
      );
      // 调用方已中断（崩溃/取消）：不结算 wake——让调度按原失败/重取路径处理；已提交目标由 stable
      // key 保护，恢复时不重放（规格 §8.2）。
      signal.throwIfAborted();
      if (outcome.kind !== "ran")
        return finish(parentBatch.source, {
          runId: runRef.current ?? "",
          status: "no_output" as const,
          outputs: [],
        });
      const delivered = new Set<string>();
      const failedTargets = new Map<string, string>();
      outcome.replyTasks.forEach((task, index) => {
        const entry = outcome.settled[index];
        const targetId = perTarget ? (task.targets[0]?.id ?? binding.peerId) : binding.peerId;
        const ok =
          entry?.status === "fulfilled" &&
          entry.value.outputs.some((output) => output.status === "prepared");
        if (ok) delivered.add(targetId);
        else
          failedTargets.set(
            targetId,
            entry?.status === "rejected"
              ? // 子 run 原因码原样上收，无码异常才落 AGENT_FAILED。
                ((entry.reason as { code?: string } | null | undefined)?.code ?? "AGENT_FAILED")
              : "AGENT_OUTPUT_FAILED",
          );
      });
      const covered = opportunities
        .filter((opportunity) => {
          const targetId = split ? (opportunity.participantId ?? "anonymous") : binding.peerId;
          return delivered.has(targetId);
        })
        .map((opportunity) => ({
          id: opportunity.wake.id,
          throughSeq: opportunity.wake.throughSeq,
        }));
      const ownTarget =
        binding.kind === "private" || !split
          ? binding.peerId
          : (focus?.participant?.id ?? "anonymous");
      const settleStatus = delivered.size > 0 ? ("completed" as const) : ("no_output" as const);
      db.transaction(() => {
        // 完整有效的批量判断消费本批冻结边界（含低分/静默），与 wake 终态同一事务落盘；
        // 协议/执行失败在 evaluateBatch 抛出，走原失败结算，不把未判断消息标成已判。
        if (path === "chiming_in")
          o.journal.advanceChimingInObservedSeq(conversation.id, wake.throughSeq);
        o.wakes.complete(
          wake.id,
          wake.leaseToken!,
          settleStatus,
          wake.throughSeq,
          now(),
          covered,
          failedTargets.get(ownTarget),
        );
      }).immediate();
      // 各 target 的事实取自它自己那条子 run（同 target 的 outbox owner）——模型可能对非本 child
      // 授权的目标给出草稿（runtime 标 AGENT_TARGET_UNAUTHORIZED），那不属于本目标事实。
      // 子 run 整体失败（无 prepared 输出即抛）时不带 outputs 回来，按该 child 的 target 记 failed 事实。
      const outputs: PreparedOutput[] = outcome.replyTasks.flatMap((task, index) => {
        const entry = outcome.settled[index];
        const own = new Set(task.targets.map((t) => t.id));
        if (entry?.status !== "fulfilled")
          return task.targets.map(
            (target): PreparedOutput => ({
              outputId: idempotentIntentId([
                conversation.id,
                wake.throughSeq,
                path,
                target.id,
                "failed",
              ]),
              targetId: target.id,
              status: "failed",
              code: "AGENT_FAILED",
            }),
          );
        return entry.value.outputs.filter((output) => own.has(output.targetId));
      });
      return finish(parentBatch.source, {
        runId: runRef.current ?? "",
        status: settleStatus,
        outputs,
      });
    }
    const direct = buildRun(undefined, spec, targets, authorizedTargets, decisionTier, runRef);
    const result = await direct.activateReply(true);
    return finish(direct.source, result);
  }
}
