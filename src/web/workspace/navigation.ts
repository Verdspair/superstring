import {
  Activity,
  BookOpen,
  Bot,
  Cable,
  Cpu,
  MessageCircle,
  SlidersHorizontal,
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
  if (["external-api", "management", "knowledge-model"].includes(state.settingsRoute))
    return "models";
  if (["long-memory", "profile", "knowledge-config", "qq-stickers"].includes(state.settingsRoute))
    return "library";
  if (["qq-scheme-config", "qq-storage"].includes(state.settingsRoute)) return "connections";
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
