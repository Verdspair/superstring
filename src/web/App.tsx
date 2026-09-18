import { useEffect } from "react";
import { SettingsHub } from "./app/SettingsHub";
import { Sidebar as SidebarView } from "./app/Sidebar";
import { StatusBar } from "./app/StatusBar";
import { AgentSettings } from "./features/agents/AgentSettings";
import { AppearanceSettings } from "./features/appearance/AppearanceSettings";
import { ChatPage } from "./features/chat/ChatPage";
import { GeneralSettings } from "./features/general/GeneralSettings";
import { OperatingModeSettings } from "./features/general/OperatingModeSettings";
import { useI18n } from "./i18n";
import { useSuperstringStore } from "./store";
import { Icon } from "./ui/icons";

const VERSION = "0.2.0-alpha";

export { SectionB } from "./features/memory/SectionB";
export { AppearanceSettings, ChatPage };
export function Sidebar() {
  return <SidebarView version={VERSION} />;
}

function App() {
  const t = useI18n();
  const status = useSuperstringStore((state) => state.status);
  const page = useSuperstringStore((state) => state.page);
  const settingsView = useSuperstringStore((state) => state.settingsView);
  const bootstrap = useSuperstringStore((state) => state.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
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
    <div id="superstring-shell">
      <Sidebar />
      <main className="main-area">
        {page === "chat" ? (
          <ChatPage />
        ) : settingsView === "hub" ? (
          <SettingsHub />
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
    </div>
  );
}

export default App;
