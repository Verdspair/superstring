import { ArrowRight, Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { NativeSelect } from "../../components/ui/native-select";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { openSpace } from "../../workspace/navigation";

/** Creation selects the next conversation's identity; it never edits the current Agent. */
export function CreateConversation({ children }: { children?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const agents = useSuperstringStore((s) => s.agents);
  const candidate = useSuperstringStore((s) => s.selectedNewSessionAgentId);
  const setCandidate = useSuperstringStore((s) => s.setNewSessionAgent);
  const create = useSuperstringStore((s) => s.createSession);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const active = agents.filter((a) => a.is_active);
  useEffect(() => {
    if (open) {
      setName("");
      setNotice("");
    }
  }, [open]);
  const submit = async () => {
    if (pending.current || !candidate || !active.some((agent) => agent.id === candidate)) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      const ok = await create(
        name.trim() ||
          t("workspace.new_chat", { "0": new Date().toLocaleString(i18n.resolvedLanguage) }),
      );
      if (ok) setOpen(false);
      else {
        const state = useSuperstringStore.getState();
        setNotice(state.error || state.feedback);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending.current) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        {children ?? (
          <Button size="sm">
            <Plus />
            {t("workspace.new_conversation")}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("workspace.start_a_new_conversation")}</DialogTitle>
          <DialogDescription>
            {t(
              "workspace.choose_the_assistant_for_this_conversation_editing_another_assistant_wil",
            )}
          </DialogDescription>
        </DialogHeader>
        {active.length ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="conversation-agent">{t("workspace.new_chats")}</Label>
              <NativeSelect
                id="conversation-agent"
                className="w-full"
                value={candidate ?? ""}
                disabled={busy}
                onChange={(e) => setCandidate(e.target.value)}
              >
                <option value="" disabled>
                  {t("workspace.select_an_assistant")}
                </option>
                {active.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="conversation-name">{t("workspace.conversation_name")}</Label>
              <Input
                id="conversation-name"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("workspace.leave_blank_to_use_the_creation_time")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t("workspace.you_can_rename_it_later")}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-4 text-sm">
            <p>
              {t(
                "workspace.no_enabled_assistants_enable_or_create_one_in_settings_to_start_a_chat",
              )}
            </p>
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => {
                setOpen(false);
                openSpace("assistants");
              }}
            >
              {t("workspace.open_assistant_workspace")}
              <ArrowRight />
            </Button>
          </div>
        )}
        {notice && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(notice)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            {t("workspace.cancel")}
          </Button>
          <Button
            disabled={busy || !candidate || !active.some((a) => a.id === candidate)}
            onClick={() => void submit()}
          >
            {busy ? t("workspace.creating") : t("workspace.start_chatting")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
