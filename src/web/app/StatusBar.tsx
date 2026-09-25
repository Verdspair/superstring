import { currentChat } from "../features/chat/conversation-state";
import {
  selectedConversation,
  currentSessionId as selectedSessionId,
} from "../features/conversations/directory-state";
import { useI18n } from "../i18n";
import { useSuperstringStore } from "../store";
import { Icon } from "../ui/icons";

export function StatusBar() {
  const t = useI18n();
  const sessionId = useSuperstringStore(selectedSessionId);
  const runtime = useSuperstringStore((state) => currentChat(state).runtimeConfig);
  const unavailable = useSuperstringStore((state) => currentChat(state).runtimeConfigUnavailable);
  const selected = useSuperstringStore(selectedConversation);
  const bot = selected?.channel === "onebot11" ? selected : null;
  const mode = bot
    ? t(bot.topology === "shared" ? "OneBot 群聊" : "OneBot 私聊")
    : !sessionId
      ? t("对话聊天模式")
      : unavailable || !runtime
        ? t("模式信息不可用")
        : runtime.mode === "chat"
          ? t("对话聊天模式")
          : t("未知模式（{0}）", runtime.mode);
  return (
    <footer role="contentinfo" className="app-statusbar" aria-label={t("应用状态")}>
      <span role="status">
        <Icon name="chat" />
        {mode}
      </span>
      <span>{t("本地工作空间")}</span>
    </footer>
  );
}
