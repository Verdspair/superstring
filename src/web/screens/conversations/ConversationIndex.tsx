import {
  Bot,
  Camera,
  Check,
  Edit3,
  MessageCircle,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { AlertDialog } from "../../components/confirmation";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { sessionBusy } from "../../features/chat/conversation-state";
import { translateNotice } from "../../i18n";
import { cn } from "../../lib/utils";
import { useSuperstringStore } from "../../store";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { ConversationAvatar } from "./avatar";
import { ConversationAvatarDialog } from "./avatar-control";
import { ConversationEntryButton } from "./ConversationEntryButton";
import { QqGroupControls } from "./QqGroupControls";
import { RecordActions } from "./RecordActions";
import { useDirectoryManagement } from "./use-directory-management";

export function ConversationIndex({
  onSelected,
  active = true,
}: {
  onSelected?: () => void;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const searchHintId = useId();
  const ids = useSuperstringStore((s) => s.directoryIds);
  const summaries = useSuperstringStore((s) => s.summaryById);
  const current = useSuperstringStore((s) => s.currentConversationId);
  const agents = useSuperstringStore((s) => s.agents);
  const loading = useSuperstringStore((s) => s.directoryLoading);
  const error = useSuperstringStore((s) => s.directoryError);
  const cursor = useSuperstringStore((s) => s.directoryCursor);
  const load = useSuperstringStore((s) => s.loadConversations);
  const select = useSuperstringStore((s) => s.requestConversationNavigation);
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState("all");
  const api = useSuperstringStore((state) => state.apiClient);
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const management = useDirectoryManagement(active);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A hidden directory or replacement API must not restore a previous modal's row origin.
  const modalOrigin = useMemo(() => ({ current: null as HTMLElement | null }), [api, active]);
  useEffect(() => {
    if (!active || (avatarId && !summaries[avatarId])) setAvatarId(null);
  }, [active, avatarId, summaries]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A replacement API does not own the directory avatar dialog opened by its predecessor.
  useEffect(() => {
    setAvatarId(null);
  }, [api]);
  const header = useRef<HTMLHeadingElement>(null);
  const postDelete = useRef<object | null>(null);
  const directoryOwner = useMemo(() => ({ api, active }), [api, active]);
  const liveDirectory = useRef(directoryOwner);
  liveDirectory.current = directoryOwner;
  useEffect(
    () => () => {
      postDelete.current = null;
    },
    [],
  );
  // 常挂载删除确认在关闭动画期间仍会渲染：目标取最近一次点击删除的行。
  const lastDeleting = useRef<ConversationSummary | null>(null);
  const deleting = management.deleting ?? lastDeleting.current;
  const deletingQq = deleting?.channel === "onebot11";
  const groupEditing =
    management.editing?.channel === "onebot11" &&
    management.editing.topology === "shared" &&
    management.editing.qqGroup
      ? management.editing
      : null;
  const busy = management.busy;
  const deleteBusy = useSuperstringStore((s) =>
    sessionBusy(s, management.deleting?.sourceId ?? ""),
  );
  // Agent names are looked up per row on every render; one identity-stable map
  // keeps the filter/haystack work linear and skips it entirely when idle.
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const needle = query.trim().toLocaleLowerCase();
  const rows = ids
    .map((id) => summaries[id])
    .filter(Boolean)
    .filter((item) => {
      if (channel !== "all" && item.channel !== channel) return false;
      if (!needle) return true;
      return `${item.title} ${agentNames.get(item.agentId) ?? ""} ${item.participants.map((p) => p.label).join(" ")}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  const choose = async (id: string) => {
    await select(id);
    if (
      useSuperstringStore.getState().currentConversationId === id &&
      useSuperstringStore.getState().page === "chat"
    )
      onSelected?.();
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-muted/20"
      aria-label={t("workspace.conversation_index")}
    >
      <header className="space-y-3 border-b px-4 py-3.5">
        <h2
          ref={header}
          tabIndex={-1}
          className="sr-only outline-none focus:not-sr-only focus:rounded focus:outline-2 focus:outline-primary"
        >
          {t("workspace.conversations")}
        </h2>
        <div className="flex items-center justify-between gap-2">
          <InputGroup className="flex-1">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t("workspace.search_loaded_conversations")}
              placeholder={t("workspace.conversationSearchPlaceholder")}
              aria-describedby={searchHintId}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tooltip={t("hints.conversation.clearSearch")}
                  aria-label={t("workspace.clear_search")}
                  onClick={() => setQuery("")}
                >
                  <X />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
          <WorkspaceHelp
            title={t("workspace.search_loaded_conversations")}
            description={t("workspace.conversationSearchHint")}
          />
          <span id={searchHintId} className="sr-only">
            {t("workspace.conversationSearchHint")}
          </span>
          <ConversationEntryButton />
        </div>
        <Tabs value={channel} onValueChange={setChannel}>
          <TabsList
            presentation="compact"
            flow="wrap"
            className="w-full"
            aria-label={t("workspace.conversation_channels")}
          >
            <TabsTrigger
              value="all"
              tooltip={t("hints.custom.conversationFilter.all")}
              className="flex-1"
            >
              {t("workspace.all")}
            </TabsTrigger>
            <TabsTrigger
              value="web"
              tooltip={t("hints.custom.conversationFilter.web")}
              className="flex-1"
            >
              {t("channel.web")}
            </TabsTrigger>
            <TabsTrigger
              value="onebot11"
              tooltip={t("hints.custom.conversationFilter.onebot11")}
              className="flex-1"
            >
              {t("channel.onebot")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      <nav
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
        aria-label={t("workspace.chat_history")}
      >
        {!rows.length && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <MessageCircle className="mx-auto mb-3 size-6" />
            <p>
              {t(
                ids.length
                  ? "workspace.no_loaded_conversations_match_these_filters"
                  : "workspace.no_chats_yet_create_one_to_get_started",
              )}
            </p>
            {!!ids.length && (
              <Button
                tooltip={<Trans i18nKey="hints.complete.clearFilters" />}
                variant="link"
                onClick={() => {
                  setQuery("");
                  setChannel("all");
                }}
              >
                {t("workspace.clear_filters")}
              </Button>
            )}
          </div>
        )}
        {rows.map((item) => (
          <IndexRecord
            key={item.id}
            item={item}
            selected={item.id === current}
            agentName={agentNames.get(item.agentId)}
            disabled={management.busy}
            onSelect={() => void choose(item.id)}
            onRename={(origin) => {
              postDelete.current = null;
              modalOrigin.current = origin;
              management.rename(item);
            }}
            onRefresh={() => void management.refresh(item)}
            onDelete={(origin) => {
              postDelete.current = null;
              modalOrigin.current = origin;
              lastDeleting.current = item;
              management.remove(item);
            }}
            onConfigure={() => useSuperstringStore.getState().openQqGroupConfig(item.sourceId)}
            onAvatar={(origin) => {
              postDelete.current = null;
              modalOrigin.current = origin;
              setAvatarId(item.id);
            }}
          />
        ))}
      </nav>
      <footer className="space-y-2 border-t p-3 text-xs text-muted-foreground">
        {(error || (management.notice && !management.editing && !management.deleting)) && (
          <p role="alert" className="text-destructive">
            {translateNotice(error || management.notice)}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span role="status">
            {loading
              ? t("workspace.loading_conversation")
              : t("workspace.conversations_loaded", { "0": ids.length })}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            tooltip={t("hints.conversation.refreshDirectory")}
            aria-label={t("workspace.refresh_conversations")}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button>
        </div>
        {cursor && (
          <Button
            tooltip={<Trans i18nKey="hints.complete.loadMore" />}
            variant="outline"
            className="w-full"
            size="sm"
            disabled={loading}
            onClick={() => void load("more")}
          >
            {t("workspace.load_more_conversations")}
          </Button>
        )}
      </footer>
      <Dialog
        open={!!management.editing}
        onOpenChange={(open) => {
          if (!open) management.cancel();
        }}
      >
        <DialogContent returnFocusRef={modalOrigin} scrollMode="surface" showCloseButton={!busy}>
          <DialogTitle>{t("workspace.rename_conversation")}</DialogTitle>
          <DialogDescription>
            {groupEditing
              ? t("workspace.qq_group_rename_hint")
              : t("workspace.use_a_name_of_1_200_characters")}
          </DialogDescription>
          <Input
            aria-label={t("workspace.conversation_name")}
            value={management.name}
            placeholder={
              groupEditing ? (groupEditing.qqGroup?.originalName ?? groupEditing.title) : undefined
            }
            onChange={(e) => management.setName(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => {
              const trimmed = management.name.trim();
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                (groupEditing
                  ? [...trimmed].length <= 100
                  : !!trimmed && [...trimmed].length <= 200)
              ) {
                e.preventDefault();
                void management.save();
              }
            }}
          />
          {management.notice && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(management.notice)}
            </p>
          )}
          <DialogFooter>
            <Button
              tooltip={<Trans i18nKey="hints.complete.cancel" />}
              variant="outline"
              disabled={busy}
              onClick={management.cancel}
            >
              {t("workspace.cancel")}
            </Button>
            <Button
              tooltip={<Trans i18nKey="hints.complete.nameSave" />}
              disabled={
                busy ||
                (groupEditing
                  ? [...management.name.trim()].length > 100
                  : !management.name.trim() || [...management.name.trim()].length > 200)
              }
              onClick={() => void management.save()}
            >
              {busy ? t("workspace.saving") : t("workspace.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {active && avatarId && summaries[avatarId] && (
        <ConversationAvatarDialog
          key={avatarId}
          conversation={summaries[avatarId]}
          returnFocusRef={modalOrigin}
          open
          onOpenChange={(open) => {
            if (!open) setAvatarId(null);
          }}
        />
      )}
      <AlertDialog
        returnFocusRef={modalOrigin}
        open={management.deleting !== null}
        title={t(deletingQq ? "qq.conversation.removeTitle" : "workspace.delete_chat")}
        busy={management.busy}
        onCancel={management.cancel}
      >
        {deleting && (
          <>
            <p className="text-sm">
              {t(
                deletingQq
                  ? "qq.conversation.removeHint"
                  : "workspace.delete_and_all_its_messages_this_cannot_be_undone",
                { "0": deleting.title, name: deleting.title },
              )}
            </p>
            {management.notice && (
              <p role="alert" className="text-sm text-destructive">
                {translateNotice(management.notice)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                tooltip={<Trans i18nKey="hints.complete.cancel" />}
                variant="outline"
                data-dialog-cancel
                disabled={management.busy}
                onClick={management.cancel}
              >
                {t("workspace.cancel")}
              </Button>
              <Button
                tooltip={<Trans i18nKey="hints.complete.delete" />}
                variant="destructive"
                disabled={management.busy || deleteBusy}
                onClick={() => {
                  const target = management.deleting;
                  const destination = header.current;
                  if (!target || !destination) return;
                  const operation = {};
                  const owner = directoryOwner;
                  postDelete.current = operation;
                  void management.confirmDelete()?.then((removed) => {
                    const current = useSuperstringStore.getState();
                    if (
                      removed !== true ||
                      postDelete.current !== operation ||
                      current.apiClient !== api ||
                      liveDirectory.current !== owner ||
                      !liveDirectory.current.active ||
                      lastDeleting.current !== target ||
                      current.summaryById[target.id] ||
                      header.current !== destination ||
                      !destination.isConnected
                    )
                      return;
                    for (
                      let node: HTMLElement | null = destination;
                      node;
                      node = node.parentElement
                    ) {
                      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
                      if (
                        node.hidden ||
                        node.hasAttribute("inert") ||
                        style?.display === "none" ||
                        style?.visibility === "hidden" ||
                        style?.visibility === "collapse"
                      )
                        return;
                    }
                    postDelete.current = null;
                    destination.focus();
                  });
                }}
              >
                {management.busy
                  ? t("workspace.deleting")
                  : t(deletingQq ? "qq.conversation.remove" : "workspace.delete")}
              </Button>
            </div>
          </>
        )}
      </AlertDialog>
    </section>
  );
}
function IndexRecord({
  item,
  selected,
  agentName,
  disabled,
  onSelect,
  onRename,
  onRefresh,
  onDelete,
  onConfigure,
  onAvatar,
}: {
  item: ConversationSummary;
  selected: boolean;
  agentName?: string;
  disabled: boolean;
  onSelect: () => void;
  onRename: (origin: HTMLElement | null) => void;
  onRefresh: () => void;
  onDelete: (origin: HTMLElement | null) => void;
  onConfigure: () => void;
  onAvatar: (origin: HTMLElement | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const busy = useSuperstringStore((s) => sessionBusy(s, item.sourceId));
  const phase = useSuperstringStore(
    (s) => s.conversationById[s.sessionConversationIds[item.sourceId]]?.phase,
  );
  return (
    <RecordActions
      label={t("workspace.conversation_actions", { "0": item.title })}
      disabled={disabled}
      actions={[
        {
          label: t("avatar.edit"),
          tooltip: t("hints.complete.avatarEdit"),
          icon: Camera,
          run: onAvatar,
        },
        ...(item.channel === "web"
          ? [
              {
                label: t("workspace.rename"),
                tooltip: t("hints.recordMenu.rename"),
                icon: Edit3,
                run: onRename,
              },
              {
                label: t("workspace.refresh_chat"),
                tooltip: t("hints.recordMenu.refresh"),
                icon: RefreshCw,
                disabled: busy,
                run: onRefresh,
              },
              {
                label: t("workspace.delete_chat"),
                tooltip: t("hints.recordMenu.deleteConversation"),
                icon: Trash2,
                disabled: busy,
                destructive: true,
                run: onDelete,
              },
            ]
          : item.channel === "onebot11"
            ? [
                ...(item.topology === "shared" && item.qqGroup
                  ? [
                      {
                        label: t("workspace.rename"),
                        tooltip: t("hints.recordMenu.rename"),
                        icon: Edit3,
                        run: onRename,
                      },
                    ]
                  : []),
                {
                  label: t(
                    item.topology === "shared"
                      ? "schemes.qq.groupConfig.controls.configure"
                      : "qq.conversation.privateConfig",
                  ),
                  tooltip: t("hints.conversation.qqConfigure"),
                  icon: Settings2,
                  run: onConfigure,
                },
                {
                  label: t("qq.conversation.remove"),
                  tooltip: t("hints.recordMenu.deleteConversation"),
                  icon: Trash2,
                  disabled: busy,
                  destructive: true,
                  run: onDelete,
                },
              ]
            : []),
      ]}
    >
      {(trigger) => (
        <div
          className={cn(
            "group mb-3 rounded-xl border p-2 transition-colors",
            selected ? "border-primary/40 bg-primary/5" : "border-border bg-card hover:bg-muted/60",
          )}
        >
          {/* QQ 卡片常显启停与配置入口：独立一行放在标题/选择按钮上方，点控件不选中会话。 */}
          {item.channel === "onebot11" && (
            <div className="px-2 pb-2 pt-2">
              <QqGroupControls bindingId={item.sourceId} expectedAgentId={item.agentId} />
            </div>
          )}
          <div className="flex items-start">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-lg p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-source-id={item.sourceId}
                  aria-current={selected ? "page" : undefined}
                  aria-label={item.title}
                  disabled={disabled}
                  onClick={onSelect}
                >
                  <div className="flex items-center gap-2">
                    <ConversationAvatar
                      conversation={item}
                      value={item.avatar}
                      className="size-9"
                    />
                    <strong className="truncate text-sm font-medium">{item.title}</strong>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="px-1 py-0 text-[9px]">
                      {item.channel === "web"
                        ? "Web"
                        : item.topology === "shared"
                          ? t("workspace.onebot_group")
                          : t("workspace.onebot_direct")}
                    </Badge>
                    <Bot className="size-3 shrink-0" />
                    <span className="truncate">{agentName ?? "Agent"}</span>
                    {item.qqGroup && (
                      <span className="font-mono" title={t("workspace.group_number")}>
                        {item.qqGroup.number}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <time dateTime={item.updatedAt}>
                      {new Date(item.updatedAt).toLocaleDateString(i18n.resolvedLanguage)}
                    </time>
                    {phase && phase !== "idle" && (
                      <span
                        role="status"
                        className={phase === "failed" ? "text-destructive" : "text-primary"}
                      >
                        {t(
                          phase === "failed"
                            ? "workspace.run_failed"
                            : phase === "reconciling"
                              ? "workspace.result_unconfirmed"
                              : "workspace.processing",
                        )}
                      </span>
                    )}
                    {selected && (!phase || phase === "idle") && (
                      <Check className="size-3 text-primary" />
                    )}
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("strict.hints.conversationSelect")}</TooltipContent>
            </Tooltip>
            {trigger}
          </div>
        </div>
      )}
    </RecordActions>
  );
}
