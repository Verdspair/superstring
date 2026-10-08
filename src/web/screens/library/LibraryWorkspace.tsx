import { BookOpen, Brain, Smile } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
      className="h-full min-h-0 w-full space-y-6 overflow-y-auto px-4 py-6"
    >
      <header className="space-y-1">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">
          {t("brand.workspace", { "0": t("library.materials") })}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{t("library.library")}</h1>
        <p className="text-sm text-muted-foreground">
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
        <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
          <TabsTrigger value="knowledge">
            <BookOpen />
            {t("library.documents")}
          </TabsTrigger>
          <TabsTrigger value="memory">
            <Brain />
            {t("library.memory")}
          </TabsTrigger>
          <TabsTrigger value="stickers">
            <Smile />
            {t("library.sticker.library")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {panel("knowledge", <KnowledgeLibrary active={active && tab === "knowledge"} />)}
      {panel("memory", <MemoryLibrary active={active && tab === "memory"} />)}
      {panel("stickers", <StickerLibrary active={active && tab === "stickers"} />)}
    </div>
  );
}
