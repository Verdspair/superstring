import { Plus, RefreshCw, Search, Shield } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { QqBindingResponse, QqConversationListItem } from "../../../shared/contracts/qq";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { manualBindingTarget, qqConversationKey } from "../../features/qq/draft-state";
import { translateNotice } from "../../i18n";
import { formatDate } from "../../i18n/runtime";
import type { SuperstringState } from "../../state/types";
import { useSuperstringStore } from "../../store";
import { QqGroupControls } from "../conversations/QqGroupControls";
import { BindingEditor } from "./binding-editor";

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

function AddConversationDialog({
  schemeId,
  onClose,
  onManage,
}: {
  schemeId: string | null;
  onClose: () => void;
  onManage: (binding: QqBindingResponse) => void;
}) {
  const { t } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      // 数据字段按实际读取面窄订阅；无关 store 更新不再重渲染本对话框。
      agents: s.agents,
      error: s.error,
      feedback: s.feedback,
      qqAccessSaving: s.qqAccessSaving,
      qqBindings: s.qqBindings,
      qqConversations: s.qqConversations,
      qqInputs: s.qqInputs,
      qqSchemes: s.qqSchemes,
      qqSettings: s.qqSettings,
      // 动作引用稳定。
      bindQqConversation: s.bindQqConversation,
      bindQqPeerNumber: s.bindQqPeerNumber,
    })),
  );
  const saving = state.qqAccessSaving;
  const inputs = state.qqInputs;
  const patch = (next: Partial<typeof inputs>) =>
    useSuperstringStore.setState((current) => ({ qqInputs: { ...current.qqInputs, ...next } }));
  // 只把入口当前方案写进草稿；已有目标（号码或观察行）时保留草稿自己的目标，不隐式改写。
  useEffect(() => {
    const current = useSuperstringStore.getState().qqInputs;
    const drafting = current.manualPicked !== "" || current.manualPeer.trim() !== "";
    // 无入口方案（全局 ALL）不种子草稿；已有目标草稿时也绝不改写入口方案。
    if (!schemeId || drafting || current.manualSchemeId === schemeId) return;
    useSuperstringStore.setState((storeState) => ({
      qqInputs: { ...storeState.qqInputs, manualSchemeId: schemeId },
    }));
  }, [schemeId]);
  // manualBindingTarget 只读 qqInputs 与 qqConversations；本视图已窄订阅这两个字段。
  const target = manualBindingTarget({
    qqInputs: state.qqInputs,
    qqConversations: state.qqConversations,
  } as SuperstringState);
  const observed = target?.conversation ?? null;
  const kind = target?.kind ?? inputs.manualKind;
  const peer = target?.peer ?? "";
  const agentId = inputs.manualAgentId;
  const schemeChoice = inputs.manualSchemeId;
  const schemeAvailable = state.qqSchemes.some((scheme) => scheme.id === schemeChoice);
  // 同名号码已有绑定：只指出它在哪里并给管理入口，不允许从这里静默覆盖。
  // 观察行自带的 binding_id 优先；没有就用类型+号码在已载入的绑定里核对。
  const rowBinding = observed
    ? state.qqBindings.find((binding) => binding.id === observed.binding_id)
    : undefined;
  const existing =
    rowBinding ??
    (peer
      ? state.qqBindings.find(
          (binding) =>
            binding.account_id === (observed?.account_id ?? state.qqSettings?.account_id) &&
            binding.kind === kind &&
            binding.peer_id === peer,
        )
      : undefined) ??
    null;
  const existingSchemeName = existing
    ? (state.qqSchemes.find((scheme) => scheme.id === existing.scheme_id)?.name ??
      t("connections.unknown"))
    : "";
  const ready =
    !saving &&
    !!agentId &&
    schemeAvailable &&
    !!peer &&
    (!inputs.manualPicked || !!observed) &&
    !existing;
  const bind = async () => {
    if (!ready) return;
    const ok = observed
      ? await state.bindQqConversation({ conversation: observed, agentId, schemeId: schemeChoice })
      : await state.bindQqPeerNumber({ kind, peerId: peer, agentId, schemeId: schemeChoice });
    // 失败保留对话框与草稿；只有真正写成功才清掉本对话框建立的目标草稿。
    if (ok) {
      patch({ manualPeer: "", manualPicked: "", manualAgentId: "" });
      onClose();
    }
  };
  const unboundCount = state.qqConversations.filter(
    (row) =>
      !state.qqBindings.some(
        (binding) =>
          binding.account_id === row.account_id &&
          binding.kind === row.kind &&
          binding.peer_id === row.peer_id,
      ),
  ).length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 关闭/取消都不提交、也不清草稿：它随 qqInputs 保留，导航守卫会如实提示。
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("schemes.bindings.addTitle")}</DialogTitle>
          <DialogDescription>{t("schemes.bindings.addHint")}</DialogDescription>
        </DialogHeader>
        <Field
          label="schemes.bindings.pickConversation"
          tooltip={t("hints.fieldExtra.bindingPick")}
        >
          <NativeSelect
            value={inputs.manualPicked}
            disabled={saving}
            onChange={(event) => patch({ manualPicked: event.target.value })}
          >
            <option value="">{t("schemes.bindings.pickManual")}</option>
            {inputs.manualPicked && !observed && (
              <option value={inputs.manualPicked}>
                {t("connections.unknown")} · {peer}
              </option>
            )}
            {state.qqConversations.map((row) => {
              const bound =
                state.qqBindings.find(
                  (binding) =>
                    binding.account_id === row.account_id &&
                    binding.kind === row.kind &&
                    binding.peer_id === row.peer_id,
                ) ?? null;
              const schemeName = bound
                ? (state.qqSchemes.find((scheme) => scheme.id === bound.scheme_id)?.name ??
                  t("connections.unknown"))
                : "";
              return (
                <option key={qqConversationKey(row)} value={qqConversationKey(row)}>
                  {`${t(row.kind === "group" ? "connections.group" : "connections.privateChat")} ${row.peer_id} · ${
                    bound
                      ? t("schemes.bindings.observedBound", { "0": schemeName })
                      : t("schemes.bindings.observedUnbound")
                  }`}
                </option>
              );
            })}
          </NativeSelect>
        </Field>
        {!unboundCount && (
          <p className="text-xs text-muted-foreground">{t("schemes.bindings.noUnbound")}</p>
        )}
        {!inputs.manualPicked && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="connections.typeForTheManualBinding"
              tooltip={t("hints.fieldExtra.bindingKind")}
            >
              <NativeSelect
                value={inputs.manualKind}
                disabled={saving}
                onChange={(event) =>
                  patch({ manualKind: event.target.value === "private" ? "private" : "group" })
                }
              >
                <option value="group">{t("connections.group")}</option>
                <option value="private">{t("connections.privateChat")}</option>
              </NativeSelect>
            </Field>
            <Field label="connections.number" tooltip={t("hints.fieldExtra.bindingPeer")}>
              <Input
                inputMode="numeric"
                value={inputs.manualPeer}
                disabled={saving}
                onChange={(event) => patch({ manualPeer: event.target.value })}
              />
            </Field>
          </div>
        )}
        {existing && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">
              {t("schemes.bindings.boundElsewhere", { "0": existingSchemeName })}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                patch({ manualPeer: "", manualPicked: "", manualAgentId: "" });
                onManage(existing);
              }}
              tooltip={t("hints.qq.manageExistingBinding")}
            >
              {t("schemes.bindings.manageExisting")}
            </Button>
          </div>
        )}
        <div className="grid gap-5 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
          <Field label="connections.assistant" tooltip={t("hints.fieldExtra.bindingAgent")}>
            <NativeSelect
              value={agentId}
              disabled={saving}
              onChange={(event) => patch({ manualAgentId: event.target.value })}
            >
              <option value="">{t("schemes.bindings.selectAgent")}</option>
              {state.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="connections.schemes" tooltip={t("hints.fieldExtra.bindingScheme")}>
            <NativeSelect
              value={schemeChoice}
              disabled={saving}
              onChange={(event) => patch({ manualSchemeId: event.target.value })}
            >
              {!schemeChoice && <option value="">{t("schemes.bindings.selectScheme")}</option>}
              {schemeChoice && !schemeAvailable && (
                <option value={schemeChoice}>{t("schemes.bindings.schemeMissing")}</option>
              )}
              {state.qqSchemes.map((scheme) => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(state.error)}
          </p>
        )}
        {state.feedback && !state.error && (
          <p role="status" className="text-sm text-muted-foreground">
            {translateNotice(state.feedback)}
          </p>
        )}
        <DialogFooter>
          <Button
            tooltip={<Trans i18nKey="hints.complete.cancel" />}
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            {t("connections.cancel")}
          </Button>
          <Button disabled={!ready} tooltip={t("hints.qq.confirmBind")} onClick={() => void bind()}>
            {t("connections.bind")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const [addOpen, setAddOpen] = useState(false);
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
  if (qqBindingsLoading && !qqBindingsLoaded) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("schemes.bindings.reading")}
      </p>
    );
  }
  if (!qqBindingsLoaded) {
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
    <div className="min-w-0 space-y-4" data-scheme-id={effectiveId ?? "all"}>
      {picker && (
        <Field label="schemes.bindings.chooseScheme" tooltip={t("hints.fieldExtra.schemeUsage")}>
          <NativeSelect
            className="min-w-0 w-full sm:min-w-48 sm:w-auto"
            value={effectiveId ?? ""}
            disabled={busy}
            onChange={(event) => setPickedScheme(event.target.value || null)}
          >
            {!schemeId && <option value="">{t("schemes.bindings.scopeAll")}</option>}
            {!schemeId && pickedScheme && !schemes.some((scheme) => scheme.id === pickedScheme) && (
              <option value={pickedScheme}>{t("schemes.bindings.schemeMissing")}</option>
            )}
            {schemes.map((scheme) => (
              <option key={scheme.id} value={scheme.id}>
                {scheme.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3">
        <Button
          disabled={busy}
          tooltip={t("hints.qq.addBinding")}
          onClick={(event) => {
            editorTrigger.current = event.currentTarget;
            setAddOpen(true);
          }}
        >
          <Plus />
          {t("schemes.bindings.add")}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          tooltip={t("hints.qq.reloadBindings")}
          onClick={load}
        >
          <RefreshCw />
          {t("schemes.bindings.refresh")}
        </Button>
        <div className="relative min-w-0 basis-full sm:order-first sm:basis-64 sm:flex-1">
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
          className="min-w-36"
          aria-label={t("connections.conversationType")}
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as "all" | "group" | "private")}
        >
          <option value="all">{t("connections.all")}</option>
          <option value="group">{t("connections.group")}</option>
          <option value="private">{t("connections.privateChat")}</option>
        </NativeSelect>
        <p className="min-w-0 basis-full text-xs text-muted-foreground">
          {t(allScope && !effectiveId ? "schemes.bindings.allHint" : "schemes.bindings.boardHint")}
        </p>
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
                {rowTitle && (
                  <span className="min-w-0 truncate text-sm font-medium">{rowTitle}</span>
                )}
                <Badge variant="outline">
                  {t(binding.kind === "group" ? "connections.group" : "connections.privateChat")}
                </Badge>
                <span className="min-w-0 break-all font-mono text-sm">{binding.peer_id}</span>
                <span className="text-xs text-muted-foreground">
                  {t("schemes.qq.groupConfig.account")} {binding.account_id}
                </span>
                <span className="text-sm text-muted-foreground">
                  {agent?.name ?? t("connections.unknown")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("schemes.qq.groupConfig.baseScheme")}: {schemeName}
                </span>
                {binding.paused && <Badge variant="secondary">{t("connections.paused")}</Badge>}
                {observation && observation.last_at_seconds > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t("connections.latestMessage")}{" "}
                    {formatDate(observation.last_at_seconds * 1000, i18n.language, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("connections.nothingObservedYet")}
                  </span>
                )}
                <div className="flex w-full flex-wrap items-center justify-end gap-2 border-t pt-2 sm:ml-auto sm:w-auto sm:border-0 sm:pt-0">
                  {/* 每行常显启停与「本群配置」：与目录卡片同一组件、同一写路径（只带 paused）。
                      目录由本视图读取，行内不再回读整页事实——连接状态可能保持未知，启停按目录可用。 */}
                  <QqGroupControls bindingId={binding.id} loadFacts={false} />
                  {binding.kind === "group" && (
                    <Button
                      variant="ghost"
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
                    variant="ghost"
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
      {addOpen && (
        <AddConversationDialog
          schemeId={effectiveId}
          onClose={() => setAddOpen(false)}
          onManage={(binding) => {
            setAddOpen(false);
            setEditing({ id: binding.id });
          }}
        />
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
    </div>
  );
}
