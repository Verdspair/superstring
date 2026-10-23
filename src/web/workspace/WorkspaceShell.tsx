import { Globe, Menu, Search, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type AppearanceMode,
  MODE_STORAGE_KEY,
  MODES,
  readMode,
  readTheme,
  SELECTABLE_THEMES,
  selectMode,
  selectTheme,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "../appearance";
import { Button } from "../components/ui/button";
import { NativeSelect } from "../components/ui/native-select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet";
import { BrandLogo } from "../design-system/BrandLogo";
import { isDesktopHost } from "../desktop-host";
import { broadcastAppearance } from "../desktop-lifecycle";
import { useIsMobile } from "../hooks/use-mobile";
import { selectLocale, useLocale } from "../i18n";
import { useSuperstringStore } from "../store";
import { NavigationGuard } from "./NavigationGuard";

import { ProductNavigation } from "./ProductNavigation";
import { WorkspaceCommand } from "./WorkspaceCommand";

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const desktopHost = isDesktopHost();
  const locale = useLocale();
  const [theme, setTheme] = useState(readTheme);
  const [mode, setMode] = useState(readMode);
  const [menu, setMenu] = useState(false);
  const [command, setCommand] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const destination = useSuperstringStore(
    (s) => `${s.page}:${s.settingsView}:${s.settingsRoute}:${s.currentConversationId}`,
  );
  useEffect(() => {
    if (destination) setMenu(false);
    setTheme(readTheme());
    setMode(readMode());
  }, [destination]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === MODE_STORAGE_KEY || event.key === null) {
        setTheme(readTheme());
        setMode(readMode());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const chooseTheme = (value: ThemeId) => {
    selectTheme(value);
    setTheme(value);
    broadcastAppearance({ theme: value, mode });
  };
  const chooseMode = (value: AppearanceMode) => {
    selectMode(value);
    setMode(value);
    broadcastAppearance({ theme, mode: value });
  };
  const showSearch = () => {
    returnTo.current = document.activeElement as HTMLElement;
    setCommand(true);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.isComposing) {
        e.preventDefault();
        if (!command) returnTo.current = document.activeElement as HTMLElement;
        setCommand(!command);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [command]);
  return (
    <div
      id="superstring-shell"
      className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <Sheet open={menu} onOpenChange={setMenu}>
        <header
          data-slot="app-header"
          data-desktop-host={desktopHost ? "true" : undefined}
          style={
            desktopHost
              ? ({
                  minHeight:
                    "max(56px, calc(env(titlebar-area-height, 36px) / var(--app-interface-scale, 1)))",
                  paddingRight: "calc(148px / var(--app-interface-scale, 1))",
                } as CSSProperties)
              : undefined
          }
          className="sticky top-0 z-40 flex min-h-[56px] shrink-0 flex-wrap items-center justify-between gap-[10px] border-b border-border bg-[var(--header-background)] px-[20px] py-[8px] backdrop-blur-[16px] max-[480px]:px-[12px]"
        >
          <div className="flex shrink-0 items-center gap-[10px]">
            {mobile && (
              <SheetTrigger asChild>
                <Button
                  id="workspace-navigation-trigger"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("workspace.conversations_and_navigation")}
                  tooltip={t("workspace.choose_a_conversation_or_open_settings")}
                >
                  <Menu />
                </Button>
              </SheetTrigger>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={t("brand.name")}
                  onClick={() => useSuperstringStore.getState().openChat()}
                  className="flex items-center gap-[10px] rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <BrandLogo
                    className={mobile ? "size-[20px] text-primary" : "size-[32px] text-primary"}
                  />
                  <span className="text-[15px] font-bold tracking-[-0.01em] max-[480px]:text-[14px]">
                    {t("brand.name")}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("strict.hints.chatHome")}</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-[8px]">
            <NativeSelect
              aria-label={t("library.appearance")}
              value={theme}
              onChange={(event) => chooseTheme(event.target.value as ThemeId)}
              className="w-auto max-w-[260px] max-[480px]:max-w-[140px]"
              selectClassName="h-[32px] w-auto max-w-[260px] rounded-[6px] bg-card py-0 pl-[10px] text-[12.5px] text-muted-foreground max-[480px]:h-[30px] max-[480px]:max-w-[140px] max-[480px]:pl-[6px] max-[480px]:text-[11.5px]"
            >
              {!SELECTABLE_THEMES.some((item) => item.id === theme) && (
                <option value={theme} hidden disabled>
                  {t(`preferences.theme.${theme}`)}
                </option>
              )}
              {SELECTABLE_THEMES.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(`preferences.theme.${item.id}`)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t("hints.system.mode.system")}
              value={mode}
              onChange={(event) => chooseMode(event.target.value as AppearanceMode)}
              className="w-auto max-w-[260px] max-[480px]:max-w-[140px]"
              selectClassName="h-[32px] w-auto rounded-[6px] bg-card py-0 pl-[10px] text-[12.5px] text-muted-foreground max-[480px]:h-[30px] max-[480px]:pl-[6px] max-[480px]:text-[11.5px]"
            >
              {MODES.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(`strict.mode.${item.id}`)}
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="outline"
              className="h-[32px] gap-[6px] rounded-[6px] px-[12px] text-[12.5px] text-muted-foreground max-[480px]:h-[30px] max-[480px]:px-[8px] max-[480px]:text-[11.5px]"
              tooltip={t("hints.system.language")}
              aria-label={t("hints.system.language")}
              onClick={() => selectLocale(locale === "zh-CN" ? "en" : "zh-CN")}
            >
              <Globe className="size-[15px]" />
              {locale === "zh-CN" ? "English" : "中文"}
            </Button>
            {mobile && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("workspace.search_and_jump")}
                tooltip={t("workspace.search_with_shortcut")}
                onClick={showSearch}
              >
                <Search />
              </Button>
            )}
          </div>
        </header>
        {mobile && (
          <SheetContent side="left" showCloseButton={false} className="w-[200px] p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>{t("workspace.conversations_and_navigation")}</SheetTitle>
              <SheetDescription>
                {t("workspace.choose_a_conversation_or_open_settings")}
              </SheetDescription>
            </SheetHeader>
            <ProductNavigation onSearch={showSearch} />
            <SheetClose asChild>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label={t("workspace.close_navigation")}
                tooltip={t("workspace.close_navigation")}
                className="absolute -right-11 top-3"
              >
                <X />
              </Button>
            </SheetClose>
          </SheetContent>
        )}
      </Sheet>
      <div className="flex min-h-0 min-w-0 flex-1">
        <ResizablePanelGroup
          orientation="horizontal"
          resizeTargetMinimumSize={{ fine: 12, coarse: 24 }}
        >
          {!mobile && (
            <ResizablePanel
              id="product-navigation"
              defaultSize="200px"
              minSize="180px"
              maxSize="300px"
              groupResizeBehavior="preserve-pixel-size"
            >
              <ProductNavigation onSearch={showSearch} />
            </ResizablePanel>
          )}
          {!mobile && (
            <ResizableHandle
              aria-label={t("workspace.resize_main_navigation")}
              title={t("hints.workspace.resizeNavigation")}
              className="w-px cursor-col-resize bg-border hover:bg-border focus-visible:bg-border"
            />
          )}
          <ResizablePanel id="workspace-content" minSize={mobile ? "0px" : "380px"}>
            <main className="h-full min-h-0 min-w-0 overflow-hidden">{children}</main>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <WorkspaceCommand open={command} onOpenChange={setCommand} returnTo={returnTo.current} />
      <NavigationGuard />
    </div>
  );
}
