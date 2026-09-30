import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
import type { BeforeHistoryChange, HistoryChange } from "./use-conversation-events";

export function timelineKey(item: ConversationEventView) {
  return item.outputId
    ? `output:${item.outputId}`
    : item.kind === "inbound" || item.kind === "outbound" || item.kind === "media_revision"
      ? `source:${item.source.kind}:${item.source.id}`
      : item.wake
        ? `wake:${item.wake.id}`
        : `event:${item.seq}`;
}

type TimelineAnchor = { top: number; height: number; key?: string; offset: number };

/** Anchor metadata only (key/offset/scrollTop); protected bodies stay out of parking. */
function captureTimelineAnchor(node: HTMLElement): TimelineAnchor {
  const bounds = node.getBoundingClientRect();
  const anchor = [...node.querySelectorAll<HTMLElement>("[data-timeline-key]")].find(
    (row) => row.getBoundingClientRect().bottom > bounds.top,
  );
  return {
    top: node.scrollTop,
    height: node.scrollHeight,
    key: anchor?.dataset.timelineKey,
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  };
}

function captureVisibleTimelineAnchor(node: HTMLElement | null): TimelineAnchor | null {
  return node && !node.hidden ? captureTimelineAnchor(node) : null;
}

/** Capture the user's visible source before React replaces/reorders projected rows. */
export function useTimelineScroll() {
  const viewport = useRef<HTMLElement>(null);
  const following = useRef(true);
  const known = useRef(new Set<string>());
  const latestSeq = useRef(0);
  const wasHidden = useRef(false);
  const suspended = useRef(false);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(0);
  const snapshot = useRef<(TimelineAnchor & { kind: HistoryChange }) | null>(null);
  const parked = useRef<TimelineAnchor | null>(null);
  // 隐藏后 DOM 读不到布局（rect/scrollTop 归零），用最后可见滚动时的元数据兜底。
  const lastVisible = useRef<TimelineAnchor | null>(null);
  const beforeChange: BeforeHistoryChange = useCallback((kind, next) => {
    const node = viewport.current;
    if (kind === "clear") suspended.current = true;
    else suspended.current = false;
    if (kind === "clear") {
      const captured = captureVisibleTimelineAnchor(node);
      if (captured) {
        lastVisible.current = captured;
        if (node?.querySelector("[data-timeline-key]")) parked.current = captured;
      } else if (!parked.current && lastVisible.current) {
        parked.current = lastVisible.current;
      }
      snapshot.current = null;
    } else {
      const captured = captureVisibleTimelineAnchor(node);
      if (captured) {
        lastVisible.current = captured;
        snapshot.current = parked.current ? { ...parked.current, kind } : { ...captured, kind };
        parked.current = null;
      }
    }
    if (kind === "clear") return;
    const messages = next.filter((item) => item.kind === "inbound" || item.kind === "outbound");
    if (kind === "refresh" && !following.current) {
      const added = messages.filter(
        (item) => item.seq > latestSeq.current && !known.current.has(timelineKey(item)),
      ).length;
      if (added) setUnread((count) => count + added);
    }
    known.current = new Set([...known.current, ...messages.map(timelineKey)]);
    latestSeq.current = Math.max(latestSeq.current, ...next.map((item) => item.seq));
  }, []);
  useLayoutEffect(() => {
    const node = viewport.current,
      saved = snapshot.current;
    if (!node || suspended.current) return;
    if (node.hidden) {
      wasHidden.current = true;
      return;
    }
    if (wasHidden.current) {
      wasHidden.current = false;
      if (following.current) node.scrollTop = node.scrollHeight;
    }
    if (saved) {
      snapshot.current = null;
      if (saved.kind === "initial" || (following.current && saved.kind !== "older")) {
        node.scrollTop = node.scrollHeight;
      } else {
        const anchor = [...node.querySelectorAll<HTMLElement>("[data-timeline-key]")].find(
          (row) => row.dataset.timelineKey === saved.key,
        );
        node.scrollTop = anchor
          ? node.scrollTop +
            anchor.getBoundingClientRect().top -
            node.getBoundingClientRect().top -
            saved.offset
          : saved.top + (saved.kind === "older" ? node.scrollHeight - saved.height : 0);
      }
      following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 64;
      setAway(!following.current);
    }
    lastVisible.current = captureTimelineAnchor(node);
  });
  const onScroll = () => {
    const node = viewport.current;
    if (!node || suspended.current || node.hidden) return;
    following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 64;
    setAway(!following.current);
    if (following.current) setUnread(0);
    lastVisible.current = captureTimelineAnchor(node);
  };
  const toLatest = () => {
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
    following.current = true;
    setAway(false);
    setUnread(0);
  };
  /** 宿主在隐藏页签前调用；DOM 已隐藏时退回最后可见锚点，不能读隐藏读数。 */
  const parkBeforeHide = useCallback(() => {
    const node = viewport.current;
    const captured = captureVisibleTimelineAnchor(node);
    if (captured) {
      lastVisible.current = captured;
      if (node?.querySelector("[data-timeline-key]")) parked.current = captured;
      return;
    }
    if (!parked.current && lastVisible.current) parked.current = lastVisible.current;
  }, []);
  return { viewport, beforeChange, onScroll, toLatest, parkBeforeHide, away, unread };
}
