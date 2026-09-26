import { cn } from "@/lib/utils";
import { ActionMenu } from "../../app/ActionMenu";
import { useI18n } from "../../i18n";
import type { ChatItem } from "../../state/types";
import { localTime } from "../../ui/local-time";

export function ChatMessage({ message, onDelete }: { message: ChatItem; onDelete: () => void }) {
  const t = useI18n();
  const actionable = message.status !== "pending" && !message.id.startsWith("optimistic-");
  return (
    <ActionMenu
      label={t("消息操作")}
      disabled={!actionable}
      items={[
        { id: "delete", label: t("删除消息"), icon: "trash", danger: true, onSelect: onDelete },
      ]}
    >
      {(trigger) => (
        <article
          tabIndex={actionable ? 0 : undefined}
          aria-label={t("消息 {0}", message.role === "user" ? t("用户") : t("模型"))}
          className={cn(
            `message ${message.role} ${message.status}`,
            "group flex max-w-full flex-col gap-1 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring",
            message.role === "user" ? "ml-auto w-fit max-w-[90%] md:max-w-[80%]" : "w-full",
          )}
        >
          <div
            className={cn(
              "bubble whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-sm leading-7",
              message.role === "user" ? "bg-muted" : "px-0",
              message.status === "failed" && "text-destructive",
            )}
          >
            {message.content || (message.status === "pending" ? t("正在生成…") : "")}
            {message.status === "failed" && `\n\n${t("[生成失败]")}`}
            {message.status === "cancelled" && `\n\n${t("[生成已取消]")}`}
          </div>
          <div className="message-footer flex items-center gap-2 text-muted-foreground">
            <small className="message-meta text-[11px]">
              {message.role === "user" ? t("用户") : t("模型")} ·{" "}
              {localTime(message.completedAt ?? message.createdAt)}
              {message.errorCode ? ` · ${message.errorCode}` : ""}
            </small>
            {trigger}
          </div>
        </article>
      )}
    </ActionMenu>
  );
}
