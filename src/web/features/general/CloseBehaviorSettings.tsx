import { Button } from "@/components/ui/button";
// §12's close behaviour (ADR0018/U07), shown only in desktop mode.
//
// The user decided (2026-09-24) that the answer is remembered and changeable, and that a
// background-online answer must actually keep the app online. Two consequences are visible here
// rather than hidden:
//
//   * The remembered answer IS the setting — there is no separate "remember" switch, because the
//     dialog that would otherwise produce the answer belongs to the desktop host and does not
//     exist yet. "每次询问" is therefore listed as unavailable rather than offered as a choice
//     that currently behaves like something else.
//   * "保持后台在线" needs a way back out, and until the host ships its tray icon the way out is
//     this page's explicit exit button: it asks the running server to quit through the same
//     liveness socket the page already holds. Without it, "stay online" would be a one-way door.

import { useEffect, useState } from "react";
import { isDesktopMode, requestDesktopExit } from "../../desktop-lifecycle";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";

export function CloseBehaviorSettings() {
  const t = useI18n();
  const [desktop] = useState(() => isDesktopMode());
  const [exitState, setExitState] = useState<"idle" | "sent" | "unsent">("idle");
  const action = useSuperstringStore((s) => s.desktopCloseAction);
  const loading = useSuperstringStore((s) => s.desktopSettingsLoading);
  const saving = useSuperstringStore((s) => s.desktopSettingsSaving);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const load = useSuperstringStore((s) => s.loadDesktopSettings);
  const update = useSuperstringStore((s) => s.updateDesktopCloseAction);

  useEffect(() => {
    if (desktop) void load();
  }, [desktop, load]);

  // No desktop host means nothing would obey the value, so the entry is not shown at all rather
  // than shown and inert.
  if (!desktop) return null;

  return (
    <Accordion
      title={t("关闭窗口时")}
      note={t("记住这个选择，之后关闭窗口时按它执行；随时可以在这里改。")}
      icon="power"
    >
      {loading && <p role="status">{t("正在读取关闭行为…")}</p>}
      {error && (
        <p role="alert" className="error text-sm text-destructive">
          {translateNotice(error)}
        </p>
      )}
      {feedback && (
        <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
          {translateNotice(feedback)}
        </p>
      )}
      {action !== null && (
        <fieldset className="mode-options close-behavior-options flex flex-wrap gap-2 [&>button]:flex-col [&>button]:items-start [&>button]:gap-1">
          <legend className="visually-hidden sr-only">{t("关闭窗口时")}</legend>
          {(
            [
              [
                "background",
                "保持后台在线",
                "界面关闭后继续在后台运行，QQ 连接与任务照常；再次打开应用即可回到界面。",
              ],
              ["exit", "完全退出", "关闭界面后应用随之退出；正在运行的模型任务不会等待。"],
            ] as const
          ).map(([value, label, note]) => (
            <Button
              variant="outline"
              key={value}
              type="button"
              className="mode-option h-auto min-h-10 whitespace-normal px-4 py-3 text-left aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              aria-pressed={action === value}
              disabled={saving}
              onClick={() => void update(value)}
            >
              <span>{t(label)}</span>
              <small className="hint text-sm leading-relaxed text-muted-foreground">
                {t(note)}
              </small>
            </Button>
          ))}
          {/* Not a choice yet: the dialog belongs to the desktop host, which is not built here. */}
          <Button
            variant="outline"
            type="button"
            className="mode-option h-auto min-h-10 whitespace-normal px-4 py-3 text-left aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            disabled
            aria-pressed={false}
          >
            <span>{t("每次询问")}</span>
            <small className="hint text-sm leading-relaxed text-muted-foreground">
              {t("关闭时先弹窗询问；该弹窗随桌面宿主提供，尚未开放。")}
            </small>
          </Button>
        </fieldset>
      )}
      <div className="settings-inline-action mt-4 flex flex-col items-start gap-2">
        <Button
          variant="link"
          type="button"
          className="link-button h-auto p-0 text-sm"
          onClick={() => setExitState(requestDesktopExit() ? "sent" : "unsent")}
        >
          {t("立即完全退出应用")}
        </Button>
        {exitState === "sent" && (
          <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
            {t("已请求退出；页面会在服务停止后断开。")}
          </p>
        )}
        {exitState === "unsent" && (
          <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
            {t("没能发出退出请求：当前没有可用的连接，请稍后重试。")}
          </p>
        )}
        {exitState === "idle" && action === "background" && (
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("后台在线时用它退出；桌面宿主托盘就位后会多一个入口。")}
          </p>
        )}
      </div>
    </Accordion>
  );
}
