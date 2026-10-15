import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { timelineKey } from "../../features/conversations/use-timeline-scroll";

export type ConversationTimelineRow = ConversationEventView & {
  activityId?: string;
  activityEvents?: ConversationEventView[];
};

/** Media revisions decorate their loaded source message without becoming duplicate chat turns. */
export function timelineRows(
  events: (ConversationEventView & { activityId?: string })[],
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
  // Legacy events without activityId stay independent
  const standaloneRows: ConversationTimelineRow[] = [];
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
    } else {
      standaloneRows.push(event);
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

  // Combine standalone rows and canonical activity chain rows, sorted by representative seq
  return [...standaloneRows, ...projectedActivityRows].sort((a, b) => a.seq - b.seq);
}
