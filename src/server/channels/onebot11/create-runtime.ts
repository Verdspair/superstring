import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../../agent/agent-runtime";
import { sourceAccess } from "../../agent/context-access";
import type { ConversationHost } from "../../agent/conversation-host";
import { OutboundDelivery } from "../../conversation/outbound-delivery";
import { WakeScheduler } from "../../conversation/wake-scheduler";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import { OutboundIntentRepository } from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { readQqDispatchSettings } from "../../db/qq-dispatch-repository";
import { readQqOwnerIdentity } from "../../db/qq-owner-repository";
import { effectiveQqTriggers, readQqScheme } from "../../db/qq-scheme-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import { WakeRepository } from "../../db/wake-repository";
import type { ModelGateway } from "../../llm/model-gateway";
import { QQ_OBSERVATION_RETENTION_DAYS } from "../../services/qq-retention";
import { type QqSendPort, qqStickerFileReference } from "../../services/qq-send-transport";
import { qqStickerSelectionForScheme } from "../../services/qq-sticker-candidates";
import { qqStickerUsable } from "../../services/qq-sticker-contract";
import type { QqStickerStore } from "../../services/qq-sticker-store";
import { OneBot11Adapter } from "./adapter";
import { OneBotPrivateHost } from "./private-host";

export interface BotConversationPolicy {
  maxSteps: number;
  deliveryTtlSeconds: number;
  retentionDays: number;
  retryDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_BOT_CONVERSATION_POLICY: BotConversationPolicy = {
  maxSteps: 16,
  deliveryTtlSeconds: 120,
  retentionDays: QQ_OBSERVATION_RETENTION_DAYS,
  retryDelayMs: 15_000,
  maxAttempts: 3,
};

/** Production composition of protocol ingress, Agent activation and durable delivery. */
export function createOneBotConversationRuntime(options: {
  orm: Orm;
  db: Database;
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">;
  agentRuntime: AgentRuntime;
  host: ConversationHost;
  journal: ConversationEventRepository;
  store: QqStickerStore;
  port: QqSendPort;
  wake: () => void;
  policy?: Partial<BotConversationPolicy>;
}) {
  const { orm, db, journal } = options;
  const policy = { ...DEFAULT_BOT_CONVERSATION_POLICY, ...options.policy };
  const wakes = new WakeRepository(db);
  const outbox = new OutboundIntentRepository(db);
  const adapter = new OneBot11Adapter({ orm, journal, wakes, wake: options.wake });
  const host = new OneBotPrivateHost({
    ...options,
    wakes,
    outbox,
    stickers: {
      counts: ["confirmed"],
      isAvailable: (asset) => options.store.copyExists(asset.fileName),
    },
    policy: () => policy,
  });
  const delivery = new OutboundDelivery({
    orm,
    repository: outbox,
    journal,
    port: options.port,
    stickerFile: qqStickerFileReference(orm, options.store),
    stickerAvailable(stickerId, target, at) {
      const binding = readQqBinding(orm, target.bindingId);
      if (!binding) return false;
      const selection = qqStickerSelectionForScheme(orm, {
        schemeId: binding.schemeId,
        scope: {
          kind: "qq",
          accountId: target.accountId,
          conversationKind: target.conversationKind,
          peerId: target.peerId,
          agentId: target.agentId,
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
      const scheme = binding ? readQqScheme(orm, binding.schemeId) : null;
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
      const owner = {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: target.agentId,
      };
      return (target.sources ?? []).every(
        (source) =>
          sourceAccess(db, source, owner, { userId: DEFAULT_USER_ID }, new Date().toISOString()) ===
          "available",
      );
    },
    onStale(intent) {
      const conversation = journal.get(intent.conversationId);
      const row = outbox.row(intent.id);
      if (!conversation || !row || journal.row(conversation.id)?.closed_at) return;
      // A stale plan is never resent. The Agent gets a fresh opportunity to inspect current facts.
      wakes.enqueue({
        conversationId: conversation.id,
        cause: row.speech_kind,
        throughSeq: conversation.lastSeq,
        dedupeKey: `stale:${intent.id}`,
        readyAt: new Date().toISOString(),
        priority: row.speech_kind === "direct_reply" ? 100 : 0,
      });
      options.wake();
    },
  });
  const scheduler = new WakeScheduler({
    repository: wakes,
    policy: () => {
      const leaseMs = readQqDispatchSettings(orm).leaseSeconds * 1000;
      return {
        leaseMs,
        renewMs: Math.max(1, Math.floor(leaseMs / 3)),
        retryDelayMs: policy.retryDelayMs,
        maxAttempts: policy.maxAttempts,
      };
    },
    async activate(wake, signal) {
      await host.activate(wake, signal);
      await delivery.runOnce();
    },
  });
  delivery.recover();
  delivery.housekeep();
  return { adapter, scheduler, delivery, outbox };
}
