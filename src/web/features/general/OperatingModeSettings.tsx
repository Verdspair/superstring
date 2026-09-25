import { useEffect } from "react";
import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Icon } from "../../ui/icons";
import { QqAppAccess } from "../qq/QqAppAccess";

/**
 * 运行模式（§11.1）。
 *
 * 2026-09-25（用户指示）：第三方 App 接入（QQ）整体搬到这里——原先它在「快捷管理」下是一个独立页，
 * 而运行模式里那一行「主动聊天模式（未开放）」正是它的位置。现在模式列表里那一行就是它（带总开关与
 * 连接状态），配置内容紧跟在同一页的「QQ」分组里：一个地方管完，不再需要跨页跳转。
 *
 * 页面形状与其它设置页一致：`SettingsHeader` + `SettingsBody`，往上两个锚点，配置参数全部展开、
 * 不折叠（§3.3）。
 */
const MODES = [
  { title: "对话聊天模式", icon: "chat", available: true },
  { title: "任务模式", icon: "instructions", available: false },
] as const;

export function OperatingModeSettings() {
  const t = useI18n();
  const navigate = useSuperstringStore((state) => state.requestPageNavigation);
  const settings = useSuperstringStore((s) => s.qqSettings);
  const connection = useSuperstringStore((s) => s.qqConnection);
  const saving = useSuperstringStore((s) => s.qqAccessSaving);
  const error = useSuperstringStore((s) => s.error);
  const load = useSuperstringStore((s) => s.loadQqAccess);
  const save = useSuperstringStore((s) => s.saveQqSurface);
  useEffect(() => {
    // §11.1 puts the third-party master switch here, so this page reads the same state the QQ
    // section below does rather than a second copy of it.
    void load();
  }, [load]);
  return (
    <section className="page settings-page">
      <SettingsHeader onBack={() => navigate("settings", "hub")} />
      <SettingsBody>
        <div className="settings-content operating-mode-settings">
          <h2>{t("运行模式")}</h2>
          <p className="settings-note">
            {t("当前使用对话聊天模式；第三方聊天（QQ）可在这里开关与配置，任务模式暂未开放。")}
          </p>
          {error && (
            <p role="alert" className="error">
              {translateNotice(error)}
            </p>
          )}
          <nav className="workspace-anchors" aria-label={t("本页快捷跳转")}>
            <a href="#settings-operating-modes">{t("模式")}</a>
            <a href="#settings-qq">{t("QQ")}</a>
          </nav>
          <fieldset className="operating-modes" id="settings-operating-modes">
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
            {/* 第三方聊天（QQ）：这一行取代原来「主动聊天模式（未开放）」的占位，配置就在下面的
                「QQ」分组里，所以这一行不跳转，只承载总开关与连接状态（§11.1 的基础启停快捷字段）。 */}
            <div className="operating-mode-row is-current">
              <Icon name="plug" />
              <span className="operating-mode-name">{t("第三方聊天（QQ）")}</span>
              <span className="operating-mode-status">
                {settings ? (
                  <>
                    <label className="hint">
                      <input
                        type="checkbox"
                        disabled={saving}
                        checked={settings.enabled}
                        aria-label={t("第三方聊天总开关")}
                        onChange={(event) => void save({ enabled: event.target.checked })}
                      />
                      {settings.enabled ? t("使用中") : t("未开启")}
                    </label>
                    <small>
                      {connection
                        ? t(connection.phase === "ready" ? "已连接" : "未连接")
                        : t("未知")}
                    </small>
                  </>
                ) : (
                  <small>{t("正在读取…")}</small>
                )}
              </span>
            </div>
          </fieldset>
          <SettingsGroup
            id="settings-qq"
            title="QQ"
            note="连接、群与私聊绑定、逐会话的发言开关与记忆整理；地址与令牌只保存在本机。"
          >
            <QqAppAccess embedded />
          </SettingsGroup>
        </div>
      </SettingsBody>
    </section>
  );
}
