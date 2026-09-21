import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";
import { SETTINGS_GROUPS, SETTINGS_ROUTES, settingsRoute } from "./settings-routes";

function useSettingsNavigation() {
  const page = useSuperstringStore((s) => s.page);
  const view = useSuperstringStore((s) => s.settingsView);
  const route = useSuperstringStore((s) => s.settingsRoute);
  const navigate = useSuperstringStore((s) => s.requestPageNavigation);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const busy = useSuperstringStore(
    (s) =>
      s.settingsSaving ||
      s.editorLoading ||
      s.knowledgeReadLoading ||
      s.memoryCorrectionSaving ||
      s.knowledgeBusy,
  );
  const group = view === "workspace" ? settingsRoute(route)?.group : undefined;
  const management =
    (view === "workspace" &&
      (group === "management" || route === "management" || route === "knowledge-model")) ||
    view === "agents";
  return { page, view, route, navigate, openRoute, busy, group, management };
}

export function SettingsNavigation() {
  const t = useI18n();
  const { page, view, navigate, openRoute, busy, group, management } = useSettingsNavigation();
  if (page !== "settings") return null;
  return (
    <nav className="settings-navigation" aria-label={t("设置导航")}>
      <div className="settings-navigation-inner">
        <div className="settings-primary-nav">
          {(
            [
              ["hub", "设置中心", "settings"],
              ["general", "通用", "sliders"],
              ["operating-mode", "运行模式", "chat"],
            ] as const
          ).map(([id, title, icon]) => (
            <button
              key={id}
              type="button"
              disabled={busy}
              aria-current={
                view === id || (id === "general" && view === "appearance") ? "page" : undefined
              }
              onClick={() => navigate("settings", id)}
            >
              <Icon name={icon} />
              <span>{t(title)}</span>
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            aria-current={management ? "true" : undefined}
            onClick={() => openRoute("management")}
          >
            <Icon name="users" />
            <span>{t("快捷管理")}</span>
          </button>
          {SETTINGS_GROUPS.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              aria-current={group === item.id ? "true" : undefined}
              onClick={() => openRoute(item.id === "persona" ? "identity" : "long-memory")}
            >
              <Icon name={item.id === "persona" ? "profile" : "book"} />
              <span>{t(item.title)}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}

export function SettingsBody({ children }: { children: ReactNode }) {
  const t = useI18n();
  const { page, view, route, openRoute, busy, group, management } = useSettingsNavigation();
  const items = management
    ? [
        {
          id: "models",
          title: "默认模型",
          icon: "chip" as const,
          active:
            view === "workspace" && ["models", "management", "knowledge-model"].includes(route),
          action: () => openRoute("management"),
        },
        {
          id: "agents",
          title: "助手管理",
          icon: "agent" as const,
          active: view === "agents",
          action: () => useSuperstringStore.getState().openAgentSettings(),
        },
        ...SETTINGS_ROUTES.filter(
          (item) => item.group === "management" && item.id !== "models" && item.id !== "basic",
        ).map((item) => ({
          id: item.id,
          title: item.title,
          icon: "chip" as const,
          active: view === "workspace" && route === item.id,
          unavailable: item.state === "unavailable",
          action: () => openRoute(item.id),
        })),
      ]
    : SETTINGS_ROUTES.filter((item) => item.group === group).map((item) => ({
        id: item.id,
        title: item.title,
        icon:
          item.group === "management"
            ? ("chip" as const)
            : item.group === "persona"
              ? ("profile" as const)
              : ("book" as const),
        active: route === item.id,
        unavailable: item.state === "unavailable",
        action: () => openRoute(item.id),
      }));
  if (page !== "settings") return <>{children}</>;
  return (
    <div className="settings-body">
      <SettingsNavigation />
      <div className="settings-body-content">
        {(group || management) && (
          <nav
            className="settings-secondary-nav"
            aria-label={t(management ? "管理入口" : "配置页面")}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                className={item.active ? "active" : undefined}
                aria-current={item.active ? "page" : undefined}
                onClick={item.action}
              >
                <span className="section-row-head">
                  <Icon name={item.icon} />
                  <strong>{t(item.title)}</strong>
                </span>
                {"unavailable" in item && item.unavailable && <small>{t("未开放")}</small>}
              </button>
            ))}
          </nav>
        )}
        {children}
      </div>
    </div>
  );
}
