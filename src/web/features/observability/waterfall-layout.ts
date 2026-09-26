import type { RuntimeSpan } from "../../../shared/contracts/runtime-observability";

export interface WaterfallNode {
  span: RuntimeSpan;
  children: WaterfallNode[];
  missingParent: boolean;
}

/** Parent identity defines the tree; adjacent timestamps never imply a relationship. */
export function waterfallLayout(spans: readonly RuntimeSpan[], sampledAt: string) {
  const nodes = new Map(
    spans.map((span) => [
      span.spanId,
      { span, children: [], missingParent: false } as WaterfallNode,
    ]),
  );
  const roots: WaterfallNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.span.parentSpanId ? nodes.get(node.span.parentSpanId) : undefined;
    // Incomplete historical telemetry remains visible without inventing a parent.
    const ancestors = new Set([node.span.spanId]);
    let cursor = parent;
    while (cursor && !ancestors.has(cursor.span.spanId)) {
      ancestors.add(cursor.span.spanId);
      cursor = cursor.span.parentSpanId ? nodes.get(cursor.span.parentSpanId) : undefined;
    }
    if (parent && !cursor) parent.children.push(node);
    else {
      node.missingParent = node.span.parentSpanId !== null;
      roots.push(node);
    }
  }
  const sort = (items: WaterfallNode[]) => {
    items.sort((a, b) => Date.parse(a.span.at) - Date.parse(b.span.at) || a.span.id - b.span.id);
    for (const item of items) sort(item.children);
  };
  sort(roots);
  const now = Date.parse(sampledAt);
  const start = spans.length ? Math.min(...spans.map((span) => Date.parse(span.at))) : now;
  const end = (span: RuntimeSpan) =>
    span.status === "started" && !span.finishedAt
      ? now
      : span.durationMs !== null
        ? Date.parse(span.at) + span.durationMs
        : Date.parse(span.finishedAt ?? span.at);
  const duration = Math.max(1, ...spans.map((span) => end(span) - start));
  const interval = (span: RuntimeSpan) => {
    const offsetMs = Math.max(0, Date.parse(span.at) - start);
    const durationMs = Math.max(0, end(span) - Date.parse(span.at));
    return {
      offsetMs,
      durationMs,
      left: (offsetMs / duration) * 100,
      width: (durationMs / duration) * 100,
    };
  };
  return { roots, start, duration, interval };
}
