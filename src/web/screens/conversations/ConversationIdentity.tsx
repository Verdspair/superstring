import { Info, MessageCircle, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";
export function ConversationIdentity({
  conversation,
  agentName,
  model,
  mode,
  actions,
  directory,
}: {
  conversation: ConversationSummary | null;
  agentName?: string;
  model?: string;
  mode?: string;
  actions?: ReactNode;
  directory?: ReactNode;
}) {
  const { t } = useTranslation();
  const Glyph = conversation?.topology === "shared" ? Users : MessageCircle;
  return (
    <header className="flex min-h-20 shrink-0 items-center gap-3 border-b bg-background px-4 py-4 md:px-7">
      {directory}
      <div className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:flex">
        <Glyph className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold tracking-tight">
          {conversation?.title ?? t("workspace.your_next_conversation")}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="py-0 text-[10px]">
            {conversation?.channel === "onebot11"
              ? t(
                  conversation.topology === "shared"
                    ? "workspace.onebot_group"
                    : "workspace.onebot_direct",
                )
              : t("workspace.web_direct")}
          </Badge>
          {agentName && <span>{agentName}</span>}
          {mode && (
            <span>
              {mode === "chat"
                ? t("workspace.chat_mode")
                : mode === "work"
                  ? t("workspace.work_mode")
                  : t("workspace.unknown_mode", { "0": mode })}
            </span>
          )}
          {model && <span className="hidden max-w-56 truncate font-mono lg:inline">{model}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {actions}
        {conversation && (
          <Sheet>
            <SheetTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("workspace.conversation_details")}
              >
                <Info />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{t("workspace.conversation_details")}</SheetTitle>
                <SheetDescription>{conversation.title}</SheetDescription>
              </SheetHeader>
              <div className="space-y-6 overflow-auto px-5 pb-5 text-sm">
                <dl className="space-y-4">
                  {[
                    ["workspace.conversation_id", conversation.id],
                    ["workspace.source_binding", conversation.sourceId],
                    ["workspace.assistant", conversation.agentId],
                    ["workspace.source_revision", conversation.bindingEpoch],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{t(String(label))}</dt>
                      <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
                    </div>
                  ))}
                </dl>
                <section>
                  <h2 className="mb-3 font-medium">{t("workspace.participants")}</h2>
                  <ul className="divide-y rounded-lg border">
                    {conversation.participants.map((person) => (
                      <li key={person.id} className="p-3">
                        <strong className="text-sm font-medium">{person.label}</strong>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {person.id}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </header>
  );
}
