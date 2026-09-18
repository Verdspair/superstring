import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";

export function SettingsHeader({ onBack }: { onBack?: () => void }) {
  const t = useI18n();
  const openChat = useSuperstringStore((state) => state.openChat);
  return (
    <header className="page-header settings-header">
      {onBack ? (
        <nav aria-label={t("设置导航")}>
          <button
            className="settings-back"
            type="button"
            aria-label={t("返回设置中心")}
            title={t("返回设置中心")}
            onClick={onBack}
          >
            <Icon name="back" />
          </button>
        </nav>
      ) : (
        <h1>
          <Icon name="settings" />
          {t("设置中心")}
        </h1>
      )}
      <button type="button" onClick={openChat}>
        {t("返回对话")}
      </button>
    </header>
  );
}
