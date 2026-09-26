import { useEffect } from "react";
import { CommandNavigation } from "./app/CommandNavigation";
import { NavigationConfirm } from "./app/NavigationConfirm";
import { ResponsiveSidebar } from "./app/ResponsiveSidebar";
import { SettingsHub } from "./app/SettingsHub";
import { SettingsWorkspace } from "./app/SettingsWorkspace";
import { Sidebar as SidebarView } from "./app/Sidebar";
import { StatusBar } from "./app/StatusBar";
import { DesignSystemProvider } from "./design-system/Providers";
import { AgentSettings } from "./features/agents/AgentSettings";
import { AppearanceSettings } from "./features/appearance/AppearanceSettings";
import { ChatPage } from "./features/chat/ChatPage";
import { ConversationShell } from "./features/conversations/ConversationShell";
import { GeneralSettings } from "./features/general/GeneralSettings";
import { OperatingModeSettings } from "./features/general/OperatingModeSettings";
import { KnowledgeSettings } from "./features/knowledge/KnowledgeSettings";
import { ObservabilityPage } from "./features/observability/ObservabilityPage";
import { settingsHaveDrafts } from "./features/qq/draft-state";
import { useI18n } from "./i18n";
import { useSuperstringStore } from "./store";
import { Icon } from "./ui/icons";

const VERSION = "0.2.1";

export { SectionB } from "./features/memory/SectionB";
export { AppearanceSettings, ChatPage };
export function Sidebar() {
  return <SidebarView version={VERSION} />;
}

function AppContent() {
  const t = useI18n();
  const status = useSuperstringStore((state) => state.status);
  const page = useSuperstringStore((state) => state.page);
  const settingsView = useSuperstringStore((state) => state.settingsView);
  const bootstrap = useSuperstringStore((state) => state.bootstrap);
  const confirm = useSuperstringStore((state) => state.navigationConfirmOpen);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  const unsaved = useSuperstringStore(settingsHaveDrafts);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  if (status === "loading" || status === "idle")
    return (
      <div className="loading-page">
        <div className="loading-brand">
          <Icon name="brand" />
          <strong>superstring</strong>
        </div>
        <h1>{t("正在加载本地工作空间")}</h1>
        <p>{t("正在连接本地服务并读取会话与 Agent 配置…")}</p>
      </div>
    );
  return (
    <CommandNavigation>
      <div id="superstring-shell">
        <ResponsiveSidebar version={VERSION} />
        <main className="main-area">
          {page === "chat" ? (
            <ConversationShell />
          ) : settingsView === "hub" ? (
            <SettingsHub />
          ) : settingsView === "workspace" ? (
            <SettingsWorkspace />
          ) : settingsView === "observability" ? (
            <ObservabilityPage />
          ) : settingsView === "knowledge" ? (
            <KnowledgeSettings />
          ) : settingsView === "general" ? (
            <GeneralSettings />
          ) : settingsView === "operating-mode" ? (
            <OperatingModeSettings />
          ) : settingsView === "appearance" ? (
            <AppearanceSettings />
          ) : (
            <AgentSettings />
          )}
        </main>
        <StatusBar />
        {confirm &&
          page === "settings" &&
          !["agents", "workspace", "knowledge"].includes(settingsView) && <NavigationConfirm />}
      </div>
    </CommandNavigation>
  );
}

export default function App() {
  return (
    <DesignSystemProvider>
      <AppContent />
    </DesignSystemProvider>
  );
}
