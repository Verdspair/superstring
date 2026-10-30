import { ArrowLeft, BookOpen, Brain, Smile } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSuperstringStore } from "@/store";
import { WorkspacePageHeader } from "../../workspace/WorkspacePageHeader";
import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { MemoryLibrary } from "./MemoryLibrary";
import { StickerLibrary } from "./StickerLibrary";

function libraryTab(route: string) {
  return route === "qq-stickers"
    ? "stickers"
    : route === "long-memory" || route === "profile"
      ? "memory"
      : "knowledge";
}

export function LibraryWorkspace({ active = true }: { active?: boolean } = {}) {
  const route = useSuperstringStore((s) => s.settingsRoute),
    navigate = useSuperstringStore((s) => s.openSettingsRoute),
    requestKnowledgeEditor = useSuperstringStore((s) => s.requestKnowledgeEditor),
    returnToOrigin = useSuperstringStore((s) => s.returnWorkspaceTarget),
    hasReturn = useSuperstringStore((s) => s.workspaceReturns.length > 0),
    t = useTranslation().t;
  const tab = libraryTab(route);
  const [visited, setVisited] = useState([tab]);
  useEffect(() => {
    if (
      active &&
      route === "context-allocation" &&
      useSuperstringStore.getState().knowledgeEditor?.kind !== "settings"
    ) {
      requestKnowledgeEditor({ kind: "settings" });
    }
  }, [active, route, requestKnowledgeEditor]);
  const workspaceScroll = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const previousTab = useRef(tab);
  const wasActive = useRef(active);
  const pending = useRef<{ tab: string; target: number } | null>(null);
  const scrollObserver = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    return useSuperstringStore.subscribe((next, before) => {
      const oldTab = libraryTab(before.settingsRoute);
      const newTab = libraryTab(next.settingsRoute);
      const element = workspaceScroll.current;
      if (oldTab !== newTab && previousTab.current === oldTab && element && !pending.current)
        scrollPositions.current.set(oldTab, element.scrollTop);
    });
  }, [active]);
  useEffect(() => {
    setVisited((previous) => (previous.includes(tab) ? previous : [...previous, tab]));
  }, [tab]);
  useLayoutEffect(() => {
    const element = workspaceScroll.current;
    if (!element) return;
    if (!active) {
      wasActive.current = false;
      pending.current = null;
      return;
    }
    const returning = !wasActive.current;
    wasActive.current = true;
    if (previousTab.current !== tab || returning) {
      previousTab.current = tab;
      const target = scrollPositions.current.get(tab) ?? 0;
      pending.current = { tab, target };
      if (element.scrollHeight - element.clientHeight >= target) {
        element.scrollTop = target;
        pending.current = null;
      }
    }
    const content = element.querySelector<HTMLElement>(`[data-workspace-scroll="${tab}"]`);
    const request = pending.current;
    if (!request || !content) return;
    const observer = new ResizeObserver(() => {
      const attempt = pending.current;
      if (
        attempt !== request ||
        attempt.tab !== tab ||
        previousTab.current !== tab ||
        !element.isConnected ||
        content.closest("[hidden]")
      )
        return;
      if (element.scrollHeight - element.clientHeight >= attempt.target) {
        element.scrollTop = attempt.target;
        pending.current = null;
        observer.disconnect();
        if (scrollObserver.current === observer) scrollObserver.current = null;
      }
    });
    scrollObserver.current = observer;
    observer.observe(content);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (scrollObserver.current === observer) scrollObserver.current = null;
      if (pending.current === request) pending.current = null;
    };
  }, [tab, active]);
  useLayoutEffect(() => {
    const element = workspaceScroll.current;
    if (!active || !element) return;
    const cancelPendingScroll = () => {
      if (!pending.current) return;
      pending.current = null;
      scrollPositions.current.set(tab, element.scrollTop);
      scrollObserver.current?.disconnect();
      scrollObserver.current = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
        !(
          event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,button,[role="tab"],[contenteditable="true"]')
        )
      )
        cancelPendingScroll();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target === element &&
        event.clientX >= element.getBoundingClientRect().left + element.clientWidth
      )
        cancelPendingScroll();
    };
    element.addEventListener("wheel", cancelPendingScroll, { passive: true });
    element.addEventListener("touchmove", cancelPendingScroll, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    return () => {
      element.removeEventListener("wheel", cancelPendingScroll);
      element.removeEventListener("touchmove", cancelPendingScroll);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);
    };
  }, [active, tab]);
  // 只有当前可见面板走入场动效；已访问面板仍常挂载，草稿与滚动位置不受影响。
  const panel = (name: "knowledge" | "memory" | "stickers", child: React.ReactNode) =>
    visited.includes(name) || tab === name ? (
      <div
        hidden={tab !== name}
        data-workspace-scroll={name}
        className={tab === name ? "panel-enter" : undefined}
      >
        {child}
      </div>
    ) : null;
  return (
    <div
      ref={workspaceScroll}
      data-testid="library-workspace-scroll"
      onScroll={(event) => {
        if (active && previousTab.current === tab && !pending.current)
          scrollPositions.current.set(tab, event.currentTarget.scrollTop);
      }}
      className="workspace-page h-full min-h-0 overflow-y-auto"
    >
      <WorkspacePageHeader
        backAction={
          hasReturn ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("library.returnToOrigin")}
              tooltip={t("library.returnToOrigin")}
              onClick={returnToOrigin}
            >
              <ArrowLeft />
            </Button>
          ) : undefined
        }
        location={t("brand.workspace", { "0": t("library.materials") })}
        title={t("library.library")}
        description={t(
          "library.documents.provide.knowledge.memories.preserve.experience.and.assets.enrich",
        )}
      />
      <Tabs
        className="mb-[24px]"
        value={tab}
        onValueChange={(value) =>
          navigate(
            value === "stickers"
              ? "qq-stickers"
              : value === "memory"
                ? "long-memory"
                : "knowledge-config",
          )
        }
      >
        <TabsList presentation="workspace" flow="scroll" className="w-fit max-w-full justify-start">
          <Tooltip>
            <TooltipTrigger asChild preserveTriggerState>
              <TabsTrigger value="knowledge">
                <BookOpen />
                {t("library.documents")}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("hints.library.tabs.knowledge")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild preserveTriggerState>
              <TabsTrigger value="memory">
                <Brain />
                {t("library.memory")}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("hints.library.tabs.memory")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild preserveTriggerState>
              <TabsTrigger value="stickers">
                <Smile />
                {t("library.sticker.library")}
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("hints.library.tabs.stickers")}</TooltipContent>
          </Tooltip>
        </TabsList>
      </Tabs>
      {panel("knowledge", <KnowledgeLibrary active={active && tab === "knowledge"} />)}
      {panel("memory", <MemoryLibrary active={active && tab === "memory"} />)}
      {panel("stickers", <StickerLibrary active={active && tab === "stickers"} />)}
    </div>
  );
}
