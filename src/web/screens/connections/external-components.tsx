import { ExternalLink, Layers, PlugZap, Puzzle, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  useMcpServersResource,
  useSkillsResource,
  useToolDirectoryResource,
} from "../../services/connection-resources";
import { useSuperstringStore } from "../../store";

export function ExternalIntegrationsCard({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const open = useSuperstringStore((s) => s.openSystemComponent);
  const openSettingsRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const apiClient = useSuperstringStore((s) => s.apiClient);

  const {
    data: mcpData,
    loading: mcpLoading,
    error: mcpError,
    refresh: mcpRefresh,
  } = useMcpServersResource(apiClient, active);
  const {
    data: skillData,
    loading: skillLoading,
    error: skillError,
    refresh: skillRefresh,
  } = useSkillsResource(apiClient, active);
  const {
    data: toolData,
    loading: toolLoading,
    error: toolError,
    refresh: toolRefresh,
  } = useToolDirectoryResource(apiClient, active);

  const servers = mcpData?.servers ?? [];
  const connectedCount = servers.filter((s) => s.state === "connected").length;
  const customSkills = (skillData?.skills ?? []).filter((s) => s.origin !== "system");
  const mcpTools = (toolData?.tools ?? []).filter((t) => t.origin === "mcp");

  const mcpHasErrorCode = mcpData?.code !== null && mcpData?.code !== undefined;
  const mcpErrorDisplay =
    mcpError || (mcpHasErrorCode ? `${t("connections.mcp.title")} (${mcpData.code})` : null);
  const skillProblems = skillData?.problems ?? [];
  const skillHasProblems = skillProblems.length > 0;

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 text-card-foreground">
      {/* 头部与主配置导航 */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border bg-muted/40 p-2 text-muted-foreground">
            <Puzzle className="size-5 shrink-0" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{t("capabilities.external.name")}</span>
              <Badge variant="outline" className="text-xs">
                {t("capabilities.external.connectedCount", { count: connectedCount })}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("capabilities.external.description")}
            </p>
          </div>
        </div>

        {/* 3 个主要管理入口 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-8 h-auto gap-1.5 px-3 py-1 text-xs"
            onClick={() => openSettingsRoute("mcp-servers")}
          >
            <PlugZap className="size-3.5" />
            {t("capabilities.external.manageMcp")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-8 h-auto gap-1.5 px-3 py-1 text-xs"
            onClick={() => openSettingsRoute("skill-catalog")}
          >
            <Layers className="size-3.5" />
            {t("capabilities.external.manageSkills")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="min-h-8 h-auto gap-1.5 px-3 py-1 text-xs"
            onClick={() => openSettingsRoute("tool-grants")}
          >
            <Wrench className="size-3.5" />
            {t("capabilities.external.manageTools")}
          </Button>
        </div>
      </div>

      {/* 1. MCP 服务及专属工具 */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <PlugZap className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">
            {t("connections.components.mcpCount", { count: servers.length })}
          </span>
        </div>

        {mcpLoading && !mcpData && (
          <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
        )}
        {mcpErrorDisplay && (
          <div className="flex items-center justify-between gap-2">
            <p role="alert" className="text-xs text-destructive">
              {mcpErrorDisplay}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="min-h-8 h-auto px-2.5 py-1 text-xs"
              onClick={() => mcpRefresh()}
            >
              {t("capabilities.retry")}
            </Button>
          </div>
        )}
        {!mcpLoading && !mcpErrorDisplay && servers.length === 0 && (
          <div className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
            {t("capabilities.external.noServers")}
          </div>
        )}

        {servers.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {servers.map((server) => {
              const serverPrefix = `mcp.${server.config.id}.`;
              const serverTools = mcpTools.filter((tool) => tool.name.startsWith(serverPrefix));
              const stateKey = `connections.mcp.state.${server.state}`;
              return (
                <div
                  key={server.config.id}
                  className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-8 h-auto p-0 font-medium hover:underline text-left justify-start"
                      onClick={() => open({ kind: "mcp", id: server.config.id })}
                    >
                      <span>{server.config.name}</span>
                      <ExternalLink className="size-3 ml-1 text-muted-foreground inline" />
                    </Button>
                    <Badge
                      variant={server.state === "connected" ? "secondary" : "outline"}
                      className="text-[10px]"
                    >
                      {t(stateKey)}
                    </Badge>
                  </div>

                  {toolLoading && !toolData && (
                    <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
                  )}

                  {toolError && !toolData && (
                    <div className="flex items-center justify-between gap-2">
                      <p role="alert" className="text-xs text-destructive">
                        {toolError}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-8 h-auto px-2 py-1 text-xs"
                        onClick={() => toolRefresh()}
                      >
                        {t("capabilities.retry")}
                      </Button>
                    </div>
                  )}

                  {!toolLoading && !toolError && serverTools.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {serverTools.map((tool) => {
                        const isOff = tool.globalEnabled === false;
                        return (
                          <Button
                            key={tool.name}
                            variant="outline"
                            size="sm"
                            className={`min-h-8 h-auto gap-1.5 px-2 py-1 text-xs font-mono ${
                              isOff ? "opacity-60 bg-muted/50" : ""
                            }`}
                            onClick={() => open({ kind: "tool", id: tool.name })}
                          >
                            <Badge variant="outline" className="px-1 py-0 text-[9px]">
                              {t("connections.components.tools")}
                            </Badge>
                            <span>{tool.name.replace(serverPrefix, "")}</span>
                            {isOff && (
                              <span className="text-[10px] text-destructive">
                                ({t("connections.components.globalOff")})
                              </span>
                            )}
                          </Button>
                        );
                      })}
                    </div>
                  )}

                  {!toolLoading && !toolError && serverTools.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("capabilities.external.noMcpTools")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. 外置技能文档 */}
      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center gap-2">
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">
            {t("connections.components.skillsCount", { count: customSkills.length })}
          </span>
        </div>

        {skillLoading && !skillData && (
          <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
        )}
        {skillError && (
          <div className="flex items-center justify-between gap-2">
            <p role="alert" className="text-xs text-destructive">
              {skillError}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="min-h-8 h-auto px-2.5 py-1 text-xs"
              onClick={() => skillRefresh()}
            >
              {t("capabilities.retry")}
            </Button>
          </div>
        )}
        {skillHasProblems && (
          <p role="alert" className="text-xs text-destructive">
            {skillProblems.map((p) => `${p.skill}: ${p.code}`).join(", ")}
          </p>
        )}
        {!skillLoading && !skillError && !skillHasProblems && customSkills.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("capabilities.external.noCustomSkills")}
          </p>
        )}

        {customSkills.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {customSkills.map((skill) => {
              const isOff = skill.globalEnabled === false;
              return (
                <Button
                  key={skill.name}
                  variant="outline"
                  size="sm"
                  className={`min-h-8 h-auto gap-1.5 px-2.5 py-1 text-xs ${
                    isOff ? "opacity-60 bg-muted/50" : ""
                  }`}
                  onClick={() => open({ kind: "skill", id: skill.name })}
                >
                  <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                    {t("connections.components.skills")}
                  </Badge>
                  <span className="font-mono text-[11px]">{skill.name}</span>
                  {isOff && (
                    <span className="text-[10px] text-destructive">
                      ({t("connections.components.globalOff")})
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
