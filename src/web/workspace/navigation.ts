import {
  BookOpen,
  Bot,
  Cpu,
  ListTree,
  MessageCircle,
  Puzzle,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import type { SuperstringState } from "../state/types";
import { useSuperstringStore } from "../store";

export const SPACES = [
  {
    id: "conversations",
    label: "workspace.conversations",
    icon: MessageCircle,
    description: "workspace.talk_with_an_assistant_or_follow_connected_conversations",
  },
  {
    id: "assistants",
    label: "workspace.assistant",
    icon: Bot,
    description: "workspace.shape_an_assistant_s_identity_capabilities_and_material_rules",
  },
  {
    id: "capabilities",
    label: "workspace.capabilities",
    icon: Wrench,
    description: "workspace.manage_built_in_capabilities_and_execution_limits_by_function",
  },
  // 方案（P9）：独立一级目录；按应用登记，QQ 是当前唯一实现，群与私聊共用同一批方案。
  {
    id: "schemes",
    label: "workspace.schemes",
    icon: ListTree,
    description: "workspace.shared_schemes_grouped_by_app",
  },
  {
    id: "library",
    label: "workspace.materials",
    icon: BookOpen,
    description: "workspace.manage_knowledge_memories_and_sticker_assets",
  },
  {
    id: "connections",
    label: "workspace.extensions",
    icon: Puzzle,
    description: "workspace.manage_external_extensions",
  },
] as const;
export const ENVIRONMENT = [
  {
    id: "models",
    label: "workspace.model_services",
    icon: Cpu,
    description: "workspace.manage_workspace_model_services_and_default_uses",
  },
  {
    id: "preferences",
    label: "workspace.preferences_dfdf11",
    icon: SlidersHorizontal,
    description: "workspace.language_appearance_and_desktop_behavior",
  },
] as const;
export type SpaceId = (typeof SPACES)[number]["id"] | (typeof ENVIRONMENT)[number]["id"];
export function activeSpace(
  state: Pick<SuperstringState, "page" | "settingsView" | "settingsRoute">,
): SpaceId {
  if (state.page === "chat") return "conversations";
  if (["general", "appearance", "hub"].includes(state.settingsView)) return "preferences";
  // 运行一级栏目已取消：执行台账/任务与审批归对话的消息/观测/任务，观测设置页也回对话。
  if (state.settingsView === "observability") return "conversations";
  // 旧 operating-mode 只是 QQ 连接的兼容别名：连接已随 QQ 应用归方案。
  if (state.settingsView === "operating-mode") return "schemes";
  if (state.settingsView === "knowledge") return "library";
  if (state.settingsView === "agents") return "assistants";
  // "models" is the canonical route every quick-management entry normalizes to; the legacy aliases
  // and the external API entry stay here so each destination keeps its own screen and tab.
  if (["models", "external-api", "management", "knowledge-model"].includes(state.settingsRoute))
    return "models";
  if (["long-memory", "profile", "knowledge-config", "qq-stickers"].includes(state.settingsRoute))
    return "library";
  if (
    [
      "system-capabilities",
      "memory-tools",
      "knowledge-tools",
      "media-tools",
      "web-access",
      "execution-settings",
      "session-history",
    ].includes(state.settingsRoute)
  )
    return "capabilities";
  // 原 qq-scheme-config 详情归方案一级；目录入口是 scheme-library，绑定首次发现入口是 scheme-bindings。
  // QQ 应用级管理（方案目录/连接/数据）也归方案，接入只留外置扩展。
  if (
    [
      "scheme-library",
      "qq-scheme-config",
      "scheme-bindings",
      "qq-app-schemes",
      "qq-connection",
      "qq-storage",
    ].includes(state.settingsRoute)
  )
    return "schemes";
  if (["mcp-servers", "skill-catalog", "tool-grants"].includes(state.settingsRoute))
    return "connections";
  if (["task-ledger", "execution-ledger"].includes(state.settingsRoute)) return "conversations";
  return "assistants";
}
/** Every global destination uses the existing draft-aware transition, never a direct state patch. */
export function openSpace(space: SpaceId) {
  const state = useSuperstringStore.getState();
  switch (space) {
    case "conversations":
      state.openChat();
      break;
    case "assistants":
      state.openAgentSettings();
      break;
    case "capabilities":
      state.openSettingsRoute("system-capabilities");
      break;
    case "schemes":
      // 默认落到方案目录；详情沿用既有 qq-scheme-config 路由。
      state.openSettingsRoute("scheme-library");
      break;
    case "library":
      state.requestPageNavigation("settings", "knowledge");
      break;
    case "connections":
      // 接入只保留外置扩展（MCP 服务/技能/工具授权）；QQ 连接随 QQ 应用归方案。
      state.openSettingsRoute("mcp-servers");
      break;
    case "models":
      state.openSettingsRoute("external-api");
      break;
    case "preferences":
      state.requestPageNavigation("settings", "general");
      break;
  }
}
