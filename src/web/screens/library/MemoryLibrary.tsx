import {
  ChevronLeft,
  ChevronRight,
  Combine,
  Cpu,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useLiveResource } from "@/services/use-live-resource";
import { errorText } from "@/state/helpers";
import { useSuperstringStore } from "@/store";
import type { MemoryJobView } from "../../../shared/contracts";
import { memoryScopeIdentity } from "../../../shared/memory-scope";
import { JobRunLink } from "../runs/RunEntry";
import { BindingMemoryControls } from "./BindingMemoryControls";
import { memoryScopeLabel } from "./scope-label";

export function MemoryLibrary() {
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
    [shareBusy, setShareBusy] = useState(false),
    [retryJob, setRetryJob] = useState<MemoryJobView | null>(null),
    [retryBusy, setRetryBusy] = useState(false),
    [retryError, setRetryError] = useState("");
  const agentId = s.editorAgentId,
    agent = s.agents.find((a) => a.id === agentId),
    ready = !!agent && !s.editorLoading;
  useEffect(() => {
    if (!s.pageEditor && !s.editorLoading && s.agents[0]) s.requestAgentNavigation(s.agents[0].id);
  }, [s.pageEditor, s.editorLoading, s.agents, s.requestAgentNavigation]);
  useEffect(() => () => s.resetMemoryManagement(), [s.resetMemoryManagement]);
  const read = useCallback(async () => {
    const [scopes, connections] = await Promise.all([
      s.apiClient.listMemoryScopes(agentId),
      Promise.allSettled([s.apiClient.listQqBindings(), s.apiClient.getQqOwner()]),
    ]);
    const [bindings, owner] = connections;
    return {
      scopes,
      bindings: bindings.status === "fulfilled" ? bindings.value : [],
      owner: owner.status === "fulfilled" ? owner.value : null,
      connectionError: connections.some((result) => result.status === "rejected"),
    };
  }, [s.apiClient, agentId]);
  const resource = useLiveResource(read, { enabled: ready });
  useEffect(() => {
    if (!agentId) return;
    setScope("");
    setPage(1);
    setSelected([]);
    setSearch("");
    setQuery("");
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
  useEffect(() => {
    if (ready && agentId)
      void s.loadMemoryPage(page, {
        ...(scope ? { scope_key: scope } : {}),
        ...(query ? { search: query } : {}),
        ...(status !== "all" ? { status } : {}),
      });
  }, [ready, agentId, page, scope, query, status, s.loadMemoryPage]);
  const selectedScope = resource.data?.scopes.find((item) => item.scope_key === scope);
  const binding = resource.data?.bindings.find((item) => item.id === selectedScope?.binding?.id);
  const owner = resource.data?.owner;
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
  useEffect(() => {
    if (ready && !editor?.policy) void s.loadMemoryPolicy();
  }, [ready, editor?.policy, s.loadMemoryPolicy]);
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
    await s.reloadMemory();
    await s.loadMemoryPage(page, {
      ...(scope ? { scope_key: scope } : {}),
      ...(query ? { search: query } : {}),
      ...(status !== "all" ? { status } : {}),
    });
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
      if (state.memoryCorrectionDirty || state.memoryCorrectionSaving) {
        // 草稿在场时 reloadMemory 会整体早退（任务列表不更新）；这里只替换任务列表，不触碰草稿与详情。
        const jobs = await client.listMemoryJobs(targetAgent);
        if (!stillCurrent()) return;
        useSuperstringStore.setState({ memoryJobs: jobs });
      } else {
        // 成功后走 reloadMemory 刷新任务列表与页面基线，纠正草稿与保存中的内容不会被清空。
        await s.reloadMemory();
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
  const retryConfirmMessage = retryJob
    ? t("library.memory.job.retry.confirm", { "0": retryJob.id })
    : "";
  return (
    <section className="space-y-5" aria-label={t("library.memory.library")}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <Field label="library.agent.owner">
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
        <Button variant="outline" disabled={!ready || locked} onClick={refresh}>
          <RefreshCw />
          {t("library.refresh")}
        </Button>
        <Button disabled={!ready || locked} onClick={() => setManual(true)}>
          {t("library.organize.memories.from.a.conversation")}
        </Button>
        {/* 读取额度已迁到系统能力页：内容区只保留直达入口，草稿安全跳转。 */}
        <Button
          variant="outline"
          className="h-auto min-h-8 max-w-full whitespace-normal break-words"
          onClick={() => s.openSettingsRoute("memory-tools")}
        >
          <SlidersHorizontal />
          {t("capabilities.resources.openMemoryTools")}
        </Button>
      </div>
      {resource.data?.connectionError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("library.connection.metadata.unavailable")}
        </p>
      )}
      {(resource.error || s.error) && (
        <p role="alert" className="text-sm text-destructive">
          {resource.error || translateNotice(s.error ?? "")}
        </p>
      )}
      {s.feedback && !resource.error && !s.error && (
        <p role="status" className="text-sm text-muted-foreground">
          {translateNotice(s.feedback)}
        </p>
      )}
      {ready && (
        <>
          <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            <aside className="space-y-4">
              <div className="space-y-1 rounded-xl border p-2">
                <Button
                  variant={scope === "" ? "secondary" : "ghost"}
                  className="w-full justify-between"
                  disabled={locked}
                  onClick={() => {
                    setScope("");
                    setPage(1);
                    setSelected([]);
                  }}
                >
                  {t("library.all.partitions")}
                  <Badge variant="outline">
                    {resource.data?.scopes.reduce((sum, row) => sum + row.count, 0) ?? 0}
                  </Badge>
                </Button>
                {resource.data?.scopes.map((item) => (
                  <Button
                    key={item.scope_key}
                    variant={scope === item.scope_key ? "secondary" : "ghost"}
                    className="h-auto w-full justify-between gap-3 py-3 text-left"
                    disabled={locked}
                    onClick={() => {
                      setScope(item.scope_key);
                      setPage(1);
                      setSelected([]);
                    }}
                  >
                    <span className="whitespace-normal text-xs leading-relaxed">
                      {memoryScopeLabel(item.scope_key, agentId, t)}
                    </span>
                    <span className="text-xs tabular-nums">{item.count}</span>
                  </Button>
                ))}
              </div>
              {selectedScope && (
                <Card>
                  <CardContent className="space-y-4">
                    <p className="text-xs text-muted-foreground">
                      {t("library.value.active.value.total", {
                        "0": selectedScope.active_count,
                        "1": selectedScope.count,
                      })}
                    </p>
                    <div className="space-y-1 text-xs">
                      <p className="font-medium">{t("library.read.partitions")}</p>
                      {selectedScope.read_scope_keys === null ? (
                        <p className="text-muted-foreground">
                          {t("library.reading.scope.unavailable")}
                        </p>
                      ) : (
                        selectedScope.read_scope_keys.map((key) => (
                          <p key={key} className="break-all text-muted-foreground">
                            {memoryScopeLabel(key, agentId, t)}
                          </p>
                        ))
                      )}
                      <p className="pt-2 font-medium">{t("library.write.partition")}</p>
                      <p className="text-muted-foreground">
                        {memoryScopeLabel(selectedScope.write_scope_key, agentId, t)}
                      </p>
                    </div>
                    {binding && (
                      <BindingMemoryControls
                        binding={binding}
                        pending={selectedScope.pending ?? undefined}
                        onChanged={refresh}
                      />
                    )}
                    {binding && shareEligible && (
                      <Field
                        label="library.share.with.web.memories"
                        info="library.turning.sharing.off.does.not.move.or.delete.existing"
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
                    )}
                    {selectedScope.latest_job && (
                      <JobRunLink ownerKind="memory_job" ownerId={selectedScope.latest_job.id} />
                    )}
                  </CardContent>
                </Card>
              )}
            </aside>
            <div className="min-w-0 space-y-4">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setQuery(search);
                  setPage(1);
                  setSelected([]);
                }}
              >
                <Input
                  className="min-w-40 flex-1"
                  aria-label={t("library.search.memories")}
                  placeholder={t("library.search.memories")}
                  value={search}
                  disabled={locked}
                  onChange={(e) => setSearch(e.target.value)}
                />
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
                <Button type="submit" variant="outline" disabled={locked}>
                  {t("library.search")}
                </Button>
              </form>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || !s.memoryEntries.length}
                onClick={() => setSelected(s.memoryEntries.map((entry) => entry.id))}
              >
                {t("library.select.current.results")}
              </Button>
              {selected.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 p-3">
                  <span className="mr-2 text-sm">
                    {t("library.value.selected", { "0": selected.length })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!mergeable || locked}
                    onClick={() =>
                      void s.mergeMemories(agentId, selected).then((ok) => {
                        if (ok) refresh();
                      })
                    }
                  >
                    <Combine />
                    {t("library.merge")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked}
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
                    onClick={() => setPurge(true)}
                  >
                    {t("library.permanently.delete")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                    {t("library.clear.selection")}
                  </Button>
                </div>
              )}
              <div className="divide-y rounded-xl border">
                {s.memoryEntries.map((entry) => (
                  <div key={entry.id} className="flex gap-3 p-4">
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
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="link"
                          className="h-auto p-0 text-left font-medium"
                          disabled={locked}
                          onClick={() => void s.loadMemoryEntryDetail(entry.id)}
                        >
                          {entry.name}
                        </Button>
                        <Badge variant="outline">{t(`library.status.${entry.status}`)}</Badge>
                      </div>
                      <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                        {entry.summary}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-1">
                        {entry.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {memoryScopeLabel(entry.scope_key, agentId, t)} ·{" "}
                        {new Date(entry.created_at).toLocaleString(i18n.resolvedLanguage)}
                      </p>
                    </div>
                  </div>
                ))}
                {s.memoryEntries.length === 0 && (
                  <p className="p-12 text-center text-sm text-muted-foreground">
                    {t("library.no.memories.in.this.scope.organize.completed.conversation.turns")}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {t("library.value.entries.page.value", { "0": s.memoryEntryTotal, "1": page })}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("library.previous.page")}
                    disabled={page <= 1 || locked}
                    onClick={() => {
                      setPage(page - 1);
                      setSelected([]);
                    }}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("library.next.page")}
                    disabled={page * 100 >= s.memoryEntryTotal || locked}
                    onClick={() => {
                      setPage(page + 1);
                      setSelected([]);
                    }}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
              {showMaintenance && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center gap-2">
                      {t("library.memory.maintenance")}
                      <Badge variant="secondary">{t("library.scope.web")}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {t(
                        "library.web.conversations.use.a.turn.based.policy.connected.conversations",
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {editor?.policyDraft ? (
                      <>
                        <Field label="library.automatically.organize.web.memories">
                          <Checkbox
                            disabled={locked}
                            checked={editor.policyDraft.auto_enabled}
                            onCheckedChange={(value) =>
                              s.patchPagePolicy({ auto_enabled: value === true })
                            }
                          />
                        </Field>
                        <Field label="library.organize.every.n.turns">
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
                        <Field label="library.target.memory.characters">
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
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("library.loading")}</p>
                    )}
                    <Field label="library.memory.organization.prompt">
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
                    <Field label="library.additional.organization.instructions">
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
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
                      <Button
                        variant="outline"
                        className="mr-auto h-auto min-h-8 max-w-full whitespace-normal break-words"
                        onClick={() => s.openSettingsRoute("models")}
                      >
                        <Cpu />
                        {t("library.open.model.services")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!maintenanceDirty || locked || s.settingsSaving}
                        onClick={discardMaintenance}
                      >
                        {t("library.discard.changes")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!maintenanceDirty || locked || s.settingsSaving}
                        onClick={() => void saveMaintenance()}
                      >
                        {t("library.save.memory.rules")}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("library.maintenance.jobs")}</CardTitle>
              <CardDescription>
                {t("library.inspect.organization.and.merge.results.and.their.model.runs")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {s.memoryJobs.map((job) => (
                  <div key={job.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                    <Badge variant="outline">{job.kind}</Badge>
                    <span>{t(`library.status.${job.status}`)}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(job.created_at).toLocaleString(i18n.resolvedLanguage)}
                    </span>
                    {job.error_code && <span className="text-destructive">{job.error_code}</span>}
                    <div className="ml-auto flex items-center gap-2">
                      {job.status === "failed" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={hasActiveJob || retryBusy}
                          onClick={() => {
                            setRetryError("");
                            setRetryJob(job);
                          }}
                        >
                          <RotateCcw />
                          {t("capabilities.retry")}
                        </Button>
                      )}
                      <JobRunLink ownerKind="memory_job" ownerId={job.id} />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
      <MemoryDetail />
      {manual && <ManualMemory onClose={() => setManual(false)} />}
      {purge && (
        <ConfirmDialog
          message={t("library.permanently.delete.value.memories.this.cannot.be.undone", {
            "0": selected.length,
          })}
          onCancel={() => setPurge(false)}
          onConfirm={() => {
            return s.governMemories(agentId, selected, "purge", true).then((ok) => {
              if (ok) {
                setPurge(false);
                setSelected([]);
                refresh();
              }
            });
          }}
        />
      )}
      {retryJob && (
        <ConfirmDialog
          message={
            retryError
              ? `${retryConfirmMessage} ${translateNotice(retryError)}`
              : retryConfirmMessage
          }
          confirmLabel={t("capabilities.retry")}
          busy={retryBusy}
          onCancel={() => {
            setRetryJob(null);
            setRetryError("");
          }}
          onConfirm={retryFailedJob}
        />
      )}
    </section>
  );
}

export function MemoryDetail() {
  const s = useSuperstringStore(),
    t = useTranslation().t,
    entry = s.memoryEntryDetail,
    content = s.memoryContent,
    draft = s.memoryCorrectionDraft;
  const [discard, setDiscard] = useState(false);
  const [tagText, setTagText] = useState(draft?.tags.join(", ") ?? "");
  const correctionRevision = draft?.expected_revision;
  const entryId = entry?.id;
  useEffect(() => {
    if (correctionRevision)
      setTagText(useSuperstringStore.getState().memoryCorrectionDraft?.tags.join(", ") ?? "");
  }, [correctionRevision]);
  useEffect(() => {
    if (entryId) void s.loadMemoryContent();
  }, [entryId, s.loadMemoryContent]);
  const close = () => {
    if (s.memoryCorrectionDirty) setDiscard(true);
    else s.clearMemoryDetail();
  };
  return (
    <>
      <Sheet
        open={!!entry}
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
                  <TabsTrigger value="snapshot">{t("library.configuration.snapshot")}</TabsTrigger>
                </TabsList>
                <TabsContent value="content" className="space-y-4">
                  <p className="text-sm text-muted-foreground">{entry.summary}</p>
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">
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
                      <Field label="library.name">
                        <Input
                          maxLength={100}
                          value={draft.name}
                          onChange={(e) => s.patchMemoryCorrection({ name: e.target.value })}
                        />
                      </Field>
                      <Field label="library.summary">
                        <Textarea
                          maxLength={500}
                          rows={3}
                          value={draft.summary}
                          onChange={(e) => s.patchMemoryCorrection({ summary: e.target.value })}
                        />
                      </Field>
                      <Field label="library.tags.comma.separated">
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
                      <Field label="library.memory.body">
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
                  <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs">
                    {JSON.stringify(entry.config_snapshot, null, 2)}
                  </pre>
                </TabsContent>
              </Tabs>
            </div>
          )}
          <SheetFooter className="border-t">
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={s.memoryCorrectionSaving} onClick={close}>
                {t("library.close")}
              </Button>
              <Button
                variant="outline"
                disabled={!s.memoryCorrectionDirty || s.memoryCorrectionSaving}
                onClick={() => {
                  s.discardMemoryCorrection();
                  void s.loadMemoryContent();
                }}
              >
                {t("library.discard.correction")}
              </Button>
              <Button
                disabled={!s.memoryCorrectionDirty || s.memoryCorrectionSaving}
                onClick={() => void s.saveMemoryCorrection()}
              >
                {t("library.save.correction")}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      {discard && (
        <ConfirmDialog
          message={t("library.discard.the.unsaved.memory.correction")}
          onCancel={() => setDiscard(false)}
          onConfirm={() => {
            s.discardMemoryCorrection();
            s.clearMemoryDetail();
            setDiscard(false);
          }}
        />
      )}
    </>
  );
}

function ManualMemory({ onClose }: { onClose: () => void }) {
  const s = useSuperstringStore(),
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
      open
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
          <Field label="library.source.conversation">
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
              <Field label="library.turns.to.load">
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
            onClick={() => void s.manualConsolidate(session, selected)}
          >
            {t("library.organize.value.selected.turns", { "0": selected.length })}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
