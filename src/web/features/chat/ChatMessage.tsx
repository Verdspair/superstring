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
          className={`message ${message.role} ${message.status}`}
        >
          <div className="bubble">
            {message.content || (message.status === "pending" ? t("正在生成…") : "")}
            {message.status === "failed" && `\n\n${t("[生成失败]")}`}
            {message.status === "cancelled" && `\n\n${t("[生成已取消]")}`}
          </div>
          <div className="message-footer">
            <small className="message-meta">
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
