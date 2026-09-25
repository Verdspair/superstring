import type { ContentItem, ContentSource } from "../../shared/contracts";

/**
 * One provenance reference for the model prompt. Every variant is handled
 * explicitly — a `chat`/else ternary would have silently described a QQ
 * observation as a document range.
 */
function sourceRef(source: ContentSource): Record<string, unknown> {
  switch (source.type) {
    case "chat":
      return { type: source.type, turn_id: source.turn_id };
    case "qq_observation":
      return {
        type: source.type,
        conversation_key: source.conversation_key,
        event_key: source.event_key,
        speaker_kind: source.speaker_kind,
      };
    case "document":
      return {
        type: source.type,
        document_id: source.document_id,
        version: source.version,
        start: source.start,
        end: source.end,
      };
  }
}

/** Used after authorization only; omit storage, permissions and lifecycle metadata. */
export function contentBlocks(items: ContentItem[]) {
  return items.map((item) => ({
    id: item.id,
    source_type: item.source_type,
    content_origin: item.content_origin,
    body: item.body,
    sources: item.sources.map(sourceRef),
  }));
}

export function contentCandidate(item: ContentItem) {
  return {
    id: item.id,
    source_type: item.source_type,
    name: item.name,
    summary: item.summary,
    tags: item.tags,
  };
}
