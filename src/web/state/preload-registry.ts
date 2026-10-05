import { isDesktopMode } from "../desktop-lifecycle";
import {
  getPreloadTargetAgentId,
  isAgentPreloadEligible,
  warmAgentResources,
} from "../services/agent-preload";
import { warmConnectionResources } from "../services/connection-resources";
import { useSuperstringStore } from "../store";
import type { SpaceId } from "../workspace/navigation";

/**
 * 具有失败自愈特性的在途 Promise 缓存装配器。
 * - 多次并发调用返回同一个在途 Promise；
 * - 若加载失败，自动清除在途缓存，后续调用可重新发起底层加载；
 * - 注意：已挂载的 React.lazy 节点具有自身的内部状态生命周期，外部重置供重试请求使用。
 */
export function createCachedLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = load().catch((error) => {
      inFlight = null;
      throw error;
    });
    return inFlight;
  };
}

/**
 * 8 大工作区 Chunk 动态导入单源定义 (同时供 React.lazy 与代码预载使用)。
 * 保留各个工作区组件的原生 Props 类型 (如 active?: boolean)，避免 ComponentType<any>。
 */
export const WORKSPACE_LOADERS = {
  conversations: createCachedLoader(() =>
    import("../screens/conversations/ConversationWorkspace").then((m) => ({
      default: m.ConversationWorkspace,
    })),
  ),
  assistants: createCachedLoader(() =>
    import("../screens/assistants/AssistantWorkspace").then((m) => ({
      default: m.AssistantWorkspace,
    })),
  ),
  capabilities: createCachedLoader(() =>
    import("../screens/connections/CapabilitiesWorkspace").then((m) => ({
      default: m.CapabilitiesWorkspace,
    })),
  ),
  schemes: createCachedLoader(() =>
    import("../screens/connections/SchemesWorkspace").then((m) => ({
      default: m.SchemesWorkspace,
    })),
  ),
  library: createCachedLoader(() =>
    import("../screens/library/LibraryWorkspace").then((m) => ({
      default: m.LibraryWorkspace,
    })),
  ),
  connections: createCachedLoader(() =>
    import("../screens/connections/ConnectionWorkspace").then((m) => ({
      default: m.ConnectionWorkspace,
    })),
  ),
  models: createCachedLoader(() =>
    import("../screens/environment/ModelServices").then((m) => ({
      default: m.ModelServices,
    })),
  ),
  preferences: createCachedLoader(() =>
    import("../screens/environment/Preferences").then((m) => ({
      default: m.Preferences,
    })),
  ),
} as const;

export interface PreloadRegistryItem {
  readonly id: string;
  readonly space: SpaceId;
  readonly loadChunk: () => Promise<unknown>;
  /** 数据预热状态：eligible 已在登记表接线，excluded 必须给出原因 */
  readonly dataStatus: "eligible" | "excluded";
  /** 排除原因说明：结构性不预热项据实说明 */
  readonly excludedReason?: string;
  /** 数据预热执行入口 (当 dataStatus === "eligible" 时提供) */
  readonly loadData?: () => Promise<unknown>;
}

/** 助手预热只在没有在途草稿时进行；草稿属主仍是用户编辑，不被后台读取顶掉。 */
const warmAssistantPersona = () => {
  const state = useSuperstringStore.getState();
  const agentId = getPreloadTargetAgentId(state);
  if (!agentId || !isAgentPreloadEligible(state)) return Promise.resolve();
  return warmAgentResources(state.apiClient, agentId);
};

/** 8 大工作区统一登记表 (覆盖 navigation.ts 中的 SPACES 与 ENVIRONMENT) */
export const PRELOAD_REGISTRY: readonly PreloadRegistryItem[] = [
  {
    id: "workspace:conversations",
    space: "conversations",
    loadChunk: WORKSPACE_LOADERS.conversations,
    dataStatus: "excluded",
    excludedReason:
      "Bootstrap already fetches directory & active conversation; excluded to protect the 512 KiB session cache from churn",
  },
  {
    id: "workspace:assistants",
    space: "assistants",
    loadChunk: WORKSPACE_LOADERS.assistants,
    dataStatus: "eligible",
    loadData: warmAssistantPersona,
  },
  {
    id: "workspace:capabilities",
    space: "capabilities",
    loadChunk: WORKSPACE_LOADERS.capabilities,
    dataStatus: "eligible",
    loadData: () => useSuperstringStore.getState().loadPermissionSettings({ background: true }),
  },
  {
    id: "workspace:schemes",
    space: "schemes",
    loadChunk: WORKSPACE_LOADERS.schemes,
    dataStatus: "eligible",
    loadData: () =>
      Promise.all([
        useSuperstringStore.getState().loadQqSchemes({ background: true, editor: false }),
        useSuperstringStore.getState().loadQqBindings({ background: true }),
      ]),
  },
  {
    id: "workspace:library",
    space: "library",
    loadChunk: WORKSPACE_LOADERS.library,
    dataStatus: "eligible",
    loadData: () => useSuperstringStore.getState().loadKnowledge(undefined, { background: true }),
  },
  {
    id: "workspace:connections",
    space: "connections",
    loadChunk: WORKSPACE_LOADERS.connections,
    dataStatus: "eligible",
    loadData: () => warmConnectionResources(useSuperstringStore.getState().apiClient),
  },
  {
    id: "workspace:models",
    space: "models",
    loadChunk: WORKSPACE_LOADERS.models,
    dataStatus: "excluded",
    excludedReason:
      "Bootstrap already resolves the local catalog and provider list into static model names, so a background prewarm would repeat the same reads; provider health probing is never started in the background",
  },
  {
    id: "workspace:preferences",
    space: "preferences",
    loadChunk: WORKSPACE_LOADERS.preferences,
    dataStatus: "eligible",
    loadData: () => {
      if (isDesktopMode()) {
        return useSuperstringStore.getState().loadDesktopSettings({ background: true });
      }
      return Promise.resolve();
    },
  },
] as const;
