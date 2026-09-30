import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../agent/agent-runtime";
import type { BuiltInAction } from "../../agent/built-in-actions";
import { sourceAccess } from "../../agent/context-access";
import type { ConversationHost } from "../../agent/conversation-host";
import type { AgentTaskService } from "../../agent/task-service";
import { observationRelevant } from "../../conversation/observation-relevance";
import { OutboundDelivery } from "../../conversation/outbound-delivery";
import { WakeScheduler } from "../../conversation/wake-scheduler";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { OutboundIntentRepository, type OutboundTarget } from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { readQqDispatchSettings } from "../../db/qq-dispatch-repository";
import { readEffectiveQqScheme } from "../../db/qq-group-config-repository";
import { readQqOwnerIdentity } from "../../db/qq-owner-repository";
import { effectiveQqTriggers, type QqSchemeRow } from "../../db/qq-scheme-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import { WakeRepository } from "../../db/wake-repository";
import type { ModelGateway } from "../../llm/model-gateway";
import type { ModuleQueryFactory, ModuleSourceResolver } from "../../modules/composition";
import type { RuntimeTelemetry } from "../../observability/runtime-telemetry";
import { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";
import type { QqMediaReadAdapter } from "../../services/qq-media-reader";
import { type QqSendPort, qqStickerFileReference } from "../../services/qq-send-transport";
import { qqStickerSelectionForScheme } from "../../services/qq-sticker-candidates";
import { qqStickerUsable } from "../../services/qq-sticker-contract";
import type { QqStickerStore } from "../../services/qq-sticker-store";
import { OneBot11Adapter } from "./adapter";
import { BotCompressionQueue } from "./background-compression";
import { OneBotHost } from "./bot-host";

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
  deliveryTtlSeconds: 120,
  retryDelayMs: 15_000,
  maxAttempts: 3,
  // 0.4.0 起默认允许跨会话并发：一条慢请求不再堵住别的群；模型调用仍由
  // `modelCallConcurrency` 单独封顶，所以本地单卡安装的实际模型流量与以前相同。
  globalConcurrency: 4,
  modelCallConcurrency: 1,
};

/** Production composition of protocol ingress, Agent activation and durable delivery. */
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
  mediaAdapter?: (scheme: QqSchemeRow) => QqMediaReadAdapter;
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
  });
  const compression = new BotCompressionQueue();
  // 本群能力停用集中由 guard 判定；投递与出站授权都按它复核，而不是各自读一遍配置。
  const guard = new QqGroupCapabilityGuard(orm);
  const host = new OneBotHost({
    ...options,
    enqueueCompression: (job) => compression.enqueue(job),
    wakes,
    outbox,
    stickers: {
      counts: ["confirmed"],
      isAvailable: (asset) => options.store.copyExists(asset.fileName),
    },
    policy,
    onDiagnostic(event) {
      options.telemetry?.record("bot.host.feedback", {
        channel: "onebot11",
        stage:
          event.stage === "sticker"
            ? "sticker"
            : event.stage === "reconsider"
              ? "context"
              : event.stage === "output"
                ? "delivery"
                : "action",
        status:
          event.status === "chosen" || event.status === "selected"
            ? "completed"
            : event.status === "skipped" || event.status === "none"
              ? "skipped"
              : event.status === "model_error"
                ? "failed"
                : ["feedback", "pending", "capacity_unavailable", "capacity_exceeded"].includes(
                      event.status,
                    )
                  ? "deferred"
                  : "observed",
        code: event.code ?? "BOT_FEEDBACK",
        conversationId: event.conversationId,
        runId: event.runId,
        sourceSeq: event.sourceSeq,
        details: {
          ...event.details,
          feedbackStatus: event.status,
          targetId: event.targetId ?? null,
        },
      });
    },
  });
  const delivery = new OutboundDelivery({
    orm,
    repository: outbox,
    telemetry: options.telemetry,
    journal,
    port: options.port,
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
    authorize(target, intent) {
      const binding = readQqBinding(orm, target.bindingId);
      const conversation = journal.get(intent.conversationId);
      const settings = readQqSettings(orm);
      // 投递授权按本群生效方案复核（含本群差异）：方案被本群收紧后，旧投递不得按基础方案照发。
      const scheme = binding ? readEffectiveQqScheme(orm, binding) : null;
      const agent = getAgentRow(orm, target.agentId);
      const row = outbox.row(intent.id);
      if (!binding || !conversation || !scheme || !agent || !row) return false;
      if (
        settings.enabled !== 1 ||
        settings.accountId !== target.accountId ||
        binding.paused ||
        binding.accountId !== target.accountId ||
        binding.kind !== target.conversationKind ||
        binding.peerId !== target.peerId ||
        binding.agentId !== target.agentId ||
        conversation.bindingEpoch !== target.bindingEpoch ||
        journal.row(conversation.id)?.closed_at ||
        binding.revision !== target.bindingRevision ||
        binding.authorityRevision !== target.authorityRevision ||
        binding.schemeId !== target.schemeId ||
        scheme.revision !== target.schemeRevision ||
        agent.isActive !== 1 ||
        agent.configVersion !== target.agentConfigVersion ||
        (readQqOwnerIdentity(orm)?.revision ?? null) !== (target.ownerIdentityRevision ?? null) ||
        !effectiveQqTriggers(binding, scheme)[row.speech_kind]
      )
        return false;
      const conversationOwner = {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: target.agentId,
      };
      // 本群作用域以绑定为准（会话所有者是另一回事）：能力停用与群内来源撤权都按它复核。
      const bindingOwner = {
        kind: "qq_binding",
        id: binding.id,
        userId: DEFAULT_USER_ID,
        agentId: target.agentId,
      };
      // 本群停用能力即时生效：停用「表情」后，本次投递里的素材部件不再放行；纯文字部分照旧。
      if (
        intent.parts.some((part) => part.kind === "sticker") &&
        !guard.allowed(bindingOwner, "stickers")
      )
        return false;
      return (target.sources ?? []).every((source) => {
        // 本群能力引用以 guard 为准：它判定的结果不得被任何外部解析器翻回可用（撤权不可覆盖）。
        const access = guard.sourceAccess(source, bindingOwner);
        if (access !== undefined) return access === "available";
        // 其余来源种类沿用原有解析路径：外部注入的解析器优先，其次中央授权表。
        return (
          (options.resolveSource?.(source, conversationOwner, new Date().toISOString()) ??
            sourceAccess(
              db,
              source,
              conversationOwner,
              { userId: DEFAULT_USER_ID },
              new Date().toISOString(),
            )) === "available"
        );
      });
    },
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
  const scheduler = new WakeScheduler({
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
    async activate(wake, signal) {
      const result = await host.activate(wake, signal);
      await delivery.runOnce();
      return result;
    },
  });
  delivery.recover();
  delivery.housekeep();
  return { adapter, scheduler, delivery, outbox, compression };
}
