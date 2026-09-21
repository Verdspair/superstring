import { useEffect, useState } from "react";
import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { MODES, readMode, readTheme, selectMode, selectTheme, THEMES } from "../../appearance";
import { broadcastAppearance } from "../../desktop-lifecycle";
import { msg, translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";

export function AppearanceSettings() {
  const t = useI18n();
  const requestPageNavigation = useSuperstringStore((state) => state.requestPageNavigation);
  return (
    <section className="page settings-page">
      <SettingsHeader onBack={() => requestPageNavigation("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content appearance-settings">
          <h2>{t("外观")}</h2>
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
      <p className="settings-note">{t("外观修改立即生效并自动保存。")}</p>
      <Accordion
        title={t("推荐外观")}
        note={t("16 种配色，点击色圆立即切换。")}
        icon="palette"
        open
      >
        <fieldset className="theme-options">
          <legend className="visually-hidden">{t("主题颜色")}</legend>
          {THEMES.map((theme) => (
            <button
              type="button"
              key={theme.id}
              className="theme-option"
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
                className="theme-swatch"
                style={{ backgroundColor: theme.color }}
                aria-hidden="true"
              >
                {theme.id === themeId && (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6 12 4 4 8-8" />
                  </svg>
                )}
              </span>
              <span className="theme-label">
                {t(theme.name)}
                {theme.id === "slate" && <small>{t("默认")}</small>}
              </span>
            </button>
          ))}
        </fieldset>
        <p className="hint" role="status" aria-live="polite">
          <span className="theme-dot" aria-hidden="true" />
          {translateNotice(notice) ||
            t("当前主题：{0}", t(THEMES.find((theme) => theme.id === themeId)?.name ?? ""))}
        </p>
      </Accordion>
      <Accordion title={t("明暗模式")} note={t("跟随系统，或固定浅色／深色。")} icon="sliders" open>
        <fieldset className="mode-options">
          <legend className="visually-hidden">{t("明暗模式")}</legend>
          {MODES.map((mode) => (
            <button
              type="button"
              key={mode.id}
              className="mode-option"
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
            </button>
          ))}
        </fieldset>
        <p className="hint" aria-live="polite">
          {translateNotice(modeNotice) ||
            t("当前：{0}", t(MODES.find((mode) => mode.id === modeId)?.name ?? ""))}
        </p>
      </Accordion>
      <Accordion title={t("自定义外观")} note={t("未开放")} icon="sliders">
        <p className="hint">{t("自定义颜色与更多外观选项暂未开放。")}</p>
      </Accordion>
    </>
  );
}
