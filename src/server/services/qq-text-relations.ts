// hiddenwhy：过期事实整体跳过（失效不供私文），unavailable 只留最少稳定状态；纯投影不查 scope，宿主负责。

import type { SourceRef } from "../../shared/contracts/evidence";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessagePart,
} from "../../shared/contracts/qq-message";
import { uniqueSources } from "./source-refs";

type QqTextRelationSpeaker = {
  role: "member" | "anonymous" | "assistant";
  qq: string | null;
  groupCard: string | null;
  personalNickname: string | null;
  legacyDisplayName: string | null;
  nameState: "known" | "unknown" | "legacy";
};

type QqTextRelationPart =
  | { kind: "text"; text: string }
  | { kind: "mention"; qq: string | "all" }
  | { kind: "face"; id: string; name: string | null }
  | { kind: "image"; mediaId: string; category: "ordinary" | "expression" | "unknown" }
  | { kind: "unavailable"; type: string };

function projectSpeaker(
  factUnavailable: boolean,
  speaker: QqMessageFact["speaker"],
): QqTextRelationSpeaker {
  if (factUnavailable) {
    return {
      role: speaker.role,
      qq: null,
      groupCard: null,
      personalNickname: null,
      legacyDisplayName: null,
      nameState: speaker.nameState === "known" ? "unknown" : speaker.nameState,
    };
  }
  return {
    role: speaker.role,
    qq: speaker.qq,
    groupCard: speaker.groupCard,
    personalNickname: speaker.personalNickname,
    legacyDisplayName: speaker.legacyDisplayName,
    nameState: speaker.nameState,
  };
}

function projectPart(part: QqMessagePart): QqTextRelationPart {
  switch (part.kind) {
    case "text":
      return { kind: "text", text: part.text };
    case "mention":
      return { kind: "mention", qq: part.qq };
    case "face":
      return { kind: "face", id: part.id, name: part.name };
    case "image":
      return { kind: "image", mediaId: part.mediaId, category: part.category };
    case "unavailable":
      return { kind: "unavailable", type: part.type };
  }
}

function isFactExpired(fact: QqMessageFact, now: string): boolean {
  const nowMs = Date.parse(now);
  return fact.sources.some((s) => {
    if (!s.expiresAt) return false;
    return Date.parse(s.expiresAt) <= nowMs;
  });
}

export function projectQqTextRelations(input: {
  facts: readonly QqMessageFact[];
  scope: QqConversationScope;
  now: string;
}): { records: Array<Record<string, unknown>>; sources: SourceRef[] } {
  const records: Array<Record<string, unknown>> = [];
  const collected: SourceRef[] = [];

  for (const fact of input.facts) {
    if (isFactExpired(fact, input.now)) continue;
    const unavailable = fact.completeness === "unavailable";

    records.push({
      id: fact.id,
      platformMessageId: fact.platformMessageId,
      seq: fact.seq,
      occurredAtSeconds: fact.occurredAtSeconds,
      completeness: fact.completeness,
      speaker: projectSpeaker(unavailable, fact.speaker),
      currentName:
        !unavailable && fact.speaker.currentName
          ? {
              groupCard: fact.speaker.currentName.groupCard,
              personalNickname: fact.speaker.currentName.personalNickname,
            }
          : null,
      parts: unavailable
        ? [{ kind: "unavailable" as const, type: "text" }]
        : fact.parts.map(projectPart),
      mentions: unavailable
        ? []
        : fact.mentions.map((m) => ({
            qq: m.qq,
            identity: m.identity ? projectSpeaker(false, m.identity) : null,
          })),
      replyTo: unavailable
        ? null
        : fact.replyTo
          ? { platformMessageId: fact.replyTo.platformMessageId }
          : null,
    });

    collected.push(...fact.sources);
  }

  return { records, sources: uniqueSources(collected) };
}
