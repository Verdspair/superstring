import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { timelineKey } from "../../features/conversations/use-timeline-scroll";

/** Media revisions decorate their loaded source message without becoming duplicate chat turns. */
export function timelineRows(events: ConversationEventView[]): ConversationEventView[] {
  // Use JS Map to guarantee exact insertion order with latest-value semantics, matching original
  const revisionsMap = new Map<string, ConversationEventView>();
  const records = new Map<string, ConversationEventView>();
  const parentInboundIds = new Set<string>();

  for (const event of events) {
    const key = timelineKey(event);
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
  const revisionsByParent = new Map<string, ConversationEventView[]>();

  for (const revision of revisions) {
    const matchedParentIds = new Set<string>();
    for (const source of revision.sources) {
      if (source.kind === "qq_event" && parentInboundIds.has(source.id)) {
        matchedParentIds.add(source.id);
      }
    }

    if (matchedParentIds.size === 0) {
      records.set(timelineKey(revision), revision);
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

  return [...records.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => {
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
}
