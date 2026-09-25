import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { APP_SECTIONS, currentAppSection, sectionDestinations } from "./app-routes";

export function SettingsNavigation() {
  const t = useI18n();
  const state = useSuperstringStore();
  const section = currentAppSection(state);
  if (state.page !== "settings" || !section) return null;
  return (
    <nav className="settings-secondary-nav" aria-label={t("配置页面")}>
      {sectionDestinations(section).map((destination) => (
        <button
          key={destination.id}
          type="button"
          aria-current={destination.active(state) ? "page" : undefined}
          className={destination.active(state) ? "active" : undefined}
          onClick={() => destination.open(useSuperstringStore.getState())}
        >
          <span className="section-row-head">
            <strong>{t(destination.title)}</strong>
          </span>
          {destination.unavailable && <small>{t("未开放")}</small>}
        </button>
      ))}
    </nav>
  );
}

export function SettingsBody({ children }: { children: ReactNode }) {
  const t = useI18n();
  const page = useSuperstringStore((state) => state.page);
  const section = useSuperstringStore(currentAppSection);
  if (page !== "settings") return <>{children}</>;
  return (
    <div className="settings-body unified-settings-body">
      <div className="settings-body-content">
        {section && (
          <div className="settings-area-label">
            {t(APP_SECTIONS.find((item) => item.id === section)?.title ?? "设置中心")}
          </div>
        )}
        <SettingsNavigation />
        {children}
      </div>
    </div>
  );
}
