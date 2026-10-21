import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QqBindingResponse } from "../../../shared/contracts/qq";
import { Button } from "../../components/ui/button";
import { useSuperstringStore } from "../../store";
import { AddConversationDialog } from "./add-conversation-dialog";
import { BindingEditor } from "./binding-editor";

export function QqConversationEntry({
  schemeId = null,
  initialKind,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  loadDirectory = true,
  onCloseAutoFocus,
}: {
  schemeId?: string | null;
  initialKind?: "group" | "private";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  loadDirectory?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const [localOpen, setLocalOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen !== undefined) onOpenChange?.(next);
    else setLocalOpen(next);
  };
  const load = useSuperstringStore((s) => s.loadQqBindingDirectory);
  const binding = useSuperstringStore((s) => s.qqBindings.find((b) => b.id === editing));
  const conversations = useSuperstringStore((s) => s.qqConversations);
  useEffect(() => {
    if (open && loadDirectory) void load();
  }, [open, load, loadDirectory]);
  const restoreFocus = (event: Event) => {
    if (onCloseAutoFocus) onCloseAutoFocus(event);
    else if (trigger.current) {
      event.preventDefault();
      trigger.current.focus();
    }
  };
  const manage = (saved: QqBindingResponse) => {
    setEditing(saved.id);
    setOpen(false);
  };
  return (
    <>
      {showTrigger && (
        <Button ref={trigger} tooltip={t("hints.qq.addBinding")} onClick={() => setOpen(true)}>
          <Plus />
          {t("schemes.bindings.add")}
        </Button>
      )}
      {open && (
        <AddConversationDialog
          schemeId={schemeId}
          initialKind={initialKind}
          onClose={() => setOpen(false)}
          onManage={manage}
          onCloseAutoFocus={editing ? (event) => event.preventDefault() : restoreFocus}
        />
      )}
      {binding && (
        <BindingEditor
          binding={binding}
          conversation={
            conversations.find(
              (c) =>
                c.account_id === binding.account_id &&
                c.kind === binding.kind &&
                c.peer_id === binding.peer_id,
            ) ?? {
              account_id: binding.account_id,
              kind: binding.kind,
              peer_id: binding.peer_id,
              messages: 0,
              last_at_seconds: 0,
              binding_id: binding.id,
            }
          }
          onClose={() => setEditing(null)}
          onCloseAutoFocus={restoreFocus}
        />
      )}
    </>
  );
}
