import { LockKeyhole, PanelLeft, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
import { ConversationActivity } from "../observability/ConversationActivity";
import { ObservabilityWorkspace } from "../observability/ObservabilityWorkspace";
import { TaskLedger } from "../runs/task-ledger";
import { ConversationIndex } from "./ConversationIndex";
import { DirectConversation } from "./DirectConversation";
import { ExternalConversation } from "./ExternalConversation";

export function ConversationWorkspace() {
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
  useEffect(() => {
    if (!global) setCollapsed(false);
  }, [global]);
  const switchView = (value: string) => {
    const next = value as ConversationView;
    // 消息页签明确回到当前会话；运行/任务页签保留正在查看的范围（全局不因切页签被改回当前）。
    requestView(next, next === "messages" ? "current" : scope);
  };
  const switchScope = (value: ConversationScope) => requestView(view, value);
  const canvas = (directoryTrigger?: ReactNode) => (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={t("workspace.current_conversation")}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {directoryTrigger}
          <Tabs value={view} onValueChange={switchView} className="min-w-0 max-w-full">
            <TabsList
              aria-label={t("workspace.conversation_view")}
              className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal"
            >
              <TabsTrigger value="messages">{t("workspace.message_history")}</TabsTrigger>
              <TabsTrigger value="activity">{t("workspace.runtime_observability")}</TabsTrigger>
              <TabsTrigger value="tasks">{t("connections.tasks.title")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view === "messages" && conversation?.channel === "onebot11" && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LockKeyhole className="size-3" />
              {t("workspace.read_only_conversation_history")}
            </span>
          )}
          {view !== "messages" && (
            <fieldset
              aria-label={t("workspace.conversationHub.scope")}
              className="flex flex-wrap items-center gap-1"
            >
              <Button
                size="sm"
                variant={global ? "ghost" : "secondary"}
                aria-pressed={!global}
                disabled={!conversation}
                onClick={() => switchScope("current")}
              >
                {t("workspace.conversationHub.scopeCurrent")}
              </Button>
              <Button
                size="sm"
                variant={global ? "secondary" : "ghost"}
                aria-pressed={global}
                onClick={() => switchScope("global")}
              >
                {t("workspace.conversationHub.scopeGlobal")}
              </Button>
              {!global && conversation && (
                <span className="max-w-full break-words text-xs text-muted-foreground">
                  {t("workspace.conversationHub.currentScope", { "0": conversation.title })}
                </span>
              )}
            </fieldset>
          )}
          {!mobile && (collapsed || (global && view !== "messages")) && (
            <Button
              size="icon-sm"
              variant="ghost"
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
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          hidden={view !== "messages"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          {conversation?.channel === "onebot11" ? (
            <ExternalConversation
              key={conversation.id}
              conversation={conversation}
              active={view === "messages"}
            />
          ) : (
            <DirectConversation key={conversation?.id ?? "none"} active={view === "messages"} />
          )}
        </div>
        {view === "activity" &&
          (global ? (
            <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
              <ObservabilityWorkspace />
            </div>
          ) : (
            <ConversationActivity key={conversation.id} conversationId={conversation.id} />
          ))}
        {view === "tasks" && (
          <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
            {conversation && !global ? (
              <TaskLedger key={conversation.id} conversationId={conversation.id} />
            ) : (
              <TaskLedger key="global" />
            )}
          </div>
        )}
      </div>
    </section>
  );
  if (mobile)
    return (
      <Sheet open={directory} onOpenChange={setDirectory}>
        <div className="h-full">
          {canvas(
            <SheetTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("workspace.open_conversation_index")}
              >
                <PanelLeft />
              </Button>
            </SheetTrigger>,
          )}
        </div>
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
              aria-label={t("workspace.close_conversation_index")}
              className="absolute right-3 top-2"
            >
              <X />
            </Button>
          </SheetClose>
        </SheetContent>
      </Sheet>
    );
  // 折叠只隐藏左侧面板，画布子树不换位：消息滚动、草稿与弹窗状态不因折叠丢失。
  const hideDirectory = collapsed && global;
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      {!hideDirectory && (
        <ResizablePanel id="conversation-index" defaultSize="310px" minSize="250px" maxSize="420px">
          <ConversationIndex />
        </ResizablePanel>
      )}
      {!hideDirectory && <ResizableHandle withHandle />}
      <ResizablePanel id="conversation-canvas" minSize="380px">
        {canvas()}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
