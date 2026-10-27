import type { PolicyView } from "../../../shared/contracts";
import { msg } from "../../i18n";
import { consumePreloadedMemory } from "../../services/agent-preload";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { type PageEditor, POLICY_FIELDS } from "../agents/page-drafts";

// 刷新只推进未改字段，返回时的新编辑也必须保留。
function mergePolicyIntoEditor(editor: PageEditor, policy: PolicyView): PageEditor {
  if (!editor.policy)
    return { ...editor, policy, policyDraft: editor.policyDraft ?? { ...policy } };
  const baseline = editor.policy;
  const draft = editor.policyDraft ?? { ...baseline };
  const merged: PolicyView = { ...policy };
  for (const key of POLICY_FIELDS) {
    // 联合字面量键无法直接收窄赋值；写入值来自同型草稿对象，只覆盖字段值。
    if (draft[key] !== baseline[key]) Object.assign(merged, { [key]: draft[key] });
  }
  return { ...editor, policy, policyDraft: merged };
}

export function createMemoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "resetMemoryManagement"
  | "loadMemoryPolicy"
  | "clearMemoryTurns"
  | "reloadMemory"
  | "loadMemoryManagement"
  | "cancelMemoryManagementRead"
  | "loadMemoryContent"
  | "patchMemoryCorrection"
  | "saveMemoryCorrection"
  | "discardMemoryCorrection"
  | "loadMemoryTurns"
  | "loadMemoryPage"
  | "loadMemoryEntryDetail"
  | "manualConsolidate"
  | "updatePolicy"
  | "governMemories"
  | "mergeMemories"
  | "patchQqMemoryBatchDraft"
  | "saveQqMemoryBatchDrafts"
  | "discardQqMemoryBatchDrafts"
  | "loadMemoryAccessMetadata"
  | "patchMemoryVisibilityDraft"
  | "saveMemoryVisibility"
  | "discardMemoryVisibilityDraft"
  | "clearMemoryMetadata"
> {
  let selectionRequest = 0;
  let managementEpoch = 0;
  let turnsRequest = 0;
  let metadataReadRequest = 0;
  let metadataSaveRequest = 0;
  let metadataReadTask: ReadTask | null = null;
  let activeMetadataResolve: ((value: boolean) => void) | null = null;
  let managementReadTask: ReadTask | null = null;
  let managementResolve: ((value: boolean) => void) | null = null;
  let managementReadRequest = 0;
  const currentContext = () => {
    const { editorAgentId, page, settingsView, settingsRoute, pageEditor, apiClient } = get();
    const epoch = managementEpoch;
    return () => {
      const state = get();
      return (
        epoch === managementEpoch &&
        state.editorAgentId === editorAgentId &&
        state.page === page &&
        state.settingsView === settingsView &&
        state.settingsRoute === settingsRoute &&
        state.pageEditor?.token === pageEditor?.token &&
        state.apiClient === apiClient
      );
    };
  };
  let loadedManagement: { api: SuperstringState["apiClient"]; agentId: string } | null = null;
  const cancelManagement = () => {
    managementReadRequest++;
    managementReadTask?.cancel();
    managementReadTask = null;
    managementResolve?.(false);
    managementResolve = null;
    loadedManagement = null;
    set({ memoryManagementLoading: false });
  };
  const loadManagement = (
    page: number,
    filters: { scope_key?: string; search?: string; status?: string } = {},
    options: { metadata?: boolean } = {},
  ): Promise<boolean> => {
    if (
      get().memoryCorrectionDirty ||
      get().memoryCorrectionSaving ||
      get().memoryVisibilityDirty ||
      get().memoryVisibilitySaving
    )
      return Promise.resolve(false);
    if (!Number.isInteger(page) || page < 1) {
      set({ memoryManagementError: msg("页码必须为正整数") });
      return Promise.resolve(false);
    }
    const id = get().editorAgentId;
    if (id === "__new__") return Promise.resolve(false);
    const api = get().apiClient;
    const previousLoaded = loadedManagement;
    managementReadTask?.cancel();
    managementReadTask = null;
    managementResolve?.(false);
    managementResolve = null;
    const request = ++managementReadRequest;
    get().discardMemoryCorrection();
    const selection = selectionRequest;
    const matches = currentContext();
    const metadata =
      options.metadata !== false || previousLoaded?.api !== api || previousLoaded?.agentId !== id;
    const isCurrent = () =>
      request === managementReadRequest &&
      matches() &&
      selection === selectionRequest &&
      get().editorAgentId === id &&
      get().apiClient === api &&
      !get().memoryCorrectionDirty &&
      !get().memoryCorrectionSaving &&
      !get().memoryVisibilityDirty &&
      !get().memoryVisibilitySaving;
    set({ memoryManagementLoading: true, memoryManagementError: null });
    type Stage =
      | {
          kind: "metadata";
          policy: PolicyView;
          sessions: SuperstringState["memorySessions"];
          jobs: SuperstringState["memoryJobs"];
        }
      | { kind: "page"; result: Awaited<ReturnType<typeof api.listMemoryEntries>> };
    return new Promise<boolean>((resolve) => {
      managementResolve = resolve;
      const task = startRead<Stage>(
        async (signal, progress) => {
          if (metadata) {
            const [policy, sessions, jobs] = await Promise.all([
              api.getPolicy(id, signal),
              api.listMemorySessions(id, signal),
              api.listMemoryJobs(id, signal),
            ]);
            signal.throwIfAborted();
            progress({ kind: "metadata", policy, sessions, jobs });
          }
          signal.throwIfAborted();
          const preloaded =
            page === 1 &&
            get().memoryEntries.length === 0 &&
            !filters.scope_key &&
            !filters.search &&
            !filters.status
              ? consumePreloadedMemory(api, id)
              : null;
          return {
            kind: "page",
            result:
              preloaded ??
              (await api.listMemoryEntries(id, (page - 1) * 100, 100, filters, signal)),
          };
        },
        {
          progress: (stage) => {
            if (!isCurrent() || stage.kind !== "metadata") return;
            const editor = get().pageEditor;
            set({
              policy: stage.policy,
              memorySessions: stage.sessions,
              memoryJobs: stage.jobs,
              ...(editor && editor.agent.id === id
                ? { pageEditor: mergePolicyIntoEditor(editor, stage.policy) }
                : {}),
            });
            loadedManagement = { api, agentId: id };
          },
          success: (stage) => {
            if (managementReadTask === task) managementReadTask = null;
            if (managementResolve === resolve) managementResolve = null;
            if (!isCurrent() || stage.kind !== "page") {
              if (request === managementReadRequest) set({ memoryManagementLoading: false });
              resolve(false);
              return;
            }
            set({
              memoryEntries: stage.result.items,
              memoryEntryTotal: stage.result.total,
              memoryEntryDetail: null,
              memoryManagementError: null,
              memoryManagementLoading: false,
            });
            resolve(true);
          },
          failure: (reason) => {
            if (managementReadTask === task) managementReadTask = null;
            if (managementResolve === resolve) managementResolve = null;
            if (isCurrent())
              set({ memoryManagementError: errorText(reason), memoryManagementLoading: false });
            else if (request === managementReadRequest) set({ memoryManagementLoading: false });
            resolve(false);
          },
        },
      );
      managementReadTask = task;
    });
  };
  return {
    loadMemoryManagement: loadManagement,
    cancelMemoryManagementRead: cancelManagement,
    patchQqMemoryBatchDraft: (id, draft) => {
      if (get().qqMemoryBatchSaving) return;
      const drafts = { ...get().qqMemoryBatchDrafts };
      if (draft) drafts[id] = draft;
      else delete drafts[id];
      set({ qqMemoryBatchDrafts: drafts });
    },
    discardQqMemoryBatchDrafts: () => {
      if (!get().qqMemoryBatchSaving) set({ qqMemoryBatchDrafts: {} });
    },
    saveQqMemoryBatchDrafts: async (ids) => {
      if (get().qqMemoryBatchSaving) return false;
      const entries = Object.entries(get().qqMemoryBatchDrafts).filter(
        ([id]) => !ids || ids.includes(id),
      );
      if (
        entries.some(
          ([, draft]) =>
            draft.value.trim() !== "" &&
            (!Number.isSafeInteger(Number(draft.value)) || Number(draft.value) < 1),
        )
      ) {
        set({ error: msg("条数需为正整数，留空表示关闭。") });
        return false;
      }
      set({ qqMemoryBatchSaving: true, error: null });
      try {
        for (const [id, draft] of entries) {
          const saved = await get().apiClient.updateQqBinding(id, {
            memory_batch_size: draft.value.trim() === "" ? null : Number(draft.value),
            expected_revision: draft.revision,
          });
          const drafts = { ...get().qqMemoryBatchDrafts };
          delete drafts[id];
          set({
            qqMemoryBatchDrafts: drafts,
            qqBindings: get().qqBindings.map((binding) =>
              binding.id === saved.id ? saved : binding,
            ),
          });
        }
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      } finally {
        set({ qqMemoryBatchSaving: false });
      }
    },
    resetMemoryManagement: () => {
      cancelManagement();
      managementEpoch += 1;
      selectionRequest += 1;
      turnsRequest += 1;
      if (
        get().memoryCorrectionDirty ||
        get().memoryCorrectionSaving ||
        get().memoryVisibilityDirty ||
        get().memoryVisibilitySaving
      )
        return;
      get().clearMemoryMetadata();
      set({
        memoryTurns: [],
        memoryEntries: [],
        memoryEntryTotal: 0,
        memoryManagementError: null,
        memoryEntryDetail: null,
        memoryContent: null,
        memoryCorrectionDraft: null,
      });
    },
    clearMemoryTurns: () => {
      turnsRequest += 1;
      set({ memoryTurns: [] });
    },
    discardMemoryCorrection: () => {
      if (get().memoryCorrectionSaving) return;
      selectionRequest += 1;
      set({
        memoryContent: null,
        memoryCorrectionDraft: null,
        memoryCorrectionDirty: false,
      });
    },
    patchMemoryCorrection: (patch) => {
      const draft = get().memoryCorrectionDraft;
      if (draft && !get().memoryCorrectionSaving)
        set({
          memoryCorrectionDraft: { ...draft, ...patch },
          memoryCorrectionDirty: true,
        });
    },
    loadMemoryContent: async () => {
      const agentId = get().editorAgentId;
      const id = get().memoryEntryDetail?.id;
      if (!id || get().memoryCorrectionDirty || get().memoryCorrectionSaving) return;
      const request = ++selectionRequest;
      const matches = currentContext();
      try {
        const detail = await get().apiClient.getMemoryContent(agentId, id);
        if (
          !matches() ||
          request !== selectionRequest ||
          get().editorAgentId !== agentId ||
          get().memoryEntryDetail?.id !== id ||
          get().memoryCorrectionDirty ||
          get().memoryCorrectionSaving
        )
          return;
        const c = detail.content;
        set({
          memoryContent: detail,
          memoryCorrectionDraft: {
            expected_revision: c.revision,
            name: c.name,
            summary: c.summary,
            tags: c.tags,
            body: c.body ?? "",
          },
          memoryCorrectionDirty: false,
          error: null,
        });
      } catch (error) {
        if (!matches() || request !== selectionRequest) return;
        set({ error: errorText(error) });
      }
    },
    saveMemoryCorrection: async () => {
      if (get().memoryVisibilityDirty) {
        set({ error: msg("存在未保存的共享设置修改，请先保存或放弃共享设置后再保存内容纠正。") });
        return false;
      }
      const agentId = get().editorAgentId;
      const detail = get().memoryContent;
      const draft = get().memoryCorrectionDraft;
      if (!get().memoryCorrectionDirty) return true;
      if (!detail || !draft || get().memoryCorrectionSaving) return false;
      const capturedApi = get().apiClient;
      const capturedDetailId = detail.content.id;
      const capturedEpoch = managementEpoch;
      const matches = currentContext();
      set({ memoryCorrectionSaving: true });
      try {
        const saved = await capturedApi.correctMemory(agentId, detail.content.id, {
          ...draft,
          tags: draft.tags.filter((tag) => tag.trim().length > 0),
        });
        if (
          !matches() ||
          managementEpoch !== capturedEpoch ||
          get().editorAgentId !== agentId ||
          get().apiClient !== capturedApi ||
          get().memoryEntryDetail?.id !== capturedDetailId
        ) {
          return false;
        }
        const c = saved.content;
        const old = get().memoryEntryDetail;
        set({
          memoryContent: saved,
          memoryCorrectionDraft: {
            expected_revision: c.revision,
            name: c.name,
            summary: c.summary,
            tags: c.tags,
            body: c.body ?? "",
          },
          memoryCorrectionDirty: false,
          memoryEntryDetail: old
            ? {
                ...old,
                id: c.id,
                name: c.name,
                summary: c.summary,
                body: c.body ?? "",
                tags: c.tags,
                status: saved.status,
              }
            : null,
          memoryEntries: get().memoryEntries.map((item) =>
            item.id === detail.content.id ? { ...item, status: "replaced" } : item,
          ),
          feedback: msg("记忆已纠正，后续新轮使用新修订；旧内容及派生已停用。"),
          error: null,
        });
        void get().loadMemoryAccessMetadata(c.id);
        return true;
      } catch (error) {
        if (
          matches() &&
          managementEpoch === capturedEpoch &&
          get().editorAgentId === agentId &&
          get().apiClient === capturedApi
        ) {
          set({ error: errorText(error) });
        }
        return false;
      } finally {
        if (
          managementEpoch === capturedEpoch &&
          get().editorAgentId === agentId &&
          get().apiClient === capturedApi
        ) {
          set({ memoryCorrectionSaving: false });
        }
      }
    },
    // 记忆页要显示"网页自动整理开没开"，但不需要 `reloadMemory` 那种整页重置（它会清空列表与详情）。
    // 这一跳只读策略：没有它，网页分区的状态会永远停在"正在读取…"。
    loadMemoryPolicy: async () => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      const matches = currentContext();
      try {
        const policy = await get().apiClient.getPolicy(id);
        if (!matches() || get().editorAgentId !== id) return;
        const editor = get().pageEditor;
        set({
          policy,
          ...(editor && editor.agent.id === id
            ? { pageEditor: mergePolicyIntoEditor(editor, policy) }
            : {}),
        });
      } catch (error) {
        // 读不到保留旧基线与草稿，只提示失败，不假装已关闭或已成功。
        if (!matches() || get().editorAgentId !== id) return;
        set({ memoryManagementError: errorText(error) });
      }
    },
    reloadMemory: async () => {
      await loadManagement(1, {}, { metadata: true });
    },
    loadMemoryTurns: async (sessionId, limit) => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      const contextMatches = currentContext();
      const request = ++turnsRequest;
      const matches = () => contextMatches() && request === turnsRequest;
      try {
        const result = await get().apiClient.listMemoryTurns(id, sessionId, limit);
        if (!matches()) return;
        set({
          memoryTurns: result.turns,
          feedback: msg("已加载；请勾选需要的轮次。"),
          error: null,
        });
      } catch (error) {
        if (!matches()) return;
        set({
          memoryTurns: [],
          feedback: msg("记忆设置未能加载：{0}", errorText(error)),
        });
      }
    },
    loadMemoryPage: async (page, filters) => {
      await loadManagement(page, filters, { metadata: false });
    },
    loadMemoryEntryDetail: async (memoryId) => {
      if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return;
      get().discardMemoryCorrection();
      const request = selectionRequest;
      const matches = currentContext();
      const id = get().editorAgentId;
      if (id === "__new__") return;
      try {
        const memoryEntryDetail = await get().apiClient.getMemoryEntry(id, memoryId);
        if (
          matches() &&
          request === selectionRequest &&
          get().editorAgentId === id &&
          !get().memoryCorrectionDirty &&
          !get().memoryCorrectionSaving
        )
          set({ memoryEntryDetail, error: null });
      } catch (error) {
        if (!matches() || request !== selectionRequest) return;
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
      }
    },
    manualConsolidate: async (sessionId, turnIds) => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      const matches = currentContext();
      try {
        let job = await get().apiClient.consolidate(id, {
          session_id: sessionId,
          turn_ids: turnIds,
          request_key: get().effects.requestId().replaceAll("-", ""),
        });
        if (!matches()) return;
        if (!["succeeded", "failed"].includes(job.status)) {
          set({
            feedback: msg("已提交整理任务，正在后台生成长期记忆…"),
            error: null,
          });
        }
        for (
          let attempt = 0;
          attempt < 30 && !["succeeded", "failed"].includes(job.status);
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!matches()) return;
          try {
            job = await get().apiClient.getMemoryJob(id, job.id);
            if (!matches()) return;
          } catch (error) {
            if (!matches()) return;
            set({
              feedback: msg("整理任务已提交，但状态查询失败：{0}", errorText(error)),
            });
            return;
          }
        }
        if (job.status === "succeeded") {
          set({
            feedback: job.result_id
              ? msg("整理完成，已写入长期记忆。可在“记忆列表与治理”中查看。")
              : msg("整理完成：模型判断这些轮次没有需要长期保留的新信息。"),
          });
        } else if (job.status === "failed") {
          const reason = job.error_code ?? msg("未知原因");
          set({
            feedback: msg("整理失败（{0}）。请重新勾选相同轮次再次整理。", reason),
          });
        } else {
          set({
            feedback: msg("整理仍在后台进行。稍后重新打开本分区，或再次加载轮次查看结果。"),
          });
        }
      } catch (error) {
        if (!matches()) return;
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
      }
    },
    updatePolicy: async (patch) => {
      const id = get().editorAgentId;
      const current = get().policy;
      if (id === "__new__" || !current) return;
      const matches = currentContext();
      try {
        const policy = await get().apiClient.updatePolicy(id, {
          ...patch,
          expected_version: current.version,
        });
        if (!matches()) return;
        set({
          policy,
          pageEditor: null,
          feedback: msg("整理策略已保存。"),
          error: null,
        });
      } catch {
        if (!matches()) return;
        try {
          const policy = await get().apiClient.getPolicy(id);
          if (!matches()) return;
          set({
            policy,
            feedback: msg("保存未成功，已恢复服务器值，请重试。"),
          });
        } catch (error) {
          if (!matches()) return;
          set({ feedback: msg("记忆设置未能加载：{0}", errorText(error)) });
        }
      }
    },
    governMemories: async (agentId, ids, action, confirmed) => {
      if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return false;
      if (agentId === "__new__" || ids.length === 0) {
        set({ feedback: msg("请选择记忆") });
        return false;
      }
      if (action === "purge" && !confirmed) {
        set({ feedback: msg("永久删除需要明确确认") });
        return false;
      }
      const contextMatches = currentContext();
      const request = selectionRequest;
      const matches = () =>
        contextMatches() &&
        request === selectionRequest &&
        get().editorAgentId === agentId &&
        !get().memoryCorrectionDirty &&
        !get().memoryCorrectionSaving;
      if (!matches()) return false;
      try {
        await get().apiClient.govern(agentId, {
          memory_ids: ids,
          action,
          confirm_permanent: action === "purge",
        });
        if (!matches()) return false;
        set({
          memoryEntryDetail: null,
          feedback: msg("操作完成，请重新加载记忆列表。"),
          error: null,
        });
        return true;
      } catch (error) {
        if (!matches()) return false;
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
        return false;
      }
    },
    mergeMemories: async (agentId, ids) => {
      if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return false;
      if (agentId === "__new__" || ids.length === 0) {
        set({ feedback: msg("请选择记忆") });
        return false;
      }
      const contextMatches = currentContext();
      const request = selectionRequest;
      const matches = () =>
        contextMatches() &&
        request === selectionRequest &&
        get().editorAgentId === agentId &&
        !get().memoryCorrectionDirty &&
        !get().memoryCorrectionSaving;
      if (!matches()) return false;
      try {
        await get().apiClient.merge(agentId, {
          request_key: get().effects.requestId().replaceAll("-", ""),
          memory_ids: ids,
        });
        if (!matches()) return false;
        set({
          memoryEntryDetail: null,
          feedback: msg("整合任务已排队；成功后原条目被替代，新条目生效。"),
          error: null,
        });
        return true;
      } catch (error) {
        if (!matches()) return false;
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
        return false;
      }
    },
    clearMemoryMetadata: () => {
      if (activeMetadataResolve) {
        activeMetadataResolve(false);
        activeMetadataResolve = null;
      }
      metadataReadTask?.cancel();
      metadataReadTask = null;
      set({
        memoryMetadata: null,
        memoryMetadataBaseline: null,
        memoryVisibilityDraft: null,
        memoryVisibilityDirty: false,
        memoryMetadataLoading: false,
        memoryVisibilitySaving: false,
        memoryVisibilityError: null,
      });
    },
    loadMemoryAccessMetadata: async (memoryId, options?: { advanceRevisionIfDirty?: boolean }) => {
      const agentId = get().editorAgentId;
      const id = memoryId ?? get().memoryEntryDetail?.id;
      if (!id || !agentId || agentId === "__new__") return false;

      if (activeMetadataResolve) {
        activeMetadataResolve(false);
        activeMetadataResolve = null;
      }
      metadataReadTask?.cancel();
      metadataReadTask = null;

      const request = ++metadataReadRequest;
      const matches = currentContext();
      const capturedApi = get().apiClient;
      set({ memoryMetadataLoading: true, memoryVisibilityError: null });

      return new Promise<boolean>((resolve) => {
        activeMetadataResolve = resolve;
        const task = startRead(
          (signal) => capturedApi.getMemoryAccessMetadata(agentId, id, signal),
          {
            success: (metadata) => {
              if (metadataReadTask === task) {
                metadataReadTask = null;
              }
              if (activeMetadataResolve === resolve) {
                activeMetadataResolve = null;
              }
              if (
                !matches() ||
                request !== metadataReadRequest ||
                get().editorAgentId !== agentId ||
                get().memoryEntryDetail?.id !== id ||
                get().apiClient !== capturedApi
              ) {
                resolve(false);
                return;
              }
              set((state) => {
                const prevBase = state.memoryMetadataBaseline;
                const isSame =
                  prevBase !== null &&
                  prevBase.agentId === agentId &&
                  prevBase.memoryId === id &&
                  prevBase.api === capturedApi;
                const isDirty =
                  isSame && state.memoryVisibilityDirty && state.memoryVisibilityDraft !== null;

                const advanceRevision = options?.advanceRevisionIfDirty === true;
                const revisionConflict =
                  isDirty &&
                  prevBase !== null &&
                  metadata.visibility_revision !== prevBase.revision;

                const baseline =
                  isDirty && !advanceRevision
                    ? prevBase
                    : {
                        agentId,
                        memoryId: id,
                        visibility: metadata.visibility,
                        revision: metadata.visibility_revision,
                        recipient_agent_ids: [...metadata.recipient_agent_ids],
                        api: capturedApi,
                      };

                return {
                  memoryMetadata: metadata,
                  memoryMetadataBaseline: baseline,
                  memoryVisibilityDraft: isDirty
                    ? state.memoryVisibilityDraft
                    : {
                        visibility: metadata.visibility,
                        recipient_agent_ids: [...metadata.recipient_agent_ids],
                      },
                  memoryVisibilityDirty: isDirty,
                  memoryMetadataLoading: false,
                  memoryVisibilityError:
                    revisionConflict && !advanceRevision
                      ? msg(
                          "远端记忆版本已更新为 rev {0}，请核对最新状态或刷新重试。",
                          metadata.visibility_revision,
                        )
                      : null,
                };
              });
              resolve(true);
            },
            failure: (reason) => {
              if (metadataReadTask === task) {
                metadataReadTask = null;
              }
              if (activeMetadataResolve === resolve) {
                activeMetadataResolve = null;
              }
              if (
                matches() &&
                request === metadataReadRequest &&
                get().editorAgentId === agentId &&
                get().memoryEntryDetail?.id === id &&
                get().apiClient === capturedApi
              ) {
                set({
                  memoryMetadataLoading: false,
                  memoryVisibilityError: errorText(reason),
                });
              }
              resolve(false);
            },
          },
        );
        metadataReadTask = task;
      });
    },
    patchMemoryVisibilityDraft: (patch) => {
      const baseline = get().memoryMetadataBaseline;
      const current = get().memoryVisibilityDraft;
      if (!baseline || get().memoryVisibilitySaving) return;
      const next = {
        visibility:
          patch.visibility !== undefined
            ? patch.visibility
            : (current?.visibility ?? baseline.visibility),
        recipient_agent_ids:
          patch.recipient_agent_ids !== undefined
            ? patch.recipient_agent_ids
            : (current?.recipient_agent_ids ?? baseline.recipient_agent_ids),
      };
      const equalRecipients = (a: string[], b: string[]) =>
        a.length === b.length &&
        a
          .slice()
          .sort()
          .every((v, i) => v === b.slice().sort()[i]);
      const isDirty =
        next.visibility !== baseline.visibility ||
        !equalRecipients(next.recipient_agent_ids, baseline.recipient_agent_ids);
      set({
        memoryVisibilityDraft: next,
        memoryVisibilityDirty: isDirty,
      });
    },
    discardMemoryVisibilityDraft: () => {
      if (get().memoryVisibilitySaving) return;
      const baseline = get().memoryMetadataBaseline;
      set({
        memoryVisibilityDraft: baseline
          ? {
              visibility: baseline.visibility,
              recipient_agent_ids: [...baseline.recipient_agent_ids],
            }
          : null,
        memoryVisibilityDirty: false,
        memoryVisibilityError: null,
      });
    },
    saveMemoryVisibility: async () => {
      const baseline = get().memoryMetadataBaseline;
      const draft = get().memoryVisibilityDraft;
      const agentId = get().editorAgentId;
      const entryId = get().memoryEntryDetail?.id;
      const capturedApi = get().apiClient;

      if (!baseline || !draft || !agentId || !entryId) return false;
      if (
        baseline.agentId !== agentId ||
        baseline.memoryId !== entryId ||
        baseline.api !== capturedApi
      ) {
        return false;
      }
      if (!get().memoryVisibilityDirty) return true;
      if (draft.visibility === null) return true;
      if (get().memoryVisibilitySaving) return false;

      let recipientsToSend: string[] = [];
      if (draft.visibility === "session_private") {
        recipientsToSend = [];
      } else if (draft.visibility === "agent_shared") {
        recipientsToSend = [agentId];
      } else if (draft.visibility === "public") {
        recipientsToSend = Array.from(new Set(draft.recipient_agent_ids));
        if (recipientsToSend.length === 0) {
          set({ memoryVisibilityError: msg("公共记忆必须指定至少一个接收助手") });
          return false;
        }
      }

      const matches = currentContext();
      const thisSaveToken = ++metadataSaveRequest;
      set({ memoryVisibilitySaving: true, memoryVisibilityError: null });

      try {
        const res = await capturedApi.saveMemoryVisibility(agentId, entryId, {
          expected_revision: baseline.revision,
          visibility: draft.visibility,
          recipient_agent_ids: recipientsToSend,
        });

        if (
          !matches() ||
          thisSaveToken !== metadataSaveRequest ||
          get().editorAgentId !== agentId ||
          get().memoryEntryDetail?.id !== entryId ||
          get().apiClient !== capturedApi
        ) {
          return false;
        }

        const newBaseline = {
          agentId,
          memoryId: entryId,
          visibility: res.visibility,
          revision: res.visibility_revision,
          recipient_agent_ids: [...res.recipient_agent_ids],
          api: capturedApi,
        };

        set((state) => ({
          memoryMetadata: state.memoryMetadata
            ? {
                ...state.memoryMetadata,
                visibility: res.visibility,
                visibility_revision: res.visibility_revision,
                recipient_agent_ids: [...res.recipient_agent_ids],
              }
            : null,
          memoryMetadataBaseline: newBaseline,
          memoryVisibilityDraft: {
            visibility: res.visibility,
            recipient_agent_ids: [...res.recipient_agent_ids],
          },
          memoryVisibilityDirty: false,
          memoryVisibilitySaving: false,
          memoryVisibilityError: null,
          memoryEntries: state.memoryEntries.map((item) =>
            item.id === entryId ? { ...item } : item,
          ),
          feedback: msg("记忆可见性已更新。"),
        }));
        return true;
      } catch (reason: unknown) {
        if (
          matches() &&
          thisSaveToken === metadataSaveRequest &&
          get().editorAgentId === agentId &&
          get().memoryEntryDetail?.id === entryId &&
          get().apiClient === capturedApi
        ) {
          set({
            memoryVisibilitySaving: false,
            memoryVisibilityError: errorText(reason),
          });
        }
        return false;
      } finally {
        if (thisSaveToken === metadataSaveRequest) {
          set({ memoryVisibilitySaving: false });
        }
      }
    },
  };
}
