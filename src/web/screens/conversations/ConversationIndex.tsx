import {
  Bot,
  Check,
  Edit3,
  MessageCircle,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { CreateConversation } from "./CreateConversation";
import { RecordActions } from "./RecordActions";
import { useDirectoryManagement } from "./use-directory-management";

export function ConversationIndex({ onSelected }: { onSelected?: () => void }) {
  const { t } = useTranslation();
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
  const management = useDirectoryManagement();
  const header = useRef<HTMLHeadingElement>(null);
  const deleteBusy = useSuperstringStore((s) =>
    sessionBusy(s, management.deleting?.sourceId ?? ""),
  );
  const rows = ids
    .map((id) => summaries[id])
    .filter(Boolean)
    .filter(
      (item) =>
        (channel === "all" || item.channel === channel) &&
        `${item.title} ${agents.find((agent) => agent.id === item.agentId)?.name ?? ""} ${item.participants.map((p) => p.label).join(" ")}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    );
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
      <header className="space-y-4 border-b px-4 pb-4 pt-6">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
              {t("brand.wordmark")}
            </p>
            <h2
              ref={header}
              tabIndex={-1}
              className="mt-1 text-xl font-semibold tracking-tight outline-none"
            >
              {t("workspace.conversations")}
            </h2>
          </div>
          <CreateConversation />
        </div>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("workspace.search_loaded_conversations")}
            placeholder={t("workspace.search_loaded_conversations")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <InputGroupAddon align="inline-end">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("workspace.clear_search")}
                onClick={() => setQuery("")}
              >
                <X />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Tabs value={channel} onValueChange={setChannel}>
          <TabsList className="w-full" aria-label={t("workspace.conversation_channels")}>
            <TabsTrigger value="all" className="flex-1">
              {t("workspace.all")}
            </TabsTrigger>
            <TabsTrigger value="web" className="flex-1">
              {t("channel.web")}
            </TabsTrigger>
            <TabsTrigger value="onebot11" className="flex-1">
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
            agentName={agents.find((agent) => agent.id === item.agentId)?.name}
            disabled={management.busy}
            onSelect={() => void choose(item.id)}
            onRename={() => management.rename(item)}
            onRefresh={() => void management.refresh(item)}
            onDelete={() => management.remove(item)}
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
            aria-label={t("workspace.refresh_conversations")}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button>
        </div>
        {cursor && (
          <Button
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
        <DialogContent showCloseButton={!management.busy}>
          <DialogTitle>{t("workspace.rename_conversation")}</DialogTitle>
          <DialogDescription>{t("workspace.use_a_name_of_1_200_characters")}</DialogDescription>
          <Input
            aria-label={t("workspace.conversation_name")}
            value={management.name}
            onChange={(e) => management.setName(e.target.value)}
            disabled={management.busy}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                management.name.trim() &&
                [...management.name.trim()].length <= 200
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
            <Button variant="outline" disabled={management.busy} onClick={management.cancel}>
              {t("workspace.cancel")}
            </Button>
            <Button
              disabled={
                management.busy ||
                !management.name.trim() ||
                [...management.name.trim()].length > 200
              }
              onClick={() => void management.save()}
            >
              {management.busy ? t("workspace.saving") : t("workspace.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {management.deleting && (
        <AlertDialog
          title={t("workspace.delete_chat")}
          busy={management.busy}
          onCancel={management.cancel}
        >
          <p className="text-sm">
            {t("workspace.delete_and_all_its_messages_this_cannot_be_undone", {
              "0": management.deleting.title,
            })}
          </p>
          {management.notice && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(management.notice)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              data-dialog-cancel
              disabled={management.busy}
              onClick={management.cancel}
            >
              {t("workspace.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={management.busy || deleteBusy}
              onClick={() =>
                void management.confirmDelete()?.then(() => {
                  if (!useSuperstringStore.getState().summaryById[management.deleting?.id ?? ""])
                    header.current?.focus();
                })
              }
            >
              {management.busy ? t("workspace.deleting") : t("workspace.delete")}
            </Button>
          </div>
        </AlertDialog>
      )}
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
}: {
  item: ConversationSummary;
  selected: boolean;
  agentName?: string;
  disabled: boolean;
  onSelect: () => void;
  onRename: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const busy = useSuperstringStore((s) => sessionBusy(s, item.sourceId));
  const phase = useSuperstringStore(
    (s) => s.conversationById[s.sessionConversationIds[item.sourceId]]?.phase,
  );
  const Glyph = item.topology === "shared" ? Users : MessageCircle;
  return (
    <RecordActions
      label={t("workspace.conversation_actions", { "0": item.title })}
      disabled={disabled || item.channel !== "web"}
      actions={[
        { label: t("workspace.rename"), icon: Edit3, run: onRename },
        { label: t("workspace.refresh_chat"), icon: RefreshCw, disabled: busy, run: onRefresh },
        {
          label: t("workspace.delete_chat"),
          icon: Trash2,
          disabled: busy,
          destructive: true,
          run: onDelete,
        },
      ]}
    >
      {(trigger) => (
        <div
          className={cn(
            "group mb-1 flex items-start rounded-xl border border-transparent p-1 transition-colors",
            selected ? "border-border bg-background shadow-xs" : "hover:bg-muted/60",
          )}
        >
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
              <Glyph
                className={cn(
                  "size-4 shrink-0",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
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
          {trigger}
        </div>
      )}
    </RecordActions>
  );
}
