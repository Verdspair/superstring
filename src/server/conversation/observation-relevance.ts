import type { ConversationEvent } from "../../shared/contracts/conversation";
import type { SourceRef } from "../../shared/contracts/evidence";

/** 与 `speech_kind` 同名字面量；缺省=原群/直聊语义。 */
export type ObservationPurpose = "direct_reply" | "follow_up" | "chiming_in" | "idle_topic";

export interface ObservationAudience {
  topology: "direct" | "shared";
  participantIds: readonly (string | null)[];
  attentionMembers?: readonly string[];
  /**
   * 本批目的。群内自主接话（`chiming_in`）的批次范围在冻结时已定：此后到达的
   * 普通群消息归下一批，不作废已准备输出；其余目的仍按原 mention/回复/说话人判据。
   */
  purpose?: ObservationPurpose;
  /**
   * 本批真正读入的来源（Outbox 的 `target.sources` 与宿主的 source.sources 同一入口）。
   * 只在群内自主接话分支用于识别**已用内容的修订**，不参与其它判据。
   */
  usedSources?: readonly SourceRef[];
}

const sourceKey = (ref: SourceRef) => `${ref.kind}:${ref.id}`;

/**
 * Shared by draft checkpoints and delivery. An addressed message can change the whole plan.
 *
 * 自主接话路径先于原判据：群内普通消息与本批无关（归下一批），只有**已用来源的修订事件**
 * 才使本批失效。来源匹配只认修订事件本身，不回溯同 ID 的旧入站重放，也不代表来源授权。
 */
export function observationRelevant(
  event: ConversationEvent,
  audience: ObservationAudience,
): boolean {
  if (event.kind !== "inbound" && event.kind !== "media_revision") return false;
  const speaker = event.participant?.id;
  if (audience.topology === "shared" && audience.purpose === "chiming_in") {
    if (event.kind !== "media_revision") return false;
    const used = new Set((audience.usedSources ?? []).map(sourceKey));
    return used.size > 0 && event.sources.some((ref) => used.has(sourceKey(ref)));
  }
  if (audience.attentionMembers && (!speaker || !audience.attentionMembers.includes(speaker)))
    return false;
  if (audience.topology === "direct") return true;
  if (
    event.addressing.reasons.some((reason) => reason === "mention" || reason === "reply_to_agent")
  )
    return true;
  return (
    audience.participantIds.includes(null) ||
    (!!speaker && audience.participantIds.includes(speaker))
  );
}
