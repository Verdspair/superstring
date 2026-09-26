import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SheetClose } from "@/components/ui/sheet";
import {
  SidebarContent,
  SidebarFooter,
  Sidebar as SidebarFrame,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { ConversationList } from "../features/conversations/ConversationList";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { HeadingIcon, Icon } from "../ui/icons";
import { APP_SECTIONS, currentAppSection } from "./app-routes";
import { CommandSearchButton } from "./CommandNavigation";
import { NewSessionDialog } from "./NewSessionDialog";
import { PrimaryNavigation } from "./PrimaryNavigation";
import { SettingsNavigation } from "./SettingsSidebar";

export function Sidebar({
  version,
  collapsible = "offcanvas",
}: {
  version: string;
  collapsible?: "offcanvas" | "none";
}) {
  const t = useI18n();
  const page = useSuperstringStore((state) => state.page);
  const section = useSuperstringStore(currentAppSection);
  const openSettings = useSuperstringStore((state) => state.openSettings);
  const { isMobile } = useSidebar();
  return (
    <SidebarFrame
      className="sidebar"
      variant="inset"
      collapsible={collapsible}
      role="complementary"
      aria-label={t("会话与导航")}
    >
      <SidebarHeader className="gap-4 p-3">
        <div className="brand flex items-center gap-2.5 px-1 py-1 [&>svg]:size-8">
          <HeadingIcon name="brand" />
          <div className="min-w-0 flex-1">
            <strong className="block text-base tracking-tight">superstring</strong>
            <span className="text-xs text-muted-foreground">{t("本地工作空间")}</span>
          </div>
          {isMobile && (
            <SheetClose asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t("关闭导航")}>
                <Icon name="close" />
              </Button>
            </SheetClose>
          )}
        </div>
        <CommandSearchButton />
        <PrimaryNavigation />
        {page === "chat" && <NewSessionDialog />}
      </SidebarHeader>
      <Separator />
      <SidebarContent className="sidebar-context">
        <SidebarGroup className="p-3">
          {page === "chat" ? (
            <ConversationList />
          ) : (
            <>
              <SidebarGroupLabel className="session-heading">
                {t(APP_SECTIONS.find((item) => item.id === section)?.title ?? "设置中心")}
              </SidebarGroupLabel>
              <SettingsNavigation />
            </>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="sidebar-footer border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            <SidebarMenuButton
              className="settings-button"
              aria-label={t("设置")}
              onClick={openSettings}
            >
              <Icon name="settings" />
              <span>{t("设置")}</span>
            </SidebarMenuButton>
            <span className="version shrink-0 px-2 font-mono text-xs text-muted-foreground">
              v{version}
            </span>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </SidebarFrame>
  );
}
