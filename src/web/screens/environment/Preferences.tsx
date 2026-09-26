import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AppearanceMode,
  MODE_STORAGE_KEY,
  MODES,
  readMode,
  readTheme,
  selectMode,
  selectTheme,
  THEME_STORAGE_KEY,
  THEMES,
  type ThemeId,
} from "@/appearance";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { broadcastAppearance, isDesktopMode, requestDesktopExit } from "@/desktop-lifecycle";
import { selectLocale, useLocale } from "@/i18n";
import { useSuperstringStore } from "@/store";

export function Preferences() {
  const t = useTranslation().t,
    locale = useLocale(),
    s = useSuperstringStore();
  const [theme, setTheme] = useState(readTheme),
    [mode, setMode] = useState(readMode),
    [notice, setNotice] = useState(""),
    [exit, setExit] = useState(false);
  const desktop = isDesktopMode();
  useEffect(() => {
    if (desktop) void s.loadDesktopSettings();
  }, [desktop, s.loadDesktopSettings]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === MODE_STORAGE_KEY || event.key === null) {
        setTheme(readTheme());
        setMode(readMode());
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
  const modeIcon = { system: Laptop, light: Sun, dark: Moon };
  return (
    <div className="mx-auto h-full min-h-0 w-full overflow-y-auto max-w-5xl space-y-7 p-5 md:p-8">
      <header className="space-y-1">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">
          SUPERSTRING / {t("library.preferences")}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("library.make.this.workspace.yours")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("library.language.color.and.desktop.behavior.changes.apply.immediately")}
        </p>
      </header>
      {notice && (
        <p role="status" className="rounded-lg border p-3 text-sm">
          {notice}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("library.interface.language")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Field label="library.language">
            <NativeSelect
              value={locale}
              onChange={(e) => {
                if (!selectLocale(e.target.value as "zh-CN" | "en"))
                  setNotice(t("library.language.changed.but.could.not.be.saved.in.this"));
              }}
            >
              <option value="zh-CN">{t("library.simplified.chinese")}</option>
              <option value="en">{t("library.english")}</option>
            </NativeSelect>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("library.appearance")}</CardTitle>
          <CardDescription>
            {t("library.keep.your.personal.color.palette.while.keeping.text.and")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-7">
          <div className="grid gap-3 sm:grid-cols-3">
            {MODES.map((item) => {
              const Icon = modeIcon[item.id];
              return (
                <Button
                  key={item.id}
                  variant={mode === item.id ? "secondary" : "outline"}
                  className="h-20 justify-start gap-4 px-5"
                  aria-pressed={mode === item.id}
                  onClick={() => chooseMode(item.id)}
                >
                  <Icon className="size-5" />
                  <span>{t(`preferences.mode.${item.id}`)}</span>
                  {mode === item.id && <Check className="ml-auto" />}
                </Button>
              );
            })}
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-medium">{t("library.theme.color")}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {THEMES.map((item) => (
                <Button
                  key={item.id}
                  variant={theme === item.id ? "secondary" : "outline"}
                  className="h-auto justify-start gap-3 p-3"
                  aria-pressed={theme === item.id}
                  onClick={() => chooseTheme(item.id)}
                >
                  <span
                    aria-hidden="true"
                    className="size-6 shrink-0 rounded-full border border-black/10"
                    style={{ background: item.color }}
                  />
                  <span className="text-sm">{t(`preferences.theme.${item.id}`)}</span>
                  {theme === item.id && <Check className="ml-auto" />}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      {desktop && (
        <Card>
          <CardHeader>
            <CardTitle>{t("library.desktop.behavior")}</CardTitle>
            <CardDescription>
              {t("library.choose.whether.agents.stay.online.after.you.close.the")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="library.when.the.window.closes">
              <NativeSelect
                value={s.desktopCloseAction ?? ""}
                disabled={s.desktopSettingsLoading || s.desktopSettingsSaving}
                onChange={(e) => {
                  if (e.target.value)
                    void s.updateDesktopCloseAction(e.target.value as "background" | "exit");
                }}
              >
                {s.desktopCloseAction === null && <option value="">{t("library.not.set")}</option>}
                <option value="background">{t("library.stay.online.in.the.background")}</option>
                <option value="exit">{t("library.quit.completely")}</option>
              </NativeSelect>
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
              <p className="text-sm text-muted-foreground">
                {t("library.quitting.stops.the.local.service.and.running.agents")}
              </p>
              <Button variant="outline" onClick={() => setExit(true)}>
                {t("library.quit.application.now")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {exit && (
        <ConfirmDialog
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
      )}
    </div>
  );
}
