import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { MODES, readMode, readTheme, selectMode, selectTheme, THEMES } from "../../appearance";
import { broadcastAppearance } from "../../desktop-lifecycle";
import { msg, translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { Icon } from "../../ui/icons";

export function AppearanceSettings() {
  const requestPageNavigation = useSuperstringStore((state) => state.requestPageNavigation);
  return (
    <section className="page settings-page flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <SettingsHeader onBack={() => requestPageNavigation("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content appearance-settings min-w-0 space-y-6">
          <AppearanceControls />
        </div>
      </SettingsBody>
    </section>
  );
}

export function AppearanceControls() {
  const t = useI18n();
  const [themeId, setThemeId] = useState(readTheme);
  const [notice, setNotice] = useState("");
  const [modeId, setModeId] = useState(readMode);
  const [modeNotice, setModeNotice] = useState("");

  // Storage events arrive only from other tabs. Local changes are broadcast
  // by the click handlers below.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === "superstring-appearance" ||
        event.key === "superstring-appearance-mode"
      ) {
        setThemeId(readTheme());
        setModeId(readMode());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <>
      <p className="settings-note text-sm leading-relaxed text-muted-foreground">
        {t("外观修改立即生效并自动保存。")}
      </p>
      <Accordion
        title={t("推荐外观")}
        note={t("16 种配色，点击色圆立即切换。")}
        icon="palette"
        open
      >
        <fieldset className="theme-options grid grid-cols-4 gap-2 xl:grid-cols-8">
          <legend className="visually-hidden sr-only">{t("主题颜色")}</legend>
          {THEMES.map((theme) => (
            <Button
              variant="outline"
              type="button"
              key={theme.id}
              className="theme-option h-auto flex-col gap-3 whitespace-normal px-2 py-4 aria-pressed:border-primary aria-pressed:bg-accent"
              aria-label={t("{0}主题{1}", t(theme.name), theme.id === "slate" ? t("（默认）") : "")}
              aria-pressed={theme.id === themeId}
              title={t(theme.name)}
              onClick={() => {
                const saved = selectTheme(theme.id);
                setThemeId(theme.id);
                broadcastAppearance({ theme: theme.id, mode: readMode() });
                setNotice(
                  saved
                    ? msg("已切换为{0}", msg(theme.name))
                    : msg("已切换为{0}，但浏览器未允许保存；刷新后可能恢复默认。", msg(theme.name)),
                );
              }}
            >
              <span
                className="theme-swatch grid size-8 shrink-0 place-items-center rounded-full [&>svg]:size-4 [&>svg]:fill-none [&>svg]:stroke-white [&>svg]:stroke-2"
                style={{ backgroundColor: theme.color }}
                aria-hidden="true"
              >
                {theme.id === themeId && <Icon name="check" />}
              </span>
              <span className="theme-label flex flex-wrap items-baseline justify-center gap-1 text-xs [&>small]:text-muted-foreground">
                {t(theme.name)}
                {theme.id === "slate" && <small>{t("默认")}</small>}
              </span>
            </Button>
          ))}
        </fieldset>
        <p
          className="hint text-sm leading-relaxed text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <span
            className="theme-dot mr-2 inline-block size-2 rounded-full bg-primary"
            aria-hidden="true"
          />
          {translateNotice(notice) ||
            t("当前主题：{0}", t(THEMES.find((theme) => theme.id === themeId)?.name ?? ""))}
        </p>
      </Accordion>
      <Accordion title={t("明暗模式")} note={t("跟随系统，或固定浅色／深色。")} icon="sliders" open>
        <fieldset className="mode-options flex flex-wrap gap-2">
          <legend className="visually-hidden sr-only">{t("明暗模式")}</legend>
          {MODES.map((mode) => (
            <Button
              variant="outline"
              type="button"
              key={mode.id}
              className="mode-option h-auto min-h-10 whitespace-normal px-4 py-3 text-left aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              aria-pressed={mode.id === modeId}
              onClick={() => {
                const saved = selectMode(mode.id);
                setModeId(mode.id);
                broadcastAppearance({ theme: readTheme(), mode: mode.id });
                setModeNotice(
                  saved
                    ? ""
                    : msg("已切换为{0}，但浏览器未允许保存；刷新后可能恢复默认。", msg(mode.name)),
                );
              }}
            >
              {t(mode.name)}
            </Button>
          ))}
        </fieldset>
        <p className="hint text-sm leading-relaxed text-muted-foreground" aria-live="polite">
          {translateNotice(modeNotice) ||
            t("当前：{0}", t(MODES.find((mode) => mode.id === modeId)?.name ?? ""))}
        </p>
      </Accordion>
      <Accordion title={t("自定义外观")} note={t("未开放")} icon="sliders">
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("自定义颜色与更多外观选项暂未开放。")}
        </p>
      </Accordion>
    </>
  );
}
