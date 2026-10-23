import { LockKeyhole, PanelLeft, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../components/ui/resizable";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { selectedConversation } from "../../features/conversations/directory-state";
import { useIsMobile } from "../../hooks/use-mobile";
import type { ConversationScope, ConversationView } from "../../state/types";
import { useSuperstringStore } from "../../store";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { ConversationActivity } from "../observability/ConversationActivity";
import { ObservabilityWorkspace } from "../observability/ObservabilityWorkspace";
import { TaskLedger } from "../runs/task-ledger";
import { ConversationIndex } from "./ConversationIndex";
import { DirectConversation } from "./DirectConversation";
import { ExternalConversation } from "./ExternalConversation";

export function ConversationWorkspace({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const conversation = useSuperstringStore(selectedConversation);
  const view = useSuperstringStore((s) => s.conversationView);
  const scope = useSuperstringStore((s) => s.conversationScope);
  const requestView = useSuperstringStore((s) => s.requestConversationView);
  const [directory, setDirectory] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const selected = conversation?.id;
  useEffect(() => {
    if (selected) setDirectory(false);
  }, [selected]);
  // 没有选中会话时「当前会话」没有对象：运行观测与任务自动按全局展示。
  const global = !conversation || scope === "global";
  const isActivity = view === "activity";
  const activityScopeKey = global ? "global" : (conversation?.id ?? "none");
  const [visitedActivityScopes, setVisitedActivityScopes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isActivity) {
      setVisitedActivityScopes((prev) =>
        prev[activityScopeKey] ? prev : { ...prev, [activityScopeKey]: true },
      );
    }
  }, [isActivity, activityScopeKey]);

  const isTasks = view === "tasks";
  const tasksScopeKey = global ? "global" : (conversation?.id ?? "none");
  const [visitedTasksScopes, setVisitedTasksScopes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isTasks) {
      setVisitedTasksScopes((prev) =>
        prev[tasksScopeKey] ? prev : { ...prev, [tasksScopeKey]: true },
      );
    }
  }, [isTasks, tasksScopeKey]);

  useEffect(() => {
    if (!global) setCollapsed(false);
  }, [global]);
  const switchView = (value: string) => {
    const next = value as ConversationView;
    // 消息页签明确回到当前会话；运行/任务页签保留正在查看的范围（全局不因切页签被改回当前）。
    requestView(next, next === "messages" ? "current" : scope);
  };
  const switchScope = (value: ConversationScope) => requestView(view, value);
  const canvas = () => (
    <section
      data-slot="conversation-surface"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={t("workspace.current_conversation")}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          hidden={view !== "messages"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          {conversation?.channel === "onebot11" ? (
            <ExternalConversation
              key={conversation.id}
              conversation={conversation}
              active={active && view === "messages"}
            />
          ) : (
            <DirectConversation
              key={conversation?.id ?? "none"}
              active={active && view === "messages"}
            />
          )}
        </div>
        {(isActivity || visitedActivityScopes[activityScopeKey]) && (
          <div
            key={activityScopeKey}
            hidden={!isActivity}
            className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
          >
            {global ? (
              <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
                <ObservabilityWorkspace active={active && isActivity} />
              </div>
            ) : (
              conversation && (
                <ConversationActivity
                  key={conversation.id}
                  conversationId={conversation.id}
                  active={active && isActivity}
                />
              )
            )}
          </div>
        )}
        {(isTasks || visitedTasksScopes[tasksScopeKey]) && (
          <div
            key={`tasks-${tasksScopeKey}`}
            hidden={!isTasks}
            className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
          >
            <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
              {conversation && !global ? (
                <TaskLedger
                  key={conversation.id}
                  conversationId={conversation.id}
                  active={active && isTasks}
                />
              ) : (
                <TaskLedger key="global" active={active && isTasks} />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
  // 折叠只隐藏左侧面板，画布子树不换位：消息滚动、草稿与弹窗状态不因折叠丢失。
  const hideDirectory = collapsed && global;
  const showDirectoryToggle = collapsed || (global && view !== "messages");
  return (
    <Sheet open={directory} onOpenChange={setDirectory}>
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 max-[768px]:px-3">
          <h1 className="sr-only">{t("workspace.conversations")}</h1>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {mobile && (
              <SheetTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  tooltip={t("hints.conversation.openIndex")}
                  aria-label={t("workspace.open_conversation_index")}
                >
                  <PanelLeft />
                </Button>
              </SheetTrigger>
            )}
            <Tabs value={view} onValueChange={switchView} className="min-w-0 max-w-full">
              <TabsList
                aria-label={t("workspace.conversation_view")}
                className="h-auto group-data-horizontal/tabs:h-auto w-fit max-w-full justify-start flex-wrap gap-[6px] rounded-[10px] border border-border bg-muted p-[4px] [&_[role=tab]]:h-[32px] [&_[role=tab]]:rounded-[6px] [&_[role=tab]]:shrink-0 [&_[role=tab]]:flex-none [&_[role=tab]]:border-0 [&_[role=tab][data-state=active]]:border [&_[role=tab][data-state=active]]:border-border [&_[role=tab][data-state=active]]:bg-card [&_[role=tab][data-state=active]]:font-semibold [&_[role=tab]]:px-[14px] [&_[role=tab]]:text-[13px] [&_[role=tab]]:font-medium"
              >
                <TabsTrigger value="messages">{t("workspace.message_history")}</TabsTrigger>
                <TabsTrigger value="activity">{t("workspace.runtime_observability")}</TabsTrigger>
                <TabsTrigger value="tasks">{t("connections.tasks.title")}</TabsTrigger>
              </TabsList>
            </Tabs>
            <WorkspaceHelp
              title={t("workspace.conversations")}
              description={t("workspace.search_select_or_create_a_conversation")}
            />
          </div>

          {view === "messages" &&
            (conversation?.channel === "onebot11" || (!mobile && collapsed)) && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {conversation?.channel === "onebot11" && (
                  <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-full border border-border/60 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    <LockKeyhole className="size-3 text-muted-foreground/80" />
                    <span
                      className="truncate"
                      title={t("workspace.read_only_conversation_history")}
                    >
                      {t("workspace.read_only_conversation_history")}
                    </span>
                  </span>
                )}
                {!mobile && collapsed && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    tooltip={t("hints.conversation.toggleDirectory")}
                    aria-label={t("workspace.conversationHub.expandDirectory")}
                    onClick={() => setCollapsed(false)}
                  >
                    <PanelLeftOpen />
                  </Button>
                )}
              </div>
            )}

          {view !== "messages" && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <fieldset
                aria-label={t("workspace.conversationHub.scope")}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-border/40 bg-muted/30 p-0.5"
              >
                <Button
                  size="sm"
                  variant={global ? "ghost" : "secondary"}
                  tooltip={t("hints.conversation.scopeCurrent")}
                  aria-pressed={!global}
                  disabled={!conversation}
                  onClick={() => switchScope("current")}
                >
                  {t("workspace.conversationHub.scopeCurrent")}
                </Button>
                <Button
                  size="sm"
                  variant={global ? "secondary" : "ghost"}
                  tooltip={t("hints.conversation.scopeGlobal")}
                  aria-pressed={global}
                  onClick={() => switchScope("global")}
                >
                  {t("workspace.conversationHub.scopeGlobal")}
                </Button>
                {conversation && (
                  <span
                    className="min-w-0 max-w-[200px] truncate px-1.5 text-xs text-muted-foreground"
                    title={conversation.title}
                    style={global ? { display: "none" } : undefined}
                    aria-hidden={global}
                  >
                    {t("workspace.conversationHub.currentScope", { "0": conversation.title })}
                  </span>
                )}
              </fieldset>
              {!mobile && showDirectoryToggle && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  tooltip={t("hints.conversation.toggleDirectory")}
                  aria-label={t(
                    collapsed
                      ? "workspace.conversationHub.expandDirectory"
                      : "workspace.conversationHub.collapseDirectory",
                  )}
                  onClick={() => setCollapsed((value) => !value)}
                >
                  {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                </Button>
              )}
            </div>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          <ResizablePanelGroup
            orientation="horizontal"
            className="h-full"
            resizeTargetMinimumSize={{ fine: 12, coarse: 24 }}
          >
            {!mobile && !hideDirectory && (
              <ResizablePanel
                id="conversation-index"
                defaultSize="260px"
                minSize="200px"
                maxSize="420px"
                groupResizeBehavior="preserve-pixel-size"
              >
                <ConversationIndex />
              </ResizablePanel>
            )}
            {!mobile && !hideDirectory && (
              <ResizableHandle
                aria-label={t("workspace.resize_conversation_index")}
                title={t("hints.conversation.resizeIndex")}
                className="w-px cursor-col-resize bg-border hover:bg-border focus-visible:bg-border"
              />
            )}
            <ResizablePanel id="conversation-canvas" minSize={mobile ? "0px" : "380px"}>
              {canvas()}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
      {mobile && (
        <SheetContent side="left" className="w-[min(22rem,100vw-2rem)] p-0" showCloseButton={false}>
          <SheetHeader className="sr-only">
            <SheetTitle>{t("workspace.conversation_index")}</SheetTitle>
            <SheetDescription>
              {t("workspace.search_select_or_create_a_conversation")}
            </SheetDescription>
          </SheetHeader>
          <ConversationIndex onSelected={() => setDirectory(false)} />
          <SheetClose asChild>
            <Button
              variant="outline"
              size="icon-sm"
              tooltip={t("hints.conversation.closeIndex")}
              aria-label={t("workspace.close_conversation_index")}
              className="absolute right-3 top-2"
            >
              <X />
            </Button>
          </SheetClose>
        </SheetContent>
      )}
    </Sheet>
  );
}
