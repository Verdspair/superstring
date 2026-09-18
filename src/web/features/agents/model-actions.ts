import type { SuperstringApi } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";

export function createModelActions(
  set: StoreSet,
  get: StoreGet,
): Pick<SuperstringState, "refreshModels" | "refreshCapacityPreview"> {
  return {
    refreshModels: async () => {
      try {
        const catalog = await get().apiClient.listModels();
        const modelNames = [...new Set(catalog.models)];
        set({
          modelNames,
          modelStatus: modelNames.length
            ? msg("LM Studio 当前报告 {0} 个已加载模型。", modelNames.length)
            : msg("LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。"),
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
      set({ chatContextCapacity: null });
      const p5 = draft.p5_config;
      // The three models to probe come from the caller so that the effect which
      // re-probes on model change actually depends on them, but they must describe
      // the draft the store holds — a stale caller must not probe a different
      // model set than the one the panel is editing.
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
      const cache = new Map<string, Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>>();
      const lines: string[] = [];
      let chatContextCapacity: number | null = null;
      try {
        for (const [label, name] of models) {
          let result = cache.get(name);
          if (!result) {
            result = await get().apiClient.getModelCapacity(name);
            cache.set(name, result);
          }
          if (label === "聊天") chatContextCapacity = result.context_length;
          if (result.status === "unavailable") {
            // Unavailable always carries the AppError code that caused it
            // (api/models.py:18-20); "unknown" and "loaded" never carry one.
            lines.push(msg("{0}：未加载／容量未知（{1}）", msg(label), result.error_code));
            continue;
          }
          if (result.context_length === null) {
            lines.push(msg("{0}：未加载／容量未知（{1}）", msg(label), result.status));
            continue;
          }
          const budget =
            label === "聊天" && p5.context_window !== null
              ? p5.context_window
              : result.context_length;
          if (budget > result.context_length) {
            lines.push(
              msg(
                "{0}：实际 {1}，自定义 {2} 超限，请调整",
                msg(label),
                result.context_length,
                budget,
              ),
            );
            continue;
          }
          const available =
            budget - p5.max_output_tokens - Math.ceil(budget * p5.safety_margin_ratio);
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
        set({
          capacityPreview: lines.join("\n"),
          chatContextCapacity,
          error: null,
        });
      } catch (error) {
        set({
          capacityPreview: msg("容量预览不可用：{0}；未修改配置或加载模型。", errorText(error)),
        });
      }
    },
  };
}
