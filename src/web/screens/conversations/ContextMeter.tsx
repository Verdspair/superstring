import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ContextRing } from "../../components/context-ring";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Table, TableBody, TableCell, TableRow } from "../../components/ui/table";
import { chatBusy, currentChat } from "../../features/chat/conversation-state";
import { currentSessionId } from "../../features/conversations/directory-state";
import { useSuperstringStore } from "../../store";

const sections = [
  ["instructions", "workspace.instructions_persona"],
  ["recent_history", "workspace.recent_history"],
  ["summaries", "workspace.summaries"],
  ["long_term_memory", "workspace.long_term_memory"],
  ["knowledge", "workspace.knowledge_documents"],
  ["current_question", "workspace.current_question"],
  ["protocol", "workspace.protocol_overhead"],
] as const;
export function ContextMeter() {
  const { t, i18n } = useTranslation();
  const chat = useSuperstringStore(currentChat);
  const session = useSuperstringStore(currentSessionId);
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const usage = chat.contextUsage?.session_id === session ? chat.contextUsage : null;
  const percent = usage ? (usage.input_units / usage.capacity) * 100 : null;
  const draft = new TextEncoder().encode(chat.composer.trim()).length;
  useEffect(() => {
    if (owner !== session) setOpen(false);
  }, [owner, session]);
  const parts = usage
    ? [
        ...sections.map(([key, label]) => ({ key, label, value: usage.components[key] })),
        { key: "output", label: "workspace.reply_reserve", value: usage.output_reserved },
        { key: "safety", label: "workspace.safety_margin", value: usage.safety_reserved },
        { key: "remaining", label: "workspace.remaining_space", value: usage.remaining },
      ]
    : [];
  return (
    <Popover
      open={open && owner === session}
      onOpenChange={(value) => {
        setOwner(session);
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("workspace.context_usage")}
          title={t("workspace.context_usage")}
          className="gap-1.5 px-2 text-muted-foreground"
        >
          <ContextRing percent={percent} />
          <span className="font-mono text-[11px]">
            {percent === null ? "—" : `${percent.toFixed(1)}%`}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        className="w-[min(25rem,calc(100vw-2rem))] max-h-[80svh] overflow-auto p-4"
        aria-label={t("workspace.context_usage")}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          close.current?.focus();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{t("workspace.context_usage")}</h2>
          <Button
            ref={close}
            variant="ghost"
            size="icon-sm"
            aria-label={t("workspace.close_context_usage")}
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        <div className="flex items-end justify-between gap-3 py-3">
          <strong className="text-3xl font-semibold tabular-nums tracking-tight">
            {percent === null ? "—" : `${percent.toFixed(1)}%`}
          </strong>
          <span className="pb-1 text-xs text-muted-foreground">
            {t("workspace.input_usage_of_the_latest_request")}
          </span>
        </div>
        {usage ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t("workspace.approx_used", {
                "0": usage.input_units.toLocaleString(i18n.resolvedLanguage),
                "1": usage.capacity.toLocaleString(i18n.resolvedLanguage),
              })}
            </p>
            <Table>
              <TableBody>
                {parts.map((part, index) => (
                  <TableRow key={part.key} className={index === 7 ? "border-t-2" : undefined}>
                    <TableCell className="py-1.5 text-xs">{t(part.label)}</TableCell>
                    <TableCell className="py-1.5 text-right font-mono text-xs">
                      {part.value.toLocaleString(i18n.resolvedLanguage)}
                    </TableCell>
                    <TableCell className="py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {((part.value / usage.capacity) * 100).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">
              {t("workspace.reserves_are_not_used_input_percentages_use_total_model_capacity")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("workspace.latest_request_model_excludes_its_reply_and_the_unsent_draft", {
                "0": usage.model,
              })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {chatBusy(chat)
              ? t("workspace.preparing_context")
              : t("workspace.no_request_statistics_yet")}{" "}
            ·{" "}
            {t(
              "workspace.request_usage_appears_after_sending_unmeasured_items_are_unknown_not_zer",
            )}
          </p>
        )}
        <p className="border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
          {t("workspace.estimated_from_utf_8_bytes_and_message_overhead_not_exact_model_tokens")}
        </p>
        {draft > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("workspace.unsent_draft_approx_excluded_from_the_request_above", { "0": draft })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
