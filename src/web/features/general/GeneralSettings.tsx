import { useState } from "react";
import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { selectLocale, useI18n, useLocale } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { AppearanceControls } from "../appearance/AppearanceSettings";
import { CloseBehaviorSettings } from "./CloseBehaviorSettings";

export function GeneralSettings() {
  const t = useI18n();
  const locale = useLocale();
  const [unsaved, setUnsaved] = useState(false);
  const requestPageNavigation = useSuperstringStore((state) => state.requestPageNavigation);
  return (
    <section className="page settings-page">
      <SettingsHeader onBack={() => requestPageNavigation("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content general-settings">
          <h2>{t("通用")}</h2>
          <Accordion
            title={t("界面语言")}
            note={t("立即应用并自动保存，不改变聊天内容或模型回复语言。")}
            icon="language"
          >
            <fieldset className="mode-options">
              <legend className="visually-hidden">{t("界面语言")}</legend>
              {(
                [
                  ["zh-CN", "简体中文"],
                  ["en", "English"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  lang={id}
                  className="mode-option"
                  aria-pressed={locale === id}
                  onClick={() => setUnsaved(!selectLocale(id))}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {unsaved && (
              <p className="hint" role="status">
                {t("语言已切换，但浏览器未允许保存；刷新后可能恢复默认。")}
              </p>
            )}
          </Accordion>
          <Accordion title={t("外观")} note={t("主题配色与明暗模式。")} icon="palette">
            <div className="appearance-settings general-appearance">
              <AppearanceControls />
            </div>
          </Accordion>
          <CloseBehaviorSettings />
        </div>
      </SettingsBody>
    </section>
  );
}
