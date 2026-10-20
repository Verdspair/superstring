import { BookOpen, Brain, Smile } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSuperstringStore } from "@/store";
import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { MemoryLibrary } from "./MemoryLibrary";
import { StickerLibrary } from "./StickerLibrary";
export function LibraryWorkspace({ active = true }: { active?: boolean } = {}) {
  const route = useSuperstringStore((s) => s.settingsRoute),
    navigate = useSuperstringStore((s) => s.openSettingsRoute),
    t = useTranslation().t;
  const tab =
    route === "qq-stickers"
      ? "stickers"
      : route === "long-memory" || route === "profile"
        ? "memory"
        : "knowledge";
  const [visited, setVisited] = useState([tab]);
  const workspaceScroll = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const previousTab = useRef(tab);
  useEffect(() => {
    setVisited((previous) => (previous.includes(tab) ? previous : [...previous, tab]));
  }, [tab]);
  useLayoutEffect(() => {
    const element = workspaceScroll.current;
    if (!element) return;
    if (previousTab.current !== tab) {
      scrollPositions.current.set(previousTab.current, element.scrollTop);
      element.scrollTop = scrollPositions.current.get(tab) ?? 0;
      previousTab.current = tab;
    }
  }, [tab]);
  const panel = (name: "knowledge" | "memory" | "stickers", child: React.ReactNode) =>
    visited.includes(name) || tab === name ? (
      <div hidden={tab !== name} data-workspace-scroll={name}>
        {child}
      </div>
    ) : null;
  return (
    <div
      ref={workspaceScroll}
      data-testid="library-workspace-scroll"
      onScroll={(event) => scrollPositions.current.set(tab, event.currentTarget.scrollTop)}
      className="mx-auto h-full min-h-0 w-full max-w-[1160px] space-y-[24px] overflow-y-auto px-[36px] pt-[28px] pb-[64px] max-[768px]:px-[16px] max-[768px]:pt-[20px] max-[768px]:pb-[48px]"
    >
      <header className="workspace-page-header space-y-[6px]">
        <p className="workspace-page-location">
          {t("brand.workspace", { "0": t("library.materials") })}
        </p>
        <h1 className="workspace-page-title">{t("library.library")}</h1>
        <p className="workspace-page-description">
          {t("library.documents.provide.knowledge.memories.preserve.experience.and.assets.enrich")}
        </p>
      </header>
      <Tabs
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
        <TabsList className="h-[42px] group-data-horizontal/tabs:h-[42px] w-fit max-w-full justify-start gap-[6px] overflow-x-auto rounded-[10px] border border-border bg-muted p-[4px] [&_[role=tab]]:h-[32px] [&_[role=tab]]:flex-none [&_[role=tab]]:px-[14px] [&_[role=tab]]:text-[13px]">
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
