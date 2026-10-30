import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useSuperstringStore } from "../../store";
import { WorkspacePageHeader } from "../../workspace/WorkspacePageHeader";
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
    <section
      className="workspace-page flex h-full min-h-0 flex-col"
      aria-label={t("workspace.extensions")}
    >
      <WorkspacePageHeader
        location={t("brand.workspace", { "0": t("workspace.extensions") })}
        title={t("workspace.extensions")}
        description={t("workspace.manage_external_extensions")}
      />
      <Tabs value={tab} onValueChange={openTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="mb-[24px]">
          <TabsList
            presentation="workspace"
            flow="scroll"
            className="w-fit max-w-full justify-start"
          >
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
