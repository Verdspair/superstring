// Plans a prepared QQ reply from its selected sticker and the current binding and library facts.
// Transport and delivery are owned by the host and outbound-delivery path.

import { readQqBinding } from "../db/qq-binding-repository";
import { readQqGroupAgentConfig } from "../db/qq-group-config-repository";
import { readQqScheme } from "../db/qq-scheme-repository";
import type { QqStickerAssetView } from "../db/qq-sticker-repository";
import type { Orm } from "../db/repositories";
import type { QqBinding } from "./qq-binding-contract";
import type { QqSendPartResult } from "./qq-output-contract";
import { planQqOutput, type QqOutputPlan } from "./qq-output-plan";
import type { QqPreparedReply } from "./qq-prepared-reply";
import { qqStickerSelectionForScheme } from "./qq-sticker-candidates";

/**
 * What the two entry points need about the library, as two caller-supplied seams.
 *
 * Both are required rather than defaulted: the copy store owns availability (§8.1-5 says the
 * file must be usable now, which only the store can answer), and U13 owns `counts`.
 */
export interface QqStickerStage {
  readonly counts: readonly QqSendPartResult[];
  readonly isAvailable: (asset: QqStickerAssetView) => boolean;
}

function groupStickersDisabled(orm: Orm, binding: QqBinding): boolean {
  return readQqGroupAgentConfig(orm, binding).disabled_capabilities.includes("stickers");
}

export function planQqPreparedReply(
  orm: Orm,
  prepared: QqPreparedReply,
  stage: QqStickerStage,
): QqOutputPlan {
  const pick = prepared.stickerId ?? null;
  const binding = readQqBinding(orm, prepared.snapshot.bindingId);
  const scheme = readQqScheme(orm, prepared.snapshot.schemeId);
  if (
    pick === null ||
    binding === null ||
    // 换绑后草稿的本群作用域已经变了：不再按新绑定重新解释，降级为纯文字。
    binding.schemeId !== prepared.snapshot.schemeId ||
    scheme === null ||
    scheme.revision !== prepared.schemeRevision ||
    // 本群停用后的显式 stickerIds 与"选中的素材已经不可用"同一条语义：降级为纯文字，绝不照发。
    groupStickersDisabled(orm, binding)
  ) {
    return planQqOutput({
      text: prepared.text,
      requestedStickers: 0,
      maxStickerCount: 1,
      candidates: [],
      minRepeatSeconds: null,
      avoidRecent: false,
      mentions: prepared.mentionIds,
      replyToMessageId: prepared.replyToMessageId,
    });
  }
  const selection = qqStickerSelectionForScheme(orm, {
    schemeId: scheme.id,
    // 显式带上本群绑定：复验的那张素材按本群生效集合与参数判定，而不是按基础方案。
    binding,
    scope: {
      kind: "qq",
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    },
    counts: stage.counts,
    nowSeconds: prepared.nowSeconds,
    isAvailable: stage.isAvailable,
  });
  const candidate = selection.candidates.find((entry) => entry.id === pick);
  return planQqOutput({
    text: prepared.text,
    // §8.1-4's ceiling is re-applied from the scheme; the model asked for exactly one.
    requestedStickers: 1,
    maxStickerCount: selection.maxStickerCount,
    candidates: candidate === undefined ? [] : [candidate],
    minRepeatSeconds: selection.minRepeatSeconds,
    avoidRecent: selection.avoidRecent,
    mentions: prepared.mentionIds,
    replyToMessageId: prepared.replyToMessageId,
  });
}
