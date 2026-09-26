import { BookOpen, Brain, Smile } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSuperstringStore } from "@/store";
import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { MemoryLibrary } from "./MemoryLibrary";
import { StickerLibrary } from "./StickerLibrary";
export function LibraryWorkspace() {
  const route = useSuperstringStore((s) => s.settingsRoute),
    navigate = useSuperstringStore((s) => s.openSettingsRoute),
    t = useTranslation().t;
  const tab =
    route === "qq-stickers"
      ? "stickers"
      : route === "long-memory" || route === "profile"
        ? "memory"
        : "knowledge";
  return (
    <div className="mx-auto h-full min-h-0 w-full overflow-y-auto max-w-7xl space-y-6 p-5 md:p-8">
      <header className="space-y-1">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">
          SUPERSTRING / {t("library.materials")}
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
        <TabsList className="h-auto flex-wrap">
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
      {tab === "knowledge" ? (
        <KnowledgeLibrary />
      ) : tab === "memory" ? (
        <MemoryLibrary />
      ) : (
        <StickerLibrary />
      )}
    </div>
  );
}
