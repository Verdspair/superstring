import { Puzzle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useSuperstringStore } from "../../store";
import { McpPanel } from "./mcp-panel";
import { SkillsPanel } from "./skills-panel";
import { ToolDirectoryPanel } from "./tool-directory-panel";

export function ConnectionWorkspace({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const route = useSuperstringStore((s) => s.settingsRoute);
  const tab = route === "skill-catalog" ? "skills" : route === "tool-grants" ? "grants" : "mcp";
  const [visited, setVisited] = useState([tab]);
  useEffect(() => {
    setVisited((previous) => (previous.includes(tab) ? previous : [...previous, tab]));
  }, [tab]);
  const openTab = (value: string) =>
    useSuperstringStore
      .getState()
      .openSettingsRoute(
        value === "skills" ? "skill-catalog" : value === "grants" ? "tool-grants" : "mcp-servers",
      );
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t("workspace.extensions")}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b px-4 py-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Puzzle className="size-4 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">{t("workspace.extensions")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("workspace.manage_external_extensions")}
          </p>
        </div>
      </header>
      <Tabs value={tab} onValueChange={openTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="border-b px-4 py-3">
          <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
            <TabsTrigger value="mcp">{t("connections.mcp.title")}</TabsTrigger>
            <TabsTrigger value="skills">{t("connections.skills.title")}</TabsTrigger>
            <TabsTrigger value="grants">{t("connections.tools.title")}</TabsTrigger>
          </TabsList>
        </div>
        {visited.includes("mcp") && (
          <TabsContent
            value="mcp"
            forceMount
            className="m-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
          >
            <McpPanel active={active && tab === "mcp"} />
          </TabsContent>
        )}
        {visited.includes("skills") && (
          <TabsContent
            value="skills"
            forceMount
            className="m-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
          >
            <SkillsPanel active={active && tab === "skills"} />
          </TabsContent>
        )}
        {visited.includes("grants") && (
          <TabsContent
            value="grants"
            forceMount
            className="m-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
          >
            <ToolDirectoryPanel active={active && tab === "grants"} />
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}
