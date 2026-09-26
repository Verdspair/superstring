import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "../design-system/IconButton";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";
import { APP_SECTIONS, openAppSection, sectionDestinations } from "./app-routes";

const OpenCommands = createContext<() => void>(() => {});

export function CommandSearchButton() {
  const t = useI18n();
  const open = useContext(OpenCommands);
  return (
    <Button
      type="button"
      variant="outline"
      className="command-search-trigger w-full justify-start text-muted-foreground"
      aria-label={t("搜索与跳转")}
      onClick={open}
    >
      <Icon name="search" />
      <span>{t("搜索与跳转")}</span>
      <kbd className="ml-auto rounded border px-1.5 font-mono text-[10px]">
        {navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}
      </kbd>
    </Button>
  );
}

/** Search is a presentation surface over the same draft-guarded navigation actions. */
export function CommandNavigation({ children }: { children: ReactNode }) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigated = useRef(false);
  const show = () => {
    returnFocus.current = document.activeElement as HTMLElement;
    navigated.current = false;
    setOpen(true);
  };
  const ids = useSuperstringStore((state) => state.directoryIds);
  const summaries = useSuperstringStore((state) => state.summaryById);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !event.isComposing
      ) {
        event.preventDefault();
        if (open) setOpen(false);
        else {
          returnFocus.current = document.activeElement as HTMLElement;
          navigated.current = false;
          setOpen(true);
        }
      }
    };
    document.addEventListener("keydown", toggle);
    return () => document.removeEventListener("keydown", toggle);
  }, [open]);
  const select = (action: () => void) => {
    navigated.current = true;
    setOpen(false);
    action();
  };
  return (
    <OpenCommands.Provider value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="command-dialog gap-0 overflow-hidden p-0 sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!navigated.current && returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
        >
          <DialogTitle className="sr-only">{t("搜索与跳转")}</DialogTitle>
          <Command label={t("搜索与跳转")} loop>
            <DialogDescription className="sr-only">
              {t("搜索功能页面或已加载的会话，使用方向键选择并按 Enter 打开。")}
            </DialogDescription>
            <div className="command-search flex items-center gap-1 p-1 [&>[data-slot=command-input-wrapper]]:flex-1">
              <CommandInput placeholder={t("搜索页面或已加载会话…")} />
              <IconButton label={t("关闭搜索")} icon="close" onClick={() => setOpen(false)} />
            </div>
            <CommandList className="command-list max-h-[min(60svh,28rem)]">
              <CommandEmpty>{t("没有匹配的页面或已加载会话。")}</CommandEmpty>
              <CommandGroup heading={t("工作区")} className="command-group">
                {APP_SECTIONS.map((section) => (
                  <CommandItem
                    className="command-item"
                    key={section.id}
                    value={`section:${section.id}`}
                    keywords={[t(section.title), t(section.note)]}
                    onSelect={() =>
                      select(() => openAppSection(useSuperstringStore.getState(), section.id))
                    }
                  >
                    <Icon name={section.icon} />
                    <span>{t(section.title)}</span>
                    <CommandShortcut>{t(section.note)}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              {APP_SECTIONS.filter((section) => section.id !== "conversations").map((section) => (
                <CommandGroup key={section.id} heading={t(section.title)} className="command-group">
                  {sectionDestinations(section.id).map((destination) => (
                    <CommandItem
                      className="command-item"
                      key={destination.id}
                      value={`page:${destination.id}`}
                      keywords={[t(destination.title), t(section.title)]}
                      onSelect={() =>
                        select(() => destination.open(useSuperstringStore.getState()))
                      }
                    >
                      <Icon name={section.icon} />
                      <span>{t(destination.title)}</span>
                      {destination.unavailable && <CommandShortcut>{t("未开放")}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {!!ids.length && (
                <CommandGroup heading={t("已加载的会话")} className="command-group">
                  {ids.map((id) => {
                    const conversation = summaries[id];
                    if (!conversation) return null;
                    const channel =
                      conversation.channel === "web"
                        ? "Web · 私聊"
                        : conversation.topology === "shared"
                          ? "OneBot · 群聊"
                          : "OneBot · 私聊";
                    return (
                      <CommandItem
                        className="command-item"
                        key={id}
                        value={`conversation:${id}`}
                        keywords={[conversation.title, t(channel)]}
                        onSelect={() =>
                          select(() => {
                            void useSuperstringStore.getState().requestConversationNavigation(id);
                          })
                        }
                      >
                        <Icon name="chat" />
                        <span>{conversation.title}</span>
                        <CommandShortcut>{t(channel)}</CommandShortcut>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
            <div className="command-footer border-t px-3 py-2 text-xs text-muted-foreground">
              <span>{t("方向键选择 · Enter 打开 · Esc 关闭")}</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </OpenCommands.Provider>
  );
}
