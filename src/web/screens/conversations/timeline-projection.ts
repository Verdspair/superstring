import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { timelineKey } from "../../features/conversations/use-timeline-scroll";

/** Media revisions decorate their loaded source message without becoming duplicate chat turns. */
export function timelineRows(events: ConversationEventView[]): ConversationEventView[] {
  const revisions = [
    ...new Map(
      events
        .filter((event) => event.kind === "media_revision")
        .map((event) => [timelineKey(event), event]),
    ).values(),
  ];
  const records = new Map(
    events
      .filter((event) => event.kind !== "media_revision")
      .map((event) => [timelineKey(event), event]),
  );
  const parents = new Set(
    [...records.values()]
      .filter((event) => event.kind === "inbound")
      .flatMap((event) =>
        event.sources.filter((source) => source.kind === "qq_event").map((source) => source.id),
      ),
  );
  for (const revision of revisions)
    if (!revision.sources.some((source) => source.kind === "qq_event" && parents.has(source.id)))
      records.set(timelineKey(revision), revision);
  return [...records.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => {
      if (event.kind !== "inbound") return event;
      const parent = event.sources.find((source) => source.kind === "qq_event")?.id;
      if (!parent) return event;
      const media = [
        ...event.media,
        ...revisions
          .filter((revision) =>
            revision.sources.some((source) => source.kind === "qq_event" && source.id === parent),
          )
          .flatMap((revision) => revision.media),
      ];
      return { ...event, media: [...new Map(media.map((part) => [part.id, part])).values()] };
    });
}
