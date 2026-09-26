import { Menu, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui/button";
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
import { useIsMobile } from "../hooks/use-mobile";
import { useSuperstringStore } from "../store";
import { NavigationGuard } from "./NavigationGuard";
import { activeSpace, ENVIRONMENT, SPACES } from "./navigation";
import { ProductNavigation } from "./ProductNavigation";
import { WorkspaceCommand } from "./WorkspaceCommand";

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const active = useSuperstringStore(activeSpace);
  const [menu, setMenu] = useState(false);
  const [command, setCommand] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const destination = useSuperstringStore(
    (s) => `${s.page}:${s.settingsView}:${s.settingsRoute}:${s.currentConversationId}`,
  );
  useEffect(() => {
    if (destination) setMenu(false);
  }, [destination]);
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
  const label =
    [...SPACES, ...ENVIRONMENT].find((space) => space.id === active)?.label ??
    "workspace.conversations";
  return (
    <div
      id="superstring-shell"
      className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground"
    >
      {!mobile && <ProductNavigation onSearch={showSearch} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mobile && (
          <Sheet open={menu} onOpenChange={setMenu}>
            <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("workspace.conversations_and_navigation")}
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <BrandLogo className="size-5 text-primary" />
              <span className="text-sm font-semibold">{t(label)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={t("workspace.search_and_jump")}
                onClick={showSearch}
              >
                <Search />
              </Button>
            </header>
            <SheetContent side="left" showCloseButton={false} className="w-20 p-0">
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
                  className="absolute -right-11 top-3"
                >
                  <X />
                </Button>
              </SheetClose>
            </SheetContent>
          </Sheet>
        )}
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
      <WorkspaceCommand open={command} onOpenChange={setCommand} returnTo={returnTo.current} />
      <NavigationGuard />
    </div>
  );
}
