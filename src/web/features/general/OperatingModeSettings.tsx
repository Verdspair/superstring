import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Icon } from "../../ui/icons";

const MODES = [
  { title: "对话聊天模式", icon: "chat", available: true },
  { title: "主动聊天模式", icon: "clock", available: false },
  { title: "任务模式", icon: "instructions", available: false },
] as const;

export function OperatingModeSettings() {
  const t = useI18n();
  const navigate = useSuperstringStore((state) => state.requestPageNavigation);
  return (
    <section className="page settings-page">
      <SettingsHeader onBack={() => navigate("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content operating-mode-settings">
          <h2>{t("运行模式")}</h2>
          <p className="settings-note">{t("目前仅支持对话聊天模式，其他模式暂未开放。")}</p>
          <fieldset className="operating-modes">
            <legend className="visually-hidden">{t("运行模式")}</legend>
            {MODES.map((mode) => (
              <button
                key={mode.title}
                type="button"
                className="operating-mode-row"
                aria-label={t(mode.title)}
                aria-pressed={mode.available}
                disabled={!mode.available}
              >
                <Icon name={mode.icon} />
                <span className="operating-mode-name">{t(mode.title)}</span>
                <span className="operating-mode-status">
                  {mode.available ? (
                    <>
                      <small>{t("使用中")}</small>
                      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m6 12 4 4 8-8" />
                      </svg>
                    </>
                  ) : (
                    <small>{t("未开放")}</small>
                  )}
                </span>
              </button>
            ))}
          </fieldset>
        </div>
      </SettingsBody>
    </section>
  );
}
