import { MessageCircle } from "lucide-react";
import { useId, useRef } from "react";
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
  const searchHintId = useId();
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
        scrollMode="none"
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
        <DialogDescription id={searchHintId} className="sr-only">
          {t("workspace.search_pages_or_loaded_conversations_use_the_arrow_keys_to_select_and_en")}
        </DialogDescription>
        <Command loop label={t("workspace.search_and_jump")} className="border-none bg-transparent">
          <CommandInput
            placeholder={t("workspace.pageSearchPlaceholder")}
            aria-label={t("workspace.search_pages_or_loaded_conversations")}
            aria-describedby={searchHintId}
            className="h-11 text-sm"
          />
          <CommandList className="max-h-[min(60svh,30rem)] px-1 py-1">
            <CommandEmpty className="py-8 text-center text-sm text-muted-foreground">
              {t("workspace.no_matching_pages_or_loaded_conversations")}
            </CommandEmpty>
            <CommandGroup heading={t("workspace.workspace")}>
              {[...SPACES, ...ENVIRONMENT].map((space) => (
                <CommandItem
                  key={space.id}
                  value={`space:${space.id}`}
                  keywords={[t(space.label), t(space.description)]}
                  onSelect={() => select(() => openSpace(space.id))}
                  className="gap-2.5 rounded-lg py-2"
                >
                  <space.icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium text-foreground">{t(space.label)}</span>
                  <CommandShortcut className="text-[11px] font-normal text-muted-foreground">
                    {t(space.description)}
                  </CommandShortcut>
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
                  className="gap-2.5 rounded-lg py-2"
                >
                  <span className="font-medium text-foreground">{t(route.title)}</span>
                  {route.state === "unavailable" && (
                    <CommandShortcut className="text-[11px] text-muted-foreground/80">
                      {t("workspace.not_available")}
                    </CommandShortcut>
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
                    className="gap-2.5 rounded-lg py-2"
                  >
                    <MessageCircle className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium text-foreground">
                      {conversation.title}
                    </span>
                    <CommandShortcut className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-muted-foreground">
                      {conversation.channel === "web" ? "Web" : "OneBot"}
                    </CommandShortcut>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-between border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              {t(
                "workspace.search_pages_or_loaded_conversations_use_the_arrow_keys_to_select_and_en",
              )}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
