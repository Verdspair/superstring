import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";
import { APP_SECTIONS, currentAppSection } from "./app-routes";
import { settingsRoute } from "./settings-routes";

export function SettingsHeader({ onBack }: { onBack?: () => void }) {
  const t = useI18n();
  const openChat = useSuperstringStore((state) => state.openChat);
  const view = useSuperstringStore((state) => state.settingsView);
  const routeId = useSuperstringStore((state) => state.settingsRoute);
  const section = useSuperstringStore(currentAppSection);
  const route = settingsRoute(routeId);
  const title =
    view === "hub"
      ? "设置中心"
      : view === "agents"
        ? "助手管理"
        : view === "general"
          ? "通用"
          : view === "appearance"
            ? "外观"
            : view === "operating-mode"
              ? "运行模式与连接"
              : view === "knowledge"
                ? "知识库"
                : view === "observability"
                  ? "运行观测"
                  : (route?.title ?? "默认模型");
  return (
    <header className="page-header settings-header">
      <div className="page-heading-copy">
        {onBack && (
          <button
            className="settings-back"
            type="button"
            aria-label={t("返回设置中心")}
            title={t("返回设置中心")}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        )}
        <div>
          <span className="page-eyebrow">
            {t(APP_SECTIONS.find((item) => item.id === section)?.title ?? "本地工作空间")}
          </span>
          <h1>{t(title)}</h1>
        </div>
      </div>
      <button type="button" className="quiet" onClick={openChat}>
        <Icon name="chat" />
        {t("返回对话")}
      </button>
    </header>
  );
}
