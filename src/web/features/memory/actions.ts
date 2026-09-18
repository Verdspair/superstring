import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";

export function createMemoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "reloadMemory"
  | "loadMemoryTurns"
  | "loadMemoryPage"
  | "loadMemoryEntryDetail"
  | "manualConsolidate"
  | "updatePolicy"
  | "governMemories"
  | "mergeMemories"
> {
  return {
    reloadMemory: async () => {
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
        let feedback = msg(
          "已加载。策略字段改动即保存；整理完成后可在“记忆列表与治理”中查看结果。",
        );
        const latest = memoryJobs[0];
        if (latest?.status === "failed") {
          feedback += msg(
            " 上次整理未成功（{0}）。请重新勾选相同轮次，再次点击“第 5 步：开始整理所选轮次”。",
            latest.error_code ?? msg("未知原因"),
          );
        } else if (latest && ["queued", "running"].includes(latest.status)) {
          feedback += msg("上次提交的整理任务仍在后台处理，稍后可重新打开本分区查看结果。");
        }
        set({
          policy,
          memorySessions,
          memoryTurns: [],
          memoryEntries: [],
          memoryEntryTotal: 0,
          memoryEntryDetail: null,
          memoryJobs,
          feedback,
          error: null,
        });
      } catch (error) {
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
      try {
        const result = await get().apiClient.listMemoryTurns(id, sessionId, limit);
        set({
          memoryTurns: result.turns,
          feedback: msg("已加载；请勾选需要的轮次。"),
          error: null,
        });
      } catch (error) {
        set({
          memoryTurns: [],
          feedback: msg("记忆设置未能加载：{0}", errorText(error)),
        });
      }
    },
    loadMemoryPage: async (page) => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      if (!Number.isInteger(page) || page < 1) {
        set({ feedback: msg("页码必须为正整数") });
        return;
      }
      try {
        const result = await get().apiClient.listMemoryEntries(id, (page - 1) * 100, 100);
        set({
          memoryEntries: result.items,
          memoryEntryTotal: result.total,
          memoryEntryDetail: null,
          feedback: msg("共 {0} 条记忆，当前第 {1} 页。", result.total, page),
          error: null,
        });
      } catch (error) {
        set({ feedback: msg("记忆设置未能加载：{0}", errorText(error)) });
      }
    },
    loadMemoryEntryDetail: async (memoryId) => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      try {
        const memoryEntryDetail = await get().apiClient.getMemoryEntry(id, memoryId);
        set({ memoryEntryDetail, error: null });
      } catch (error) {
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
      }
    },
    manualConsolidate: async (sessionId, turnIds) => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      try {
        let job = await get().apiClient.consolidate(id, {
          session_id: sessionId,
          turn_ids: turnIds,
          request_key: get().effects.requestId().replaceAll("-", ""),
        });
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
          try {
            job = await get().apiClient.getMemoryJob(id, job.id);
          } catch (error) {
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
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
      }
    },
    updatePolicy: async (patch) => {
      const id = get().editorAgentId;
      const current = get().policy;
      if (id === "__new__" || !current) return;
      try {
        const policy = await get().apiClient.updatePolicy(id, {
          ...patch,
          expected_version: current.version,
        });
        set({ policy, feedback: msg("整理策略已保存。"), error: null });
      } catch {
        try {
          const policy = await get().apiClient.getPolicy(id);
          set({
            policy,
            feedback: msg("保存未成功，已恢复服务器值，请重试。"),
          });
        } catch (error) {
          set({ feedback: msg("记忆设置未能加载：{0}", errorText(error)) });
        }
      }
    },
    governMemories: async (agentId, ids, action, confirmed) => {
      if (agentId === "__new__" || ids.length === 0) {
        set({ feedback: msg("请选择记忆") });
        return false;
      }
      if (action === "purge" && !confirmed) {
        set({ feedback: msg("永久删除需要明确确认") });
        return false;
      }
      try {
        await get().apiClient.govern(agentId, {
          memory_ids: ids,
          action,
          confirm_permanent: action === "purge",
        });
        set({
          memoryEntryDetail: null,
          feedback: msg("操作完成，请重新加载记忆列表。"),
          error: null,
        });
        return true;
      } catch (error) {
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
        return false;
      }
    },
    mergeMemories: async (agentId, ids) => {
      if (agentId === "__new__" || ids.length === 0) {
        set({ feedback: msg("请选择记忆") });
        return false;
      }
      try {
        await get().apiClient.merge(agentId, {
          request_key: get().effects.requestId().replaceAll("-", ""),
          memory_ids: ids,
        });
        set({
          memoryEntryDetail: null,
          feedback: msg("整合任务已排队；成功后原条目被替代，新条目生效。"),
          error: null,
        });
        return true;
      } catch (error) {
        set({ feedback: msg("操作未完成：{0}", errorText(error)) });
        return false;
      }
    },
  };
}
