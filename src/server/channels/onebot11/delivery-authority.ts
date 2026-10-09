import type { Database } from "bun:sqlite";
import type { Delivery } from "../../../shared/contracts/conversation";
import { sourceAccess } from "../../agent/context-access";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import type { OutboundIntentRepository, OutboundTarget } from "../../db/outbound-intent-repository";
import { readQqBinding } from "../../db/qq-binding-repository";
import { readEffectiveQqScheme } from "../../db/qq-group-config-repository";
import { readQqOwnerIdentity } from "../../db/qq-owner-repository";
import { effectiveQqTriggers } from "../../db/qq-scheme-repository";
import { readQqSettings } from "../../db/qq-settings-repository";
import { DEFAULT_USER_ID, getAgentRow, type Orm } from "../../db/repositories";
import type { ModuleSourceResolver } from "../../modules/composition";
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
      kind: "qq_binding" as const,
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
        (resolveSource?.(source, conversationOwner, new Date().toISOString()) ??
          sourceAccess(
            db,
            source,
            conversationOwner,
            { userId: DEFAULT_USER_ID },
            new Date().toISOString(),
          )) === "available"
      );
    });
  };
}
