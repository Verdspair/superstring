import { Camera } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { Button } from "../../components/ui/button";
import { useConversationAvatar } from "../../features/conversations/use-conversation-avatar";
import { ConversationAvatar } from "./avatar";
import { AvatarEditor } from "./avatar-editor";

export function ConversationAvatarDialog({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: ConversationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { value, save } = useConversationAvatar(conversation);
  return (
    <AvatarEditor
      key={conversation.id}
      conversationId={conversation.id}
      title={conversation.title}
      topology={conversation.topology}
      value={value}
      open={open}
      onOpenChange={onOpenChange}
      onSave={save}
    />
  );
}

export function ConversationAvatarButton({
  conversation,
  detailed = false,
}: {
  conversation: ConversationSummary;
  detailed?: boolean;
}) {
  const { t } = useTranslation();
  const { value } = useConversationAvatar(conversation);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        className={
          detailed
            ? "h-auto w-full justify-start gap-4 rounded-xl border p-4 text-left"
            : "relative size-10 shrink-0 rounded-full p-0"
        }
        aria-label={t("avatar.edit_named", { "0": conversation.title })}
        onClick={() => setOpen(true)}
      >
        <ConversationAvatar
          conversation={conversation}
          value={value}
          className={detailed ? "size-16" : "size-10"}
        />
        {detailed ? (
          <span className="min-w-0 space-y-1">
            <span className="block text-xs font-normal text-muted-foreground">
              {t("avatar.current")}
            </span>
            <span className="flex items-center gap-1.5 text-sm">
              <Camera className="size-3.5" />
              {t("avatar.edit")}
            </span>
          </span>
        ) : (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full border bg-background p-0.5">
            <Camera className="size-2.5" />
          </span>
        )}
      </Button>
      <ConversationAvatarDialog conversation={conversation} open={open} onOpenChange={setOpen} />
    </>
  );
}
