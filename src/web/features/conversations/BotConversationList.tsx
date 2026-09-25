import { useState } from "react";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { translateNotice, useI18n } from "../../i18n";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

export function BotConversationList() {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const selected = useSuperstringStore((s) => s.selectedBotConversation?.id);
  const openChat = useSuperstringStore((s) => s.openChat);
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const load = async (more = false) => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const page = await api.listConversations({
        channel: "onebot11",
        ...(more && cursor ? { cursor } : {}),
      });
      setItems((previous) => [
        ...new Map(
          [
            ...(more ? previous : []),
            ...page.items.filter((item) => item.topology === "direct"),
          ].map((item) => [item.id, item]),
        ).values(),
      ]);
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      className="bot-conversation-list"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !loading) void load();
      }}
    >
      <summary>{t("OneBot 私聊")}</summary>
      <nav className="session-list" aria-label={t("OneBot 私聊")}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={selected === item.id ? "active" : ""}
            aria-current={selected === item.id ? "page" : undefined}
            onClick={() => {
              useSuperstringStore.setState({
                selectedBotConversation: item,
                currentConversationId: item.id,
              });
              openChat();
            }}
          >
            {item.title}
            <small>{item.participants.map((p) => p.label).join(" · ")}</small>
          </button>
        ))}
      </nav>
      {loaded && !items.length && <p className="hint">{t("暂无 OneBot 私聊记录。")}</p>}
      {loading && <p role="status">{t("正在读取会话…")}</p>}
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      <button type="button" disabled={loading} onClick={() => void load()}>
        {t("刷新会话")}
      </button>
      {cursor && (
        <button type="button" disabled={loading} onClick={() => void load(true)}>
          {t("加载更多会话")}
        </button>
      )}
    </details>
  );
}
