import type { SuperstringApi } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import {
  isCurrentModelDiscovery,
  modelStatusText,
  startModelDiscovery,
} from "../models/model-discovery";

type Capacity = Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>;
type CapacityLabel = "聊天" | "上下文压缩";
type CapacityKey = {
  apiClient: SuperstringApi;
  agentId: string | "__new__";
  token: object | undefined;
  models: readonly [string, string | null];
};
const sameCapacityKey = (a: CapacityKey, b: CapacityKey) =>
  a.apiClient === b.apiClient &&
  a.agentId === b.agentId &&
  a.token === b.token &&
  a.models[0] === b.models[0] &&
  a.models[1] === b.models[1];
export function createModelActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  "refreshModels" | "refreshCapacityPreview" | "recalculateCapacityPreview"
> {
  let capacityRequest = 0;
  let cached: {
    key: CapacityKey;
    results: Array<readonly [CapacityLabel, Capacity]>;
  } | null = null;
  let inFlight: { key: CapacityKey; promise: Promise<void> } | null = null;
  const applyCapacityResults = (results: Array<readonly [CapacityLabel, Capacity]>) => {
    const state = get();
    const p5 =
      state.settingsView === "workspace" && state.pageEditor
        ? state.pageEditor.draft.p5_config
        : state.editorDraft?.p5_config;
    if (!p5) return;
    const lines: string[] = [];
    let chatContextCapacity: number | null = null;
    for (const [label, result] of results) {
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
  const recalculateCapacityPreview = () => {
    if (!cached) return;
    const state = get();
    if (
      state.apiClient !== cached.key.apiClient ||
      state.editorAgentId !== cached.key.agentId ||
      state.pageEditor?.token !== cached.key.token
    )
      return;
    applyCapacityResults(cached.results);
  };
  return {
    recalculateCapacityPreview,
    refreshModels: async (prefetchedProviders) => {
      const api = get().apiClient;
      // 外部模型 API（0032）：登记过的外部模型名与本地模型并列出现在每个选择器里。
      // 两个来源独立结算：任一来源失败不能丢掉另一来源已拿到的可用模型。调用方已预取
      // provider 清单或读取（如 ModelServices 初始读取/主动刷新）时直接复用，避免重复 GET。
      const discovery = startModelDiscovery(
        api,
        api.listModels(),
        prefetchedProviders === undefined
          ? api.listModelProviders()
          : Promise.resolve(prefetchedProviders),
      );
      const result = await discovery.result;
      if (!isCurrentModelDiscovery(api, discovery.revision) || get().apiClient !== api) return;
      set({
        modelNames: result.modelNames,
        loadedModelNames: result.local,
        externalModelNames: result.external,
        modelStatus: modelStatusText(result, { includeExternalCount: true }),
      });
    },
    refreshCapacityPreview: async (probeModels) => {
      const state = get();
      const draft = state.editorDraft;
      if (!draft) return;
      // Keep the public tuple shape; the retired retrieval slot is never probed.
      const chatModel = probeModels?.[0] ?? draft.model_name;
      const compressionModel = probeModels ? probeModels[2] : draft.context_compression_model_name;
      const key: CapacityKey = {
        apiClient: state.apiClient,
        agentId: state.editorAgentId,
        token: state.pageEditor?.token,
        models: [chatModel, compressionModel ?? null],
      };
      // Same editor identity: reuse the successful read. Parking the tab or changing route is not
      // a freshness boundary; agent/API/model identity changes are.
      if (cached && sameCapacityKey(cached.key, key)) {
        applyCapacityResults(cached.results);
        return;
      }
      if (inFlight && sameCapacityKey(inFlight.key, key)) return inFlight.promise;
      const request = ++capacityRequest;
      const matches = () =>
        request === capacityRequest &&
        get().apiClient === key.apiClient &&
        get().editorAgentId === key.agentId &&
        get().pageEditor?.token === key.token;
      set({
        chatContextCapacity: null,
        capacityPreview: msg("正在刷新容量预览…"),
      });
      const models = [
        ["聊天", chatModel],
        ["上下文压缩", compressionModel ?? chatModel],
      ] as const;
      const probe = (async () => {
        const cache = new Map<string, Capacity>();
        const results: Array<readonly [CapacityLabel, Capacity]> = [];
        try {
          for (const [label, name] of models) {
            let result = cache.get(name);
            if (!result) {
              result = await key.apiClient.getModelCapacity(name);
              if (!matches()) return;
              cache.set(name, result);
            }
            results.push([label, result]);
          }
          if (!matches()) return;
          cached = { key, results };
          // Budget edits during a probe are applied to the result, never captured stale values.
          applyCapacityResults(results);
        } catch (error) {
          if (!matches()) return;
          set({
            capacityPreview: msg("容量预览不可用：{0}；未修改配置或加载模型。", errorText(error)),
          });
        }
      })();
      inFlight = { key, promise: probe };
      try {
        await probe;
      } finally {
        if (inFlight?.promise === probe) inFlight = null;
      }
    },
  };
}
