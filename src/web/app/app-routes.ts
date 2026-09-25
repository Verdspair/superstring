import type { SuperstringState } from "../state/types";
import { SETTINGS_ROUTES, type SettingsRoute } from "./settings-routes";

export const APP_SECTIONS = [
  { id: "conversations", title: "对话", icon: "chat", note: "Web、私聊与群聊的消息和运行活动。" },
  { id: "agent", title: "Agent", icon: "agent", note: "助手、模型用途、身份表达与上下文。" },
  { id: "materials", title: "资料", icon: "book", note: "长期记忆、知识库与资料授权。" },
  { id: "access", title: "接入", icon: "plug", note: "连接、会话绑定、发言方案、素材与存储。" },
  { id: "preferences", title: "偏好", icon: "sliders", note: "语言、外观与桌面行为。" },
] as const;
export type AppSection = (typeof APP_SECTIONS)[number]["id"];
export function routeSection(route: SettingsRoute): AppSection {
  if (route.startsWith("qq-")) return "access";
  if (["long-memory", "knowledge-config", "profile"].includes(route)) return "materials";
  return "agent";
}
export function currentAppSection(state: SuperstringState): AppSection | null {
  if (state.page === "chat") return "conversations";
  if (state.settingsView === "hub") return null;
  if (state.settingsView === "general" || state.settingsView === "appearance") return "preferences";
  if (state.settingsView === "operating-mode") return "access";
  if (state.settingsView === "knowledge") return "materials";
  if (state.settingsView === "agents") return "agent";
  return routeSection(state.settingsRoute);
}
export function openAppSection(state: SuperstringState, section: AppSection) {
  if (section === "conversations") state.openChat();
  else if (section === "agent") state.openSettingsRoute("models");
  else if (section === "materials") state.openSettingsRoute("long-memory");
  else if (section === "access") state.requestPageNavigation("settings", "operating-mode");
  else state.requestPageNavigation("settings", "general");
}
type Destination = {
  id: string;
  title: string;
  unavailable: boolean;
  active: (state: SuperstringState) => boolean;
  open: (state: SuperstringState) => void;
};
export function sectionDestinations(section: AppSection) {
  const routes: Destination[] = SETTINGS_ROUTES.filter(
    (route) => routeSection(route.id) === section,
  ).map((route) => ({
    id: route.id as string,
    title: route.title,
    unavailable: route.state === "unavailable",
    active: (state: SuperstringState) =>
      route.id === "basic"
        ? state.settingsView === "agents"
        : state.settingsView === "workspace" &&
          (state.settingsRoute === route.id ||
            (route.id === "models" &&
              ["management", "knowledge-model"].includes(state.settingsRoute))),
    open: (state: SuperstringState) => state.openSettingsRoute(route.id),
  }));
  if (section === "access")
    routes.unshift({
      id: "operating-mode",
      title: "运行模式与连接",
      unavailable: false,
      active: (state) => state.settingsView === "operating-mode",
      open: (state) => state.requestPageNavigation("settings", "operating-mode"),
    });
  if (section === "preferences")
    routes.push({
      id: "general",
      title: "通用",
      unavailable: false,
      active: (state) => ["general", "appearance"].includes(state.settingsView),
      open: (state) => state.requestPageNavigation("settings", "general"),
    });
  return routes;
}
