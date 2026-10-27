import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Clock,
  Combine,
  Cpu,
  Database,
  ListFilter,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { SettingsGroup } from "@/components/settings-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { agentPageDirty, policyDirty } from "@/features/agents/page-drafts";
import { translateNotice } from "@/i18n";
import { formatDate } from "@/i18n/runtime";
import { useForegroundRead } from "@/services/use-foreground-read";
import { useLiveResource } from "@/services/use-live-resource";
import { errorText } from "@/state/helpers";
import { useSuperstringStore } from "@/store";
import type { MemoryJobView } from "../../../shared/contracts";
import { memoryScopeIdentity } from "../../../shared/memory-scope";
import type { SuperstringApi } from "../../api";
import { JobRunLink } from "../runs/RunEntry";
import { BindingMemoryControls } from "./BindingMemoryControls";
import { memoryScopeLabel } from "./scope-label";

export function MemoryLibrary({ active = true }: { active?: boolean } = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      agents: state.agents,
      apiClient: state.apiClient,
      clearMemoryDetail: state.clearMemoryDetail,
      clearMemoryTurns: state.clearMemoryTurns,
      discardMemoryCorrection: state.discardMemoryCorrection,
      editorAgentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      error: state.error,
      feedback: state.feedback,
      governMemories: state.governMemories,
      loadMemoryContent: state.loadMemoryContent,
      loadMemoryEntryDetail: state.loadMemoryEntryDetail,
      loadMemoryPage: state.loadMemoryPage,
      loadMemoryPolicy: state.loadMemoryPolicy,
      loadMemoryTurns: state.loadMemoryTurns,
      loadMemoryManagement: state.loadMemoryManagement,
      cancelMemoryManagementRead: state.cancelMemoryManagementRead,
      memoryManagementError: state.memoryManagementError,
      memoryManagementLoading: state.memoryManagementLoading,
      manualConsolidate: state.manualConsolidate,
      memoryContent: state.memoryContent,
      memoryCorrectionDirty: state.memoryCorrectionDirty,
      memoryCorrectionDraft: state.memoryCorrectionDraft,
      memoryCorrectionSaving: state.memoryCorrectionSaving,
      memoryEntries: state.memoryEntries,
      memoryEntryDetail: state.memoryEntryDetail,
      memoryEntryTotal: state.memoryEntryTotal,
      memoryJobs: state.memoryJobs,
      memorySessions: state.memorySessions,
      memoryTurns: state.memoryTurns,
      mergeMemories: state.mergeMemories,
      openSettingsRoute: state.openSettingsRoute,
      pageEditor: state.pageEditor,
      patchMemoryCorrection: state.patchMemoryCorrection,
      patchPageAgent: state.patchPageAgent,
      patchPagePolicy: state.patchPagePolicy,
      pendingOperations: state.pendingOperations,
      qqMemoryBatchDrafts: state.qqMemoryBatchDrafts,
      reloadMemory: state.reloadMemory,
      requestAgentNavigation: state.requestAgentNavigation,
      resetMemoryManagement: state.resetMemoryManagement,
      saveMemoryCorrection: state.saveMemoryCorrection,
      saveSettingsPage: state.saveSettingsPage,
      setNotice: state.setNotice,
      settingsRoute: state.settingsRoute,
      settingsSaving: state.settingsSaving,
    })),
  );
  const { t, i18n } = useTranslation();
  const [scope, setScope] = useState(""),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]),
    [manual, setManual] = useState(false),
    [purge, setPurge] = useState(false),
    [rebuildOpen, setRebuildOpen] = useState(false),
    [shareBusy, setShareBusy] = useState(false),
    [retryJob, setRetryJob] = useState<MemoryJobView | null>(null),
    [retryBusy, setRetryBusy] = useState(false),
    [retryError, setRetryError] = useState("");
  // 常挂载弹窗在关闭动画期间仍会渲染，目标与计数必须来自最近一次打开时的快照。
  const purgeTarget = useRef<{ ids: string[]; count: number }>({ ids: [], count: 0 });
  const retryTarget = useRef<MemoryJobView | null>(null);
  const requestRetry = (job: MemoryJobView) => {
    retryTarget.current = job;
    setRetryJob(job);
  };
  const agentId = s.editorAgentId,
    agent = s.agents.find((a) => a.id === agentId),
    ready = !!agent && s.pageEditor?.agent.id === agentId && !s.editorLoading;
  const automaticAgent = useRef<{ api: typeof s.apiClient; id: string } | null>(null);
  useEffect(() => {
    const target = s.agents[0]?.id;
    if (!active || s.pageEditor || s.editorLoading || !target) return;
    if (automaticAgent.current?.api === s.apiClient && automaticAgent.current.id === target) return;
    automaticAgent.current = { api: s.apiClient, id: target };
    s.requestAgentNavigation(target);
  }, [active, s.apiClient, s.pageEditor, s.editorLoading, s.agents, s.requestAgentNavigation]);
  useEffect(() => () => s.resetMemoryManagement(), [s.resetMemoryManagement]);
  const read = useCallback(
    async () => ({
      api: s.apiClient,
      agentId,
      scopes: await s.apiClient.listMemoryScopes(agentId),
    }),
    [s.apiClient, agentId],
  );
  const readConnections = useCallback(async () => {
    const connections = await Promise.allSettled([
      s.apiClient.listQqBindings(),
      s.apiClient.getQqOwner(),
    ]);
    const [bindings, owner] = connections;
    return {
      api: s.apiClient,
      bindings: bindings.status === "fulfilled" ? bindings.value : [],
      owner: owner.status === "fulfilled" ? owner.value : null,
      connectionError: connections.some((result) => result.status === "rejected"),
    };
  }, [s.apiClient]);
  const resource = useLiveResource(read, { enabled: ready, paused: !active });
  const connections = useLiveResource(readConnections, { enabled: ready, paused: !active });
  const scopes =
    resource.data?.api === s.apiClient && resource.data.agentId === agentId
      ? resource.data.scopes
      : [];
  const connectionData = connections.data?.api === s.apiClient ? connections.data : null;
  useEffect(() => {
    if (!agentId) return;
    setScope("");
    setPage(1);
    setSelected([]);
    setSearch("");
    setQuery("");
    setStatus("all");
  }, [agentId]);
  // 切 Agent 或换设置分区时收起重试确认并作废在途重试：迟到响应不得写当前 Agent/列表/feedback。
  const retryAttempt = useRef(0);
  // 同步闸门：React 状态更新是异步的，连击时要靠 ref 保证同一时刻只发出一次写请求。
  const retryBusyRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 切 Agent/分区只作触发条件，effect 体无需读取它们。
  useEffect(() => {
    retryAttempt.current += 1;
    retryBusyRef.current = false;
    setRetryJob(null);
    setRetryError("");
    setRetryBusy(false);
    // 离页（卸载）同样作废在途重试，避免迟到响应写回已离开的页面。
    return () => {
      retryAttempt.current += 1;
    };
  }, [agentId, s.settingsRoute]);
  const managementSelection = useRef({ agentId, page, scope, query, status });
  managementSelection.current =
    managementSelection.current.agentId === agentId
      ? { agentId, page, scope, query, status }
      : { agentId, page: 1, scope: "", query: "", status: "all" };
  // biome-ignore lint/correctness/useExhaustiveDependencies: API and Agent identity own this foreground read; filters reuse it without resetting metadata.
  const readManagement = useCallback(() => {
    const selection = managementSelection.current;
    void s.loadMemoryManagement(
      selection.page,
      {
        ...(selection.scope ? { scope_key: selection.scope } : {}),
        ...(selection.query ? { search: selection.query } : {}),
        ...(selection.status !== "all" ? { status: selection.status } : {}),
      },
      { metadata: false },
    );
  }, [agentId, s.apiClient, s.loadMemoryManagement]);
  useForegroundRead(readManagement, s.cancelMemoryManagementRead, {
    enabled: ready && !!agentId && agentId !== "__new__",
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: s.cancelMemoryManagementRead,
  });
  const previousManagementSelection = useRef(managementSelection.current);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Filter values trigger the page read while the foreground callback stays identity-stable.
  useEffect(() => {
    const previous = previousManagementSelection.current;
    const current = managementSelection.current;
    previousManagementSelection.current = current;
    if (previous.agentId !== current.agentId) return;
    if (
      previous.page === current.page &&
      previous.scope === current.scope &&
      previous.query === current.query &&
      previous.status === current.status
    )
      return;
    if (active && ready && document.visibilityState !== "hidden") readManagement();
  }, [active, ready, page, scope, query, status, readManagement]);
  const selectedScope = scopes.find((item) => item.scope_key === scope);
  const binding = connectionData?.bindings.find((item) => item.id === selectedScope?.binding?.id);
  const owner = connectionData?.owner;
  const shareEligible =
    binding?.kind === "private" &&
    owner?.configured &&
    owner.account_id === binding.account_id &&
    owner.peer_id === binding.peer_id;
  const selectedIdSet = useMemo(() => new Set(selected), [selected]);
  const selectedRows = useMemo(
    () => s.memoryEntries.filter((row) => selectedIdSet.has(row.id)),
    [s.memoryEntries, selectedIdSet],
  );
  const mergeable =
    selectedRows.length >= 2 &&
    selectedRows.every(
      (row) => row.status === "active" && row.scope_key === selectedRows[0]?.scope_key,
    );
  const locked =
    s.memoryCorrectionDirty ||
    s.memoryCorrectionSaving ||
    Object.keys(s.qqMemoryBatchDrafts).length > 0;
  // 同一 Agent 已有排队/执行中的整理任务时不允许再重试，避免与后台任务抢占来源。
  const hasActiveJob = s.memoryJobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );
  const editor = s.pageEditor;
  const showMaintenance = scope === "" || memoryScopeIdentity(scope, agentId).kind === "web";
  // 维护保存只拥有整理提示词与网页整理策略；读取额度属于独立的 memory-tools 草稿。
  const maintenanceDirty =
    !!editor && (policyDirty(editor) || agentPageDirty(editor, "long-memory"));
  const discardMaintenance = () => {
    if (!editor) return;
    if (editor.policy)
      s.patchPagePolicy({
        auto_enabled: editor.policy.auto_enabled,
        every_turns: editor.policy.every_turns,
        target_chars: editor.policy.target_chars,
      });
    s.patchPageAgent("long-memory", {
      memory_consolidation_prompt: editor.agent.memory_consolidation_prompt,
      memory_consolidation_additional_instructions:
        editor.agent.memory_consolidation_additional_instructions,
    });
  };
  const saveMaintenance = async () => {
    if (await s.saveSettingsPage("long-memory")) await refresh();
  };
  const refresh = async () => {
    resource.refresh();
    connections.refresh();
    await s.loadMemoryManagement(
      page,
      {
        ...(scope ? { scope_key: scope } : {}),
        ...(query ? { search: query } : {}),
        ...(status !== "all" ? { status } : {}),
      },
      { metadata: true },
    );
  };
  const retryFailedJob = async () => {
    const job = retryJob;
    if (!job || retryBusyRef.current) return;
    const targetAgent = agentId;
    const client = s.apiClient;
    const attempt = retryAttempt.current;
    const stillCurrent = () => {
      const state = useSuperstringStore.getState();
      return (
        attempt === retryAttempt.current &&
        state.apiClient === client &&
        state.editorAgentId === targetAgent &&
        state.page === "settings" &&
        state.settingsRoute === "long-memory"
      );
    };
    if (!stillCurrent()) return;
    retryBusyRef.current = true;
    setRetryBusy(true);
    try {
      await client.retryMemoryJob(targetAgent, job.id);
      if (!stillCurrent()) return;
      setRetryJob(null);
      setRetryError("");
      const state = useSuperstringStore.getState();
      if (
        state.memoryCorrectionDirty ||
        state.memoryCorrectionSaving ||
        state.memoryVisibilityDirty ||
        state.memoryVisibilitySaving
      ) {
        // 未保存内容在场时只更新作业，不触碰详情、列表或共享草稿。
        const jobs = await client.listMemoryJobs(targetAgent);
        if (!stillCurrent()) return;
        useSuperstringStore.setState({ memoryJobs: jobs });
      } else {
        await s.loadMemoryManagement(
          page,
          {
            ...(scope ? { scope_key: scope } : {}),
            ...(query ? { search: query } : {}),
            ...(status !== "all" ? { status } : {}),
          },
          { metadata: true },
        );
      }
    } catch (error) {
      if (!stillCurrent()) return;
      // 失败保留确认框与原始任务，409 等来源变更按服务端原文提示，不伪装成功。
      const text = errorText(error);
      setRetryError(text);
      s.setNotice({ error: text });
    } finally {
      // 过期尝试（切 Agent/离页后）不得复位，否则会清掉新一轮重试的 busy 闸门。
      if (attempt === retryAttempt.current) {
        retryBusyRef.current = false;
        setRetryBusy(false);
      }
    }
  };
  const retryDisplay = retryJob ?? retryTarget.current;
  const retryConfirmMessage = retryDisplay
    ? t("library.memory.job.retry.confirm", { "0": retryDisplay.id })
    : "";
  return (
    <section className="space-y-6" aria-label={t("library.memory.library")}>
      {/* 顶部导航与上下文任务栏：Agent 归属、刷新与直达通道 */}
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-border/70 bg-card p-4">
        <div className="min-w-60 flex-1">
          <Field label="library.agent.owner" tooltip={t("hints.library.memory.ownerAgentField")}>
            <NativeSelect
              value={ready ? agentId : ""}
              onChange={(e) => s.requestAgentNavigation(e.target.value)}
            >
              {!ready && <option value="">{t("library.select.an.assistant")}</option>}
              {s.agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!ready || locked}
            tooltip={t("hints.library.memory.refresh")}
            onClick={refresh}
          >
            <RefreshCw />
            {t("library.refresh")}
          </Button>
          <Button
            disabled={!ready || locked}
            tooltip={t("hints.library.memory.manualOrganize")}
            onClick={() => setManual(true)}
          >
            {t("library.organize.memories.from.a.conversation")}
          </Button>
          <Button
            variant="outline"
            disabled={!ready || locked}
            tooltip={t("hints.library.memory.rebuildSearchProjection")}
            onClick={() => setRebuildOpen(true)}
          >
            <Database />
            {t("library.rebuildSearchProjection")}
          </Button>
          {/* 读取额度已迁到系统能力页：内容区只保留直达入口，草稿安全跳转。 */}
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            tooltip={t("hints.library.memory.tools")}
            onClick={() => s.openSettingsRoute("memory-tools")}
          >
            <SlidersHorizontal />
            {t("capabilities.resources.openMemoryTools")}
          </Button>
        </div>
      </div>

      {connectionData?.connectionError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("library.connection.metadata.unavailable")}
        </p>
      )}
      {(resource.error || s.memoryManagementError || s.error) && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {resource.error ||
            (s.memoryManagementError ? translateNotice(s.memoryManagementError) : "") ||
            (s.error ? translateNotice(s.error) : "")}
        </p>
      )}
      {s.feedback && !resource.error && !s.error && (
        <p role="status" className="text-sm text-muted-foreground">
          {translateNotice(s.feedback)}
        </p>
      )}

      {ready && (
        <>
          <div className="grid items-start gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
            {/* 左侧：分区与隔离侧栏 */}
            <aside className="space-y-4">
              <div className="space-y-4 rounded-xl border border-border/80 bg-card p-4">
                <div className="flex items-center gap-2 px-2 py-1">
                  <Database className="size-4 text-muted-foreground" />
                  <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                    {t("library.all.partitions")}
                  </span>
                </div>
                <div className="space-y-1">
                  <Button
                    tooltip={<Trans i18nKey="hints.complete.memoryAll" />}
                    variant={scope === "" ? "secondary" : "ghost"}
                    className="w-full justify-between font-medium"
                    disabled={locked}
                    onClick={() => {
                      setScope("");
                      setPage(1);
                      setSelected([]);
                    }}
                  >
                    <span>{t("library.all.partitions")}</span>
                    <Badge variant="outline" className="tabular-nums">
                      {scopes.reduce((sum, row) => sum + row.count, 0)}
                    </Badge>
                  </Button>
                  {scopes.map((item) => (
                    <Button
                      tooltip={<Trans i18nKey="hints.complete.memoryScope" />}
                      key={item.scope_key}
                      variant={scope === item.scope_key ? "secondary" : "ghost"}
                      className="h-auto w-full justify-between gap-3 py-2.5 text-left"
                      disabled={locked}
                      onClick={() => {
                        setScope(item.scope_key);
                        setPage(1);
                        setSelected([]);
                      }}
                    >
                      <span className="min-w-0 flex-1 whitespace-normal text-xs leading-relaxed">
                        {memoryScopeLabel(item.scope_key, agentId, t)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {item.count}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>

              {selectedScope && (
                <Card className="rounded-xl border-border/80">
                  <CardHeader className="p-4 pb-2">
                    <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                      {t("library.read.partitions")}
                    </p>
                    <CardDescription className="text-xs">
                      {t("library.value.active.value.total", {
                        "0": selectedScope.active_count,
                        "1": selectedScope.count,
                      })}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 p-4 pt-2">
                    <div className="space-y-1.5 text-xs">
                      <p className="font-medium text-foreground">{t("library.read.partitions")}</p>
                      {selectedScope.read_scope_keys === null ? (
                        <p className="rounded-md bg-muted/60 p-2 text-muted-foreground">
                          {t("library.reading.scope.unavailable")}
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {selectedScope.read_scope_keys.map((key) => (
                            <p
                              key={key}
                              className="break-all rounded-md bg-muted/50 p-1.5 text-muted-foreground"
                            >
                              {memoryScopeLabel(key, agentId, t)}
                            </p>
                          ))}
                        </div>
                      )}
                      <p className="pt-2 font-medium text-foreground">
                        {t("library.write.partition")}
                      </p>
                      <p className="break-all rounded-md bg-muted/50 p-1.5 text-muted-foreground">
                        {memoryScopeLabel(selectedScope.write_scope_key, agentId, t)}
                      </p>
                    </div>

                    {binding && (
                      <div className="border-t border-border/60 pt-3">
                        <BindingMemoryControls
                          binding={binding}
                          pending={selectedScope.pending ?? undefined}
                          onChanged={refresh}
                        />
                      </div>
                    )}

                    {binding && shareEligible && (
                      <div className="border-t border-border/60 pt-3">
                        <Field
                          label="library.share.with.web.memories"
                          info="library.turning.sharing.off.does.not.move.or.delete.existing"
                          tooltip={t(
                            "library.turning.sharing.off.does.not.move.or.delete.existing",
                          )}
                        >
                          <Checkbox
                            disabled={shareBusy}
                            checked={binding.share_web_memory}
                            onCheckedChange={(value) => {
                              setShareBusy(true);
                              void s.apiClient
                                .updateQqBinding(binding.id, {
                                  expected_revision: binding.revision,
                                  share_web_memory: value === true,
                                })
                                .then(refresh)
                                .catch((error) => s.setNotice({ error: errorText(error) }))
                                .finally(() => setShareBusy(false));
                            }}
                          />
                        </Field>
                      </div>
                    )}

                    {selectedScope.latest_job && (
                      <div className="border-t border-border/60 pt-3">
                        <JobRunLink ownerKind="memory_job" ownerId={selectedScope.latest_job.id} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </aside>

            {/* 右侧：记忆检索、治理操作与维护政策 */}
            <div className="min-w-0 space-y-5">
              {/* 搜索与状态过滤任务栏 */}
              <div className="space-y-3 rounded-xl border border-border/80 bg-card p-4">
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setQuery(search);
                    setPage(1);
                    setSelected([]);
                  }}
                >
                  <div className="min-w-48 flex-1">
                    <Input
                      aria-label={t("library.search.memories")}
                      placeholder={t("library.search.memories")}
                      value={search}
                      disabled={locked}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <NativeSelect
                    value={status}
                    aria-label={t("library.memory.status")}
                    disabled={locked}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(1);
                      setSelected([]);
                    }}
                  >
                    <option value="all">{t("library.all.statuses")}</option>
                    {["active", "suppressed", "replaced", "invalid"].map((value) => (
                      <option key={value} value={value}>
                        {t(`library.status.${value}`)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={locked}
                    tooltip={t("hints.library.memory.search")}
                  >
                    {t("library.search")}
                  </Button>
                </form>

                <div className="flex items-center justify-between pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs text-muted-foreground"
                    disabled={locked || !s.memoryEntries.length}
                    disabledReason={t("hints.library.memory.selectAllDisabled")}
                    onClick={() => setSelected(s.memoryEntries.map((entry) => entry.id))}
                  >
                    <ListFilter className="mr-1.5 size-3.5" />
                    {t("library.select.current.results")}
                  </Button>
                </div>
              </div>

              {/* 批量治理操作栏（选中时浮出） */}
              {selected.length > 0 && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                  <span className="mr-2 text-sm font-medium text-foreground">
                    {t("library.value.selected", { "0": selected.length })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!mergeable || locked}
                    disabledReason={t("hints.library.memory.mergeDisabled")}
                    tooltip={t("hints.library.memory.merge")}
                    onClick={() =>
                      void s.mergeMemories(agentId, selected).then((ok) => {
                        if (ok) refresh();
                      })
                    }
                  >
                    <Combine className="mr-1.5 size-3.5" />
                    {t("library.merge")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked}
                    tooltip={t("hints.library.memory.suppress")}
                    onClick={() =>
                      void s.governMemories(agentId, selected, "suppress", false).then((ok) => {
                        if (ok) refresh();
                      })
                    }
                  >
                    {t("library.suppress")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked}
                    tooltip={t("hints.library.memory.enable")}
                    onClick={() =>
                      void s.governMemories(agentId, selected, "enable", false).then((ok) => {
                        if (ok) refresh();
                      })
                    }
                  >
                    {t("library.enabled.2")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={locked}
                    tooltip={t("hints.library.memory.purge")}
                    onClick={() => {
                      purgeTarget.current = { ids: [...selected], count: selected.length };
                      setPurge(true);
                    }}
                  >
                    {t("library.permanently.delete")}
                  </Button>
                  <Button
                    tooltip={<Trans i18nKey="hints.complete.selectionClear" />}
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-xs"
                    onClick={() => setSelected([])}
                  >
                    {t("library.clear.selection")}
                  </Button>
                </div>
              )}

              {/* 记忆条目列表 */}
              <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/80 bg-card">
                {s.memoryEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex gap-4 p-4 transition-colors hover:bg-muted/30"
                  >
                    <Checkbox
                      className="mt-1"
                      aria-label={t("library.select.value", { "0": entry.name })}
                      checked={selected.includes(entry.id)}
                      disabled={locked}
                      onCheckedChange={(v) =>
                        setSelected((ids) =>
                          v === true ? [...ids, entry.id] : ids.filter((id) => id !== entry.id),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          tooltip={<Trans i18nKey="hints.complete.memoryOpen" />}
                          variant="link"
                          className="h-auto p-0 text-left font-semibold text-foreground hover:underline"
                          disabled={locked}
                          onClick={() => void s.loadMemoryEntryDetail(entry.id)}
                        >
                          {entry.name}
                        </Button>
                        <Badge variant="outline" className="text-2xs">
                          {t(`library.status.${entry.status}`)}
                        </Badge>
                      </div>
                      <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                        {entry.summary}
                      </p>
                      {entry.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {entry.tags.map((tag) => (
                            <Badge key={tag} variant="secondary" className="text-2xs font-normal">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <p className="text-2xs text-muted-foreground">
                        {memoryScopeLabel(entry.scope_key, agentId, t)} ·{" "}
                        {formatDate(entry.created_at, i18n.resolvedLanguage ?? i18n.language, {
                          year: "numeric",
                          month: "numeric",
                          day: "numeric",
                          hour: "numeric",
                          minute: "numeric",
                          second: "numeric",
                        })}
                      </p>
                    </div>
                  </div>
                ))}
                {s.memoryEntries.length === 0 && (
                  <div className="flex flex-col items-center justify-center p-12 text-center">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground mb-3">
                      <Brain className="size-5" />
                    </div>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      {t("library.no.memories.in.this.scope.organize.completed.conversation.turns")}
                    </p>
                  </div>
                )}
              </div>

              {/* 分页控制 */}
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-muted-foreground">
                  {t("library.value.entries.page.value", { "0": s.memoryEntryTotal, "1": page })}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("library.previous.page")}
                    tooltip={t("hints.library.memory.prevPage")}
                    disabled={page <= 1 || locked}
                    onClick={() => {
                      setPage(page - 1);
                      setSelected([]);
                    }}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("library.next.page")}
                    tooltip={t("hints.library.memory.nextPage")}
                    disabled={page * 100 >= s.memoryEntryTotal || locked}
                    onClick={() => {
                      setPage(page + 1);
                      setSelected([]);
                    }}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>

              {/* 网页对话记忆维护政策（仅当选中网页 scope 或空 scope 时显示） */}
              {showMaintenance && (
                <SettingsGroup
                  title={
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{t("library.memory.maintenance")}</span>
                      <Badge variant="secondary">{t("library.scope.web")}</Badge>
                    </div>
                  }
                  description={t(
                    "library.web.conversations.use.a.turn.based.policy.connected.conversations",
                  )}
                  icon={Sparkles}
                >
                  <div className="space-y-4 p-4">
                    {editor?.policyDraft ? (
                      <div className="space-y-4">
                        <Field
                          label="library.automatically.organize.web.memories"
                          tooltip={t("hints.library.memory.autoOrganizeField")}
                        >
                          <Checkbox
                            disabled={locked}
                            checked={editor.policyDraft.auto_enabled}
                            onCheckedChange={(value) =>
                              s.patchPagePolicy({ auto_enabled: value === true })
                            }
                          />
                        </Field>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field
                            label="library.organize.every.n.turns"
                            tooltip={t("hints.library.memory.everyTurnsField")}
                          >
                            <Input
                              type="number"
                              min={1}
                              max={200}
                              disabled={locked}
                              value={editor.policyDraft.every_turns}
                              onChange={(e) =>
                                s.patchPagePolicy({ every_turns: Number(e.target.value) })
                              }
                            />
                          </Field>
                          <Field
                            label="library.target.memory.characters"
                            tooltip={t("hints.library.memory.targetCharsField")}
                          >
                            <Input
                              type="number"
                              min={50}
                              max={4000}
                              disabled={locked}
                              value={editor.policyDraft.target_chars}
                              onChange={(e) =>
                                s.patchPagePolicy({ target_chars: Number(e.target.value) })
                              }
                            />
                          </Field>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
                    )}
                    <Field
                      label="library.memory.organization.prompt"
                      tooltip={t("hints.library.memory.orgPromptField")}
                    >
                      <Textarea
                        rows={4}
                        disabled={locked}
                        value={editor?.draft.memory_consolidation_prompt ?? ""}
                        onChange={(e) =>
                          s.patchPageAgent("long-memory", {
                            memory_consolidation_prompt: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field
                      label="library.additional.organization.instructions"
                      tooltip={t("hints.library.memory.orgExtraField")}
                    >
                      <Textarea
                        rows={3}
                        disabled={locked}
                        value={editor?.draft.memory_consolidation_additional_instructions ?? ""}
                        onChange={(e) =>
                          s.patchPageAgent("long-memory", {
                            memory_consolidation_additional_instructions: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-3">
                      <Button
                        variant="outline"
                        className="mr-auto h-auto min-h-8 max-w-full whitespace-normal break-words"
                        tooltip={t("hints.library.memory.modelServices")}
                        onClick={() => s.openSettingsRoute("execution-settings")}
                      >
                        <Cpu />
                        {t("library.open.model.services")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!maintenanceDirty || locked || s.settingsSaving}
                        disabledReason={t("hints.library.memory.discardDisabled")}
                        tooltip={t("hints.library.memory.discard")}
                        onClick={discardMaintenance}
                      >
                        {t("library.discard.changes")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!maintenanceDirty || locked || s.settingsSaving}
                        disabledReason={t("hints.library.memory.saveDisabled")}
                        tooltip={t("hints.library.memory.save")}
                        onClick={() => void saveMaintenance()}
                      >
                        {t("library.save.memory.rules")}
                      </Button>
                    </div>
                  </div>
                </SettingsGroup>
              )}
            </div>
          </div>

          {/* 整理与合并作业任务流 (Maintenance Jobs) */}
          <SettingsGroup
            title={t("library.maintenance.jobs")}
            description={t("library.inspect.organization.and.merge.results.and.their.model.runs")}
            icon={Clock}
          >
            <div className="divide-y divide-border/60">
              {s.memoryJobs.map((job) => (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center gap-3 p-3.5 text-sm transition-colors hover:bg-muted/20"
                >
                  <Badge variant="outline">{job.kind}</Badge>
                  <span className="font-medium">{t(`library.status.${job.status}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(job.created_at, i18n.resolvedLanguage ?? i18n.language, {
                      year: "numeric",
                      month: "numeric",
                      day: "numeric",
                      hour: "numeric",
                      minute: "numeric",
                      second: "numeric",
                    })}
                  </span>
                  {job.error_code && (
                    <span className="text-destructive font-mono text-xs">{job.error_code}</span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {job.status === "failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={hasActiveJob || retryBusy}
                        disabledReason={t("hints.library.memory.retryDisabled")}
                        tooltip={t("hints.library.memory.retry")}
                        onClick={() => {
                          setRetryError("");
                          requestRetry(job);
                        }}
                      >
                        <RotateCcw className="size-3.5" />
                        {t("capabilities.retry")}
                      </Button>
                    )}
                    <JobRunLink ownerKind="memory_job" ownerId={job.id} />
                  </div>
                </div>
              ))}
            </div>
          </SettingsGroup>
        </>
      )}

      {/* 记忆详情与纠正 Sheet */}
      <MemoryDetail active={active} />

      {/* 对话手动整理 Sheet */}
      {manual && <ManualMemory active={active} onClose={() => setManual(false)} />}

      {/* 搜索投影重建 Sheet */}
      {rebuildOpen && (
        <RebuildSearchProjectionSheet
          active={active}
          agentId={agentId}
          apiClient={s.apiClient}
          onClose={() => setRebuildOpen(false)}
        />
      )}

      {/* 永久删除确认弹窗 */}
      <ConfirmDialog
        open={active && purge}
        message={t("library.permanently.delete.value.memories.this.cannot.be.undone", {
          "0": purgeTarget.current.count,
        })}
        onCancel={() => setPurge(false)}
        onConfirm={() => {
          const ids = purgeTarget.current.ids;
          return s.governMemories(agentId, ids, "purge", true).then((ok) => {
            if (ok) {
              setPurge(false);
              setSelected([]);
              refresh();
            }
          });
        }}
      />

      {/* 作业重试确认弹窗 */}
      <ConfirmDialog
        open={active && retryJob !== null}
        message={
          retryError ? `${retryConfirmMessage} ${translateNotice(retryError)}` : retryConfirmMessage
        }
        confirmLabel={t("capabilities.retry")}
        busy={retryBusy}
        onCancel={() => {
          setRetryJob(null);
          setRetryError("");
        }}
        onConfirm={retryFailedJob}
      />
    </section>
  );
}

export function MemoryDetail({ active = true }: { active?: boolean } = {}) {
  const s = useSuperstringStore(
      useShallow((state) => ({
        clearMemoryDetail: state.clearMemoryDetail,
        discardMemoryCorrection: state.discardMemoryCorrection,
        loadMemoryContent: state.loadMemoryContent,
        memoryContent: state.memoryContent,
        memoryCorrectionDirty: state.memoryCorrectionDirty,
        memoryCorrectionDraft: state.memoryCorrectionDraft,
        memoryCorrectionSaving: state.memoryCorrectionSaving,
        memoryEntryDetail: state.memoryEntryDetail,
        patchMemoryCorrection: state.patchMemoryCorrection,
        saveMemoryCorrection: state.saveMemoryCorrection,
        metadata: state.memoryMetadata,
        metadataBaseline: state.memoryMetadataBaseline,
        visibilityDraft: state.memoryVisibilityDraft,
        visibilityDirty: state.memoryVisibilityDirty,
        metadataLoading: state.memoryMetadataLoading,
        visibilitySaving: state.memoryVisibilitySaving,
        visibilityError: state.memoryVisibilityError,
        loadMetadata: state.loadMemoryAccessMetadata,
        patchVisibilityDraft: state.patchMemoryVisibilityDraft,
        saveVisibility: state.saveMemoryVisibility,
        discardVisibilityDraft: state.discardMemoryVisibilityDraft,
        clearMetadata: state.clearMemoryMetadata,
        agents: state.agents,
        apiClient: state.apiClient,
        editorAgentId: state.editorAgentId,
      })),
    ),
    t = useTranslation().t,
    entry = s.memoryEntryDetail,
    content = s.memoryContent,
    draft = s.memoryCorrectionDraft;
  const [discard, setDiscard] = useState(false);
  const [confirmSnapshot, setConfirmSnapshot] = useState<{
    agentId: string;
    entryId: string;
    api: unknown;
    revision: number;
    visibility: "session_private" | "agent_shared" | "public" | null;
    recipient_agent_ids: string[];
  } | null>(null);
  const [tagText, setTagText] = useState(draft?.tags.join(", ") ?? "");
  const correctionRevision = draft?.expected_revision;
  const entryId = entry?.id;

  const hasValidBaseline =
    s.metadataBaseline !== null &&
    s.metadataBaseline.agentId === s.editorAgentId &&
    s.metadataBaseline.memoryId === entryId &&
    s.metadataBaseline.api === s.apiClient;

  useEffect(() => {
    if (!confirmSnapshot) return;
    const current = s.visibilityDraft;
    const base = s.metadataBaseline;
    const equalRecipients = (a: string[], b: string[]) =>
      a.length === b.length &&
      a
        .slice()
        .sort()
        .every((v, i) => v === b.slice().sort()[i]);

    if (
      confirmSnapshot.entryId !== entryId ||
      confirmSnapshot.agentId !== s.editorAgentId ||
      confirmSnapshot.api !== s.apiClient ||
      !base ||
      confirmSnapshot.revision !== base.revision ||
      !current ||
      confirmSnapshot.visibility !== current.visibility ||
      !equalRecipients(confirmSnapshot.recipient_agent_ids, current.recipient_agent_ids)
    ) {
      setConfirmSnapshot(null);
    }
  }, [
    confirmSnapshot,
    entryId,
    s.editorAgentId,
    s.apiClient,
    s.metadataBaseline,
    s.visibilityDraft,
  ]);

  useEffect(() => {
    if (correctionRevision)
      setTagText(useSuperstringStore.getState().memoryCorrectionDraft?.tags.join(", ") ?? "");
  }, [correctionRevision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The same entry on another API requires fresh content and access metadata.
  useEffect(() => {
    if (active && entryId) {
      void s.loadMemoryContent();
      void s.loadMetadata(entryId);
    }
  }, [active, entryId, s.apiClient, s.loadMemoryContent, s.loadMetadata]);
  const close = () => {
    if (s.memoryCorrectionSaving || s.visibilitySaving) return;
    setConfirmSnapshot(null);
    if (s.memoryCorrectionDirty || s.visibilityDirty) setDiscard(true);
    else {
      s.clearMemoryDetail();
      s.clearMetadata();
    }
  };
  return (
    <>
      <Sheet
        open={active && !!entry}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent className="w-full sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>{entry?.name}</SheetTitle>
            <SheetDescription>
              {t(
                "library.inspect.content.sources.and.configuration.snapshots.corrections.create.a",
              )}
            </SheetDescription>
          </SheetHeader>
          {entry && (
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
              <div className="flex flex-wrap gap-2">
                <Badge>{t(`library.status.${entry.status}`)}</Badge>
                {content?.corrected && (
                  <Badge variant="outline">{t("library.manual.correction")}</Badge>
                )}
                {content?.retired && <Badge variant="secondary">{t("library.retired")}</Badge>}
              </div>
              <Tabs defaultValue="content">
                <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
                  <TabsTrigger value="content">{t("library.content")}</TabsTrigger>
                  <TabsTrigger value="sources">{t("library.sources")}</TabsTrigger>
                  <TabsTrigger value="edit">{t("library.correct")}</TabsTrigger>
                  <TabsTrigger value="access">{t("library.memory.accessTitle")}</TabsTrigger>
                  <TabsTrigger value="snapshot">{t("library.configuration.snapshot")}</TabsTrigger>
                </TabsList>
                <TabsContent value="content" className="space-y-4">
                  <p className="text-sm text-muted-foreground">{entry.summary}</p>
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm font-mono leading-relaxed">
                    {content?.content.body ?? entry.body}
                  </pre>
                </TabsContent>
                <TabsContent value="sources" className="space-y-4">
                  {content?.content.sources.map((source) => (
                    <div
                      key={
                        source.type === "chat"
                          ? source.turn_id
                          : source.type === "qq_observation"
                            ? source.event_key
                            : `${source.document_id}:${source.version}:${source.start}:${source.end}`
                      }
                      className="space-y-2 rounded-lg border p-4"
                    >
                      <div className="flex gap-2">
                        <Badge variant="outline">{source.type}</Badge>
                        <Badge variant={source.valid ? "secondary" : "destructive"}>
                          {t(source.valid ? "library.valid" : "library.invalid")}
                        </Badge>
                      </div>
                      <pre className="overflow-auto text-xs">{JSON.stringify(source, null, 2)}</pre>
                      {source.type === "chat" &&
                        content.source_messages
                          .filter((message) => message.turn_id === source.turn_id)
                          .map((message) => (
                            <div key={message.turn_id} className="space-y-3 text-sm">
                              <p className="font-medium">{message.session_title}</p>
                              <p className="whitespace-pre-wrap">
                                {message.user ?? t("library.source.content.is.no.longer.available")}
                              </p>
                              <p className="whitespace-pre-wrap text-muted-foreground">
                                {message.assistant ??
                                  t("library.source.content.is.no.longer.available")}
                              </p>
                            </div>
                          ))}
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="edit" className="space-y-4">
                  {draft ? (
                    <>
                      <Field label="library.name" tooltip={t("hints.library.memory.nameField")}>
                        <Input
                          maxLength={100}
                          value={draft.name}
                          onChange={(e) => s.patchMemoryCorrection({ name: e.target.value })}
                        />
                      </Field>
                      <Field
                        label="library.summary"
                        tooltip={t("hints.library.memory.summaryField")}
                      >
                        <Textarea
                          maxLength={500}
                          rows={3}
                          value={draft.summary}
                          onChange={(e) => s.patchMemoryCorrection({ summary: e.target.value })}
                        />
                      </Field>
                      <Field
                        label="library.tags.comma.separated"
                        tooltip={t("hints.library.memory.tagsField")}
                      >
                        <Input
                          value={tagText}
                          onChange={(e) => {
                            setTagText(e.target.value);
                            s.patchMemoryCorrection({
                              tags: e.target.value
                                .split(/[,，]/)
                                .map((tag) => tag.trim())
                                .filter(Boolean),
                            });
                          }}
                        />
                      </Field>
                      <Field
                        label="library.memory.body"
                        tooltip={t("hints.library.memory.bodyField")}
                      >
                        <Textarea
                          rows={14}
                          maxLength={16000}
                          value={draft.body}
                          onChange={(e) => s.patchMemoryCorrection({ body: e.target.value })}
                        />
                      </Field>
                    </>
                  ) : (
                    <p role="status">{t("library.loading")}</p>
                  )}
                </TabsContent>
                <TabsContent value="snapshot">
                  <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs font-mono">
                    {JSON.stringify(entry.config_snapshot, null, 2)}
                  </pre>
                </TabsContent>
                <TabsContent value="access" className="space-y-4">
                  <div className="space-y-3 rounded-lg border p-4 bg-card">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold tracking-tight">
                        {t("library.memory.accessTitle")}
                      </h4>
                      <div className="flex items-center gap-2">
                        {s.metadataBaseline && (
                          <Badge variant="outline" className="font-mono text-[10px]">
                            {t("common.revision", { "0": s.metadataBaseline.revision })}
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={s.metadataLoading || s.visibilitySaving}
                          onClick={() => {
                            if (entryId)
                              void s.loadMetadata(entryId, { advanceRevisionIfDirty: true });
                          }}
                        >
                          {t("library.refresh")}
                        </Button>
                      </div>
                    </div>

                    {/* 来源链路 */}
                    <div className="space-y-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{t("library.sources")}:</span>
                        <Badge
                          variant={
                            s.metadata?.origin_complete === true
                              ? "secondary"
                              : s.metadata?.origin_complete === false
                                ? "destructive"
                                : "outline"
                          }
                          className="text-[10px]"
                        >
                          {t(
                            s.metadata?.origin_complete === true
                              ? "library.memory.originComplete"
                              : s.metadata?.origin_complete === false
                                ? "library.memory.originIncomplete"
                                : "library.memory.originUnknown",
                          )}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {t("library.memory.notEvaluated")}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        {s.metadata?.origins.map((origin) => (
                          <div
                            key={`${origin.channel}:${origin.conversation_id ?? "unknown"}`}
                            className="flex items-center gap-2 font-mono text-muted-foreground"
                          >
                            <span>[{origin.channel}]</span>
                            <span>
                              {origin.conversation_id ?? t("library.memory.originUnknown")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 可见性选择 */}
                    <div className="space-y-3 pt-2 border-t">
                      <Field label={t("library.memory.accessTitle")}>
                        <NativeSelect
                          aria-label={t("library.memory.accessTitle")}
                          disabled={!hasValidBaseline || s.metadataLoading || s.visibilitySaving}
                          value={
                            !hasValidBaseline
                              ? "unknown"
                              : (s.visibilityDraft?.visibility ?? "unclassified")
                          }
                          onChange={(e) => {
                            const val = e.target.value;
                            if (
                              val === "session_private" ||
                              val === "agent_shared" ||
                              val === "public"
                            ) {
                              s.patchVisibilityDraft({ visibility: val });
                            }
                          }}
                        >
                          {!hasValidBaseline ? (
                            <option value="unknown">{t("connections.unknown")}</option>
                          ) : s.metadataBaseline?.visibility === null ? (
                            <option value="unclassified">
                              {t("library.memory.visibility.unclassified")}
                            </option>
                          ) : null}
                          <option value="session_private">
                            {t("library.memory.visibility.session_private")}
                          </option>
                          <option value="agent_shared">
                            {t("library.memory.visibility.agent_shared")}
                          </option>
                          <option value="public">{t("library.memory.visibility.public")}</option>
                        </NativeSelect>
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        {s.visibilityDraft?.visibility === "session_private"
                          ? t("library.memory.visibility.session_private_desc")
                          : s.visibilityDraft?.visibility === "agent_shared"
                            ? t("library.memory.visibility.agent_shared_desc")
                            : s.visibilityDraft?.visibility === "public"
                              ? t("library.memory.visibility.public_desc")
                              : ""}
                      </p>

                      {/* 公共记忆接收助手勾选 */}
                      {s.visibilityDraft?.visibility === "public" && (
                        <div className="space-y-2 pt-2 border-t">
                          <p className="text-xs font-medium">
                            {t("library.memory.recipientsLabel")}
                          </p>
                          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border bg-muted/20">
                            {s.agents.map((ag) => (
                              <label
                                htmlFor={`recipient-agent-${ag.id}`}
                                key={ag.id}
                                className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer"
                              >
                                <Checkbox
                                  id={`recipient-agent-${ag.id}`}
                                  aria-label={ag.name}
                                  checked={s.visibilityDraft?.recipient_agent_ids.includes(ag.id)}
                                  onCheckedChange={(checked) => {
                                    const current = s.visibilityDraft?.recipient_agent_ids ?? [];
                                    const next =
                                      checked === true
                                        ? [...current, ag.id]
                                        : current.filter((id) => id !== ag.id);
                                    s.patchVisibilityDraft({ recipient_agent_ids: next });
                                  }}
                                />
                                <span>{ag.name}</span>
                                <Badge variant="outline" className="ml-auto text-[10px]">
                                  {ag.model_name}
                                </Badge>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}

                      {s.visibilityError && (
                        <div
                          role="alert"
                          className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive"
                        >
                          <p>{translateNotice(s.visibilityError)}</p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs ml-2 shrink-0"
                            disabled={s.metadataLoading || s.visibilitySaving}
                            onClick={() => {
                              if (entryId)
                                void s.loadMetadata(entryId, { advanceRevisionIfDirty: true });
                            }}
                          >
                            {t("capabilities.retry")}
                          </Button>
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-2 pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!hasValidBaseline || !s.visibilityDirty || s.visibilitySaving}
                          onClick={s.discardVisibilityDraft}
                        >
                          {t("library.memory.discardVisibility")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            !hasValidBaseline ||
                            !s.visibilityDirty ||
                            s.visibilitySaving ||
                            (s.visibilityDraft?.visibility === "public" &&
                              s.visibilityDraft.recipient_agent_ids.length === 0)
                          }
                          onClick={() => {
                            if (
                              hasValidBaseline &&
                              s.metadataBaseline &&
                              s.visibilityDraft &&
                              entryId &&
                              s.editorAgentId
                            ) {
                              setConfirmSnapshot({
                                agentId: s.editorAgentId,
                                entryId,
                                api: s.apiClient,
                                revision: s.metadataBaseline.revision,
                                visibility: s.visibilityDraft.visibility,
                                recipient_agent_ids: [...s.visibilityDraft.recipient_agent_ids],
                              });
                            }
                          }}
                        >
                          {t("library.memory.saveVisibility")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}
          <SheetFooter className="border-t">
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={s.memoryCorrectionSaving}
                tooltip={t("hints.library.memory.closeDetail")}
                onClick={close}
              >
                {t("library.close")}
              </Button>
              <Button
                variant="outline"
                disabled={!s.memoryCorrectionDirty || s.memoryCorrectionSaving}
                disabledReason={t("hints.library.memory.discardDisabled")}
                tooltip={t("hints.library.memory.discardCorrection")}
                onClick={() => {
                  s.discardMemoryCorrection();
                  void s.loadMemoryContent();
                }}
              >
                {t("library.discard.correction")}
              </Button>
              <Button
                disabled={!s.memoryCorrectionDirty || s.memoryCorrectionSaving}
                disabledReason={t("hints.library.memory.saveDisabled")}
                tooltip={t("hints.library.memory.saveCorrection")}
                onClick={() => void s.saveMemoryCorrection()}
              >
                {t("library.save.correction")}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={active && discard}
        message={t("library.discard.the.unsaved.memory.correction")}
        busy={s.memoryCorrectionSaving || s.visibilitySaving}
        onCancel={() => setDiscard(false)}
        onConfirm={() => {
          s.discardMemoryCorrection();
          s.discardVisibilityDraft();
          s.clearMetadata();
          s.clearMemoryDetail();
          setDiscard(false);
        }}
      />
      <ConfirmDialog
        open={active && confirmSnapshot !== null}
        message={t("library.memory.publicationConfirm", {
          "0": confirmSnapshot?.visibility
            ? t(`library.memory.visibility.${confirmSnapshot.visibility}`)
            : t("library.memory.visibility.unclassified"),
          "1":
            confirmSnapshot?.visibility === "public"
              ? confirmSnapshot.recipient_agent_ids.length
              : confirmSnapshot?.visibility === "agent_shared"
                ? 1
                : 0,
        })}
        busy={s.visibilitySaving}
        onCancel={() => setConfirmSnapshot(null)}
        onConfirm={() => {
          const snapshot = confirmSnapshot;
          if (!snapshot) return;
          const current = s.visibilityDraft;
          const base = s.metadataBaseline;
          const equalRecipients = (a: string[], b: string[]) =>
            a.length === b.length &&
            a
              .slice()
              .sort()
              .every((v, i) => v === b.slice().sort()[i]);

          if (
            snapshot.entryId !== entryId ||
            snapshot.agentId !== s.editorAgentId ||
            snapshot.api !== s.apiClient ||
            !base ||
            snapshot.revision !== base.revision ||
            !current ||
            snapshot.visibility !== current.visibility ||
            !equalRecipients(snapshot.recipient_agent_ids, current.recipient_agent_ids)
          ) {
            setConfirmSnapshot(null);
            return;
          }
          return s.saveVisibility().then(() => {
            setConfirmSnapshot(null);
          });
        }}
      />
    </>
  );
}

function ManualMemory({ onClose, active }: { onClose: () => void; active: boolean }) {
  const s = useSuperstringStore(
      useShallow((state) => ({
        clearMemoryTurns: state.clearMemoryTurns,
        loadMemoryTurns: state.loadMemoryTurns,
        manualConsolidate: state.manualConsolidate,
        memorySessions: state.memorySessions,
        memoryTurns: state.memoryTurns,
        pendingOperations: state.pendingOperations,
      })),
    ),
    t = useTranslation().t;
  const [session, setSession] = useState(s.memorySessions[0]?.id ?? ""),
    [limit, setLimit] = useState(50),
    [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    s.clearMemoryTurns();
    return s.clearMemoryTurns;
  }, [s.clearMemoryTurns]);
  return (
    <Sheet
      open={active}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{t("library.organize.memories.from.a.conversation")}</SheetTitle>
          <SheetDescription>
            {t("library.select.completed.turns.that.have.not.been.organized.organization")}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
          <Field
            label="library.source.conversation"
            tooltip={t("hints.library.memory.sourceConversationField")}
          >
            <NativeSelect
              value={session}
              onChange={(e) => {
                s.clearMemoryTurns();
                setSession(e.target.value);
                setSelected([]);
              }}
            >
              {s.memorySessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Field
                label="library.turns.to.load"
                tooltip={t("hints.library.memory.turnsToLoadField")}
              >
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </Field>
            </div>
            <Button
              variant="outline"
              disabled={!session}
              tooltip={t("hints.library.memory.loadTurns")}
              onClick={() => {
                setSelected([]);
                void s.loadMemoryTurns(session, limit);
              }}
            >
              {t("library.load.turns")}
            </Button>
          </div>
          <div className="divide-y rounded-lg border">
            {s.memoryTurns.map((turn) => (
              <label htmlFor={`memory-turn-${turn.id}`} key={turn.id} className="flex gap-3 p-4">
                <Checkbox
                  id={`memory-turn-${turn.id}`}
                  aria-label={t("library.select.turn.value", { "0": turn.sequence_no })}
                  disabled={turn.processed}
                  checked={selected.includes(turn.id)}
                  onCheckedChange={(v) =>
                    setSelected((ids) =>
                      v === true ? [...ids, turn.id] : ids.filter((id) => id !== turn.id),
                    )
                  }
                />
                <span className="min-w-0 space-y-2 text-sm">
                  <span className="block text-xs text-muted-foreground">
                    #{turn.sequence_no} ·{" "}
                    {t(turn.processed ? "library.consolidated" : "library.unprocessed")}
                  </span>
                  <span className="block whitespace-pre-wrap">{turn.user}</span>
                  <span className="block whitespace-pre-wrap text-muted-foreground">
                    {turn.assistant}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <SheetFooter className="border-t">
          <Button
            disabled={!selected.length || s.pendingOperations > 0}
            tooltip={t("hints.library.memory.organizeTurns")}
            onClick={() => void s.manualConsolidate(session, selected)}
          >
            {t("library.organize.value.selected.turns", { "0": selected.length })}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

const REBUILD_DEFAULT_BATCH_SIZE = 100;
const REBUILD_MIN_BATCH_SIZE = 1;
const REBUILD_MAX_BATCH_SIZE = 300;

export function RebuildSearchProjectionSheet({
  active,
  agentId,
  apiClient,
  onClose,
}: {
  active: boolean;
  agentId: string;
  apiClient: SuperstringApi;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [batchSizeInput, setBatchSizeInput] = useState<string>(String(REBUILD_DEFAULT_BATCH_SIZE));
  const [cursor, setCursor] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [lastRebuilt, setLastRebuilt] = useState<number | null>(null);
  const [traversalFinished, setTraversalFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmedOutcome, setUnconfirmedOutcome] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const requestTokenRef = useRef(0);
  const currentAgentIdRef = useRef(agentId);
  currentAgentIdRef.current = agentId;
  const currentApiClientRef = useRef(apiClient);
  currentApiClientRef.current = apiClient;
  const activeRef = useRef(active);
  activeRef.current = active;

  const parsedBatch = Number(batchSizeInput);
  const isValidBatchSize =
    Number.isInteger(parsedBatch) &&
    parsedBatch >= REBUILD_MIN_BATCH_SIZE &&
    parsedBatch <= REBUILD_MAX_BATCH_SIZE;

  useEffect(() => {
    if (!active && inFlightRef.current) {
      abortRef.current?.abort();
      requestTokenRef.current++;
      inFlightRef.current = false;
      setRebuilding(false);
      setUnconfirmedOutcome(true);
    }
  }, [active]);

  useEffect(() => {
    if (agentId && apiClient && inFlightRef.current) {
      abortRef.current?.abort();
      inFlightRef.current = false;
    }
    requestTokenRef.current++;
    setRebuilding(false);
    setCursor(null);
    setLastRebuilt(null);
    setTraversalFinished(false);
    setError(null);
    setUnconfirmedOutcome(false);
  }, [agentId, apiClient]);

  useEffect(() => {
    return () => {
      if (inFlightRef.current) {
        abortRef.current?.abort();
        inFlightRef.current = false;
      }
    };
  }, []);

  const cancelInFlight = () => {
    if (inFlightRef.current) {
      abortRef.current?.abort();
      requestTokenRef.current++;
      inFlightRef.current = false;
      setRebuilding(false);
      setUnconfirmedOutcome(true);
    }
  };

  const handleClose = () => {
    cancelInFlight();
    onClose();
  };

  const startNewPass = () => {
    cancelInFlight();
    requestTokenRef.current++;
    setCursor(null);
    setLastRebuilt(null);
    setTraversalFinished(false);
    setError(null);
    setUnconfirmedOutcome(false);
  };

  const executeBatch = async () => {
    if (rebuilding || !isValidBatchSize) return;
    setError(null);
    setUnconfirmedOutcome(false);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;

    const thisToken = ++requestTokenRef.current;
    const targetAgentId = currentAgentIdRef.current;
    const targetApiClient = currentApiClientRef.current;

    setRebuilding(true);

    try {
      const payload: { after_id?: string; limit: number } = { limit: parsedBatch };
      if (cursor) payload.after_id = cursor;

      const res = await targetApiClient.rebuildMemorySearchProjection(
        targetAgentId,
        payload,
        controller.signal,
      );

      // 取消/过期/切 Agent：即使底层已 resolve 亦直接丢弃，不收成功，不进游标
      if (
        controller.signal.aborted ||
        thisToken !== requestTokenRef.current ||
        currentAgentIdRef.current !== targetAgentId ||
        currentApiClientRef.current !== targetApiClient ||
        !activeRef.current
      ) {
        return;
      }

      inFlightRef.current = false;
      setRebuilding(false);
      setLastRebuilt(res.rebuilt);
      setCursor(res.next_after_id);
      if (res.next_after_id === null) {
        setTraversalFinished(true);
      }
    } catch (err: unknown) {
      // 过期响应直接丢弃；取消本对象才标记未确认（unknown outcome）
      if (
        thisToken !== requestTokenRef.current ||
        currentAgentIdRef.current !== targetAgentId ||
        currentApiClientRef.current !== targetApiClient
      ) {
        return;
      }

      inFlightRef.current = false;
      setRebuilding(false);

      if (controller.signal.aborted || !activeRef.current) {
        setUnconfirmedOutcome(true);
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  return (
    <Sheet
      open={active}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t("library.rebuild.title")}</SheetTitle>
          <SheetDescription>{t("library.rebuild.description")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-4">
          <Field label={t("library.rebuild.batchSize")}>
            <Input
              type="number"
              min={REBUILD_MIN_BATCH_SIZE}
              max={REBUILD_MAX_BATCH_SIZE}
              disabled={rebuilding}
              value={batchSizeInput}
              onChange={(e) => setBatchSizeInput(e.target.value)}
            />
          </Field>

          <div className="rounded-lg border border-border/80 bg-muted/30 p-3 space-y-1.5 text-xs">
            <div className="flex justify-between items-center text-muted-foreground">
              <span>{t("library.rebuild.currentCursor")}</span>
              <span className="font-mono font-medium text-foreground">
                {cursor ?? t("library.rebuild.startFromBeginning")}
              </span>
            </div>
            {lastRebuilt !== null && (
              <div className="text-muted-foreground">
                {t("library.rebuild.batchSuccess", { "0": lastRebuilt })}
              </div>
            )}
          </div>

          {traversalFinished && (
            <div
              role="status"
              className="rounded-lg border border-border/80 bg-muted/40 p-3 text-xs text-muted-foreground"
            >
              {t("library.rebuild.traversalFinished")}
            </div>
          )}

          {unconfirmedOutcome && (
            <div
              role="status"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
            >
              {t("library.rebuild.abortedUnknown")}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <p className="font-medium">{error}</p>
              <p className="mt-1 text-muted-foreground">{t("library.rebuild.failedRetry")}</p>
            </div>
          )}
        </div>
        <SheetFooter className="gap-2 sm:justify-end">
          {rebuilding ? (
            <>
              <Button variant="outline" size="sm" onClick={cancelInFlight}>
                {t("library.rebuild.cancel")}
              </Button>
              <Button size="sm" disabled>
                {t("library.rebuild.inFlight")}
              </Button>
            </>
          ) : traversalFinished ? (
            <>
              <Button variant="outline" size="sm" onClick={handleClose}>
                {t("library.rebuild.close")}
              </Button>
              <Button size="sm" onClick={startNewPass}>
                {t("library.rebuild.startNewPass")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleClose}>
                {t("library.rebuild.close")}
              </Button>
              <Button size="sm" disabled={!isValidBatchSize} onClick={() => void executeBatch()}>
                {cursor
                  ? t("library.rebuild.continueNextBatch")
                  : t("library.rebuild.executeBatch")}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
