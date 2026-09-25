import type { ConversationEvent } from "../../shared/contracts/conversation";
export interface ObservationAudience {
  topology: "direct" | "shared";
  participantIds: readonly (string | null)[];
  attentionMembers?: readonly string[];
}
/** Shared by draft checkpoints and delivery. An addressed message can change the whole plan. */
export function observationRelevant(
  event: ConversationEvent,
  audience: ObservationAudience,
): boolean {
  if (event.kind !== "inbound" && event.kind !== "media_revision") return false;
  const speaker = event.participant?.id;
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
