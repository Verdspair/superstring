import { useEffect } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { CommandNavigation } from "./app/CommandNavigation";
import { NavigationConfirm } from "./app/NavigationConfirm";
import { NavigationSurface, NavigationTrigger, ResponsiveSidebar } from "./app/ResponsiveSidebar";
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
  return (
    <SidebarProvider>
      <SidebarView version={VERSION} />
    </SidebarProvider>
  );
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
      <div className="loading-page flex min-h-svh flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="loading-brand mb-3 flex items-center gap-3 text-lg [&>svg]:size-10">
          <Icon name="brand" />
          <strong>superstring</strong>
        </div>
        <h1>{t("正在加载本地工作空间")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("正在连接本地服务并读取会话与 Agent 配置…")}
        </p>
      </div>
    );
  return (
    <CommandNavigation>
      <SidebarProvider id="superstring-shell" className="h-svh min-h-0 overflow-hidden">
        <NavigationSurface>
          <ResponsiveSidebar version={VERSION} />
          <SidebarInset className="main-area min-h-0 min-w-0 overflow-hidden md:h-[calc(100svh-1rem)]">
            <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
              <NavigationTrigger />
              <Separator orientation="vertical" className="h-4" />
              <span className="text-sm text-muted-foreground">{t("本地工作空间")}</span>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden [&>section]:flex [&>section]:h-full [&>section]:min-h-0 [&>section]:flex-col">
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
            </div>
            <StatusBar />
          </SidebarInset>
          {confirm &&
            page === "settings" &&
            !["agents", "workspace", "knowledge"].includes(settingsView) && <NavigationConfirm />}
        </NavigationSurface>
      </SidebarProvider>
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
