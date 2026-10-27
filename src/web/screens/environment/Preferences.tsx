import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
  type AppearanceMode,
  FONT_STORAGE_KEY,
  FONTS,
  type FontId,
  INTERFACE_SIZE_STORAGE_KEY,
  INTERFACE_SIZES,
  type InterfaceSizeId,
  MODE_STORAGE_KEY,
  MODES,
  readFont,
  readInterfaceSize,
  readMode,
  readTextSize,
  readTheme,
  SELECTABLE_THEMES,
  selectFont,
  selectInterfaceSize,
  selectMode,
  selectTextSize,
  selectTheme,
  TEXT_SIZE_STORAGE_KEY,
  TEXT_SIZES,
  type TextSizeId,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "@/appearance";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { SettingsGroup, SettingsRow } from "@/components/settings-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { broadcastAppearance, isDesktopMode, requestDesktopExit } from "@/desktop-lifecycle";
import { persistDesktopPreference } from "@/desktop-preferences";
import { selectLocale, useLocale } from "@/i18n";
import { useSuperstringStore } from "@/store";
import {
  CLOSE_ANIMATION_STORAGE_KEY,
  isCloseAnimationEnabled,
} from "../../../shared/desktop-preferences";

/** The desktop host applies this on close; missing or unreadable values keep the animation. */
function readCloseAnimation(): boolean {
  try {
    return isCloseAnimationEnabled(localStorage.getItem(CLOSE_ANIMATION_STORAGE_KEY));
  } catch {
    return true;
  }
}

function selectCloseAnimation(enabled: boolean): boolean {
  const value = enabled ? "on" : "off";
  try {
    localStorage.setItem(CLOSE_ANIMATION_STORAGE_KEY, value);
    void persistDesktopPreference(CLOSE_ANIMATION_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function Preferences({ active = true }: { active?: boolean } = {}) {
  const t = useTranslation().t,
    locale = useLocale(),
    s = useSuperstringStore(
      useShallow((state) => ({ loadDesktopSettings: state.loadDesktopSettings })),
    );
  const [theme, setTheme] = useState(readTheme),
    [mode, setMode] = useState(readMode),
    [font, setFont] = useState(readFont),
    [textSize, setTextSize] = useState(readTextSize),
    [interfaceSize, setInterfaceSize] = useState(readInterfaceSize),
    [closeAnimation, setCloseAnimation] = useState(readCloseAnimation),
    [notice, setNotice] = useState(""),
    [exit, setExit] = useState(false);
  const desktop = isDesktopMode();

  useEffect(() => {
    if (active && desktop) void s.loadDesktopSettings();
  }, [active, desktop, s.loadDesktopSettings]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (
        event.key === THEME_STORAGE_KEY ||
        event.key === MODE_STORAGE_KEY ||
        event.key === FONT_STORAGE_KEY ||
        event.key === TEXT_SIZE_STORAGE_KEY ||
        event.key === INTERFACE_SIZE_STORAGE_KEY ||
        event.key === CLOSE_ANIMATION_STORAGE_KEY ||
        event.key === null
      ) {
        setTheme(readTheme());
        setMode(readMode());
        setFont(readFont());
        setTextSize(readTextSize());
        setInterfaceSize(readInterfaceSize());
        setCloseAnimation(readCloseAnimation());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const chooseTheme = (id: ThemeId) => {
    const saved = selectTheme(id);
    setTheme(id);
    broadcastAppearance({ theme: id, mode });
    setNotice(saved ? "" : t("library.appearance.applied.but.could.not.be.saved.in.this"));
  };

  const chooseMode = (value: AppearanceMode) => {
    const saved = selectMode(value);
    setMode(value);
    broadcastAppearance({ theme, mode: value });
    setNotice(saved ? "" : t("library.appearance.applied.but.could.not.be.saved.in.this"));
  };

  const chooseFont = (value: FontId) => {
    const saved = selectFont(value);
    setFont(value);
    setNotice(saved ? "" : t("library.appearance.applied.but.could.not.be.saved.in.this"));
  };

  const modeIcon = { system: Laptop, light: Sun, dark: Moon };

  return (
    <div className="mx-auto h-full min-h-0 w-full max-w-[1160px] overflow-y-auto space-y-[24px] px-[36px] pt-[28px] pb-[64px] max-[768px]:px-[16px] max-[768px]:pt-[20px] max-[768px]:pb-[48px]">
      <header className="workspace-page-header">
        <p className="workspace-page-location">
          {t("brand.workspace", { "0": t("library.preferences") })}
        </p>
        <h1 className="workspace-page-title">{t("library.make.this.workspace.yours")}</h1>
        <p className="workspace-page-description">
          {t("library.language.color.and.desktop.behavior.changes.apply.immediately")}
        </p>
      </header>

      {notice && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground"
        >
          {notice}
        </p>
      )}

      <SettingsGroup title={t("library.interface.language")}>
        <div className="p-4 sm:p-5">
          <Field label="library.language" tooltip={t("hints.system.language")}>
            <NativeSelect
              value={locale}
              onChange={(e) => {
                if (!selectLocale(e.target.value as "zh-CN" | "en"))
                  setNotice(t("library.language.changed.but.could.not.be.saved.in.this"));
              }}
              className="w-full sm:max-w-xs"
            >
              <option value="zh-CN">{t("library.simplified.chinese")}</option>
              <option value="en">{t("library.english")}</option>
            </NativeSelect>
          </Field>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("library.appearance")}
        description={t("library.keep.your.personal.color.palette.while.keeping.text.and")}
      >
        <div className="p-4 sm:p-5 space-y-3">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {MODES.map((item) => {
              const Icon = modeIcon[item.id];
              const selected = mode === item.id;
              return (
                <Button
                  key={item.id}
                  variant={selected ? "secondary" : "outline"}
                  tooltip={t(`hints.system.mode.${item.id}`)}
                  className="selection-card relative flex h-auto min-h-20 flex-col items-center justify-center gap-1.5 p-2 sm:p-3 text-center font-normal transition-colors whitespace-normal min-w-0"
                  aria-pressed={selected}
                  onClick={() => chooseMode(item.id)}
                >
                  <Icon
                    className={`size-5 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <span className="text-xs sm:text-sm font-medium leading-tight">
                    {t(`preferences.mode.${item.id}`)}
                  </span>
                  {selected && (
                    <Check className="absolute top-1.5 right-1.5 size-3.5 sm:size-4 text-primary" />
                  )}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="p-4 sm:p-5 space-y-3">
          <Field label="library.font" tooltip={t("hints.system.font")}>
            <NativeSelect
              value={font}
              onChange={(event) => chooseFont(event.target.value as FontId)}
              className="w-full sm:max-w-xs"
            >
              {FONTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(`preferences.font.${item.id}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="preferences.textSize.label" tooltip={t("preferences.textSize.hint")}>
              <NativeSelect
                value={textSize}
                onChange={(event) => {
                  const value = event.target.value as TextSizeId;
                  const saved = selectTextSize(value);
                  setTextSize(value);
                  setNotice(
                    saved ? "" : t("library.appearance.applied.but.could.not.be.saved.in.this"),
                  );
                }}
              >
                {TEXT_SIZES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(`preferences.textSize.${item.id}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="preferences.interfaceSize.label"
              tooltip={t("preferences.interfaceSize.hint")}
            >
              <NativeSelect
                value={interfaceSize}
                onChange={(event) => {
                  const value = event.target.value as InterfaceSizeId;
                  const saved = selectInterfaceSize(value);
                  setInterfaceSize(value);
                  setNotice(
                    saved ? "" : t("library.appearance.applied.but.could.not.be.saved.in.this"),
                  );
                }}
              >
                {INTERFACE_SIZES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {t(`preferences.interfaceSize.${item.id}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <figure
            className="space-y-3 rounded-lg border bg-muted/20 p-3 text-base leading-relaxed"
            aria-label={t("library.font.preview")}
          >
            {/* i18next-instrument-ignore-next-line */}
            <p>山海之间，灵感自来 · The quick brown fox 0123456789</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input
                readOnly
                value={t("preferences.sizePreview.input")}
                aria-label={t("preferences.sizePreview.input")}
                className="min-w-0 flex-1"
              />
              <Button type="button" disabled tooltip={t("preferences.sizePreview.hint")}>
                {t("preferences.sizePreview.button")}
              </Button>
            </div>
          </figure>
        </div>

        <div className="p-4 sm:p-5 space-y-3">
          <h3 className="text-sm font-medium text-foreground">{t("library.theme.color")}</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SELECTABLE_THEMES.map((item) => {
              const selected = theme === item.id;
              return (
                <Button
                  key={item.id}
                  variant={selected ? "secondary" : "outline"}
                  tooltip={t("hints.system.theme", { "0": t(`preferences.theme.${item.id}`) })}
                  className="selection-card relative flex h-auto min-h-12 items-center justify-start gap-2 p-2.5 sm:p-3 font-normal transition-colors whitespace-normal min-w-0"
                  aria-pressed={selected}
                  onClick={() => chooseTheme(item.id)}
                >
                  <span
                    aria-hidden="true"
                    className="size-4 sm:size-5 shrink-0 rounded-full border border-black/15"
                    style={{ background: item.color }}
                  />
                  <span className="min-w-0 flex-1 text-left text-xs sm:text-sm font-medium leading-tight whitespace-normal">
                    {t(`preferences.theme.${item.id}`)}
                  </span>
                  {selected && <Check className="size-4 shrink-0 text-primary ml-auto" />}
                </Button>
              );
            })}
          </div>
        </div>
      </SettingsGroup>

      {desktop && (
        <SettingsGroup
          title={t("library.desktop.behavior")}
          description={t("library.desktop.behavior.description")}
        >
          <div className="p-4 sm:p-5">
            <Field label="preferences.closeAnimation.label" info="preferences.closeAnimation.hint">
              <NativeSelect
                value={closeAnimation ? "on" : "off"}
                onChange={(event) => {
                  const enabled = event.target.value === "on";
                  const saved = selectCloseAnimation(enabled);
                  setCloseAnimation(enabled);
                  setNotice(
                    saved ? "" : t("library.appearance.applied.but.could.not.be.saved.in.this"),
                  );
                }}
                className="w-full sm:max-w-xs"
              >
                <option value="on">{t("preferences.closeAnimation.animated")}</option>
                <option value="off">{t("preferences.closeAnimation.immediate")}</option>
              </NativeSelect>
            </Field>
          </div>
          <SettingsRow
            description={t("library.window.close.exits.superstring")}
            action={
              <Button
                variant="outline"
                tooltip={t("hints.system.quitApp")}
                className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                onClick={() => setExit(true)}
              >
                {t("library.quit.application.now")}
              </Button>
            }
          />
        </SettingsGroup>
      )}

      <ConfirmDialog
        open={exit}
        message={t("library.quit.superstring.completely")}
        onCancel={() => setExit(false)}
        onConfirm={() => {
          setNotice(
            requestDesktopExit()
              ? t("library.quit.requested")
              : t("library.cannot.reach.the.desktop.service.right.now.try.again"),
          );
          setExit(false);
        }}
      />
    </div>
  );
}
