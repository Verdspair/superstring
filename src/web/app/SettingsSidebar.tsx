import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { currentAppSection, sectionDestinations } from "./app-routes";

export function SettingsNavigation() {
  const t = useI18n();
  const state = useSuperstringStore();
  const section = currentAppSection(state);
  if (state.page !== "settings" || !section) return null;
  return (
    <nav className="settings-secondary-nav" aria-label={t("配置页面")}>
      <SidebarMenu>
        {sectionDestinations(section).map((destination) => (
          <SidebarMenuItem key={destination.id}>
            <SidebarMenuButton
              type="button"
              aria-current={destination.active(state) ? "page" : undefined}
              isActive={destination.active(state)}
              className="h-auto min-h-9 py-2"
              onClick={() => destination.open(useSuperstringStore.getState())}
            >
              <span className="flex-1">{t(destination.title)}</span>
              {destination.unavailable && (
                <Badge variant="outline" className="text-[10px]">
                  {t("未开放")}
                </Badge>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </nav>
  );
}

export function SettingsBody({ children }: { children: ReactNode }) {
  return (
    <div className="settings-body unified-settings-body min-h-0 flex-1 overflow-auto">
      <div className="settings-body-content mx-auto w-full max-w-6xl p-4 md:p-6">{children}</div>
    </div>
  );
}
