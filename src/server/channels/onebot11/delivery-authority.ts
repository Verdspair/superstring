import type { Database } from "bun:sqlite";
import type { Delivery } from "../../../shared/contracts/conversation";
import { QqTaskExecutionSnapshotSchema } from "../../../shared/contracts/qq-task";
import { sourceAccess } from "../../agent/context-access";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import type { OutboundIntentRepository, OutboundTarget } from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { readEffectiveQqScheme } from "../../db/qq-group-config-repository";
import { readQqOwnerIdentity } from "../../db/qq-owner-repository";
import { effectiveQqTriggers } from "../../db/qq-scheme-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import { type ModuleSourceResolver, resolveSourceStates } from "../../modules/composition";
import type { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";

export type DeliveryAuthorityDeps = {
  orm: Orm;
  db: Database;
  journal: ConversationEventRepository;
  outbox: OutboundIntentRepository;
  guard: QqGroupCapabilityGuard;
  resolveSource?: ModuleSourceResolver;
};

/**
 * 出站发送授权的唯一判据：投递领取段与宿主「在飞覆盖」检查共用同一实现，绑定/方案/助手/
 * owner/来源授权变化都按当前状态现读；检查是纯读，不改动旧意图状态。
 */
export function qqDeliveryAuthorize(deps: DeliveryAuthorityDeps) {
  const { orm, db, journal, outbox, guard, resolveSource } = deps;
  return (target: OutboundTarget, intent: Delivery): boolean => {
    const binding = readQqBinding(orm, target.bindingId);
    const conversation = journal.get(intent.conversationId);
    const settings = readQqSettings(orm);
    // 投递授权按本群生效方案复核（含本群差异）：方案被本群收紧后，旧投递不得按基础方案照发。
    const scheme = binding ? readEffectiveQqScheme(orm, binding) : null;
    const agent = getAgentRow(orm, target.agentId);
    const row = outbox.row(intent.id);
    if (!binding || !conversation || !scheme || !agent || !row) return false;
    const frozenTask = target.qqTaskId
      ? (db
          .query(`SELECT id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
              source_from_seq,source_through_seq,source_expires_at,origin_wake_id,origin_run_id,status,execution_snapshot
            FROM qq_conversation_tasks WHERE id=?`)
          .get(target.qqTaskId) as {
          id: string;
          task_key: string;
          conversation_id: string;
          binding_epoch: number;
          agent_id: string;
          task_class: string;
          cause: string;
          source_from_seq: number;
          source_through_seq: number;
          source_expires_at: string | null;
          origin_wake_id: string | null;
          origin_run_id: string | null;
          status: string;
          execution_snapshot: string | null;
        } | null)
      : null;
    let frozenTaskConfigValid = false;
    let frozenTaskHasSchemeConfig = false;
    if (
      target.qqTaskId &&
      frozenTask &&
      frozenTask.id === target.qqTaskId &&
      frozenTask.conversation_id === intent.conversationId &&
      frozenTask.binding_epoch === target.bindingEpoch &&
      frozenTask.agent_id === target.agentId &&
      frozenTask.source_through_seq === row.source_through_seq &&
      frozenTask.cause === row.speech_kind &&
      frozenTask.execution_snapshot
    ) {
      try {
        const taskSnapshot = QqTaskExecutionSnapshotSchema.parse(
          JSON.parse(frozenTask.execution_snapshot),
        );
        const runIdentity = `SELECT conversation_id,observed_seq,wake_id,owner_kind,
          owner_id,user_id,agent_id FROM agent_runs WHERE run_id=?`;
        const taskRun = db.query(runIdentity).get(intent.runId) as {
          conversation_id: string | null;
          observed_seq: number | null;
          wake_id: string | null;
          owner_kind: string;
          owner_id: string;
          user_id: string | null;
          agent_id: string | null;
        } | null;
        const taskOwnerRun = frozenTask.origin_run_id
          ? (db.query(runIdentity).get(frozenTask.origin_run_id) as typeof taskRun)
          : null;
        const observedThroughSeq = target.observedThroughSeq ?? row.source_through_seq;
        if (
          !Number.isSafeInteger(observedThroughSeq) ||
          observedThroughSeq < row.source_through_seq
        )
          return false;
        const destination = target.participantId ?? target.peerId;
        const expectedSpeakerId =
          target.conversationKind === "private" ? target.peerId : (target.participantId ?? null);
        frozenTaskHasSchemeConfig = taskSnapshot.schemeConfig !== undefined;
        frozenTaskConfigValid =
          taskSnapshot.taskKey === frozenTask.task_key &&
          taskSnapshot.conversationId === frozenTask.conversation_id &&
          taskSnapshot.bindingEpoch === frozenTask.binding_epoch &&
          taskSnapshot.agentId === frozenTask.agent_id &&
          taskSnapshot.taskClass === frozenTask.task_class &&
          taskSnapshot.cause === frozenTask.cause &&
          taskSnapshot.sourceFromSeq === frozenTask.source_from_seq &&
          taskSnapshot.sourceThroughSeq === frozenTask.source_through_seq &&
          taskSnapshot.sourceExpiresAt === frozenTask.source_expires_at &&
          taskSnapshot.accountId === target.accountId &&
          taskSnapshot.bindingId === target.bindingId &&
          taskSnapshot.bindingRevision === target.bindingRevision &&
          taskSnapshot.authorityRevision === target.authorityRevision &&
          taskSnapshot.schemeId === target.schemeId &&
          taskSnapshot.schemeRevision === target.schemeRevision &&
          taskSnapshot.agentConfigVersion === target.agentConfigVersion &&
          taskSnapshot.authorizedTargets.includes(destination) &&
          taskSnapshot.targetParticipants.some(
            (participant) =>
              participant.targetId === destination && participant.speakerId === expectedSpeakerId,
          ) &&
          taskRun?.conversation_id === frozenTask.conversation_id &&
          taskRun.observed_seq === observedThroughSeq &&
          taskRun.wake_id === frozenTask.origin_wake_id &&
          taskRun.owner_kind === "conversation" &&
          taskRun.owner_id === frozenTask.conversation_id &&
          taskRun.user_id === DEFAULT_USER_ID &&
          taskRun.agent_id === frozenTask.agent_id &&
          (frozenTask.origin_run_id === intent.runId ||
            ((frozenTask.cause === "chiming_in" || frozenTask.cause === "idle_topic") &&
              taskOwnerRun !== null &&
              taskOwnerRun.conversation_id === frozenTask.conversation_id &&
              taskOwnerRun.observed_seq !== null &&
              taskOwnerRun.observed_seq >= frozenTask.source_through_seq &&
              taskOwnerRun.observed_seq <= observedThroughSeq &&
              taskOwnerRun.wake_id === frozenTask.origin_wake_id &&
              taskOwnerRun.owner_kind === "conversation" &&
              taskOwnerRun.owner_id === frozenTask.conversation_id &&
              taskOwnerRun.user_id === DEFAULT_USER_ID &&
              taskOwnerRun.agent_id === frozenTask.agent_id &&
              intent.runId !== frozenTask.origin_run_id)) &&
          (!taskSnapshot.schemeConfig ||
            (taskSnapshot.schemeConfig.id === target.schemeId &&
              taskSnapshot.schemeConfig.revision === target.schemeRevision));
      } catch {
        frozenTaskConfigValid = false;
      }
    }
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
      (target.qqTaskId
        ? !frozenTaskConfigValid ||
          (!frozenTaskHasSchemeConfig && scheme.revision !== target.schemeRevision)
        : scheme.revision !== target.schemeRevision) ||
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
      kind: "qq_binding" as const,
      id: binding.id,
      userId: DEFAULT_USER_ID,
      agentId: target.agentId,
    };
    const resolve: ModuleSourceResolver = (source) =>
      guard.sourceAccess(source, bindingOwner) ??
      resolveSource?.(source, conversationOwner, new Date().toISOString()) ??
      sourceAccess(
        db,
        source,
        conversationOwner,
        { userId: DEFAULT_USER_ID },
        new Date().toISOString(),
      );
    resolve.resolveMany = resolveSource?.resolveMany;
    for (const access of resolveSourceStates(
      target.sources ?? [],
      resolve,
      conversationOwner,
      new Date().toISOString(),
    ))
      if (access !== "available") return false;
    return true;
  };
}
