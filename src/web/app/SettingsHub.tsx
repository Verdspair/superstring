import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Chevron, Icon } from "../ui/icons";
import { APP_SECTIONS, openAppSection } from "./app-routes";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsBody } from "./SettingsSidebar";

export function SettingsHub() {
  const t = useI18n();
  const entries = APP_SECTIONS.filter((section) => section.id !== "conversations").map(
    (section) => ({
      ...section,
      action: () => openAppSection(useSuperstringStore.getState(), section.id),
    }),
  );
  return (
    <section className="page settings-page">
      <SettingsHeader />
      <SettingsBody>
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
      </SettingsBody>
    </section>
  );
}
