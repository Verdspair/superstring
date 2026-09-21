import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Chevron, Icon } from "../ui/icons";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsBody } from "./SettingsSidebar";

export function SettingsHub() {
  const t = useI18n();
  const openSettingsRoute = useSuperstringStore((state) => state.openSettingsRoute);
  const requestPageNavigation = useSuperstringStore((state) => state.requestPageNavigation);
  const entries = [
    {
      title: "通用",
      note: "界面语言与外观。",
      icon: "sliders",
      action: () => requestPageNavigation("settings", "general"),
    },
    {
      title: "运行模式",
      note: "目前仅支持对话聊天模式，其他模式暂未开放。",
      icon: "chat",
      action: () => requestPageNavigation("settings", "operating-mode"),
    },
    {
      title: "快捷管理",
      note: "管理助手、基础信息与全部用途模型；外部接入暂未开放。",
      icon: "users",
      action: () => openSettingsRoute("management"),
    },
    {
      title: "人设",
      note: "核心身份、互动边界、高级指令与补充指令。",
      icon: "profile",
      action: () => openSettingsRoute("identity"),
    },
    {
      title: "记忆",
      note: "当前助手的读取配置与全局共享配置分开显示。",
      icon: "book",
      action: () => openSettingsRoute("long-memory"),
    },
  ] as const;
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
