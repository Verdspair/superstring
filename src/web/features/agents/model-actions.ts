import type { SuperstringApi } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";

type Capacity = Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>;
type CapacityLabel = "聊天" | "记忆读取" | "摘要";
export function createModelActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  "refreshModels" | "refreshCapacityPreview" | "recalculateCapacityPreview"
> {
  let capacityRequest = 0;
  let cached: {
    matches: () => boolean;
    results: Array<readonly [CapacityLabel, Capacity]>;
  } | null = null;
  const recalculateCapacityPreview = () => {
    if (!cached?.matches()) return;
    const state = get();
    const p5 =
      state.settingsView === "workspace" && state.pageEditor
        ? state.pageEditor.draft.p5_config
        : state.editorDraft?.p5_config;
    if (!p5) return;
    const lines: string[] = [];
    let chatContextCapacity: number | null = null;
    for (const [label, result] of cached.results) {
      if (label === "聊天") chatContextCapacity = result.context_length;
      if (result.status === "unavailable") {
        lines.push(msg("{0}：未加载／容量未知（{1}）", msg(label), result.error_code));
        continue;
      }
      if (result.context_length === null) {
        lines.push(msg("{0}：未加载／容量未知（{1}）", msg(label), result.status));
        continue;
      }
      const budget =
        label === "聊天" && p5.context_window !== null ? p5.context_window : result.context_length;
      if (budget > result.context_length) {
        lines.push(
          msg("{0}：实际 {1}，自定义 {2} 超限，请调整", msg(label), result.context_length, budget),
        );
        continue;
      }
      const available = budget - p5.max_output_tokens - Math.ceil(budget * p5.safety_margin_ratio);
      lines.push(
        msg(
          "{0}：实际 {1}，预算 {2}，输入可用约 {3}；回复预留 {4}{5}",
          msg(label),
          result.context_length,
          budget,
          Math.max(0, available),
          p5.max_output_tokens,
          available <= 0 ? msg("（预算不足，生成将拒绝）") : "",
        ),
      );
    }
    set({ capacityPreview: lines.join("\n"), chatContextCapacity });
  };
  return {
    recalculateCapacityPreview,
    refreshModels: async () => {
      try {
        // 外部模型 API（0032）：登记过的外部模型名与本地模型并列出现在每个选择器里。取不到外部
        // 清单不是错误——本地列表照旧可用，只是少了几项可选项。
        const [catalog, providers] = await Promise.all([
          get().apiClient.listModels(),
          get()
            .apiClient.listModelProviders()
            .catch(() => []),
        ]);
        const local = [...new Set(catalog.models)];
        const external = providers.flatMap((provider) =>
          provider.models.map((model) => model.name),
        );
        const modelNames = [...new Set([...local, ...external])];
        const parts = [
          local.length
            ? msg("LM Studio 当前报告 {0} 个已加载模型。", local.length)
            : msg("LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。"),
        ];
        if (external.length) parts.push(msg("另有 {0} 个来自外部模型 API。", external.length));
        set({
          modelNames,
          loadedModelNames: local,
          externalModelNames: [...new Set(external)],
          modelStatus: parts.join(" "),
          error: null,
        });
      } catch (error) {
        set({
          modelStatus: msg("模型列表加载失败：{0}；仍可保留或手动输入模型 ID。", errorText(error)),
        });
      }
    },
    refreshCapacityPreview: async (probeModels) => {
      const draft = get().editorDraft;
      if (!draft) return;
      const request = ++capacityRequest;
      const { editorAgentId, pageEditor, apiClient, settingsView, settingsRoute, page } = get();
      const matches = () =>
        request === capacityRequest &&
        get().editorAgentId === editorAgentId &&
        get().pageEditor?.token === pageEditor?.token &&
        get().apiClient === apiClient &&
        get().settingsView === settingsView &&
        get().settingsRoute === settingsRoute &&
        get().page === page;
      cached = null;
      set({
        chatContextCapacity: null,
        capacityPreview: msg("正在刷新容量预览…"),
      });
      const [chatModel, retrievalModel, compressionModel] = probeModels ?? [
        draft.model_name,
        draft.memory_retrieval_model_name,
        draft.context_compression_model_name,
      ];
      const models = [
        ["聊天", chatModel],
        ["记忆读取", retrievalModel ?? chatModel],
        ["摘要", compressionModel ?? chatModel],
      ] as const;
      const cache = new Map<string, Capacity>();
      const results: Array<readonly [CapacityLabel, Capacity]> = [];
      try {
        for (const [label, name] of models) {
          let result = cache.get(name);
          if (!result) {
            result = await apiClient.getModelCapacity(name);
            if (!matches()) return;
            cache.set(name, result);
          }
          results.push([label, result]);
        }
        if (!matches()) return;
        cached = { matches, results };
        // Budget edits during a probe are applied to the result, never captured stale values.
        recalculateCapacityPreview();
      } catch (error) {
        if (!matches()) return;
        set({
          capacityPreview: msg("容量预览不可用：{0}；未修改配置或加载模型。", errorText(error)),
        });
      }
    },
  };
}
