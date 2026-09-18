import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Chevron, Icon } from "../ui/icons";
import { SettingsHeader } from "./SettingsHeader";

export function SettingsHub() {
  const t = useI18n();
  const openAgentSettings = useSuperstringStore((state) => state.openAgentSettings);
  const requestPageNavigation = useSuperstringStore((state) => state.requestPageNavigation);
  const entries = [
    {
      title: "通用",
      note: "界面语言与外观。",
      icon: "sliders",
      action: () => requestPageNavigation("settings", "general"),
    },
    {
      title: "运行模式",
      note: "目前仅支持对话聊天模式，其他模式暂未开放。",
      icon: "chat",
      action: () => requestPageNavigation("settings", "operating-mode"),
    },
    {
      title: "助手设置",
      note: "模型、记忆与性格人设；各分区独立保存。",
      icon: "agent",
      action: openAgentSettings,
    },
  ] as const;
  return (
    <section className="page settings-page">
      <SettingsHeader />
      <div className="settings-content settings-hub">
        <h2>{t("功能设置")}</h2>
        <nav className="settings-list" aria-label={t("功能设置")}>
          {entries.map((entry) => (
            <button
              key={entry.title}
              type="button"
              className="settings-entry"
              aria-label={t(entry.title)}
              onClick={entry.action}
            >
              <Icon name={entry.icon} />
              <span className="settings-entry-copy">
                <strong>{t(entry.title)}</strong>
                <small>{t(entry.note)}</small>
              </span>
              <span className="entry-arrow" aria-hidden="true">
                <Chevron />
              </span>
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}
