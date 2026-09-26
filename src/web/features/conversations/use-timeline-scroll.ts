import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
import type { BeforeHistoryChange, HistoryChange } from "./use-conversation-events";

export function timelineKey(item: ConversationEventView) {
  return item.outputId
    ? `output:${item.outputId}`
    : item.kind === "inbound" || item.kind === "outbound"
      ? `source:${item.source.kind}:${item.source.id}`
      : item.wake
        ? `wake:${item.wake.id}`
        : `event:${item.seq}`;
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
  const snapshot = useRef<{
    kind: HistoryChange;
    top: number;
    height: number;
    key?: string;
    offset: number;
  } | null>(null);
  const parked = useRef<typeof snapshot.current>(null);
  const beforeChange: BeforeHistoryChange = useCallback((kind, next) => {
    const node = viewport.current;
    if (kind === "clear") suspended.current = true;
    else suspended.current = false;
    if (node && !node.hidden) {
      const bounds = node.getBoundingClientRect();
      const anchor = [...node.querySelectorAll<HTMLElement>("[data-timeline-key]")].find(
        (row) => row.getBoundingClientRect().bottom > bounds.top,
      );
      const captured = {
        kind,
        top: node.scrollTop,
        height: node.scrollHeight,
        key: anchor?.dataset.timelineKey,
        offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
      };
      if (kind === "clear") {
        if (node.querySelector("[data-timeline-key]")) parked.current = captured;
        snapshot.current = null;
      } else {
        snapshot.current = parked.current ? { ...parked.current, kind } : captured;
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
    if (!saved) return;
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
  });
  const onScroll = () => {
    const node = viewport.current;
    if (!node || suspended.current || node.hidden) return;
    following.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 64;
    setAway(!following.current);
    if (following.current) setUnread(0);
  };
  const toLatest = () => {
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
    following.current = true;
    setAway(false);
    setUnread(0);
  };
  return { viewport, beforeChange, onScroll, toLatest, away, unread };
}
