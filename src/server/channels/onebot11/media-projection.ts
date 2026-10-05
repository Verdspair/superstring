// QQ 媒体候选纯选择（规格 §7.1/§7.5）：无 IO，显式入参 capabilityEnabled/detailMediaIds；
// 自动范围 = 本轮应回应目标 + 从这些目标发出的 depth1 直接根（from 必须是存在且有效的
// focus 事实），失效事实不选，所有输出对 facts 置换稳定。

import type {
  QqEffectiveMediaPolicy,
  QqImageCategory,
  QqImagePhase,
} from "../../../shared/contracts/qq-media-input";
import type { QqMessageFact, QqMessagePart } from "../../../shared/contracts/qq-message";
import type { QqReplyProjection } from "./reply-context";

export interface QqSelectedMediaCandidate {
  mediaId: string;
  category: QqImageCategory;
  messageIds: string[];
  detail: boolean;
}

export interface QqMediaOmission {
  mediaId: string;
  messageId: string;
  reason: "not_supplied" | "not_selected" | "capability_disabled" | "stage_disabled" | "unreadable";
}

export interface QqMediaCandidateSelection {
  selected: QqSelectedMediaCandidate[];
  omissions: QqMediaOmission[];
}

export interface QqMediaCandidateInput {
  facts: readonly QqMessageFact[];
  replies: QqReplyProjection;
  focus: { responseMessageIds: readonly string[] };
  settings: QqEffectiveMediaPolicy;
  phase: QqImagePhase;
  capabilityEnabled: boolean;
  detailMediaIds: ReadonlySet<string>;
  now: string;
}

interface MediaOccurrence {
  mediaId: string;
  messageId: string;
  partIndex: number;
  category: QqImageCategory;
  occurredAtSeconds: number;
  seq: number;
  factId: string;
  scope: "focus" | "direct";
}

const ROOT_OK = new Set(["available", "in_window", "budget_limited"]);

function isExpired(fact: QqMessageFact, nowMs: number): boolean {
  return fact.sources.some(
    (source) => source.expiresAt !== undefined && Date.parse(source.expiresAt) <= nowMs,
  );
}

function usableFact(fact: QqMessageFact, nowMs: number): boolean {
  return fact.completeness !== "unavailable" && !isExpired(fact, nowMs);
}

/** 图片候选出现点收集：只认真实 image part，face/unavailable 不进。 */
function collectOccurrences(fact: QqMessageFact, scope: "focus" | "direct"): MediaOccurrence[] {
  const out: MediaOccurrence[] = [];
  fact.parts.forEach((part: QqMessagePart, partIndex: number) => {
    if (part.kind !== "image") return;
    out.push({
      mediaId: part.mediaId,
      messageId: fact.id,
      partIndex,
      category: part.category,
      occurredAtSeconds: fact.occurredAtSeconds,
      seq: fact.seq,
      factId: fact.id,
      scope,
    });
  });
  return out;
}

function compareOccurrences(a: MediaOccurrence, b: MediaOccurrence): number {
  if (a.occurredAtSeconds !== b.occurredAtSeconds) return b.occurredAtSeconds - a.occurredAtSeconds;
  if (a.seq !== b.seq) return b.seq - a.seq;
  if (a.factId < b.factId) return -1;
  if (a.factId > b.factId) return 1;
  return a.partIndex - b.partIndex;
}

export function selectQqMediaCandidates(input: QqMediaCandidateInput): QqMediaCandidateSelection {
  const { facts, replies, focus, settings, phase, capabilityEnabled, detailMediaIds, now } = input;
  const nowMs = Date.parse(now);

  const scopeDirectMessageIds = new Set<string>();

  // focus 源必须真实存在且有效：absent/expired/unavailable 的 from 不扩 direct（§7.1）。
  const usableFocusIds = new Set(
    focus.responseMessageIds.filter((id) => {
      const fact = facts.find((f) => f.id === id);
      return fact !== undefined && usableFact(fact, nowMs);
    }),
  );

  for (const root of replies.roots) {
    if (root.depth !== 1) continue;
    if (!ROOT_OK.has(root.state)) continue;
    if (!usableFocusIds.has(root.fromMessageId)) continue;
    // 伪 null/state/unavailable/expired/身份不匹配的 root 不授予范围；真实投影恒带
    // 身份匹配的可用 metadata 消息。
    if (root.message === null) continue;
    if (root.message.completeness === "unavailable") continue;
    if (isExpired(root.message, nowMs)) continue;
    if (root.message.id !== root.targetMessageId) continue;
    scopeDirectMessageIds.add(root.targetMessageId);
  }

  const allOccurrences: MediaOccurrence[] = [];
  for (const fact of facts) {
    if (!usableFact(fact, nowMs)) continue;
    const isFocus = usableFocusIds.has(fact.id);
    const isDirect = scopeDirectMessageIds.has(fact.id);
    const scope: "focus" | "direct" | null = isFocus ? "focus" : isDirect ? "direct" : null;
    if (scope !== null) allOccurrences.push(...collectOccurrences(fact, scope));
  }

  const byMedia = new Map<
    string,
    { occurrences: MediaOccurrence[]; categories: Set<MediaOccurrence["category"]> }
  >();
  for (const occurrence of allOccurrences) {
    let entry = byMedia.get(occurrence.mediaId);
    if (!entry) {
      entry = { occurrences: [], categories: new Set() };
      byMedia.set(occurrence.mediaId, entry);
    }
    entry.occurrences.push(occurrence);
    entry.categories.add(occurrence.category);
  }

  const mergeCategory = (
    categories: Set<MediaOccurrence["category"]>,
  ): MediaOccurrence["category"] => {
    if (categories.size === 1) return [...categories][0];
    return "unknown";
  };

  const omissions: QqMediaOmission[] = [];
  const selected: QqSelectedMediaCandidate[] = [];

  const finalizeOmissions = (reason: QqMediaOmission["reason"]): QqMediaOmission[] => {
    const byKey = new Map<string, QqMediaOmission>();
    const key = (mediaId: string, messageId: string) => JSON.stringify([mediaId, messageId]);
    for (const fact of facts) {
      if (!usableFact(fact, nowMs)) continue;
      for (const part of fact.parts) {
        if (part.kind !== "image") continue;
        byKey.set(key(part.mediaId, fact.id), {
          mediaId: part.mediaId,
          messageId: fact.id,
          reason,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => {
      if (a.mediaId !== b.mediaId) return a.mediaId < b.mediaId ? -1 : 1;
      return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
    });
  };

  if (!capabilityEnabled) {
    return { selected, omissions: finalizeOmissions("capability_disabled") };
  }

  if (!settings.stages[phase]) {
    return { selected, omissions: finalizeOmissions("stage_disabled") };
  }

  // 桶序（§7.5）：explicit → focus ordinary/unknown → direct ordinary/unknown →
  // notdetail expression；同 media 全部合格 occurrences 入桶，代表取比较器 min 保置换稳定。
  const buckets: Record<string, MediaOccurrence[]> = {
    explicit: [],
    focus: [],
    direct: [],
    expression: [],
  };
  for (const [mediaId, entry] of byMedia) {
    const category = mergeCategory(entry.categories);
    const occurrences = entry.occurrences;
    const focusOccs = occurrences.filter((o) => o.scope === "focus");
    const directOccs = occurrences.filter((o) => o.scope === "direct");
    if (detailMediaIds.has(mediaId) && (focusOccs.length > 0 || directOccs.length > 0)) {
      buckets.explicit.push(...occurrences);
      continue;
    }
    if (category === "expression") {
      buckets.expression.push(...occurrences);
      continue;
    }
    if (focusOccs.length > 0) {
      buckets.focus.push(...focusOccs);
      continue;
    }
    buckets.direct.push(...occurrences);
  }

  // 同一 media 只保留一条代表 occurrence（桶内比较器 min），detail 只对 explicit 桶生效。
  const ordered: Array<{
    mediaId: string;
    category: MediaOccurrence["category"];
    occurrence: MediaOccurrence;
    explicit: boolean;
  }> = [];
  for (const bucketName of ["explicit", "focus", "direct", "expression"] as const) {
    const bucket = buckets[bucketName];
    const byMediaInBucket = new Map<string, MediaOccurrence>();
    for (const occurrence of bucket) {
      const existing = byMediaInBucket.get(occurrence.mediaId);
      if (!existing || compareOccurrences(occurrence, existing) < 0)
        byMediaInBucket.set(occurrence.mediaId, occurrence);
    }
    const reps = [...byMediaInBucket.values()].sort(compareOccurrences);
    for (const occurrence of reps) {
      const entry = byMedia.get(occurrence.mediaId);
      if (!entry) continue;
      ordered.push({
        mediaId: occurrence.mediaId,
        category: mergeCategory(entry.categories),
        occurrence,
        explicit: bucketName === "explicit",
      });
    }
  }

  let budget = settings.max_images;
  const selectedIds = new Set<string>();
  for (const entry0 of ordered) {
    if (budget <= 0) break;
    if (selectedIds.has(entry0.mediaId)) continue;
    selectedIds.add(entry0.mediaId);
    budget -= 1;
    const entry = byMedia.get(entry0.mediaId);
    if (!entry) continue;
    const messageIds = [...new Set(entry.occurrences.map((o) => o.messageId))].sort();
    selected.push({
      mediaId: entry0.mediaId,
      category: entry0.category,
      messageIds,
      detail: entry0.explicit && detailMediaIds.has(entry0.mediaId),
    });
  }

  // omissions 结构化元组去重稳定排序：不用字符串编码身份（NUL 是契约合法字符）。
  const omissionsByKey = new Map<string, QqMediaOmission>();
  const omissionKey = (reason: QqMediaOmission["reason"], mediaId: string, messageId: string) =>
    JSON.stringify([reason, mediaId, messageId]);
  const compareOmissions = (a: QqMediaOmission, b: QqMediaOmission): number => {
    if (a.reason !== b.reason) return a.reason === "not_supplied" ? -1 : 1;
    if (a.mediaId !== b.mediaId) return a.mediaId < b.mediaId ? -1 : 1;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  };
  const addOmission = (o: QqMediaOmission) => {
    omissionsByKey.set(omissionKey(o.reason, o.mediaId, o.messageId), o);
  };
  for (const [mediaId, entry] of byMedia) {
    if (selectedIds.has(mediaId)) continue;
    for (const occurrence of entry.occurrences) {
      addOmission({
        mediaId,
        messageId: occurrence.messageId,
        reason: "not_supplied",
      });
    }
  }
  for (const fact of facts) {
    if (!usableFact(fact, nowMs)) continue;
    const inScope = usableFocusIds.has(fact.id) || scopeDirectMessageIds.has(fact.id);
    if (inScope) continue;
    for (const part of fact.parts) {
      if (part.kind === "image")
        addOmission({ mediaId: part.mediaId, messageId: fact.id, reason: "not_selected" });
    }
  }
  omissions.push(...[...omissionsByKey.values()].sort(compareOmissions));

  return { selected, omissions };
}
