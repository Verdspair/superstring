import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";
import { Sidebar } from "./Sidebar";

/** The standard Sheet owns mobile focus; committed navigation is its only automatic dismissal. */
export function NavigationSurface({ children }: { children: ReactNode }) {
  const { openMobile, setOpenMobile } = useSidebar();
  const destination = useSuperstringStore(
    (state) =>
      `${state.page}:${state.settingsView}:${state.settingsRoute}:${state.currentConversationId}`,
  );
  useEffect(() => {
    if (destination) setOpenMobile(false);
  }, [destination, setOpenMobile]);
  return (
    <Sheet open={openMobile} onOpenChange={setOpenMobile}>
      {children}
    </Sheet>
  );
}

export function NavigationTrigger() {
  const t = useI18n();
  const { isMobile } = useSidebar();
  if (!isMobile) return <SidebarTrigger aria-label={t("会话与导航")} />;
  return (
    <SheetTrigger asChild>
      <Button variant="ghost" size="icon-sm" aria-label={t("会话与导航")}>
        <Icon name="menu" />
      </Button>
    </SheetTrigger>
  );
}

export function ResponsiveSidebar({ version }: { version: string }) {
  const t = useI18n();
  const { isMobile } = useSidebar();
  if (!isMobile) return <Sidebar version={version} />;
  return (
    <SheetContent side="left" showCloseButton={false} className="w-72 p-0">
      <SheetHeader className="sr-only">
        <SheetTitle>{t("会话与导航")}</SheetTitle>
        <SheetDescription>{t("选择会话或打开功能设置。")}</SheetDescription>
      </SheetHeader>
      <Sidebar version={version} collapsible="none" />
    </SheetContent>
  );
}
