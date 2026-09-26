import { MessageCircle } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { useSuperstringStore } from "../store";
import { ENVIRONMENT, openSpace, SPACES } from "./navigation";
import { SETTINGS_ROUTES } from "./settings-routes";

export function WorkspaceCommand({
  open,
  onOpenChange,
  returnTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnTo: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const ids = useSuperstringStore((s) => s.directoryIds);
  const summaries = useSuperstringStore((s) => s.summaryById);
  const navigated = useRef(false);
  const select = (action: () => void) => {
    navigated.current = true;
    onOpenChange(false);
    action();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        navigated.current = false;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
        onOpenAutoFocus={() => {
          navigated.current = false;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!navigated.current && returnTo?.isConnected) returnTo.focus();
        }}
      >
        <DialogTitle className="sr-only">{t("workspace.search_and_jump")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("workspace.search_pages_or_loaded_conversations_use_the_arrow_keys_to_select_and_en")}
        </DialogDescription>
        <Command loop label={t("workspace.search_and_jump")}>
          <CommandInput placeholder={t("workspace.search_pages_or_loaded_conversations")} />
          <CommandList className="max-h-[min(60svh,30rem)]">
            <CommandEmpty>{t("workspace.no_matching_pages_or_loaded_conversations")}</CommandEmpty>
            <CommandGroup heading={t("workspace.workspace")}>
              {[...SPACES, ...ENVIRONMENT].map((space) => (
                <CommandItem
                  key={space.id}
                  value={`space:${space.id}`}
                  keywords={[t(space.label), t(space.description)]}
                  onSelect={() => select(() => openSpace(space.id))}
                >
                  <space.icon />
                  <span>{t(space.label)}</span>
                  <CommandShortcut>{t(space.description)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t("workspace.preferences")}>
              {SETTINGS_ROUTES.map((route) => (
                <CommandItem
                  key={route.id}
                  value={`capability:${route.id}`}
                  keywords={[t(route.title), t(route.note)]}
                  onSelect={() =>
                    select(() => useSuperstringStore.getState().openSettingsRoute(route.id))
                  }
                >
                  <span>{t(route.title)}</span>
                  {route.state === "unavailable" && (
                    <CommandShortcut>{t("workspace.not_available")}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t("workspace.loaded_conversations")}>
              {ids
                .map((id) => summaries[id])
                .filter(Boolean)
                .map((conversation) => (
                  <CommandItem
                    key={conversation.id}
                    value={`conversation:${conversation.id}`}
                    keywords={[conversation.title, conversation.channel]}
                    onSelect={() =>
                      select(() => {
                        void useSuperstringStore
                          .getState()
                          .requestConversationNavigation(conversation.id);
                      })
                    }
                  >
                    <MessageCircle />
                    <span className="truncate">{conversation.title}</span>
                    <CommandShortcut>
                      {conversation.channel === "web" ? "Web" : "OneBot"}
                    </CommandShortcut>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            {t("workspace.arrows_to_select_enter_to_open_esc_to_close")}
          </p>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
