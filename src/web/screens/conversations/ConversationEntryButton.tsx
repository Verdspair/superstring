import { MessageCircle, Plus, User, Users } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { QqConversationEntry } from "../connections/QqConversationEntry";
import { CreateConversation } from "./CreateConversation";

/** One entry for both creation paths: the web conversation dialog and the shared QQ dialog. */
export function ConversationEntryButton() {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const invoked = useRef(false);
  const [webOpen, setWebOpen] = useState(false);
  const [qq, setQq] = useState<{ kind: "group" | "private"; open: boolean } | null>(null);
  const choose = (next: "web" | "group" | "private") => {
    invoked.current = true;
    if (next === "web") setWebOpen(true);
    else setQq({ kind: next, open: true });
  };
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) invoked.current = false;
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} size="sm" tooltip={t("conversation.entry.hint")}>
            <Plus />
            {t("conversation.entry.trigger")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-auto min-w-48"
          onCloseAutoFocus={(event) => {
            if (!invoked.current) return;
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <DropdownMenuItem onSelect={() => choose("web")}>
            <MessageCircle />
            {t("conversation.entry.newChat")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => choose("group")}>
            <Users />
            {t("conversation.entry.addGroup")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => choose("private")}>
            <User />
            {t("conversation.entry.addPrivate")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateConversation
        open={webOpen}
        onOpenChange={setWebOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      />
      {qq && (
        <QqConversationEntry
          schemeId={null}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          initialKind={qq.kind}
          open={qq.open}
          showTrigger={false}
          onOpenChange={(open) => setQq((current) => (current ? { ...current, open } : current))}
        />
      )}
    </>
  );
}
