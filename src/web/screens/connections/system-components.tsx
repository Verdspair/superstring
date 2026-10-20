import { useTranslation } from "react-i18next";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useSkillsResource, useToolDirectoryResource } from "../../services/connection-resources";
import { useSuperstringStore } from "../../store";
import {
  type CapabilityEntry,
  SKILL_HUMAN_LABELS,
  TOOL_HUMAN_LABELS,
} from "../../workspace/capability-catalog";

export function SystemComponents({
  entry,
  active = true,
}: {
  entry: CapabilityEntry;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const open = useSuperstringStore((s) => s.openSystemComponent);
  const apiClient = useSuperstringStore((s) => s.apiClient);

  const {
    data: toolData,
    loading: toolLoading,
    error: toolError,
    refresh: toolRefresh,
  } = useToolDirectoryResource(apiClient, active);
  const {
    data: skillData,
    loading: skillLoading,
    error: skillError,
    refresh: skillRefresh,
  } = useSkillsResource(apiClient, active);

  const associatedTools = (toolData?.tools ?? []).filter((tool) => tool.functionId === entry.id);
  const associatedSkills = (skillData?.skills ?? []).filter(
    (skill) => entry.skills.includes(skill.name) && skill.origin === "system",
  );

  const hasTools = associatedTools.length > 0;
  const hasSkills = associatedSkills.length > 0;
  const isQqReply = entry.id === "qq-reply";
  const actionNote =
    "actionNoteKey" in entry && entry.actionNoteKey ? t(entry.actionNoteKey) : null;

  const stickerTool = (toolData?.tools ?? []).find(
    (tool) => tool.name === "reply.sticker" || tool.name.startsWith("sticker."),
  );
  const isStickerOff = stickerTool ? stickerTool.globalEnabled === false : false;

  return (
    <section
      className="space-y-3 rounded-lg border bg-muted/20 p-3 text-xs"
      aria-label={t("connections.components.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
        <h2 className="font-medium text-foreground">{t("connections.components.title")}</h2>
        <span className="text-[11px] text-muted-foreground">
          {t("connections.components.noMcpDependency")}
        </span>
      </div>

      {actionNote && <p className="text-[11px] text-muted-foreground">{actionNote}</p>}

      {isQqReply && (
        <div className="space-y-1.5 pt-0.5">
          <span className="block text-[11px] font-medium text-muted-foreground">
            {t("capabilities.qqReply.runtimeAction")}
          </span>
          <div className="flex flex-wrap gap-1.5">
            <div className="inline-flex items-center gap-2 rounded-md border bg-background/50 px-2.5 py-1 text-xs">
              <Badge variant="outline" className="px-1 py-0 text-[10px] uppercase shrink-0">
                {t("connections.components.tools")}
              </Badge>
              {TOOL_HUMAN_LABELS["reply.text"] && (
                <span className="font-medium">{t(TOOL_HUMAN_LABELS["reply.text"])}</span>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">reply.text</span>
            </div>
            <div
              className={`inline-flex items-center gap-2 rounded-md border bg-background/50 px-2.5 py-1 text-xs ${
                isStickerOff ? "opacity-60 bg-muted/50" : ""
              }`}
            >
              <Badge
                variant={isStickerOff ? "secondary" : "outline"}
                className="px-1 py-0 text-[10px] uppercase shrink-0"
              >
                {t("connections.components.tools")}
              </Badge>
              {TOOL_HUMAN_LABELS["reply.sticker"] && (
                <span className="font-medium">{t(TOOL_HUMAN_LABELS["reply.sticker"])}</span>
              )}
              <span className="font-mono text-[11px] text-muted-foreground">reply.sticker</span>
              {isStickerOff && (
                <span className="text-[10px] text-destructive shrink-0">
                  ({t("connections.components.globalOff")})
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {toolError && !toolData && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-xs text-destructive">
            {toolError}
          </p>
          <Button
            variant="outline"
            size="sm"
            tooltip={t("hints.extensions.components.retry")}
            className="min-h-8 h-auto px-2.5 py-1 text-xs"
            onClick={() => toolRefresh()}
          >
            {t("capabilities.retry")}
          </Button>
        </div>
      )}

      {toolLoading && !toolData && (
        <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
      )}

      {hasTools && (
        <div className="space-y-1.5">
          <span className="block text-[11px] font-medium text-muted-foreground">
            {t("connections.components.toolsCount", { count: associatedTools.length })}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {associatedTools.map((tool) => {
              const labelKey = TOOL_HUMAN_LABELS[tool.name];
              const humanLabel = labelKey ? t(labelKey) : null;
              const isOff = tool.globalEnabled === false;
              return (
                <Button
                  key={`tool:${tool.name}`}
                  variant="outline"
                  size="sm"
                  tooltip={
                    isOff
                      ? t("hints.extensions.components.openToolOff")
                      : t("hints.extensions.components.openTool")
                  }
                  className={`min-h-8 h-auto gap-2 px-2.5 py-1 text-xs whitespace-normal break-words text-left ${
                    isOff ? "opacity-60 bg-muted/50" : ""
                  }`}
                  onClick={() => open({ kind: "tool", id: tool.name })}
                >
                  <Badge
                    variant={isOff ? "secondary" : "outline"}
                    className="px-1 py-0 text-[10px] uppercase shrink-0"
                  >
                    {t("connections.components.tools")}
                  </Badge>
                  {humanLabel && <span className="font-medium">{humanLabel}</span>}
                  <span className="font-mono text-[11px] text-muted-foreground">{tool.name}</span>
                  {isOff && (
                    <span className="text-[10px] text-destructive shrink-0">
                      ({t("connections.components.globalOff")})
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {skillError && !skillData && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-xs text-destructive">
            {skillError}
          </p>
          <Button
            variant="outline"
            size="sm"
            tooltip={t("hints.extensions.components.retry")}
            className="min-h-8 h-auto px-2.5 py-1 text-xs"
            onClick={() => skillRefresh()}
          >
            {t("capabilities.retry")}
          </Button>
        </div>
      )}

      {skillLoading && !skillData && (
        <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
      )}

      {hasSkills && (
        <div className="space-y-1.5 pt-1">
          <span className="block text-[11px] font-medium text-muted-foreground">
            {t("connections.components.skillsCount", { count: associatedSkills.length })}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {associatedSkills.map((skill) => {
              const labelKey = SKILL_HUMAN_LABELS[skill.name];
              const humanLabel = labelKey ? t(labelKey) : null;
              const isOff = skill.globalEnabled === false;
              return (
                <Button
                  key={`skill:${skill.name}`}
                  variant="outline"
                  size="sm"
                  tooltip={
                    isOff
                      ? t("hints.extensions.components.openSkillOff")
                      : t("hints.extensions.components.openSkill")
                  }
                  className={`min-h-8 h-auto gap-2 px-2.5 py-1 text-xs whitespace-normal break-words text-left ${
                    isOff ? "opacity-60 bg-muted/50" : ""
                  }`}
                  onClick={() => open({ kind: "skill", id: skill.name })}
                >
                  <Badge
                    variant={isOff ? "outline" : "secondary"}
                    className="px-1 py-0 text-[10px] uppercase shrink-0"
                  >
                    {t("connections.components.skills")}
                  </Badge>
                  {humanLabel && <span className="font-medium">{humanLabel}</span>}
                  <span className="font-mono text-[11px] text-muted-foreground">{skill.name}</span>
                  {isOff && (
                    <span className="text-[10px] text-destructive shrink-0">
                      ({t("connections.components.globalOff")})
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
