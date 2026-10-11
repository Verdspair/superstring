import type { Database } from "bun:sqlite";
import {
  QqConversationTaskCauseSchema,
  type QqTaskExecutionSnapshot,
  qqConversationTaskKey,
  resolveQqEffectiveTaskLimits,
} from "../../../shared/contracts/qq-task";
import type { AgentRuntime } from "../../agent/agent-runtime";
import type { BuiltInAction } from "../../agent/built-in-actions";
import { sourceAccess } from "../../agent/context-access";
import type { ConversationHost } from "../../agent/conversation-host";
import type { AgentTaskService } from "../../agent/task-service";
import { observationRelevant } from "../../conversation/observation-relevance";
import { OutboundDelivery } from "../../conversation/outbound-delivery";
import { QqTaskScheduler } from "../../conversation/qq-task-scheduler";
import { WakeScheduler } from "../../conversation/wake-scheduler";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { OutboundIntentRepository, type OutboundTarget } from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { readQqDispatchSettings } from "../../db/qq-dispatch-repository";
import { readEffectiveQqScheme } from "../../db/qq-group-config-repository";
import type { QqSchemeRow } from "../../db/qq-scheme-repository";
import {
  effectiveQqTriggers,
  readQqScheme,
  schemeReply,
  schemeTaskLimits,
} from "../../db/qq-scheme-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import {
  createQqConversationTask,
  type QqConversationTaskIdentity,
  type QqConversationTaskSourceGuard,
} from "../../db/qq-task-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import { WakeRepository } from "../../db/wake-repository";
import type { ModelGateway } from "../../llm/model-gateway";
import type { ModuleQueryFactory, ModuleSourceResolver } from "../../modules/composition";
import type { RuntimeTelemetry } from "../../observability/runtime-telemetry";
import { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";
import { attentionTriggerFilter } from "../../services/qq-dispatch";
import type { QqMediaReadAdapter } from "../../services/qq-media-reader";
import type { QqMemberReadPort } from "../../services/qq-member-tools";
import { type QqSendPort, qqStickerFileReference } from "../../services/qq-send-transport";
import { qqStickerSelectionForScheme } from "../../services/qq-sticker-candidates";
import { qqStickerUsable } from "../../services/qq-sticker-contract";
import type { QqStickerStore } from "../../services/qq-sticker-store";
import { OneBot11Adapter } from "./adapter";
import { BotCompressionQueue } from "./background-compression";
import { type BotHostDiagnostic, OneBotHost } from "./bot-host";
import { qqDeliveryAuthorize } from "./delivery-authority";
import type { QqMediaInputService } from "./media-input-service";

export interface BotConversationPolicy {
  maxSteps: number;
  deliveryTtlSeconds: number;
  retryDelayMs: number;
  maxAttempts: number;
  /** 跨会话同时最多几条唤醒（会话内始终串行，由数据库租约保证）。 */
  globalConcurrency: number;
  /** 进程级模型调用并发：本地模型服务保持 1，登记的外部服务可调大。 */
  modelCallConcurrency: number;
}

export const DEFAULT_BOT_CONVERSATION_POLICY: BotConversationPolicy = {
  maxSteps: 16,
  // 出站等待发送的默认上限。600 秒让一次慢回复不再半路作废；已显式存过别的值的
  // 方案不受缺省变化影响，范围 10..3600 由既有契约与 DDL 约束。
  deliveryTtlSeconds: 600,
  retryDelayMs: 15_000,
  maxAttempts: 3,
  // 0.4.0 起默认允许跨会话并发：一条慢请求不再堵住别的群；模型调用仍由
  // `modelCallConcurrency` 单独封顶，所以本地单卡安装的实际模型流量与以前相同。
  globalConcurrency: 4,
  modelCallConcurrency: 1,
};

/** Production composition of protocol ingress, Agent activation and durable delivery. */
/**
 * BotHostDiagnostic → telemetry.record 形状的纯映射（B1）：宿主诊断一律落 bot.host.feedback
 * span；stage 按既有桶归类（media_mode 属 context 观测面，不新增业务枚举）。details 透传
 * 宿主 typed 字段并补 feedbackStatus/targetId —— runtime_spans.details 是 scalar record，
 * 数组须由宿主侧编码（见 bot-host emitMediaMode 的 omission:<n> 固定形状 JSON）。
 */
export function mapBotHostDiagnosticTelemetry(event: BotHostDiagnostic): {
  name: string;
  metadata: Parameters<RuntimeTelemetry["record"]>[1];
} {
  return {
    name: "bot.host.feedback",
    metadata: {
      channel: "onebot11" as const,
      stage:
        event.stage === "sticker"
          ? ("sticker" as const)
          : event.stage === "reconsider" || event.stage === "media_mode"
            ? ("context" as const)
            : event.stage === "output"
              ? ("delivery" as const)
              : ("action" as const),
      status:
        event.status === "chosen" || event.status === "selected"
          ? ("completed" as const)
          : event.status === "skipped" || event.status === "none"
            ? ("skipped" as const)
            : event.status === "model_error"
              ? ("failed" as const)
              : ["feedback", "pending", "capacity_unavailable", "capacity_exceeded"].includes(
                    event.status,
                  )
                ? ("deferred" as const)
                : ("observed" as const),
      code: event.code ?? "BOT_FEEDBACK",
      conversationId: event.conversationId,
      runId: event.runId,
      sourceSeq: event.sourceSeq,
      details: {
        ...event.details,
        feedbackStatus: event.status,
        targetId: event.targetId ?? null,
      },
    },
  };
}

export function createOneBotConversationRuntime(options: {
  orm: Orm;
  telemetry?: RuntimeTelemetry;
  db: Database;
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">;
  agentRuntime: AgentRuntime;
  host: ConversationHost;
  journal: ConversationEventRepository;
  store: QqStickerStore;
  port: QqSendPort;
  wake: () => void;
  /** 有效策略：函数形式＝每次读取（P7-c 执行配置）；缺省用内置初值。 */
  policy?: Partial<BotConversationPolicy> | (() => Partial<BotConversationPolicy>);
  modules?: ModuleQueryFactory;
  resolveSource?: ModuleSourceResolver;
  /** 外部（MCP）动作：每次唤醒现取；没有登记时返回空表。 */
  externalActions?: () => readonly BuiltInAction[];
  tasks?: AgentTaskService;
  stickersEnabled?: () => boolean;
  mediaEnabled?: () => boolean;
  memberTools?: {
    platform: QqMemberReadPort;
    enabled: () => boolean;
    policyRevision: () => string;
    sourceExpiresAt: () => string;
  };
  mediaAdapter?: (scheme: QqSchemeRow) => QqMediaReadAdapter;
  /** T11 B：同源组装的媒体准备服务（factory 产物，按方案取 prompt/节奏，与 mediaAdapter 同侧同形）；缺省＝不接自动图。 */
  mediaInputService?: (scheme: QqSchemeRow) => QqMediaInputService;
  /** 执行/权限配置保存成功（CAS 通过）后的通知：投递车道据此按新上限重新准入；缺省＝不订阅。 */
  onPolicyChange?: (listener: () => void) => () => void;
  /**
   * 一条唤醒结算（成功/失败/放弃）后的通知：宿主计时循环据此在**不阻塞本轮**的前提下
   * 复查别的会话 deadline。缺省＝不通知；它不是第二准入，不代替 `BotWorker.wake()`。
   */
  onWakeSettled?: () => void;
}) {
  const { orm, db, journal } = options;
  const policy = (): BotConversationPolicy => ({
    ...DEFAULT_BOT_CONVERSATION_POLICY,
    ...(typeof options.policy === "function" ? options.policy() : options.policy),
  });
  const wakes = new WakeRepository(db);
  const outbox = new OutboundIntentRepository(db);
  const adapter = new OneBot11Adapter({
    orm,
    journal,
    wakes,
    wake: options.wake,
    telemetry: options.telemetry,
    // 名额提示读同一个模型准入观察面：只回答"现在有没有空位"，不预留、不代替 acquire，
    // 名额状态仍只有 ModelPort 内部那一份。
    admission: options.agentRuntime.admission,
  });
  const compression = new BotCompressionQueue();
  // 本群能力停用集中由 guard 判定；投递与出站授权都按它复核，而不是各自读一遍配置。
  const guard = new QqGroupCapabilityGuard(orm);
  const taskEvents = (
    identity: Readonly<
      Pick<QqConversationTaskIdentity, "conversationId" | "sourceFromSeq" | "sourceThroughSeq">
    >,
  ) =>
    journal
      .eventsAfter(
        identity.conversationId,
        Math.max(0, identity.sourceFromSeq - 1),
        identity.sourceThroughSeq - identity.sourceFromSeq + 1,
      )
      .items.filter(
        (event) =>
          event.seq <= identity.sourceThroughSeq &&
          (event.kind === "inbound" ||
            event.kind === "outbound" ||
            event.kind === "media_revision"),
      );
  const taskSourceState: QqConversationTaskSourceGuard = (_transaction, identity) => {
    const conversation = journal.row(identity.conversationId);
    const binding = conversation ? readQqBinding(orm, conversation.source_id) : null;
    const scheme = binding ? readQqScheme(orm, binding.schemeId) : null;
    const agent = binding ? getAgentRow(orm, binding.agentId) : null;
    const settings = readQqSettings(orm);
    if (
      !conversation ||
      !binding ||
      !scheme ||
      !agent ||
      conversation.closed_at ||
      conversation.binding_epoch !== identity.bindingEpoch ||
      conversation.agent_id !== identity.agentId ||
      binding.agentId !== identity.agentId ||
      binding.paused ||
      agent.isActive !== 1 ||
      settings.enabled !== 1 ||
      settings.accountId !== binding.accountId ||
      !effectiveQqTriggers(binding, scheme)[identity.cause]
    )
      return "revoked";
    const events = taskEvents(identity);
    const focus = events.find((event) => event.seq === identity.sourceThroughSeq);
    if (!focus) return "revoked";
    const attention = attentionTriggerFilter(binding);
    if (
      identity.taskClass === "mention" &&
      attention &&
      (!focus.participant?.id || !attention.includes(focus.participant.id))
    )
      return "revoked";
    const at = new Date().toISOString();
    const owner = {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: agent.id,
    };
    const bindingOwner = {
      kind: "qq_binding" as const,
      id: binding.id,
      userId: DEFAULT_USER_ID,
      agentId: agent.id,
    };
    for (const event of events) {
      for (const source of event.sources) {
        // Event identity is checked through the journal; readable content has its own source guard.
        if (source.kind === "qq_event") continue;
        const state =
          guard.sourceAccess(source, bindingOwner) ??
          options.resolveSource?.(source, owner, at) ??
          sourceAccess(db, source, owner, { userId: DEFAULT_USER_ID }, at);
        if (state !== "available") return state === "expired" ? "expired" : "revoked";
      }
    }
    return "valid";
  };
  const host = new OneBotHost({
    ...options,
    taskSourceState,
    enqueueCompression: (job) => compression.enqueue(job),
    wakes,
    outbox,
    onDeliveryCommitted: (conversationId) => delivery.notifyCommitted(conversationId),
    stickers: {
      counts: ["confirmed"],
      isAvailable: (asset) => options.store.copyExists(asset.fileName),
    },
    policy,
    onDiagnostic(event) {
      const mapped = mapBotHostDiagnosticTelemetry(event);
      options.telemetry?.record(mapped.name, mapped.metadata);
    },
  });
  const delivery = new OutboundDelivery({
    orm,
    repository: outbox,
    telemetry: options.telemetry,
    journal,
    port: options.port,
    // 发送车道＝既有 QQ wake 并发资源（不是模型帽）：每次准入现读 policy()，调低后不再按旧值放行。
    deliveryConcurrency: () => policy().globalConcurrency,
    stickerFile: qqStickerFileReference(orm, options.store),
    stickerAvailable(stickerId, target, at) {
      const binding = readQqBinding(orm, target.bindingId);
      // 投递目标必须仍然是这条绑定本身：换绑、换群或换助手之后的旧素材不再放行。
      if (
        !binding ||
        binding.accountId !== target.accountId ||
        binding.kind !== target.conversationKind ||
        binding.peerId !== target.peerId ||
        binding.agentId !== target.agentId ||
        binding.schemeId !== target.schemeId
      )
        return false;
      // 本群停用「表情」后，已排队的素材发送也不得落地（停用即时生效，不只在下一轮）。
      if (
        !guard.allowed(
          { kind: "qq_binding", id: binding.id, userId: DEFAULT_USER_ID, agentId: binding.agentId },
          "stickers",
        )
      )
        return false;
      const selection = qqStickerSelectionForScheme(orm, {
        schemeId: binding.schemeId,
        // 显式带上本群绑定：生效素材集合与表情参数按本群差异读取，也不会被会话键查到的别的绑定带偏。
        binding,
        scope: {
          kind: "qq",
          accountId: binding.accountId,
          conversationKind: binding.kind,
          peerId: binding.peerId,
          agentId: binding.agentId,
        },
        counts: ["confirmed"],
        nowSeconds: Math.floor(Date.parse(at) / 1000),
        isAvailable: (asset) => options.store.copyExists(asset.fileName),
      });
      const candidate = selection.candidates.find((item) => item.id === stickerId);
      return (
        selection.maxStickerCount > 0 &&
        candidate !== undefined &&
        qqStickerUsable(candidate, { minRepeatSeconds: selection.minRepeatSeconds }).kind ===
          "usable"
      );
    },
    // 出站发送授权唯一判据（delivery-authority）：投递领取段与宿主在飞覆盖检查共用同一实现。
    authorize: qqDeliveryAuthorize({
      orm,
      db,
      journal,
      outbox,
      guard,
      resolveSource: options.resolveSource,
    }),
    onStale(intent) {
      const conversation = journal.get(intent.conversationId);
      const row = outbox.row(intent.id);
      if (!conversation || !row || journal.row(conversation.id)?.closed_at) return;
      // Bind recovery to actual input, never to the delivery revision just appended above.
      // A later unrelated group message cannot change either the intended recipient or freshness.
      const target = JSON.parse(row.target) as OutboundTarget;
      const source = journal
        .eventsAfter(conversation.id, 0, Number.MAX_SAFE_INTEGER)
        .items.filter((event) =>
          observationRelevant(event, {
            topology: conversation.topology,
            participantIds: [target.participantId ?? null],
            attentionMembers: target.attentionMembers,
          }),
        )
        .at(-1);
      if (!source) return;
      const recovered = wakes.enqueueChanged({
        conversationId: conversation.id,
        cause: row.speech_kind,
        throughSeq: source.seq,
        dedupeKey: `stale:${intent.id}`,
        readyAt: new Date().toISOString(),
        at: source.occurredAt,
        priority:
          row.speech_kind === "direct_reply" || row.speech_kind === "follow_up"
            ? 100
            : row.speech_kind === "chiming_in"
              ? 50
              : 0,
      });
      if (recovered.changed) {
        options.telemetry?.record("bot.wake.recovery", {
          channel: "onebot11",
          stage: "wake",
          status: "scheduled",
          code: "DELIVERY_STALE_REOBSERVE",
          conversationId: conversation.id,
          agentId: conversation.agentId,
          wakeId: recovered.wake.id,
          sourceSeq: source.seq,
          sources: source.sources,
          parent:
            options.telemetry.parentFor("output_id", intent.id) ??
            options.telemetry.parentFor("run_id", row.run_id) ??
            undefined,
          details: { outputId: intent.id, cause: row.speech_kind },
        });
        options.wake();
      }
    },
  });
  // 配置保存成功（CAS 通过）后唤醒投放车道按当前上限复核：调高立即 drain，无定时器轮询。
  // 与模型准入共用同一权限保存通知源；进程级长期订阅，无卸载生命周期。
  options.onPolicyChange?.(() => delivery.notifyPolicyChange());
  const intakeScheduler = new WakeScheduler({
    repository: wakes,
    telemetry: options.telemetry,
    // 唤醒失败以前只在唤醒记录里留一个码，控制台一声不响。这里补一行原因
    // （码在记录里、这里给错误名与消息），重置预算耗尽后不会再自动重试的那次尤其需要被看见。
    onError: (error, wake) => {
      const name = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message : String(error);
      const oneLine = message.replace(/\s+/g, " ").trim().slice(0, 300);
      console.warn(
        `[qq-wake] ${wake.cause} 唤醒失败（wake ${wake.id.slice(0, 8)}）：${name}: ${oneLine}`,
      );
    },
    policy: () => {
      const leaseMs = readQqDispatchSettings(orm).leaseSeconds * 1000;
      return {
        leaseMs,
        renewMs: Math.max(1, Math.floor(leaseMs / 3)),
        retryDelayMs: policy().retryDelayMs,
        maxAttempts: policy().maxAttempts,
        globalConcurrency: policy().globalConcurrency,
      };
    },
    onSettled: options.onWakeSettled,
    // 自主接话要真模型名额才能判：闸在领取前拦下它，被闸的机会保持 pending、不烧 attempts，
    // 名额释放时的通知让 worker 立刻复查，而不是等下一轮轮询。
    resourceGate: (wake) => {
      if (wake.cause !== "chiming_in") return true;
      // 判断模型与自主接话判定用的是同一个真源：设置里指定的判断模型，未指定则跟随该会话
      // 绑定助手的对话模型——与 adapter 判断「有没有名额」时取的是同一个值。
      const agentId = journal.get(wake.conversationId)?.agentId;
      const judgement =
        readQqSettings(orm).judgementModelName ??
        (agentId ? getAgentRow(orm, agentId)?.modelName : undefined);
      return options.agentRuntime.admission?.available(judgement ?? undefined) ?? true;
    },
    async activate(wake) {
      const conversation = journal.get(wake.conversationId);
      if (!conversation) throw new Error("BOT_CONVERSATION_REQUIRED");
      const mentionTask = db
        .query(`SELECT id FROM qq_conversation_tasks
        WHERE conversation_id=? AND task_class='mention' AND source_through_seq=? LIMIT 1`)
        .get(conversation.id, wake.throughSeq);
      if (mentionTask) {
        if (!wake.leaseToken) throw new Error("WAKE_LEASE_LOST");
        wakes.complete(
          wake.id,
          wake.leaseToken,
          "no_output",
          wake.throughSeq,
          new Date().toISOString(),
        );
        return;
      }
      const boundary = wakes.getSourceFromSeq(wake.id) ?? Math.max(0, wake.throughSeq - 1);
      createQqConversationTask(
        orm,
        {
          taskKey: qqConversationTaskKey.ordinary({
            conversationId: conversation.id,
            bindingEpoch: conversation.bindingEpoch,
            agentId: conversation.agentId,
            wakeId: wake.id,
          }),
          conversationId: conversation.id,
          bindingEpoch: conversation.bindingEpoch,
          agentId: conversation.agentId,
          taskClass: "ordinary",
          cause: QqConversationTaskCauseSchema.parse(wake.cause),
          sourceFromSeq: boundary + 1,
          sourceThroughSeq: wake.throughSeq,
          originWakeId: wake.id,
          wakeLeaseToken: wake.leaseToken ?? undefined,
          sourceExpiresAt:
            taskEvents({
              conversationId: conversation.id,
              sourceFromSeq: boundary + 1,
              sourceThroughSeq: wake.throughSeq,
            })
              .flatMap((event) => event.sources)
              .map((source) => source.expiresAt)
              .filter((at): at is string => at !== undefined)
              .sort()[0] ?? null,
          at: new Date().toISOString(),
        },
        { validateSource: taskSourceState },
      );
    },
  });
  const taskScheduler = new QqTaskScheduler({
    orm,
    telemetry: options.telemetry,
    traceParent(task) {
      const telemetry = options.telemetry;
      if (!telemetry) return undefined;
      if (task.originWakeId) {
        const intake = db
          .query(`SELECT trace_id,span_id FROM runtime_spans
            WHERE wake_id=? AND conversation_id=? AND source_seq=?
              AND name='bot.wake.activate' AND expires_at>?
            ORDER BY id DESC LIMIT 1`)
          .get(
            task.originWakeId,
            task.conversationId,
            task.sourceThroughSeq,
            new Date().toISOString(),
          ) as { trace_id: string; span_id: string } | null;
        return intake ? { traceId: intake.trace_id, spanId: intake.span_id } : undefined;
      }
      const focus = journal.eventsAfter(task.conversationId, task.sourceThroughSeq - 1, 1).items[0];
      if (
        !focus ||
        focus.seq !== task.sourceThroughSeq ||
        focus.source.kind !== "qq_event" ||
        focus.source.id !== task.originEventKey
      )
        return undefined;
      const ingress = db
        .query(`SELECT trace_id,span_id FROM runtime_spans
        WHERE conversation_id=? AND source_seq=? AND name='bot.ingress'
        ORDER BY id DESC LIMIT 1`)
        .get(task.conversationId, task.sourceThroughSeq) as {
        trace_id: string;
        span_id: string;
      } | null;
      return ingress ? { traceId: ingress.trace_id, spanId: ingress.span_id } : undefined;
    },
    policy: () => {
      const leaseMs = readQqDispatchSettings(orm).leaseSeconds * 1000;
      return { leaseMs, renewMs: Math.max(1, Math.floor(leaseMs / 3)) };
    },
    sourceState: taskSourceState,
    resourceGate(task) {
      if (task.cause !== "chiming_in" || task.judgementDone === 1) return true;
      const agentId = journal.row(task.conversationId)?.agent_id;
      const model =
        readQqSettings(orm).judgementModelName ??
        (agentId ? getAgentRow(orm, agentId)?.modelName : undefined);
      return options.agentRuntime.admission?.available(model ?? undefined) ?? true;
    },
    limitsFor(identity) {
      const conversation = journal.row(identity.conversationId);
      const binding = conversation ? readQqBinding(orm, conversation.source_id) : null;
      const scheme = binding ? readQqScheme(orm, binding.schemeId) : null;
      if (!binding || !scheme) throw new Error("BOT_CONFIGURATION_MISSING");
      return resolveQqEffectiveTaskLimits(schemeTaskLimits(scheme), binding.taskLimits);
    },
    freezeAtClaim(_transaction, task, limits): QqTaskExecutionSnapshot {
      const conversation = journal.row(task.conversationId);
      const binding = conversation ? readQqBinding(orm, conversation.source_id) : null;
      const scheme = binding ? readEffectiveQqScheme(orm, binding) : null;
      const agent = binding ? getAgentRow(orm, binding.agentId) : null;
      if (!conversation || !binding || !scheme || !agent)
        throw new Error("BOT_CONFIGURATION_MISSING");
      const events = taskEvents(task);
      const focus = events.find((event) => event.seq === task.sourceThroughSeq);
      const attention = attentionTriggerFilter(binding);
      const targets =
        binding.kind === "private"
          ? [{ targetId: binding.peerId, speakerId: binding.peerId }]
          : task.cause === "idle_topic" ||
              (task.cause !== "follow_up" && !schemeReply(scheme).split_by_speaker)
            ? [{ targetId: binding.peerId, speakerId: null }]
            : task.cause === "chiming_in"
              ? [
                  ...new Set(
                    events
                      .filter(
                        (event) =>
                          event.kind === "inbound" &&
                          event.participant?.role === "member" &&
                          (!attention || attention.includes(event.participant.id)),
                      )
                      .flatMap((event) => (event.participant ? [event.participant.id] : [])),
                  ),
                ].map((speakerId) => ({ targetId: speakerId, speakerId }))
              : focus?.participant
                ? [{ targetId: focus.participant.id, speakerId: focus.participant.id }]
                : [];
      return {
        accountId: binding.accountId,
        conversationId: conversation.id,
        bindingId: binding.id,
        bindingEpoch: conversation.binding_epoch,
        agentId: agent.id,
        schemeId: scheme.id,
        bindingRevision: binding.revision,
        authorityRevision: binding.authorityRevision,
        schemeRevision: scheme.revision,
        agentConfigVersion: agent.configVersion,
        taskClass: task.taskClass as QqTaskExecutionSnapshot["taskClass"],
        cause: task.cause as QqTaskExecutionSnapshot["cause"],
        sourceFromSeq: task.sourceFromSeq,
        sourceThroughSeq: task.sourceThroughSeq,
        sourceExpiresAt: task.sourceExpiresAt,
        taskKey: task.taskKey,
        authorizedTargets: targets.map((target) => target.targetId),
        targetParticipants: targets,
        maxSteps: policy().maxSteps,
        deliveryTtlSeconds: policy().deliveryTtlSeconds,
        mentionTaskLimit: limits.mentionTaskLimit,
        ordinaryTaskLimit: limits.ordinaryTaskLimit,
      };
    },
    async activate(task, snapshot, leaseToken, signal) {
      const result = await host.activateTask({ task, snapshot, leaseToken }, signal);
      if (result.status === "deferred") return result;
      await delivery.runOnce();
      return result.status === "expired"
        ? { status: "expired" as const }
        : result.status === "no_output"
          ? {
              status: "no_output" as const,
              ...("reason" in result ? { reason: result.reason } : {}),
            }
          : { status: "completed" as const };
    },
    resolveExistingRunAndOutbox(_transaction, task) {
      const intents = db
        .query(`SELECT i.status,i.target FROM outbound_intents i
        JOIN agent_runs r ON r.run_id=i.run_id
        WHERE i.conversation_id=? AND i.source_through_seq=? AND i.speech_kind=?
          AND r.conversation_id=i.conversation_id AND r.observed_seq=i.source_through_seq
          AND (i.run_id=? OR (? IS NOT NULL AND r.wake_id=?))`)
        .all(
          task.conversationId,
          task.sourceThroughSeq,
          task.cause,
          task.originRunId,
          task.originWakeId,
          task.originWakeId,
        ) as {
        status: string;
        target: string;
      }[];
      if (task.cause === "chiming_in" && task.judgementDone === 1 && task.originWakeId) {
        const judgement = db
          .query(`SELECT 1 FROM agent_runs r
          JOIN agent_steps s ON s.run_id=r.run_id JOIN context_snapshots c ON c.step_id=s.step_id
          WHERE r.wake_id=? AND r.conversation_id=? AND r.observed_seq=?
            AND r.spec_id='onebot.initiative.evaluate_batch' AND r.status='completed'
            AND r.owner_kind='qq_binding' AND r.owner_id=? AND r.agent_id=?
            AND s.status='completed' AND c.status='exact' AND c.output_recorded=1
            AND c.protected_output IS NOT NULL AND (c.expires_at IS NULL OR c.expires_at>?) LIMIT 1`)
          .get(
            task.originWakeId,
            task.conversationId,
            task.sourceThroughSeq,
            journal.get(task.conversationId)?.sourceId ?? null,
            task.agentId,
            new Date().toISOString(),
          );
        // The host reuses the protected judgement and skips every registered target, including unknown sends.
        return judgement ? "resume" : "failed";
      }
      if (intents.some((intent) => intent.status === "unknown" || intent.status === "sending"))
        return "failed";
      if (intents.length > 0) return "completed";
      if (!task.originRunId) return "resume";
      const run = db
        .query("SELECT status FROM agent_runs WHERE run_id=?")
        .get(task.originRunId) as { status: string } | null;
      return run?.status === "no_output" ? "no_output" : "failed";
    },
    onSettled: options.onWakeSettled,
    onError: () => console.warn("QQ task failed"),
  });
  const scheduler = {
    get activeCount() {
      return taskScheduler.activeCount;
    },
    nextReadyAt() {
      const deadlines = [intakeScheduler.nextReadyAt(), taskScheduler.nextReadyAt()].filter(
        (at): at is string => at !== null,
      );
      return deadlines.sort()[0] ?? null;
    },
    async dispatchOnce() {
      const handedOff = await intakeScheduler.runOnce();
      const claimed = await taskScheduler.dispatchOnce();
      return handedOff || claimed;
    },
    async runOnce() {
      const handedOff = await intakeScheduler.runOnce();
      const claimed = await taskScheduler.runOnce();
      return handedOff || claimed;
    },
    waitForIdle: () => taskScheduler.waitForIdle(),
    cancel: (taskId: string) => taskScheduler.cancel(taskId),
    stop() {
      intakeScheduler.stop();
      taskScheduler.stop();
    },
  };
  // 名额变化（有人占用或释放、上限被改写）时复查一次队列：自主接话被闸住的机会因此
  // 在空位出现的那一刻就能被领走，而不是等下一轮轮询。退订随本运行时一起交出，停机时释放。
  const releaseAdmission = options.agentRuntime.admission?.subscribe(() => options.wake?.());
  delivery.recover();
  delivery.housekeep();
  return {
    adapter,
    scheduler,
    delivery,
    outbox,
    compression,
    /** 停机收尾：退掉本运行时对模型名额的订阅，避免它活过 runtime 本身。 */
    release: () => releaseAdmission?.(),
  };
}
