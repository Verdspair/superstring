import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationSummary, Delivery } from "../../../shared/contracts/conversation";
import { translateNotice, useI18n } from "../../i18n";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
export const deliveryLabels = {
  planned: "等待发送",
  delivering: "正在送达",
  sending: "正在送达",
  confirmed: "已送达",
  failed: "发送失败",
  unknown: "发送结果待确认",
  stale: "回复已过期",
  not_sent: "尚未发送",
};

export function DeliveryDetails({
  outputId,
  conversation,
}: {
  outputId: string;
  conversation?: Pick<ConversationSummary, "participants">;
}) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const [delivery, setDelivery] = useState<Delivery | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      setDelivery(await api.getDelivery(outputId));
    } catch (reason) {
      setDelivery(null);
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      className="delivery-details min-w-0 flex-1 rounded-lg border p-3 text-xs leading-relaxed [&_summary]:cursor-pointer [&_summary]:font-medium [&_code]:break-all [&_p]:mt-2 [&_ol]:my-3 [&_ol]:space-y-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !delivery && !loading) void load();
      }}
    >
      <summary>{t("送达详情")}</summary>
      {error && <p role="alert">{translateNotice(error)}</p>}
      {loading && <p role="status">{t("正在读取送达结果…")}</p>}
      {delivery && (
        <>
          <p>{t(deliveryLabels[delivery.status])}</p>
          <p>
            {t("输出 {0}", delivery.ordinal + 1)} ·{" "}
            {delivery.target ? (
              <>
                {t("送达会话")}: <code>{delivery.target.peerId}</code>
                {delivery.target.participantId && (
                  <>
                    {" "}
                    · {t("回应成员")}:{" "}
                    {conversation?.participants.find(
                      (person) => person.id === delivery.target?.participantId,
                    )?.label ?? ""}{" "}
                    <code>{delivery.target.participantId}</code>
                  </>
                )}
              </>
            ) : (
              t("目标信息未记录")
            )}
          </p>
          {delivery.parts.some((part) => part.status === "confirmed") &&
            delivery.parts.some((part) => part.status !== "confirmed") && (
              <p className="hint text-muted-foreground">
                {t("部分内容已送达，请查看各部分结果。")}
              </p>
            )}
          <ol>
            {delivery.parts.map((part) => (
              <li key={part.id}>
                <strong>{t(part.kind === "text" ? "文本" : "表情")}</strong> ·{" "}
                {t(deliveryLabels[part.status])}
                {part.stickerId && (
                  <p>
                    {t("表情 ID")}: <code>{part.stickerId}</code>
                  </p>
                )}
                {part.platformMessageId && (
                  <p>
                    {t("平台消息 ID")}: <code>{part.platformMessageId}</code>
                  </p>
                )}
              </li>
            ))}
          </ol>
          {delivery.status === "unknown" && (
            <p className="hint text-muted-foreground">
              {t("尚未确认外部平台是否已收到；此处仅核对结果。")}
            </p>
          )}
        </>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        type="button"
        disabled={loading}
        onClick={() => void load()}
      >
        {t("刷新送达结果")}
      </Button>
    </details>
  );
}
