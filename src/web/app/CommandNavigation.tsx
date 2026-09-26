import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
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
    <button
      type="button"
      className="command-search-trigger"
      aria-label={t("搜索与跳转")}
      onClick={open}
    >
      <Icon name="search" />
      <span>{t("搜索与跳转")}</span>
      <kbd>{navigator.platform.includes("Mac") ? "⌘ K" : "Ctrl K"}</kbd>
    </button>
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
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="command-overlay" />
          <Dialog.Content
            className="command-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!navigated.current && returnFocus.current?.isConnected)
                returnFocus.current.focus();
            }}
          >
            <Dialog.Title className="visually-hidden">{t("搜索与跳转")}</Dialog.Title>
            <Command label={t("搜索与跳转")} loop>
              <Dialog.Description className="visually-hidden">
                {t("搜索功能页面或已加载的会话，使用方向键选择并按 Enter 打开。")}
              </Dialog.Description>
              <div className="command-search">
                <Icon name="search" />
                <Command.Input placeholder={t("搜索页面或已加载会话…")} />
                <IconButton label={t("关闭搜索")} icon="close" onClick={() => setOpen(false)} />
              </div>
              <Command.List className="command-list">
                <Command.Empty>{t("没有匹配的页面或已加载会话。")}</Command.Empty>
                <Command.Group heading={t("工作区")} className="command-group">
                  {APP_SECTIONS.map((section) => (
                    <Command.Item
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
                      <small>{t(section.note)}</small>
                    </Command.Item>
                  ))}
                </Command.Group>
                {APP_SECTIONS.filter((section) => section.id !== "conversations").map((section) => (
                  <Command.Group
                    key={section.id}
                    heading={t(section.title)}
                    className="command-group"
                  >
                    {sectionDestinations(section.id).map((destination) => (
                      <Command.Item
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
                        {destination.unavailable && <small>{t("未开放")}</small>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
                {!!ids.length && (
                  <Command.Group heading={t("已加载的会话")} className="command-group">
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
                        <Command.Item
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
                          <small>{t(channel)}</small>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                )}
              </Command.List>
              <div className="command-footer">
                <span>{t("方向键选择 · Enter 打开 · Esc 关闭")}</span>
              </div>
            </Command>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </OpenCommands.Provider>
  );
}
