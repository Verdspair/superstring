import { useState } from "react";
import { Button } from "@/components/ui/button";
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
    <section className="page settings-page flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <SettingsHeader onBack={() => requestPageNavigation("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content general-settings min-w-0 space-y-6">
          <Accordion
            title={t("界面语言")}
            note={t("立即应用并自动保存，不改变聊天内容或模型回复语言。")}
            icon="language"
          >
            <fieldset className="mode-options flex flex-wrap gap-2">
              <legend className="visually-hidden sr-only">{t("界面语言")}</legend>
              {(
                [
                  ["zh-CN", "简体中文"],
                  ["en", "English"],
                ] as const
              ).map(([id, label]) => (
                <Button
                  variant="outline"
                  key={id}
                  type="button"
                  lang={id}
                  className="mode-option h-auto min-h-10 whitespace-normal px-4 py-3 text-left aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  aria-pressed={locale === id}
                  onClick={() => setUnsaved(!selectLocale(id))}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            {unsaved && (
              <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
                {t("语言已切换，但浏览器未允许保存；刷新后可能恢复默认。")}
              </p>
            )}
          </Accordion>
          <Accordion title={t("外观")} note={t("主题配色与明暗模式。")} icon="palette">
            <div className="appearance-settings general-appearance space-y-5">
              <AppearanceControls />
            </div>
          </Accordion>
          <CloseBehaviorSettings />
        </div>
      </SettingsBody>
    </section>
  );
}
