import { useEffect, useState } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Icon } from "../../ui/icons";
import { ProcessingStatus } from "../../ui/ProcessingStatus";
import { ConversationHeader } from "../conversations/ConversationHeader";
import {
  selectedConversation,
  currentSessionId as selectedSessionId,
} from "../conversations/directory-state";
import { RunLink } from "../runs/RunInspector";
import { ChatMessage } from "./ChatMessage";
import { ContextUsagePanel } from "./ContextUsagePanel";
import { chatBusy, currentChat } from "./conversation-state";

export function ChatPage() {
  const t = useI18n();
  const current = useSuperstringStore(selectedConversation);
  const currentSessionId = useSuperstringStore(selectedSessionId);
  const canonicalId = useSuperstringStore((state) => state.currentConversationId);
  const resolving = !!currentSessionId && !canonicalId;
  const chat = useSuperstringStore(currentChat);
  const {
    messages,
    runtimeConfig,
    runtimeConfigUnavailable,
    composer,
    failedChat,
    knowledgeResend,
  } = chat;
  const sending = chatBusy(chat);
  const reconcile = useSuperstringStore((state) => state.reconcileChat);
  const pendingOperations = useSuperstringStore((state) => state.pendingOperations);
  const error = useSuperstringStore((state) => currentChat(state).error ?? state.error);
  const feedback = useSuperstringStore((state) => currentChat(state).feedback || state.feedback);
  const setComposer = useSuperstringStore((state) => state.setComposer);
  const send = useSuperstringStore((state) => state.send);
  const retryChat = useSuperstringStore((state) => state.retryChat);
  const resendKnowledgeChat = useSuperstringStore((state) => state.resendKnowledgeChat);
  const cancelKnowledgeResend = useSuperstringStore((state) => state.cancelKnowledgeResend);
  const deleteMessageAction = useSuperstringStore((state) => state.deleteMessage);
  const modeLabel =
    runtimeConfig?.mode === "chat"
      ? t("聊天")
      : runtimeConfig?.mode === "work"
        ? t("工作")
        : runtimeConfig?.mode
          ? t("未知模式（{0}）", runtimeConfig.mode)
          : t("未知模式");
  const headingText = !current ? t("当前对话 · 请新建会话") : current.title;
  const [deleteMessageId, setDeleteMessageId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A confirmation belongs to the selected conversation only.
  useEffect(() => {
    setDeleteMessageId(null);
  }, [currentSessionId]);

  const deleteMessage = (id: string) => deleteMessageAction(currentSessionId, id);
  return (
    <section className="page chat-page">
      <ConversationHeader
        className="chat-header"
        title={headingText}
        detail={
          current ? (
            runtimeConfigUnavailable ? (
              t("会话信息暂不可用")
            ) : (
              <>
                {t("Web · 私聊")} · {runtimeConfig?.name ?? "Agent"} · {modeLabel}
              </>
            )
          ) : (
            t("本地工作空间")
          )
        }
        actions={chat.runId && <RunLink runId={chat.runId} />}
      />
      <div className="chat-content">
        {messages.length === 0 ? (
          <div className="empty-chat">
            <h2>{current ? t("开始对话") : t("开始一段对话")}</h2>
            <p>
              {current
                ? t("在下方输入消息，开始与助手交流。")
                : t("点击“新建任务”，开启与助手的对话。")}
            </p>
          </div>
        ) : (
          <div className="messages">
            {messages
              .filter((message) => message.role !== "system")
              .map((message) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  onDelete={() => setDeleteMessageId(message.id)}
                />
              ))}
          </div>
        )}
      </div>
      {deleteMessageId && (
        <ConfirmDialog
          message={t("确认删除这条消息？")}
          confirmLabel={t("删除")}
          onCancel={() => setDeleteMessageId(null)}
          onConfirm={() => {
            const id = deleteMessageId;
            setDeleteMessageId(null);
            void deleteMessage(id);
          }}
        />
      )}
      {knowledgeResend && knowledgeResend.sessionId === currentSessionId && (
        <ConfirmDialog
          message={t("资料权限已变化，原请求不能重试。是否按最新权限重新发送？这将创建新请求。")}
          confirmLabel={t("按最新权限重新发送")}
          onCancel={cancelKnowledgeResend}
          onConfirm={() => void resendKnowledgeChat()}
        />
      )}
      <div className="composer-region">
        <div className="composer-wrap">
          {(error || feedback) && (
            <div className={error ? "status error" : "status"}>
              {translateNotice(error ?? feedback)}
            </div>
          )}
          {chat.phase === "reconciling" && (
            <button type="button" onClick={() => void reconcile()}>
              {t("核对服务端结果")}
            </button>
          )}
          <textarea
            aria-label={t("输入消息…")}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={t("输入消息…")}
            rows={2}
            disabled={sending || resolving}
          />
          <div className="composer-actions">
            <span>{t("Enter 发送 · Shift + Enter 换行")}</span>
            <ContextUsagePanel />
            {failedChat?.sessionId === currentSessionId && (
              <button
                type="button"
                disabled={sending || resolving}
                onClick={() => void retryChat()}
              >
                {t("重试原请求")}
              </button>
            )}
            <button
              type="button"
              className="primary"
              aria-label={sending ? t("生成中") : t("发送")}
              disabled={sending || resolving}
              onClick={() => void send()}
            >
              <Icon name={sending ? "clock" : "send"} />
              {sending ? t("生成中") : t("发送")}
            </button>
          </div>
        </div>
      </div>
      <ProcessingStatus active={sending || pendingOperations > 0} />
    </section>
  );
}
