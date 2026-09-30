import {
  Activity,
  BookOpen,
  Bot,
  Cable,
  Cpu,
  MessageCircle,
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
  {
    id: "library",
    label: "workspace.materials",
    icon: BookOpen,
    description: "workspace.manage_knowledge_memories_and_sticker_assets",
  },
  {
    id: "connections",
    label: "workspace.access",
    icon: Cable,
    description: "workspace.connect_chat_channels_and_manage_bindings_and_shared_schemes",
  },
  {
    id: "runs",
    label: "workspace.runs",
    icon: Activity,
    description: "workspace.trace_the_model_input_and_outcome_of_each_action",
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
  if (state.settingsView === "observability") return "runs";
  if (state.settingsView === "operating-mode") return "connections";
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
  if (
    ["qq-scheme-config", "qq-storage", "mcp-servers", "skill-catalog", "tool-grants"].includes(
      state.settingsRoute,
    )
  )
    return "connections";
  if (["task-ledger", "execution-ledger"].includes(state.settingsRoute)) return "runs";
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
    case "library":
      state.requestPageNavigation("settings", "knowledge");
      break;
    case "connections":
      state.requestPageNavigation("settings", "operating-mode");
      break;
    case "runs":
      state.requestPageNavigation("settings", "observability");
      break;
    case "models":
      state.openSettingsRoute("external-api");
      break;
    case "preferences":
      state.requestPageNavigation("settings", "general");
      break;
  }
}
