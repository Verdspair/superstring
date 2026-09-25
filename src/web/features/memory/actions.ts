import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";

export function createMemoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "resetMemoryManagement"
  | "loadMemoryPolicy"
  | "clearMemoryTurns"
  | "reloadMemory"
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
> {
  let selectionRequest = 0;
  let managementEpoch = 0;
  let turnsRequest = 0;
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
  return {
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
      managementEpoch += 1;
      selectionRequest += 1;
      turnsRequest += 1;
      if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return;
      set({
        memoryTurns: [],
        memoryEntries: [],
        memoryEntryTotal: 0,
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
      const agentId = get().editorAgentId;
      const detail = get().memoryContent;
      const draft = get().memoryCorrectionDraft;
      if (!get().memoryCorrectionDirty) return true;
      if (!detail || !draft || get().memoryCorrectionSaving) return false;
      set({ memoryCorrectionSaving: true });
      try {
        const saved = await get().apiClient.correctMemory(agentId, detail.content.id, {
          ...draft,
          tags: draft.tags.filter((tag) => tag.trim().length > 0),
        });
        if (get().editorAgentId !== agentId) return true;
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
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      } finally {
        set({ memoryCorrectionSaving: false });
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
          ...(editor && editor.agent.id === id && !editor.policy
            ? { pageEditor: { ...editor, policy, policyDraft: { ...policy } } }
            : {}),
        });
      } catch {
        // 读不到就保持"未加载"，面板据此显示重试而不是假装已关闭。
      }
    },
    reloadMemory: async () => {
      if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return;
      get().discardMemoryCorrection();
      const request = selectionRequest;
      const matches = currentContext();
      const id = get().editorAgentId;
      if (id === "__new__") {
        set({
          policy: null,
          memorySessions: [],
          memoryTurns: [],
          memoryEntries: [],
          memoryEntryTotal: 0,
          memoryEntryDetail: null,
          memoryJobs: [],
          feedback: msg("请先创建或选择一个 Agent，这里会显示它的记忆设置。"),
        });
        return;
      }
      try {
        const [policy, memorySessions, memoryJobs] = await Promise.all([
          get().apiClient.getPolicy(id),
          get().apiClient.listMemorySessions(id),
          get().apiClient.listMemoryJobs(id),
        ]);
        if (!matches() || request !== selectionRequest || get().editorAgentId !== id) return;
        let feedback = msg("已加载。整理完成后可在“记忆列表与治理”中查看结果。");
        const latest = memoryJobs[0];
        if (latest?.status === "failed") {
          feedback += msg(
            " 上次整理未成功（{0}）。请重新勾选相同轮次，再次点击“第 5 步：开始整理所选轮次”。",
            latest.error_code ?? msg("未知原因"),
          );
        } else if (latest && ["queued", "running"].includes(latest.status)) {
          feedback += msg("上次提交的整理任务仍在后台处理，稍后可重新打开本分区查看结果。");
        }
        const editor = get().pageEditor;
        set({
          ...(editor && editor.agent.id === id && !editor.policy
            ? { pageEditor: { ...editor, policy, policyDraft: { ...policy } } }
            : {}),
          policy,
          memorySessions,
          memoryTurns: [],
          memoryEntries: [],
          memoryEntryTotal: 0,
          memoryEntryDetail: null,
          memoryJobs,
          feedback: get().settingsView === "workspace" ? "" : feedback,
          error: null,
        });
      } catch (error) {
        if (!matches() || request !== selectionRequest || get().editorAgentId !== id) return;
        set({
          policy: null,
          memorySessions: [],
          memoryTurns: [],
          memoryEntries: [],
          memoryEntryTotal: 0,
          memoryEntryDetail: null,
          memoryJobs: [],
          feedback: msg("记忆设置未能加载：{0}", errorText(error)),
        });
      }
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
      if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return;
      get().discardMemoryCorrection();
      const request = selectionRequest;
      const matches = currentContext();
      const id = get().editorAgentId;
      if (id === "__new__") return;
      if (!Number.isInteger(page) || page < 1) {
        set({ feedback: msg("页码必须为正整数") });
        return;
      }
      try {
        const result = await get().apiClient.listMemoryEntries(id, (page - 1) * 100, 100, filters);
        if (
          !matches() ||
          request !== selectionRequest ||
          get().editorAgentId !== id ||
          get().memoryCorrectionDirty ||
          get().memoryCorrectionSaving
        )
          return;
        set({
          memoryEntries: result.items,
          memoryEntryTotal: result.total,
          memoryEntryDetail: null,
          feedback: msg("共 {0} 条记忆，当前第 {1} 页。", result.total, page),
          error: null,
        });
      } catch (error) {
        if (!matches() || request !== selectionRequest) return;
        set({ feedback: msg("记忆设置未能加载：{0}", errorText(error)) });
      }
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
  };
}
