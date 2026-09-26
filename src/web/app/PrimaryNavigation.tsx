import { motion } from "motion/react";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";
import { APP_SECTIONS, currentAppSection, openAppSection } from "./app-routes";

export function PrimaryNavigation() {
  const t = useI18n();
  const current = useSuperstringStore(currentAppSection);
  return (
    <nav className="app-primary-nav" aria-label={t("主导航")}>
      {APP_SECTIONS.map((section) => (
        <button
          type="button"
          key={section.id}
          aria-current={current === section.id ? "page" : undefined}
          onClick={() => openAppSection(useSuperstringStore.getState(), section.id)}
        >
          {current === section.id && (
            <motion.span
              className="nav-selection"
              layoutId="workspace-navigation-selection"
              aria-hidden="true"
            />
          )}
          <Icon name={section.icon} />
          <span>{t(section.title)}</span>
        </button>
      ))}
    </nav>
  );
}
