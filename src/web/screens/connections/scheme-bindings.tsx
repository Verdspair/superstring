import { Plus, RefreshCw, Search, Shield } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { QqBindingResponse, QqConversationListItem } from "../../../shared/contracts/qq";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { translateNotice } from "../../i18n";
import { formatDate } from "../../i18n/runtime";
import { useSuperstringStore } from "../../store";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { QqGroupControls } from "../conversations/QqGroupControls";
import { BindingEditor } from "./binding-editor";
import { QqConversationEntry } from "./QqConversationEntry";

/** 绑定的会话如果还没有观察行，就用绑定本身合成一行，管理入口不因缺少观察而消失。 */
const conversationOf = (
  binding: QqBindingResponse,
  rows: readonly QqConversationListItem[],
): QqConversationListItem =>
  rows.find(
    (row) =>
      row.account_id === binding.account_id &&
      row.kind === binding.kind &&
      row.peer_id === binding.peer_id,
  ) ?? {
    account_id: binding.account_id,
    kind: binding.kind,
    peer_id: binding.peer_id,
    messages: 0,
    last_at_seconds: 0,
    binding_id: binding.id,
  };

export function SchemeBindingsView({
  schemeId = null,
  picker = false,
  active = true,
}: {
  schemeId?: string | null;
  picker?: boolean;
  active?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      // 数据字段按实际读取面窄订阅；无关 store 更新不再重渲染看板。
      agents: s.agents,
      qqAccessSaving: s.qqAccessSaving,
      qqBindings: s.qqBindings,
      qqBindingsError: s.qqBindingsError,
      qqBindingsLoaded: s.qqBindingsLoaded,
      qqBindingsLoading: s.qqBindingsLoading,
      qqConversations: s.qqConversations,
      qqSchemes: s.qqSchemes,
      summaryById: s.summaryById,
      // 动作引用稳定。
      loadQqBindingDirectory: s.loadQqBindingDirectory,
      openSettingsRoute: s.openSettingsRoute,
    })),
  );
  const { loadQqBindingDirectory, qqBindingsLoaded, qqBindingsLoading, qqBindingsError } = state;
  const [pickedScheme, setPickedScheme] = useState<string | null>(null);
  // 唯一编辑器选中：绑定 id + 可选初始分区；绑定被删后不回退旧对象继续操作。
  const [editing, setEditing] = useState<{ id: string; section?: "administrators" } | null>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "group" | "private">("all");
  useEffect(() => {
    if (!active) return;
    void loadQqBindingDirectory();
  }, [active, loadQqBindingDirectory]);
  // 摘要标题索引：仅 summaryById 变化时重建一次，行内 O(1) 取标题（binding+当前 Agent 配对）。
  const titleByBinding = useMemo(() => {
    const bySource = new Map<string, Map<string, string>>();
    for (const summary of Object.values(state.summaryById)) {
      let perAgent = bySource.get(summary.sourceId);
      if (!perAgent) {
        perAgent = new Map();
        bySource.set(summary.sourceId, perAgent);
      }
      perAgent.set(summary.agentId, summary.title);
    }
    return bySource;
  }, [state.summaryById]);
  const schemes = state.qqSchemes;
  // 显式给的方案不在目录里：停在明确提示上——不退回第一个方案，也不允许把别的绑定挂上来。
  const schemeMissing = !!schemeId && !schemes.some((scheme) => scheme.id === schemeId);
  // 全局看板默认「全部方案」；选中具体方案才按方案过滤；fixed 调用永远绑定传入方案。
  const allScope = !schemeId;
  const effectiveId = schemeMissing
    ? null
    : schemeId && schemes.some((scheme) => scheme.id === schemeId)
      ? schemeId
      : (pickedScheme ?? null);
  const busy = state.qqAccessSaving || qqBindingsLoading;
  const load = () => void loadQqBindingDirectory();
  const refreshing = qqBindingsLoading && !qqBindingsLoaded && state.qqBindings.length > 0;
  if (qqBindingsLoading && !qqBindingsLoaded && !refreshing) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("schemes.bindings.reading")}
      </p>
    );
  }
  if (!qqBindingsLoaded && !refreshing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-destructive">
          {t("schemes.bindings.loadFailed")}
        </p>
        {qqBindingsError && (
          <p className="text-xs text-muted-foreground">{translateNotice(qqBindingsError)}</p>
        )}
        <Button variant="outline" size="sm" tooltip={t("hints.qq.bindingsRetry")} onClick={load}>
          {t("capabilities.retry")}
        </Button>
      </div>
    );
  }
  if (schemeMissing) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
        <p role="alert" className="text-sm text-destructive">
          {t("schemes.bindings.schemeMissing")}
        </p>
        <Button variant="outline" size="sm" tooltip={t("hints.qq.bindingsRetry")} onClick={load}>
          {t("capabilities.retry")}
        </Button>
      </div>
    );
  }
  // 没有任何方案：先创建方案再绑定，不在这里制造无方案绑定。
  if (!schemes.length) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
        <p role="status" className="text-sm text-muted-foreground">
          {t("schemes.bindings.needScheme")}
        </p>
        <Button
          variant="outline"
          size="sm"
          tooltip={t("hints.qq.createFirstScheme")}
          onClick={() => state.openSettingsRoute("scheme-library")}
        >
          <Plus />
          {t("schemes.bindings.createFirst")}
        </Button>
      </div>
    );
  }
  const selectedSchemeMissing =
    !!effectiveId && !schemes.some((scheme) => scheme.id === effectiveId);
  const bindings = selectedSchemeMissing
    ? []
    : effectiveId
      ? state.qqBindings.filter((binding) => binding.scheme_id === effectiveId)
      : allScope
        ? state.qqBindings
        : [];
  const needle = query.trim().toLocaleLowerCase(i18n.language);
  const visible = bindings.filter((binding) => {
    if (kindFilter !== "all" && binding.kind !== kindFilter) return false;
    if (!needle) return true;
    const agent = state.agents.find((row) => row.id === binding.agent_id);
    const agentName = agent?.name ?? binding.agent_id;
    const schemeName = schemes.find((scheme) => scheme.id === binding.scheme_id)?.name ?? "";
    const title = titleByBinding.get(binding.id)?.get(binding.agent_id) ?? null;
    const text =
      `${title ?? ""} ${binding.peer_id} ${binding.account_id} ${schemeName} ${agentName}`.toLocaleLowerCase(
        i18n.language,
      );
    return text.includes(needle);
  });
  const editingBinding = editing
    ? (state.qqBindings.find((binding) => binding.id === editing.id) ?? null)
    : null;
  return (
    <fieldset
      disabled={busy}
      aria-busy={qqBindingsLoading}
      className="min-w-0 space-y-4"
      data-scheme-id={effectiveId ?? "all"}
    >
      {refreshing && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("schemes.bindings.reading")}
        </p>
      )}
      <div className="space-y-3" data-bindings-scope={schemeId ? "scheme" : "global"}>
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
          {picker ? (
            <Field
              label="schemes.bindings.chooseScheme"
              tooltip={t("hints.fieldExtra.schemeUsage")}
            >
              <NativeSelect
                className="min-w-0 w-full sm:min-w-48 sm:w-auto"
                value={effectiveId ?? ""}
                disabled={busy}
                onChange={(event) => setPickedScheme(event.target.value || null)}
              >
                {!schemeId && <option value="">{t("schemes.bindings.scopeAll")}</option>}
                {!schemeId &&
                  pickedScheme &&
                  !schemes.some((scheme) => scheme.id === pickedScheme) && (
                    <option value={pickedScheme}>{t("schemes.bindings.schemeMissing")}</option>
                  )}
                {schemes.map((scheme) => (
                  <option key={scheme.id} value={scheme.id}>
                    {scheme.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <p className="min-w-0 break-words text-sm font-medium">
              {effectiveId
                ? t("schemes.bindings.scopeScheme", {
                    "0": schemes.find((scheme) => scheme.id === effectiveId)?.name ?? effectiveId,
                  })
                : t("schemes.bindings.scopeAll")}
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <QqConversationEntry
              schemeId={effectiveId}
              loadDirectory={false}
              initialKind={kindFilter === "all" ? undefined : kindFilter}
            />
            <Button
              variant="outline"
              disabled={busy}
              tooltip={t("hints.qq.reloadBindings")}
              onClick={load}
            >
              <RefreshCw />
              {t("schemes.bindings.refresh")}
            </Button>
            <WorkspaceHelp
              title={t("schemes.bindings.viewBindings")}
              description={t(
                allScope && !effectiveId
                  ? "schemes.bindings.allHint"
                  : "schemes.bindings.boardHint",
              )}
            />
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="relative min-w-0 basis-full sm:basis-64 sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              aria-label={t("connections.searchConversationBindings")}
              placeholder={t("connections.searchByNumberAgentOrScheme")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <NativeSelect
            className="min-w-0 w-full sm:w-auto sm:min-w-36"
            aria-label={t("connections.conversationType")}
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as "all" | "group" | "private")}
          >
            <option value="all">{t("connections.all")}</option>
            <option value="group">{t("connections.group")}</option>
            <option value="private">{t("connections.privateChat")}</option>
          </NativeSelect>
        </div>
      </div>
      {visible.length ? (
        <ul className="space-y-3">
          {visible.map((binding) => {
            const agent = state.agents.find((row) => row.id === binding.agent_id);
            const schemeName =
              schemes.find((scheme) => scheme.id === binding.scheme_id)?.name ?? "";
            const rowTitle = titleByBinding.get(binding.id)?.get(binding.agent_id) ?? null;
            const observation =
              state.qqConversations.find(
                (row) =>
                  row.account_id === binding.account_id &&
                  row.kind === binding.kind &&
                  row.peer_id === binding.peer_id,
              ) ?? null;
            return (
              <li
                key={binding.id}
                className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border px-3 py-4 sm:px-4"
              >
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {rowTitle && (
                      <span className="min-w-0 break-words text-sm font-medium">{rowTitle}</span>
                    )}
                    <Badge variant="outline">
                      {t(
                        binding.kind === "group" ? "connections.group" : "connections.privateChat",
                      )}
                    </Badge>
                    <span className="min-w-0 break-all font-mono text-sm">{binding.peer_id}</span>
                    {binding.paused && <Badge variant="secondary">{t("connections.paused")}</Badge>}
                  </div>
                  <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {t("schemes.qq.groupConfig.account")} {binding.account_id}
                    </span>
                    <span className="inline-flex flex-wrap items-baseline gap-1">
                      <span>{t("schemes.qq.groupConfig.agent")}</span>
                      <span className="text-sm">{agent?.name ?? t("connections.unknown")}</span>
                    </span>
                    <span>
                      {t("schemes.qq.groupConfig.baseScheme")}: {schemeName}
                    </span>
                    <span>
                      {observation && observation.last_at_seconds > 0
                        ? `${t("connections.latestMessage")} ${formatDate(
                            observation.last_at_seconds * 1000,
                            i18n.language,
                            {
                              dateStyle: "short",
                              timeStyle: "short",
                            },
                          )}`
                        : t("connections.nothingObservedYet")}
                    </span>
                  </div>
                </div>
                <div
                  className="flex w-full flex-wrap items-center gap-2 border-t pt-3"
                  data-binding-actions
                >
                  {/* 每行常显启停与「本群配置」：与目录卡片同一组件、同一写路径（只带 paused）。
                      目录由本视图读取，行内不再回读整页事实——连接状态可能保持未知，启停按目录可用。 */}
                  <QqGroupControls bindingId={binding.id} loadFacts={false} />
                  {binding.kind === "group" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-8 whitespace-normal"
                      disabled={busy}
                      tooltip={t("hints.qq.rowAdministrators")}
                      onClick={(event) => {
                        editorTrigger.current = event.currentTarget;
                        setEditing({ id: binding.id, section: "administrators" });
                      }}
                    >
                      <Shield className="size-3.5" />
                      {t("connections.administrators")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-8 whitespace-normal"
                    disabled={busy}
                    tooltip={t("hints.qq.manageThisBinding")}
                    onClick={(event) => {
                      editorTrigger.current = event.currentTarget;
                      setEditing({ id: binding.id });
                    }}
                  >
                    {t("connections.manage")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {selectedSchemeMissing
            ? t("schemes.bindings.schemeMissing")
            : bindings.length
              ? t("connections.noMatchingConversations")
              : allScope && !effectiveId
                ? t("schemes.bindings.allEmpty")
                : t("connections.noConversationUsesThisSchemeYet")}
        </p>
      )}
      {editingBinding && (
        <BindingEditor
          conversation={conversationOf(editingBinding, state.qqConversations)}
          binding={editingBinding}
          initialSection={editing?.section}
          onClose={() => setEditing(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editorTrigger.current?.focus();
          }}
        />
      )}
    </fieldset>
  );
}
