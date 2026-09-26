import { motion } from "motion/react";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";
import { APP_SECTIONS, currentAppSection, openAppSection } from "./app-routes";

export function PrimaryNavigation() {
  const t = useI18n();
  const current = useSuperstringStore(currentAppSection);
  return (
    <nav className="app-primary-nav" aria-label={t("主导航")}>
      <SidebarMenu>
        {APP_SECTIONS.map((section) => (
          <SidebarMenuItem key={section.id}>
            <SidebarMenuButton
              isActive={current === section.id}
              aria-current={current === section.id ? "page" : undefined}
              onClick={() => openAppSection(useSuperstringStore.getState(), section.id)}
              className="relative h-9"
            >
              {current === section.id && (
                <motion.span
                  className="nav-selection absolute inset-y-2 left-0 w-0.5 rounded-full bg-sidebar-primary"
                  layoutId="workspace-navigation-selection"
                  aria-hidden="true"
                />
              )}
              <Icon name={section.icon} />
              <span>{t(section.title)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </nav>
  );
}
