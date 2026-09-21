import type { ContentItem } from "../../shared/contracts";

/** Used after authorization only; omit storage, permissions and lifecycle metadata. */
export function contentBlocks(items: ContentItem[]) {
  return items.map((item) => ({
    id: item.id,
    source_type: item.source_type,
    content_origin: item.content_origin,
    body: item.body,
    sources: item.sources.map((source) =>
      source.type === "chat"
        ? { type: source.type, turn_id: source.turn_id }
        : {
            type: source.type,
            document_id: source.document_id,
            version: source.version,
            start: source.start,
            end: source.end,
          },
    ),
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
