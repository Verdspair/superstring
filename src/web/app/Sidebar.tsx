import { ConversationList } from "../features/conversations/ConversationList";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { HeadingIcon, Icon } from "../ui/icons";
import { APP_SECTIONS, currentAppSection } from "./app-routes";
import { CommandSearchButton } from "./CommandNavigation";
import { NewSessionDialog } from "./NewSessionDialog";
import { PrimaryNavigation } from "./PrimaryNavigation";
import { SettingsNavigation } from "./SettingsSidebar";

export function Sidebar({ version }: { version: string }) {
  const t = useI18n();
  const page = useSuperstringStore((state) => state.page);
  const section = useSuperstringStore(currentAppSection);
  const openSettings = useSuperstringStore((state) => state.openSettings);
  return (
    <aside className="sidebar">
      <div className="sidebar-fixed">
        <div className="brand">
          <HeadingIcon name="brand" />
          <div>
            <strong>superstring</strong>
            <span>{t("本地工作空间")}</span>
          </div>
        </div>
        <CommandSearchButton />
        <PrimaryNavigation />
        {page === "chat" && <NewSessionDialog />}
      </div>
      <div className="sidebar-context">
        {page === "chat" ? (
          <ConversationList />
        ) : (
          <>
            <div className="session-heading">
              {t(APP_SECTIONS.find((item) => item.id === section)?.title ?? "设置中心")}
            </div>
            <SettingsNavigation />
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className="settings-button"
          type="button"
          aria-label={t("设置")}
          title={t("设置")}
          onClick={openSettings}
        >
          <Icon name="settings" />
          <span>{t("设置")}</span>
        </button>
        <span className="version">v{version}</span>
      </div>
    </aside>
  );
}
