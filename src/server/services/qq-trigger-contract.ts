// QQ path classification boundary (ADR0018 P3k). Pure facts, not a trigger scheduler.
// Conservative event-driven policy: only a real inbound event may start a non-idle path.
import { z } from "zod";
import type { QqSpeechKind } from "./qq-speaking-contract";

const Input = z.strictObject({
  conversationKind: z.enum(["group", "private"]),
  speaker: z.enum(["member", "anonymous", "system"]),
  mentionsSelf: z.boolean(),
  /** Separate scheduler has verified a timer candidate, not a fabricated chat event. */
  initiativePath: z.enum(["chiming_in", "idle_topic"]).optional(),
  /** A previous assistant utterance is followed by a real member message in this conversation. */
  followsAssistant: z.boolean().optional(),
});
export type QqTriggerClassification =
  | { readonly kind: "classified"; readonly path: QqSpeechKind }
  | { readonly kind: "candidate"; readonly path: "chiming_in" }
  | { readonly kind: "pending"; readonly reason: "not_classified" }
  | { readonly kind: "ignored"; readonly reason: "system_message" };

/** Only a direct address or a verified follow-up is classified; other group talk is a candidate. */
export function classifyQqTrigger(input: unknown): QqTriggerClassification {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ trigger contract input");
  const value = parsed.data;
  if (value.speaker === "system") return { kind: "ignored", reason: "system_message" };
  if (value.mentionsSelf && value.conversationKind === "group")
    return { kind: "classified", path: "direct_reply" };
  if (value.initiativePath !== undefined) return { kind: "classified", path: value.initiativePath };
  if (value.speaker !== "member") return { kind: "pending", reason: "not_classified" };
  if (value.conversationKind === "private" && !value.followsAssistant)
    return { kind: "classified", path: "direct_reply" };
  if (value.followsAssistant) return { kind: "classified", path: "follow_up" };
  return { kind: "candidate", path: "chiming_in" };
}
