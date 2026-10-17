import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { timelineKey } from "../../features/conversations/use-timeline-scroll";

export type ConversationTimelineRow = ConversationEventView & {
  activityId?: string;
  activityEvents?: ConversationEventView[];
};

function parseTimestamp(iso: string): number {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

function isTimelineRowEquivalent(
  prev: ConversationTimelineRow,
  next: ConversationTimelineRow,
): boolean {
  if (
    prev.conversationId !== next.conversationId ||
    prev.seq !== next.seq ||
    prev.eventKey !== next.eventKey ||
    prev.kind !== next.kind ||
    prev.occurredAt !== next.occurredAt ||
    prev.recordedAt !== next.recordedAt ||
    prev.runId !== next.runId ||
    prev.outputId !== next.outputId ||
    prev.text !== next.text ||
    prev.messageStatus !== next.messageStatus ||
    prev.contentState !== next.contentState ||
    prev.deliveryStatus !== next.deliveryStatus ||
    prev.deliveryStaleReason !== next.deliveryStaleReason ||
    prev.activityId !== next.activityId
  ) {
    return false;
  }

  // Source & sources provenance check
  if (
    prev.source.kind !== next.source.kind ||
    prev.source.id !== next.source.id ||
    prev.source.revision !== next.source.revision ||
    prev.sources.length !== next.sources.length
  ) {
    return false;
  }
  for (let i = 0; i < prev.sources.length; i++) {
    const ps = prev.sources[i];
    const ns = next.sources[i];
    if (ps.kind !== ns.kind || ps.id !== ns.id || ps.revision !== ns.revision) {
      return false;
    }
  }

  // Participant identity check
  if (prev.participant !== next.participant) {
    if (!prev.participant || !next.participant) return false;
    if (
      prev.participant.id !== next.participant.id ||
      prev.participant.label !== next.participant.label ||
      prev.participant.role !== next.participant.role
    ) {
      return false;
    }
  }

  // Addressing check
  if (
    prev.addressing.replyTo?.sourceId !== next.addressing.replyTo?.sourceId ||
    prev.addressing.replyTo?.participantId !== next.addressing.replyTo?.participantId ||
    prev.addressing.reasons.length !== next.addressing.reasons.length ||
    prev.addressing.mentionIds.length !== next.addressing.mentionIds.length
  ) {
    return false;
  }
  for (let i = 0; i < prev.addressing.reasons.length; i++) {
    if (prev.addressing.reasons[i] !== next.addressing.reasons[i]) return false;
  }
  for (let i = 0; i < prev.addressing.mentionIds.length; i++) {
    if (prev.addressing.mentionIds[i] !== next.addressing.mentionIds[i]) return false;
  }

  // Media check
  if (prev.media.length !== next.media.length) return false;
  for (let i = 0; i < prev.media.length; i++) {
    const pm = prev.media[i];
    const nm = next.media[i];
    if (
      !nm ||
      pm.id !== nm.id ||
      pm.kind !== nm.kind ||
      pm.description !== nm.description ||
      pm.availability !== nm.availability
    ) {
      return false;
    }
  }

  // Task check
  if (prev.task !== next.task) {
    if (!prev.task || !next.task) return false;
    if (
      prev.task.id !== next.task.id ||
      prev.task.status !== next.task.status ||
      prev.task.errorCode !== next.task.errorCode
    ) {
      return false;
    }
  }

  // Wake check
  if (prev.wake !== next.wake) {
    if (!prev.wake || !next.wake) return false;
    if (
      prev.wake.id !== next.wake.id ||
      prev.wake.status !== next.wake.status ||
      prev.wake.cause !== next.wake.cause ||
      prev.wake.readyAt !== next.wake.readyAt ||
      prev.wake.errorCode !== next.wake.errorCode
    ) {
      return false;
    }
  }

  // Activity events check
  const prevActs = prev.activityEvents ?? [];
  const nextActs = next.activityEvents ?? [];
  if (prevActs.length !== nextActs.length) return false;
  for (let i = 0; i < prevActs.length; i++) {
    const pa = prevActs[i];
    const na = nextActs[i];
    if (pa !== na) {
      if (
        pa.seq !== na.seq ||
        pa.deliveryStatus !== na.deliveryStatus ||
        pa.outputId !== na.outputId ||
        pa.runId !== na.runId ||
        pa.source.revision !== na.source.revision
      ) {
        return false;
      }
    }
  }

  return true;
}

/** Media revisions decorate their loaded source message without becoming duplicate chat turns. */
export function timelineRows(
  events: (ConversationEventView & { activityId?: string })[],
  previousRows?: ConversationTimelineRow[],
): ConversationTimelineRow[] {
  // Use JS Map to guarantee exact insertion order with latest-value semantics, matching original
  const revisionsMap = new Map<string, ConversationEventView & { activityId?: string }>();
  const records = new Map<string, ConversationEventView & { activityId?: string }>();
  const parentInboundIds = new Set<string>();

  for (const event of events) {
    // Strip activityId when generating rawMap key to prevent premature grouping across distinct events
    const key = `${event.activityId ?? "legacy"}:${timelineKey({ ...event, activityId: undefined })}`;
    if (event.kind === "media_revision") {
      revisionsMap.set(key, event);
    } else {
      records.set(key, event);
      if (event.kind === "inbound") {
        for (const source of event.sources) {
          if (source.kind === "qq_event") {
            parentInboundIds.add(source.id);
          }
        }
      }
    }
  }

  const revisions = [...revisionsMap.values()];
  const revisionsByParent = new Map<string, (ConversationEventView & { activityId?: string })[]>();

  for (const revision of revisions) {
    const matchedParentIds = new Set<string>();
    for (const source of revision.sources) {
      if (source.kind === "qq_event" && parentInboundIds.has(source.id)) {
        matchedParentIds.add(source.id);
      }
    }

    if (matchedParentIds.size === 0) {
      records.set(timelineKey({ ...revision, activityId: undefined }), revision);
    } else {
      for (const parentId of matchedParentIds) {
        let list = revisionsByParent.get(parentId);
        if (!list) {
          list = [];
          revisionsByParent.set(parentId, list);
        }
        list.push(revision);
      }
    }
  }

  const decoratedRecords = [...records.values()].map((event) => {
    if (event.kind !== "inbound") return event;
    const parentId = event.sources.find((source) => source.kind === "qq_event")?.id;
    if (!parentId) return event;
    const attachedRevisions = revisionsByParent.get(parentId);
    if (!attachedRevisions || attachedRevisions.length === 0) return event;

    const mediaMap = new Map<string, (typeof event.media)[number]>();
    for (const item of event.media) {
      mediaMap.set(item.id, item);
    }
    for (const rev of attachedRevisions) {
      for (const item of rev.media) {
        mediaMap.set(item.id, item);
      }
    }
    return { ...event, media: [...mediaMap.values()] };
  });

  // Group events by canonical activityId (same conversationId + activityId)
  // Legacy events without activityId stay independent.
  // Standalone orphan media revisions are partitioned for display-time merging.
  const standaloneNonMedia: ConversationTimelineRow[] = [];
  const orphanMediaRows: ConversationTimelineRow[] = [];
  const activityGroups = new Map<string, (ConversationEventView & { activityId?: string })[]>();

  for (const event of decoratedRecords) {
    if (event.activityId) {
      const groupKey = `${event.conversationId}::${event.activityId}`;
      let group = activityGroups.get(groupKey);
      if (!group) {
        group = [];
        activityGroups.set(groupKey, group);
      }
      group.push(event);
    } else if (event.kind === "media_revision") {
      orphanMediaRows.push(event);
    } else {
      standaloneNonMedia.push(event);
    }
  }

  const projectedActivityRows: ConversationTimelineRow[] = [];

  for (const [, group] of activityGroups) {
    // Sort events within group by original seq ascending
    group.sort((a, b) => a.seq - b.seq);

    // Pick representative:
    // Representative prefers inbound, else wake, else first delivery
    const inbounds = group.filter((e) => e.kind === "inbound");
    const wakes = group.filter((e) => e.kind === "wake" || Boolean(e.wake));
    const deliveries = group.filter(
      (e) => e.kind === "delivery" || e.kind === "outbound" || Boolean(e.outputId),
    );

    const rep = inbounds[0] ?? wakes[0] ?? deliveries[0] ?? group[0];

    // Activity events are the other original immutable event objects (avoiding self reference)
    const otherEvents = group.filter((e) => e !== rep);

    // Server-authoritative task status: take the latest non-null task projection across group
    const latestTask = [...group].reverse().find((e) => e.task)?.task ?? rep.task;

    // Wake metadata from any wake event in group if representative doesn't have it
    const linkedWake = rep.wake ?? group.find((e) => e.wake)?.wake ?? null;

    // Latest canonical runId across group
    const linkedRunId = rep.runId ?? [...group].reverse().find((e) => e.runId)?.runId ?? null;

    // Note: Do not union sources or qqMessageFacts into rep to preserve authentic provenance & bySourceMap semantics
    const row: ConversationTimelineRow = {
      ...rep,
      activityId: rep.activityId ?? group[0].activityId,
      task: latestTask,
      wake: linkedWake,
      runId: linkedRunId,
      activityEvents: otherEvents.length > 0 ? otherEvents : undefined,
    };

    projectedActivityRows.push(row);
  }

  // Core non-media rows maintain their canonical causal relative order strictly by seq
  const coreRows = [...standaloneNonMedia, ...projectedActivityRows].sort((a, b) => a.seq - b.seq);

  let candidateRows: ConversationTimelineRow[];

  if (orphanMediaRows.length === 0) {
    candidateRows = coreRows;
  } else {
    // Precompute orphan timestamps once for O(M log M) sort and linear merge
    const orphanEntries = orphanMediaRows.map((row) => ({
      row,
      time: parseTimestamp(row.occurredAt),
    }));
    orphanEntries.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.row.seq - b.row.seq));

    // Precompute core timestamps once for linear merge
    const coreTimes = coreRows.map((r) => parseTimestamp(r.occurredAt));

    // Stable linear two-pointer merge into core chronology
    const merged: ConversationTimelineRow[] = [];
    let i = 0;
    let j = 0;
    const n = coreRows.length;
    const m = orphanEntries.length;

    while (i < n && j < m) {
      const orphan = orphanEntries[j];
      if (
        orphan.time < coreTimes[i] ||
        (orphan.time === coreTimes[i] && orphan.row.seq <= coreRows[i].seq)
      ) {
        merged.push(orphan.row);
        j++;
      } else {
        merged.push(coreRows[i]);
        i++;
      }
    }

    while (j < m) merged.push(orphanEntries[j++].row);
    while (i < n) merged.push(coreRows[i++]);
    candidateRows = merged;
  }

  if (!previousRows || previousRows.length === 0) {
    return candidateRows;
  }

  const prevMap = new Map<string, ConversationTimelineRow>();
  for (const prevRow of previousRows) {
    prevMap.set(timelineKey(prevRow), prevRow);
  }

  return candidateRows.map((row) => {
    const prev = prevMap.get(timelineKey(row));
    if (prev && isTimelineRowEquivalent(prev, row)) {
      return prev;
    }
    return row;
  });
}
