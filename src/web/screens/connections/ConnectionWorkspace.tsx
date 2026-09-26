import { Cable, Plus, RefreshCw, Search, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QqConversationListItem } from "../../../shared/contracts/qq";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { BindingEditor, ManualBinding } from "./binding-editor";
import { SchemeStudio } from "./scheme-studio";
import { StorageInventory } from "./storage-inventory";
import { TransportSettings } from "./transport-settings";

const phaseNames: Record<string, string> = {
  unavailable: "connections.thisProcessHasNoTransportRuntime",
  idle: "connections.notConnected",
  connecting: "connections.connecting",
  verifying: "connections.verifying",
  ready: "connections.connected",
  closed: "connections.connectionClosed",
};

/** Connection health, participation and shared policies are separate editing tasks. */
export function ConnectionWorkspace() {
  const { t, i18n } = useTranslation();
  const state = useSuperstringStore();
  const [transportOpen, setTransportOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const { loadQqAccess } = state;
  useEffect(() => {
    void loadQqAccess();
  }, [loadQqAccess]);
  const rows = useMemo(() => {
    const observed = [...state.qqConversations];
    for (const binding of state.qqBindings) {
      if (
        !observed.some(
          (row) =>
            row.account_id === binding.account_id &&
            row.kind === binding.kind &&
            row.peer_id === binding.peer_id,
        )
      ) {
        observed.push({
          account_id: binding.account_id,
          kind: binding.kind,
          peer_id: binding.peer_id,
          messages: 0,
          last_at_seconds: 0,
          binding_id: binding.id,
        });
      }
    }
    return observed;
  }, [state.qqConversations, state.qqBindings]);
  const keyOf = (row: QqConversationListItem) => `${row.account_id}:${row.kind}:${row.peer_id}`;
  const bindingOf = (row: QqConversationListItem) =>
    state.qqBindings.find(
      (b) => b.account_id === row.account_id && b.kind === row.kind && b.peer_id === row.peer_id,
    ) ?? null;
  const visible = rows.filter((row) => {
    const binding = bindingOf(row);
    const agent = state.agents.find((a) => a.id === binding?.agent_id);
    const scheme = state.qqSchemes.find((s) => s.id === binding?.scheme_id);
    return (
      (filter === "all" || filter === row.kind || (filter === "unbound" && !binding)) &&
      `${row.peer_id} ${agent?.name ?? ""} ${scheme?.name ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    );
  });
  const active = rows.find((row) => keyOf(row) === selected);
  const tab =
    state.settingsView === "operating-mode"
      ? "bindings"
      : state.settingsRoute === "qq-scheme-config"
        ? "schemes"
        : state.settingsRoute === "qq-storage"
          ? "storage"
          : "bindings";
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t("connections.connectionsWorkspace")}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5 lg:px-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Cable className="size-4 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">{t("connections.access")}</h1>
            <Badge variant={state.qqConnection?.phase === "ready" ? "secondary" : "outline"}>
              {state.qqConnection
                ? t(phaseNames[state.qqConnection.phase] ?? state.qqConnection.phase)
                : t("connections.unknown")}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("connections.letAgentsParticipateInRealConversationsManageConnectionsBindings")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("connections.refreshState")}
            onClick={() => void state.refreshQqConnection()}
          >
            <RefreshCw />
          </Button>
          <Button variant="outline" onClick={() => setTransportOpen(true)}>
            <Settings2 />
            {t("connections.connectionSettings")}
          </Button>
        </div>
      </header>
      {state.error && (
        <p role="alert" className="px-6 py-2 text-sm text-destructive">
          {translateNotice(state.error)}
        </p>
      )}
      {state.feedback && (
        <p role="status" className="px-6 py-2 text-sm text-muted-foreground">
          {translateNotice(state.feedback)}
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) =>
          value === "bindings"
            ? state.requestPageNavigation("settings", "operating-mode")
            : state.openSettingsRoute(value === "schemes" ? "qq-scheme-config" : "qq-storage")
        }
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="border-b px-6 py-3 lg:px-8">
          <TabsList>
            <TabsTrigger value="bindings">{t("connections.conversationBindings")}</TabsTrigger>
            <TabsTrigger value="schemes">{t("connections.sharedSchemes")}</TabsTrigger>
            <TabsTrigger value="storage">{t("connections.dataRetention")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="bindings" className="m-0 min-h-0 overflow-y-auto px-6 py-6 lg:px-8">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label={t("connections.searchConversationBindings")}
                placeholder={t("connections.searchByNumberAgentOrScheme")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <NativeSelect
              aria-label={t("connections.conversationType")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">{t("connections.all")}</option>
              <option value="group">{t("connections.group")}</option>
              <option value="private">{t("connections.privateChat")}</option>
              <option value="unbound">{t("connections.notBound")}</option>
            </NativeSelect>
            <Button onClick={() => setManualOpen(true)}>
              <Plus />
              {t("connections.bindConversation")}
            </Button>
          </div>
          {state.qqAccessLoading && (
            <p role="status" className="mb-3 text-sm text-muted-foreground">
              {t("connections.readingTheAccessState")}
            </p>
          )}
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("connections.conversation")}</TableHead>
                  <TableHead>{t("connections.assistant")}</TableHead>
                  <TableHead>{t("connections.schemes")}</TableHead>
                  <TableHead>{t("connections.status")}</TableHead>
                  <TableHead>{t("connections.latestMessage")}</TableHead>
                  <TableHead className="text-right">{t("connections.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => {
                  const binding = bindingOf(row);
                  return (
                    <TableRow key={keyOf(row)}>
                      <TableCell className="font-medium">
                        <span className="mr-2 text-muted-foreground">
                          {t(
                            row.kind === "group" ? "connections.group" : "connections.privateChat",
                          )}
                        </span>
                        {row.peer_id}
                      </TableCell>
                      <TableCell>
                        {state.agents.find((a) => a.id === binding?.agent_id)?.name ?? "—"}
                      </TableCell>
                      <TableCell>
                        {state.qqSchemes.find((s) => s.id === binding?.scheme_id)?.name ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {t(
                            !binding
                              ? "connections.notBound"
                              : binding.paused
                                ? "connections.paused"
                                : "connections.takingPart",
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.last_at_seconds
                          ? new Date(row.last_at_seconds * 1000).toLocaleString(i18n.language)
                          : t("connections.nothingObservedYet")}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSelected(keyOf(row))}>
                          {t("connections.manage")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!visible.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-40 text-center text-muted-foreground">
                      {query || filter !== "all"
                        ? t("connections.noMatchingConversations")
                        : t("connections.bindAGroupOrPrivateChatToEstablishA")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("connections.messagesAreRecordedOnlyAfterBindingYouCanBind")}
          </p>
        </TabsContent>
        <TabsContent value="schemes" className="m-0 min-h-0 flex-1 overflow-hidden">
          <SchemeStudio />
        </TabsContent>
        <TabsContent value="storage" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <StorageInventory />
        </TabsContent>
      </Tabs>
      {transportOpen && <TransportSettings onClose={() => setTransportOpen(false)} />}
      {manualOpen && <ManualBinding onClose={() => setManualOpen(false)} />}
      {active && (
        <BindingEditor
          conversation={active}
          binding={bindingOf(active)}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
